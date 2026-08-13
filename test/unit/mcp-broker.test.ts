import {describe, expect, it} from 'vitest';
import {
  runMcpBroker,
  type McpBrokerChild,
  type McpBrokerDependencies,
} from '../../src/mcp_broker.js';
import type {StandaloneActiveRelease} from '../../src/standalone_process_lease.js';

describe('MCP session broker', () => {
  it('promotes the runtime at a request boundary without closing or reinitializing the client transport', async () => {
    const clientInput = new AsyncByteQueue();
    const clientOutput = new AsyncByteQueue();
    const releases = {
      first: {releaseRoot: '/threadnote/versions/4.2.2-a', version: '4.2.2-a'},
      second: {releaseRoot: '/threadnote/versions/4.2.2-b', version: '4.2.2-b'},
    } satisfies Record<string, StandaloneActiveRelease>;
    let active = releases.first;
    const spawned: FakeMcpChild[] = [];
    const dependencies: McpBrokerDependencies = {
      input: clientInput,
      readActiveRelease: async () => active,
      spawn: release => {
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
    clientInput.pushLine(
      JSON.stringify({id: 2, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}),
    );
    expect(await clientOutput.nextLine()).toContain('4.2.2-a');

    active = releases.second;
    clientInput.pushLine(
      JSON.stringify({id: 3, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}),
    );
    expect(await clientOutput.nextLine()).toContain('4.2.2-b');
    expect(spawned).toHaveLength(2);
    expect(spawned[1]?.received.map(line => JSON.parse(line).method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    expect(clientOutput.availableLines()).toBe(0);

    clientInput.end();
    await running;
  });

  it('does not replay a pending tool request when its child exits with an unknown outcome', async () => {
    const clientInput = new AsyncByteQueue();
    const clientOutput = new AsyncByteQueue();
    const release = {releaseRoot: '/threadnote/versions/4.2.2', version: '4.2.2'};
    const spawned: FakeMcpChild[] = [];
    const running = runMcpBroker({
      input: clientInput,
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

    clientInput.pushLine(
      JSON.stringify({id: 2, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}),
    );
    const replacement = await waitForSpawnedChild(spawned, 1);
    await replacement.receivedCount(3);
    expect(replacement.received.map(line => JSON.parse(line).method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);

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
    readonly options: {readonly respondToTools?: boolean} = {},
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

  #handle(line: string): void {
    this.received.push(line);
    for (const resolve of this.#receivedWaiters.splice(0)) resolve();
    const envelope = JSON.parse(line) as {readonly id?: string | number; readonly method?: string};
    if (envelope.method === 'initialize') {
      this.#output.pushLine(
        JSON.stringify({
          id: envelope.id,
          jsonrpc: '2.0',
          result: {protocolVersion: '2025-11-25', serverInfo: {name: 'threadnote', version: this.version}},
        }),
      );
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
