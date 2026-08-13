import {describe, expect, it} from 'vitest';
import {
  runMcpBroker,
  type McpBrokerChild,
  type McpBrokerDependencies,
  type McpBrokerFailureEvent,
} from '../../src/mcp_broker.js';
import type {StandaloneActiveRelease} from '../../src/standalone_process_lease.js';
import {anonymousAgentSessionId} from '../../src/telemetry/session.js';

const TEST_AGENT_SESSION_ID = anonymousAgentSessionId(Uint8Array.from({length: 16}, (_, index) => index));

describe('MCP session broker', () => {
  it('reports a closed spawn failure without allowing the observer to alter recovery', async () => {
    const clientInput = new AsyncByteQueue();
    const clientOutput = new AsyncByteQueue();
    const release = {releaseRoot: '/threadnote/versions/private-release', version: 'private-version'};
    const failures: McpBrokerFailureEvent[] = [];
    const running = runMcpBroker({
      agentSessionId: TEST_AGENT_SESSION_ID,
      input: clientInput,
      onFailure: event => {
        failures.push(event);
        throw new Error('private observer failure');
      },
      readActiveRelease: async () => release,
      spawn: () => {
        throw new Error('private spawn failure');
      },
      writeOutput: async line => clientOutput.pushLine(line),
    });

    clientInput.pushLine(JSON.stringify({id: 1, jsonrpc: '2.0', method: 'initialize', params: {}}));
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({error: {code: -32_603}, id: 1});
    clientInput.end();
    await running;

    expect(failures).toEqual([{area: 'child', reason: 'spawn'}]);
  });

  it('promotes the runtime at a request boundary without closing or reinitializing the client transport', async () => {
    const clientInput = new AsyncByteQueue();
    const clientOutput = new AsyncByteQueue();
    const releases = {
      first: {releaseRoot: '/threadnote/versions/4.2.2-a', version: '4.2.2-a'},
      second: {releaseRoot: '/threadnote/versions/4.2.2-b', version: '4.2.2-b'},
    } satisfies Record<string, StandaloneActiveRelease>;
    let active = releases.first;
    const spawned: FakeMcpChild[] = [];
    const childAgentSessionIds: string[] = [];
    const failures: McpBrokerFailureEvent[] = [];
    const dependencies: McpBrokerDependencies = {
      agentSessionId: TEST_AGENT_SESSION_ID,
      input: clientInput,
      onFailure: event => failures.push(event),
      readActiveRelease: async () => active,
      replayTimeoutMilliseconds: 5,
      spawn: (release, agentSessionId) => {
        childAgentSessionIds.push(agentSessionId);
        const child = new FakeMcpChild(release.version);
        spawned.push(child);
        return child;
      },
      writeOutput: async line => clientOutput.pushLine(line),
    };
    const running = runMcpBroker(dependencies);

    clientInput.pushLine(JSON.stringify({id: 1, jsonrpc: '2.0', method: 'initialize', params: {}}));
    expect(await clientOutput.nextLine()).toContain('4.2.2-a');
    clientInput.pushLine(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}));
    clientInput.pushLine(JSON.stringify({id: 2, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}));
    expect(await clientOutput.nextLine()).toContain('4.2.2-a');

    active = releases.second;
    clientInput.pushLine(JSON.stringify({id: 3, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}));
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({method: 'notifications/tools/list_changed'});
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({method: 'notifications/resources/list_changed'});
    expect(await clientOutput.nextLine()).toContain('4.2.2-b');
    expect(spawned).toHaveLength(2);
    expect(childAgentSessionIds).toEqual([TEST_AGENT_SESSION_ID, TEST_AGENT_SESSION_ID]);
    expect(spawned[1]?.received.map(line => JSON.parse(line).method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    expect(clientOutput.availableLines()).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(failures).toEqual([]);

    clientInput.end();
    await running;
  });

  it('does not replay a pending tool request when its child exits with an unknown outcome', async () => {
    const clientInput = new AsyncByteQueue();
    const clientOutput = new AsyncByteQueue();
    const release = {releaseRoot: '/threadnote/versions/4.2.2', version: '4.2.2'};
    const spawned: FakeMcpChild[] = [];
    const failures: McpBrokerFailureEvent[] = [];
    const running = runMcpBroker({
      agentSessionId: TEST_AGENT_SESSION_ID,
      input: clientInput,
      onFailure: event => failures.push(event),
      readActiveRelease: async () => release,
      spawn: () => {
        const child = new FakeMcpChild(release.version, {respondToTools: false});
        spawned.push(child);
        return child;
      },
      writeOutput: async line => clientOutput.pushLine(line),
    });

    clientInput.pushLine(JSON.stringify({id: 1, jsonrpc: '2.0', method: 'initialize', params: {}}));
    await clientOutput.nextLine();
    clientInput.pushLine(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}));
    clientInput.pushLine(
      JSON.stringify({id: 'mutation-1', jsonrpc: '2.0', method: 'tools/call', params: {name: 'remember_context'}}),
    );
    await spawned[0]!.receivedCount(3);
    spawned[0]!.exitUnexpectedly();

    const failure = JSON.parse(await clientOutput.nextLine()) as {
      readonly error: {readonly message: string};
      readonly id: string;
    };
    expect(failure.id).toBe('mutation-1');
    expect(failure.error.message).toContain('outcome is unknown');
    expect(spawned).toHaveLength(1);
    expect(failures).toEqual([{area: 'child', reason: 'exit'}]);

    clientInput.pushLine(JSON.stringify({id: 2, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}));
    const replacement = await waitForSpawnedChild(spawned, 1);
    await replacement.receivedCount(3);
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({method: 'notifications/tools/list_changed'});
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({method: 'notifications/resources/list_changed'});
    expect(replacement.received.map(line => JSON.parse(line).method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);

    clientInput.end();
    await running;
  });

  it('retries a rejected initialization exactly once on a replacement runtime', async () => {
    const clientInput = new AsyncByteQueue();
    const clientOutput = new AsyncByteQueue();
    const release = {releaseRoot: '/threadnote/versions/4.2.2', version: '4.2.2'};
    const spawned: FakeMcpChild[] = [];
    const running = runMcpBroker({
      agentSessionId: TEST_AGENT_SESSION_ID,
      input: clientInput,
      readActiveRelease: async () => release,
      spawn: () => {
        const child = new FakeMcpChild(release.version, {rejectInitialize: spawned.length === 0});
        spawned.push(child);
        return child;
      },
      writeOutput: async line => clientOutput.pushLine(line),
    });

    clientInput.pushLine(JSON.stringify({id: 1, jsonrpc: '2.0', method: 'initialize', params: {}}));
    expect(await clientOutput.nextLine()).toContain('initialization rejected');
    spawned[0]!.exitUnexpectedly();
    await new Promise(resolve => setTimeout(resolve, 1));
    clientInput.pushLine(JSON.stringify({id: 2, jsonrpc: '2.0', method: 'initialize', params: {}}));
    expect(await clientOutput.nextLine()).toContain('4.2.2');

    const replacement = await waitForSpawnedChild(spawned, 1);
    expect(replacement.received.map(line => JSON.parse(line).method)).toEqual(['initialize']);

    clientInput.end();
    await running;
  });

  it('promotes after a cancelled request without replaying the cancelled work', async () => {
    const clientInput = new AsyncByteQueue();
    const clientOutput = new AsyncByteQueue();
    const releases = {
      first: {releaseRoot: '/threadnote/versions/4.2.2-a', version: '4.2.2-a'},
      second: {releaseRoot: '/threadnote/versions/4.2.2-b', version: '4.2.2-b'},
    } satisfies Record<string, StandaloneActiveRelease>;
    let active = releases.first;
    const spawned: FakeMcpChild[] = [];
    const running = runMcpBroker({
      agentSessionId: TEST_AGENT_SESSION_ID,
      input: clientInput,
      readActiveRelease: async () => active,
      spawn: release => {
        const child = new FakeMcpChild(release.version, {respondToTools: spawned.length > 0});
        spawned.push(child);
        return child;
      },
      writeOutput: async line => clientOutput.pushLine(line),
    });

    clientInput.pushLine(JSON.stringify({id: 1, jsonrpc: '2.0', method: 'initialize', params: {}}));
    await clientOutput.nextLine();
    clientInput.pushLine(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}));
    clientInput.pushLine(JSON.stringify({id: 2, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}));
    await spawned[0]!.receivedCount(3);

    active = releases.second;
    clientInput.pushLine(JSON.stringify({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: 2}}));
    clientInput.pushLine(JSON.stringify({id: 3, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}));
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({method: 'notifications/tools/list_changed'});
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({method: 'notifications/resources/list_changed'});
    expect(await clientOutput.nextLine()).toContain('4.2.2-b');

    expect(spawned[0]!.received.map(line => JSON.parse(line).method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
      'notifications/cancelled',
    ]);
    expect(spawned[1]!.received.map(line => JSON.parse(line).method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);

    clientInput.end();
    await running;
  });

  it('contains a child exit between admission and write and serves the next request on the same transport', async () => {
    const clientInput = new AsyncByteQueue();
    const clientOutput = new AsyncByteQueue();
    const release = {releaseRoot: '/threadnote/versions/4.2.2', version: '4.2.2'};
    const spawned: FakeMcpChild[] = [];
    const failures: McpBrokerFailureEvent[] = [];
    const running = runMcpBroker({
      agentSessionId: TEST_AGENT_SESSION_ID,
      input: clientInput,
      onFailure: event => failures.push(event),
      readActiveRelease: async () => release,
      spawn: () => {
        const child = new FakeMcpChild(release.version, {exitBeforeFirstToolWrite: spawned.length === 0});
        spawned.push(child);
        return child;
      },
      writeOutput: async line => clientOutput.pushLine(line),
    });

    clientInput.pushLine(JSON.stringify({id: 1, jsonrpc: '2.0', method: 'initialize', params: {}}));
    await clientOutput.nextLine();
    clientInput.pushLine(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}));
    clientInput.pushLine(JSON.stringify({id: 2, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}));
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({error: {code: -32_603}, id: 2});
    expect(failures).toContainEqual({area: 'child', reason: 'write'});

    clientInput.pushLine(JSON.stringify({id: 3, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}));
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({method: 'notifications/tools/list_changed'});
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({method: 'notifications/resources/list_changed'});
    expect(await clientOutput.nextLine()).toContain('4.2.2');
    expect(spawned).toHaveLength(2);

    clientInput.end();
    await running;
  });

  it('contains a promoted initialization rejection and retries on the next request', async () => {
    const clientInput = new AsyncByteQueue();
    const clientOutput = new AsyncByteQueue();
    const releases = {
      first: {releaseRoot: '/threadnote/versions/4.2.2-a', version: '4.2.2-a'},
      second: {releaseRoot: '/threadnote/versions/4.2.2-b', version: '4.2.2-b'},
    } satisfies Record<string, StandaloneActiveRelease>;
    let active = releases.first;
    const spawned: FakeMcpChild[] = [];
    const failures: McpBrokerFailureEvent[] = [];
    const running = runMcpBroker({
      agentSessionId: TEST_AGENT_SESSION_ID,
      input: clientInput,
      onFailure: event => failures.push(event),
      readActiveRelease: async () => active,
      spawn: release => {
        const child = new FakeMcpChild(release.version, {rejectInitialize: spawned.length === 1});
        spawned.push(child);
        return child;
      },
      writeOutput: async line => clientOutput.pushLine(line),
    });

    clientInput.pushLine(JSON.stringify({id: 1, jsonrpc: '2.0', method: 'initialize', params: {}}));
    await clientOutput.nextLine();
    clientInput.pushLine(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}));
    await spawned[0]!.receivedCount(2);
    active = releases.second;
    clientInput.pushLine(JSON.stringify({id: 2, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}));
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({error: {code: -32_603}, id: 2});
    expect(failures).toEqual([{area: 'promotion', reason: 'protocol'}]);

    clientInput.pushLine(JSON.stringify({id: 3, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}));
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({method: 'notifications/tools/list_changed'});
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({method: 'notifications/resources/list_changed'});
    expect(await clientOutput.nextLine()).toContain('4.2.2-b');
    expect(spawned).toHaveLength(3);

    clientInput.end();
    await running;
  });

  it('contains a promoted initialization timeout and retries on the next request', async () => {
    const clientInput = new AsyncByteQueue();
    const clientOutput = new AsyncByteQueue();
    const releases = {
      first: {releaseRoot: '/threadnote/versions/4.2.2-a', version: '4.2.2-a'},
      second: {releaseRoot: '/threadnote/versions/4.2.2-b', version: '4.2.2-b'},
    } satisfies Record<string, StandaloneActiveRelease>;
    let active = releases.first;
    const spawned: FakeMcpChild[] = [];
    const failures: McpBrokerFailureEvent[] = [];
    const running = runMcpBroker({
      agentSessionId: TEST_AGENT_SESSION_ID,
      input: clientInput,
      onFailure: event => failures.push(event),
      readActiveRelease: async () => active,
      replayTimeoutMilliseconds: 1,
      spawn: release => {
        const child = new FakeMcpChild(release.version, {ignoreInitialize: spawned.length === 1});
        spawned.push(child);
        return child;
      },
      writeOutput: async line => clientOutput.pushLine(line),
    });

    clientInput.pushLine(JSON.stringify({id: 1, jsonrpc: '2.0', method: 'initialize', params: {}}));
    await clientOutput.nextLine();
    clientInput.pushLine(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}));
    await spawned[0]!.receivedCount(2);
    active = releases.second;
    clientInput.pushLine(JSON.stringify({id: 2, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}));
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({error: {code: -32_603}, id: 2});
    expect(failures).toEqual([{area: 'promotion', reason: 'timeout'}]);

    clientInput.pushLine(JSON.stringify({id: 3, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}));
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({method: 'notifications/tools/list_changed'});
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({method: 'notifications/resources/list_changed'});
    expect(await clientOutput.nextLine()).toContain('4.2.2-b');
    expect(spawned).toHaveLength(3);

    clientInput.end();
    await running;
  });

  it('rewrites server request ids and drops an old-generation late response', async () => {
    const clientInput = new AsyncByteQueue();
    const clientOutput = new AsyncByteQueue();
    const releases = {
      first: {releaseRoot: '/threadnote/versions/4.2.2-a', version: '4.2.2-a'},
      second: {releaseRoot: '/threadnote/versions/4.2.2-b', version: '4.2.2-b'},
    } satisfies Record<string, StandaloneActiveRelease>;
    let active = releases.first;
    const spawned: FakeMcpChild[] = [];
    const running = runMcpBroker({
      agentSessionId: TEST_AGENT_SESSION_ID,
      input: clientInput,
      readActiveRelease: async () => active,
      spawn: release => {
        const child = new FakeMcpChild(release.version);
        spawned.push(child);
        return child;
      },
      writeOutput: async line => clientOutput.pushLine(line),
    });

    clientInput.pushLine(JSON.stringify({id: 1, jsonrpc: '2.0', method: 'initialize', params: {}}));
    await clientOutput.nextLine();
    clientInput.pushLine(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}));
    spawned[0]!.emitServerRequest(7);
    const oldExternalId = (JSON.parse(await clientOutput.nextLine()) as {id: string}).id;
    expect(oldExternalId).not.toBe('7');
    spawned[0]!.exitUnexpectedly();
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({
      method: 'notifications/cancelled',
      params: {requestId: oldExternalId},
    });

    clientInput.pushLine(JSON.stringify({id: oldExternalId, jsonrpc: '2.0', result: {late: true}}));
    active = releases.second;
    clientInput.pushLine(JSON.stringify({id: 2, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}));
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({method: 'notifications/tools/list_changed'});
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({method: 'notifications/resources/list_changed'});
    await clientOutput.nextLine();
    spawned[1]!.emitServerRequest(7);
    const newExternalId = (JSON.parse(await clientOutput.nextLine()) as {id: string}).id;
    expect(newExternalId).not.toBe(oldExternalId);

    clientInput.pushLine(JSON.stringify({id: oldExternalId, jsonrpc: '2.0', result: {late: true}}));
    clientInput.pushLine(JSON.stringify({id: newExternalId, jsonrpc: '2.0', result: {accepted: true}}));
    await spawned[1]!.receivedCount(4);
    expect(JSON.parse(spawned[1]!.received[3]!)).toEqual({id: 7, jsonrpc: '2.0', result: {accepted: true}});

    clientInput.end();
    await running;
  });

  it('retires a server request when the runtime cancels it so promotion can proceed', async () => {
    const clientInput = new AsyncByteQueue();
    const clientOutput = new AsyncByteQueue();
    const releases = {
      first: {releaseRoot: '/threadnote/versions/4.2.2-a', version: '4.2.2-a'},
      second: {releaseRoot: '/threadnote/versions/4.2.2-b', version: '4.2.2-b'},
    } satisfies Record<string, StandaloneActiveRelease>;
    let active = releases.first;
    const spawned: FakeMcpChild[] = [];
    const running = runMcpBroker({
      agentSessionId: TEST_AGENT_SESSION_ID,
      input: clientInput,
      readActiveRelease: async () => active,
      spawn: release => {
        const child = new FakeMcpChild(release.version);
        spawned.push(child);
        return child;
      },
      writeOutput: async line => clientOutput.pushLine(line),
    });

    clientInput.pushLine(JSON.stringify({id: 1, jsonrpc: '2.0', method: 'initialize', params: {}}));
    await clientOutput.nextLine();
    clientInput.pushLine(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}));
    spawned[0]!.emitServerRequest('sample');
    const externalId = (JSON.parse(await clientOutput.nextLine()) as {id: string}).id;
    spawned[0]!.emitServerCancellation('sample');
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({
      method: 'notifications/cancelled',
      params: {requestId: externalId},
    });

    active = releases.second;
    clientInput.pushLine(JSON.stringify({id: 2, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}));
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({method: 'notifications/tools/list_changed'});
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({method: 'notifications/resources/list_changed'});
    expect(await clientOutput.nextLine()).toContain('4.2.2-b');

    clientInput.end();
    await running;
  });

  it('cancels a host-side server request when its runtime exits', async () => {
    const clientInput = new AsyncByteQueue();
    const clientOutput = new AsyncByteQueue();
    const release = {releaseRoot: '/threadnote/versions/4.2.2', version: '4.2.2'};
    const spawned: FakeMcpChild[] = [];
    const running = runMcpBroker({
      agentSessionId: TEST_AGENT_SESSION_ID,
      input: clientInput,
      readActiveRelease: async () => release,
      spawn: () => {
        const child = new FakeMcpChild(release.version);
        spawned.push(child);
        return child;
      },
      writeOutput: async line => clientOutput.pushLine(line),
    });

    clientInput.pushLine(JSON.stringify({id: 1, jsonrpc: '2.0', method: 'initialize', params: {}}));
    await clientOutput.nextLine();
    clientInput.pushLine(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}));
    spawned[0]!.emitServerRequest(7);
    const externalId = (JSON.parse(await clientOutput.nextLine()) as {id: string}).id;
    spawned[0]!.exitUnexpectedly();
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({
      method: 'notifications/cancelled',
      params: {requestId: externalId},
    });

    clientInput.end();
    await running;
  });

  it('cancels outstanding server requests when a child write fails', async () => {
    const clientInput = new AsyncByteQueue();
    const clientOutput = new AsyncByteQueue();
    const release = {releaseRoot: '/threadnote/versions/4.2.2', version: '4.2.2'};
    const spawned: FakeMcpChild[] = [];
    const running = runMcpBroker({
      agentSessionId: TEST_AGENT_SESSION_ID,
      input: clientInput,
      readActiveRelease: async () => release,
      spawn: () => {
        const child = new FakeMcpChild(release.version, {exitBeforeFirstToolWrite: true});
        spawned.push(child);
        return child;
      },
      writeOutput: async line => clientOutput.pushLine(line),
    });

    clientInput.pushLine(JSON.stringify({id: 1, jsonrpc: '2.0', method: 'initialize', params: {}}));
    await clientOutput.nextLine();
    clientInput.pushLine(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}));
    spawned[0]!.emitServerRequest('sample');
    const externalId = (JSON.parse(await clientOutput.nextLine()) as {id: string}).id;
    clientInput.pushLine(JSON.stringify({id: 2, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}));
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({
      method: 'notifications/cancelled',
      params: {requestId: externalId},
    });
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({error: {code: -32_603}, id: 2});

    clientInput.end();
    await running;
  });
});

class FakeMcpChild implements McpBrokerChild {
  readonly #output = new AsyncByteQueue();
  readonly #resolveExit: (code: number) => void;
  readonly exited: Promise<number>;
  readonly input;
  readonly output = this.#output;
  readonly processId = 1;
  readonly received: string[] = [];
  readonly #receivedWaiters: Array<() => void> = [];
  #ended = false;

  constructor(
    readonly version: string,
    readonly options: {
      readonly exitBeforeFirstToolWrite?: boolean;
      readonly ignoreInitialize?: boolean;
      readonly rejectInitialize?: boolean;
      readonly respondToTools?: boolean;
    } = {},
  ) {
    let resolveExit: (code: number) => void = () => undefined;
    this.exited = new Promise<number>(resolve => {
      resolveExit = resolve;
    });
    this.#resolveExit = resolveExit;
    this.input = {
      end: () => this.#end(),
      flush: async () => undefined,
      write: (value: string) => {
        for (const line of value.trimEnd().split('\n')) this.#handle(line);
        return value.length;
      },
    };
  }

  kill(): void {
    this.#end();
  }

  exitUnexpectedly(): void {
    this.#end();
  }

  async receivedCount(count: number): Promise<void> {
    while (this.received.length < count) {
      await new Promise<void>(resolve => this.#receivedWaiters.push(resolve));
    }
  }

  emitServerCancellation(requestId: string | number): void {
    this.#output.pushLine(JSON.stringify({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId}}));
  }

  emitServerRequest(id: string | number): void {
    this.#output.pushLine(JSON.stringify({id, jsonrpc: '2.0', method: 'sampling/createMessage', params: {}}));
  }

  #handle(line: string): void {
    if (this.#ended) throw new Error('Child input is closed.');
    this.received.push(line);
    for (const resolve of this.#receivedWaiters.splice(0)) resolve();
    const envelope = JSON.parse(line) as {readonly id?: string | number; readonly method?: string};
    if (envelope.method === 'initialize') {
      if (this.options.ignoreInitialize) return;
      this.#output.pushLine(
        this.options.rejectInitialize
          ? JSON.stringify({
              error: {code: -32_602, message: 'initialization rejected'},
              id: envelope.id,
              jsonrpc: '2.0',
            })
          : JSON.stringify({
              id: envelope.id,
              jsonrpc: '2.0',
              result: {protocolVersion: '2025-11-25', serverInfo: {name: 'threadnote', version: this.version}},
            }),
      );
    } else if (envelope.method === 'tools/call' && this.options.exitBeforeFirstToolWrite) {
      this.#end();
      throw new Error('Child exited before accepting the request.');
    } else if (envelope.method === 'tools/call' && this.options.respondToTools !== false) {
      this.#output.pushLine(JSON.stringify({id: envelope.id, jsonrpc: '2.0', result: {version: this.version}}));
    }
  }

  #end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#output.end();
    this.#resolveExit(0);
  }
}

async function waitForSpawnedChild(children: readonly FakeMcpChild[], index: number): Promise<FakeMcpChild> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const child = children[index];
    if (child !== undefined) return child;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error(`MCP broker did not spawn child ${index}.`);
}

class AsyncByteQueue implements AsyncIterable<Uint8Array> {
  readonly #queued: Array<IteratorResult<Uint8Array>> = [];
  readonly #waiters: Array<(value: IteratorResult<Uint8Array>) => void> = [];
  #ended = false;

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {next: () => this.#next()};
  }

  availableLines(): number {
    return this.#queued.filter(entry => !entry.done).length;
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#deliver({done: true, value: undefined});
  }

  async nextLine(): Promise<string> {
    const next = await this.#next();
    if (next.done) throw new Error('Queue ended before a line was available.');
    return new TextDecoder().decode(next.value).trimEnd();
  }

  pushLine(line: string): void {
    if (this.#ended) throw new Error('Cannot write to an ended queue.');
    this.#deliver({done: false, value: new TextEncoder().encode(`${line}\n`)});
  }

  #deliver(value: IteratorResult<Uint8Array>): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(value);
    else this.#queued.push(value);
  }

  #next(): Promise<IteratorResult<Uint8Array>> {
    const queued = this.#queued.shift();
    if (queued) return Promise.resolve(queued);
    if (this.#ended) return Promise.resolve({done: true, value: undefined});
    return new Promise(resolve => this.#waiters.push(resolve));
  }
}
