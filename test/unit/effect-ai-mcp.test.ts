import {it as effectIt} from '@effect/vitest';
import {Cause, Deferred, Effect, Exit, Fiber} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {McpSchema} from 'effect/unstable/ai';
import {RpcServer} from 'effect/unstable/rpc';
import {describe, expect, it, vi} from 'vitest';
import {
  admitMcpProgressToken,
  type EffectMcpServer,
  installCallToolProgressBridge,
  makeMcpCancellationCompatibleProtocol,
  makeMcpToolProgress,
  mcpProgressNotificationForCurrentRequest,
  mcpProgressHeartbeatMilliseconds,
  mcpRequestIdKey,
  MCP_PROGRESS_HEARTBEAT_MILLISECONDS,
  MCP_PROGRESS_MESSAGE_MAX_BYTES,
  MCP_PROGRESS_METADATA_KEY,
  MCP_RESOURCE_ERROR_DATA,
  StdioSingleClientSet,
  makeInitializeInstructionsTransform,
  mcpProgressNotification,
  mcpResourceFailureResult,
  mcpToolFailureResult,
  type McpProgressNotificationPayload,
  withMcpProgressHeartbeat,
} from '../../src/effect/ai/mcp.js';

const initializeResponse = JSON.stringify({
  id: 1,
  jsonrpc: '2.0',
  result: {
    capabilities: {tools: {}},
    protocolVersion: '2025-06-18',
    serverInfo: {name: 'threadnote', version: '4.0.0'},
  },
});

describe('Effect MCP initialization instructions', () => {
  it('parses the string initialize response once and passes later large frames through unchanged', () => {
    const transform = makeInitializeInstructionsTransform('Use Threadnote context.');
    const parse = vi.spyOn(JSON, 'parse');
    const initialized = transform(initializeResponse);
    const largeFrame = JSON.stringify({id: 2, jsonrpc: '2.0', result: {content: 'x'.repeat(2 * 1_024 * 1_024)}});
    const passedThrough = transform(largeFrame);
    const parseCalls = parse.mock.calls.length;
    parse.mockRestore();

    expect(parseCalls).toBe(1);
    expect(passedThrough).toBe(largeFrame);
    expect(typeof initialized).toBe('string');
    expect(JSON.parse(initialized as string)).toMatchObject({
      result: {instructions: 'Use Threadnote context.'},
    });
  });

  it('preserves Uint8Array output and identity for later large frames', () => {
    const encoder = new TextEncoder();
    const transform = makeInitializeInstructionsTransform('Use Threadnote context.');
    const initialized = transform(encoder.encode(initializeResponse));
    const largeFrame = encoder.encode(
      JSON.stringify({id: 2, jsonrpc: '2.0', result: {content: 'x'.repeat(2 * 1_024 * 1_024)}}),
    );
    const parse = vi.spyOn(JSON, 'parse');
    const passedThrough = transform(largeFrame);
    const parseCalls = parse.mock.calls.length;
    parse.mockRestore();

    expect(parseCalls).toBe(0);
    expect(passedThrough).toBe(largeFrame);
    expect(initialized).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(new TextDecoder().decode(initialized as Uint8Array))).toMatchObject({
      result: {instructions: 'Use Threadnote context.'},
    });
  });

  it('unwraps only Effect RPC envelopes carrying recognized MCP protocol errors', () => {
    const transform = makeInitializeInstructionsTransform('Use Threadnote context.');
    transform(initializeResponse);
    const invalidParams = JSON.stringify({
      error: {
        _tag: 'Cause',
        code: 0,
        data: [
          {
            _tag: 'Fail',
            error: {
              _tag: 'InvalidParams',
              code: -32602,
              data: MCP_RESOURCE_ERROR_DATA,
              message: 'Expected a canonical threadnote:// URI.',
            },
          },
        ],
        message: 'encoded Effect cause',
      },
      id: 2,
      jsonrpc: '2.0',
    });
    const resourceNotFound = JSON.stringify({
      error: {
        _tag: 'Cause',
        code: 0,
        data: [
          {
            _tag: 'Fail',
            error: {
              code: -32002,
              data: MCP_RESOURCE_ERROR_DATA,
              message: 'Threadnote resource was not found.',
            },
          },
        ],
        message: 'encoded Effect cause',
      },
      id: 3,
      jsonrpc: '2.0',
    });

    expect(JSON.parse(transform(invalidParams) as string)).toEqual({
      error: {code: -32602, message: 'Expected a canonical threadnote:// URI.'},
      id: 2,
      jsonrpc: '2.0',
    });
    expect(JSON.parse(transform(resourceNotFound) as string)).toEqual({
      error: {code: -32002, message: 'Threadnote resource was not found.'},
      id: 3,
      jsonrpc: '2.0',
    });
  });

  it('leaves unrelated results and Cause-shaped errors byte-for-byte unchanged', () => {
    const transform = makeInitializeInstructionsTransform('Use Threadnote context.');
    transform(initializeResponse);
    const frames = [
      JSON.stringify({
        id: 2,
        jsonrpc: '2.0',
        result: {text: 'repository data may contain "_tag":"Cause" without being a protocol error'},
      }),
      JSON.stringify({
        error: {
          _tag: 'Cause',
          code: 0,
          data: [
            {
              _tag: 'Fail',
              error: {
                _tag: 'InvalidParams',
                code: -32602,
                message: 'unbranded protocol failure',
              },
            },
          ],
        },
        id: 6,
        jsonrpc: '2.0',
      }),
      JSON.stringify({
        error: {
          _tag: 'Cause',
          code: 0,
          data: [
            {
              error: {
                _tag: 'InvalidParams',
                code: -32602,
                data: MCP_RESOURCE_ERROR_DATA,
                message: 'not an Effect Fail reason',
              },
            },
          ],
        },
        id: 7,
        jsonrpc: '2.0',
      }),
      JSON.stringify({
        error: {
          _tag: 'Cause',
          code: 0,
          data: [
            {
              _tag: 'Fail',
              error: {
                _tag: 'InvalidParams',
                code: -32602,
                data: {...MCP_RESOURCE_ERROR_DATA, privateDetail: 'must not be forwarded'},
                message: 'not an exact resource error brand',
              },
            },
          ],
        },
        id: 8,
        jsonrpc: '2.0',
      }),
      JSON.stringify({
        error: {
          _tag: 'Cause',
          code: 7,
          data: [{_tag: 'Fail', error: {_tag: 'InvalidParams', code: -32602, message: 'nested'}}],
        },
        id: 3,
        jsonrpc: '2.0',
      }),
      JSON.stringify({
        error: {
          _tag: 'Cause',
          code: 0,
          data: [{_tag: 'Fail', error: {_tag: 'OtherError', code: -32602, message: 'unrecognized'}}],
        },
        id: 4,
        jsonrpc: '2.0',
      }),
      JSON.stringify({
        error: {
          _tag: 'Cause',
          code: 0,
          data: [
            {_tag: 'Fail', error: {_tag: 'InvalidParams', code: -32602, message: 'first'}},
            {_tag: 'Fail', error: {_tag: 'InvalidParams', code: -32602, message: 'second'}},
          ],
        },
        id: 5,
        jsonrpc: '2.0',
      }),
      JSON.stringify({
        error: {
          _tag: 'Cause',
          code: 0,
          data: [{_tag: 'Fail', error: {_tag: 'InvalidParams', code: -32602, message: 'no id'}}],
        },
        jsonrpc: '2.0',
      }),
    ];

    for (const frame of frames) expect(transform(frame)).toBe(frame);
  });
});

describe('Effect MCP resource interruption', () => {
  effectIt.effect('re-fails resource cancellation instead of converting it to a protocol error', () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.never.pipe(Effect.catchCause(mcpResourceFailureResult), Effect.forkChild);
      yield* Effect.yieldNow;

      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
    }),
  );

  effectIt.effect('preserves an ordinary typed resource protocol failure', () =>
    Effect.gen(function* () {
      const expected = new McpSchema.InvalidParams({
        data: MCP_RESOURCE_ERROR_DATA,
        message: 'bounded fixture failure',
      });
      const exit = yield* Effect.fail(expected).pipe(Effect.catchCause(mcpResourceFailureResult), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.findErrorOption(exit.cause)).toEqual(expect.objectContaining({_tag: 'Some', value: expected}));
      }
    }),
  );

  effectIt.effect('maps defects to a bounded protocol error without exposing their details', () =>
    Effect.gen(function* () {
      const exit = yield* Effect.die(new Error('/private/path: secret fixture')).pipe(
        Effect.catchCause(mcpResourceFailureResult),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause);
        expect(error).toMatchObject({code: -32603, message: 'Threadnote resource request failed.'});
        expect(String(error)).not.toContain('/private/path');
        expect(String(error)).not.toContain('secret fixture');
      }
    }),
  );
});

describe('Effect MCP tool interruption', () => {
  effectIt.effect('re-fails transport cancellation instead of returning an isError payload', () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.never.pipe(Effect.catchCause(mcpToolFailureResult), Effect.forkChild);
      yield* Effect.yieldNow;

      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }),
  );

  effectIt.effect('still converts ordinary tool failures into an isError payload', () =>
    Effect.gen(function* () {
      const result = yield* Effect.fail(new Error('bounded fixture failure')).pipe(
        Effect.catchCause(mcpToolFailureResult),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{type: 'text', text: 'bounded fixture failure'}]);
    }),
  );
});

describe('Effect MCP tool progress', () => {
  it('keeps production cadence fixed and admits a shortened heartbeat only in explicit tests', () => {
    const testOverride = {THREADNOTE_TEST_MCP_PROGRESS_HEARTBEAT_MILLISECONDS: '1'};
    const removedProductionOverride = {THREADNOTE_MCP_PROGRESS_HEARTBEAT_MILLISECONDS: '1'};

    expect(mcpProgressHeartbeatMilliseconds({})).toBe(MCP_PROGRESS_HEARTBEAT_MILLISECONDS);
    expect(mcpProgressHeartbeatMilliseconds({...removedProductionOverride, NODE_ENV: 'production'})).toBe(
      MCP_PROGRESS_HEARTBEAT_MILLISECONDS,
    );
    expect(mcpProgressHeartbeatMilliseconds({...testOverride, NODE_ENV: 'production'})).toBe(
      MCP_PROGRESS_HEARTBEAT_MILLISECONDS,
    );
    expect(mcpProgressHeartbeatMilliseconds({...removedProductionOverride, NODE_ENV: 'test'})).toBe(
      MCP_PROGRESS_HEARTBEAT_MILLISECONDS,
    );
    expect(mcpProgressHeartbeatMilliseconds({NODE_ENV: 'test'})).toBe(MCP_PROGRESS_HEARTBEAT_MILLISECONDS);
    expect(
      mcpProgressHeartbeatMilliseconds({
        NODE_ENV: 'test',
        THREADNOTE_TEST_MCP_PROGRESS_HEARTBEAT_MILLISECONDS: 'invalid',
      }),
    ).toBe(MCP_PROGRESS_HEARTBEAT_MILLISECONDS);
    expect(mcpProgressHeartbeatMilliseconds({...testOverride, NODE_ENV: 'test'})).toBe(1);
  });

  it('keys numeric and string request ids without collisions', () => {
    fc.assert(
      fc.property(fc.integer(), id => {
        expect(mcpRequestIdKey(id)).not.toBe(mcpRequestIdKey(String(id)));
        expect(mcpRequestIdKey(id)).toBe(mcpRequestIdKey(id));
        expect(mcpRequestIdKey(String(id))).toBe(mcpRequestIdKey(String(id)));
      }),
      {numRuns: 100},
    );
  });

  effectIt.effect('isolates queued cancelled progress from a fresh request reusing the opaque token', () =>
    Effect.gen(function* () {
      type ProtocolService = RpcServer.Protocol['Service'];
      type Receive = Parameters<ProtocolService['run']>[0];
      type Received = Parameters<Receive>[1];
      type Sent = Parameters<ProtocolService['send']>[1];
      const ready = yield* Deferred.make<void>();
      const received: Received[] = [];
      const sent: Sent[] = [];
      const stampedProgress: Sent[] = [];
      let receive: Receive | undefined;
      const baseProtocol = {
        end: () => Effect.void,
        run: (handle: Receive) =>
          Effect.sync(() => {
            receive = handle;
          }).pipe(Effect.andThen(Deferred.succeed(ready, undefined)), Effect.andThen(Effect.never)),
        send: (_clientId: number, response: Sent) => Effect.sync(() => sent.push(response)),
      } as unknown as ProtocolService;
      const protocol = makeMcpCancellationCompatibleProtocol(baseProtocol);
      const fiber = yield* protocol
        .run((_clientId, incoming) => {
          received.push(incoming);
          if (incoming._tag !== 'Request' || incoming.tag !== 'tools/call') return Effect.void;
          return mcpProgressNotificationForCurrentRequest(
            mcpProgressNotification('shared-token', 1, {
              message: 'Preparing recall results.',
              phase: 'recall.finalizing',
            }),
          ).pipe(
            Effect.tap(notification =>
              Effect.sync(() =>
                stampedProgress.push({
                  _tag: 'Request',
                  headers: [],
                  id: 0,
                  payload: notification,
                  tag: 'notifications/progress',
                } as unknown as Sent),
              ),
            ),
            Effect.asVoid,
          );
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(ready);
      const dispatch = receive as Receive;
      const request = {
        _tag: 'Request' as const,
        headers: [],
        id: 9,
        payload: {_meta: {progressToken: 'shared-token'}},
        tag: 'tools/call',
      };
      yield* dispatch(7, request);
      const normalizedRequest = received[0];
      expect(normalizedRequest?._tag).toBe('Request');
      if (normalizedRequest?._tag !== 'Request') return;
      yield* dispatch(7, {
        _tag: 'Request',
        headers: [],
        id: '',
        payload: {requestId: 9},
        tag: 'notifications/cancelled',
      });
      const oldProgress = stampedProgress[0] as Sent;
      const unrelatedProgress = {
        _tag: 'Request',
        headers: [],
        id: 0,
        payload: {progressToken: 9},
        tag: 'notifications/progress',
      } as unknown as Sent;
      const exit = {
        _tag: 'Exit',
        exit: {_tag: 'Failure', cause: [{_tag: 'Interrupt', fiberId: 1}]},
        requestId: normalizedRequest.id,
      } as Sent;

      yield* protocol.send(7, unrelatedProgress);
      yield* protocol.send(7, oldProgress);
      yield* protocol.send(7, exit);
      yield* protocol.send(7, oldProgress);

      expect(sent).toEqual([unrelatedProgress]);

      const ordinaryRequest = {...request, id: 10};
      yield* dispatch(7, ordinaryRequest);
      const normalizedOrdinaryRequest = received[2];
      expect(normalizedOrdinaryRequest?._tag).toBe('Request');
      if (normalizedOrdinaryRequest?._tag !== 'Request') return;
      const freshProgress = stampedProgress[1] as Sent;
      yield* protocol.send(7, freshProgress);
      yield* protocol.send(7, {
        _tag: 'Exit',
        exit: {_tag: 'Success', value: 'complete'},
        requestId: normalizedOrdinaryRequest.id,
      });
      expect(sent).toEqual([
        unrelatedProgress,
        {
          ...(freshProgress as object),
          payload: mcpProgressNotification('shared-token', 1, {
            message: 'Preparing recall results.',
            phase: 'recall.finalizing',
          }),
        },
        {
          _tag: 'Exit',
          exit: {_tag: 'Success', value: 'complete'},
          requestId: 10,
        },
      ]);
      expect(JSON.stringify(sent)).not.toContain('threadnote.io/private/progress-generation');

      yield* Fiber.interrupt(fiber);
    }),
  );

  effectIt.effect('routes concurrent numeric and string twin ids without cross-talk', () =>
    Effect.gen(function* () {
      type ProtocolService = RpcServer.Protocol['Service'];
      type Receive = Parameters<ProtocolService['run']>[0];
      type Received = Parameters<Receive>[1];
      type Sent = Parameters<ProtocolService['send']>[1];
      const ready = yield* Deferred.make<void>();
      const received: Received[] = [];
      const sent: Sent[] = [];
      let receive: Receive | undefined;
      const baseProtocol = {
        end: () => Effect.void,
        run: (handle: Receive) =>
          Effect.sync(() => {
            receive = handle;
          }).pipe(Effect.andThen(Deferred.succeed(ready, undefined)), Effect.andThen(Effect.never)),
        send: (_clientId: number, response: Sent) => Effect.sync(() => sent.push(response)),
      } as unknown as ProtocolService;
      const protocol = makeMcpCancellationCompatibleProtocol(baseProtocol);
      const fiber = yield* protocol
        .run((_clientId, request) => Effect.sync(() => received.push(request)))
        .pipe(Effect.forkChild);
      yield* Deferred.await(ready);
      const dispatch = receive as Receive;
      const numericRequest = {
        _tag: 'Request' as const,
        headers: [],
        id: 9,
        payload: {_meta: {progressToken: 'numeric-token'}},
        tag: 'tools/call',
      };
      const stringRequest = {...numericRequest, id: '9', payload: {_meta: {progressToken: 'string-token'}}};

      yield* dispatch(7, numericRequest);
      yield* dispatch(7, stringRequest);
      const normalizedNumeric = received[0];
      const normalizedString = received[1];
      expect(normalizedNumeric?._tag).toBe('Request');
      expect(normalizedString?._tag).toBe('Request');
      if (normalizedNumeric?._tag !== 'Request' || normalizedString?._tag !== 'Request') return;
      expect(normalizedNumeric.id).not.toBe(normalizedString.id);

      yield* dispatch(7, {_tag: 'Ack', requestId: 9});
      yield* dispatch(7, {_tag: 'Interrupt', requestId: '9'});
      expect(received.slice(2)).toEqual([
        {_tag: 'Ack', requestId: normalizedNumeric.id},
        {_tag: 'Interrupt', requestId: normalizedString.id},
      ]);

      yield* protocol.send(7, {
        _tag: 'Chunk',
        requestId: normalizedNumeric.id,
        values: ['numeric'],
      });
      yield* dispatch(7, {
        _tag: 'Request',
        headers: [],
        id: '',
        payload: {requestId: 9},
        tag: 'notifications/cancelled',
      });
      const numericProgress = {
        _tag: 'Request',
        headers: [],
        id: 0,
        payload: {progressToken: 'numeric-token'},
        tag: 'notifications/progress',
      } as unknown as Sent;
      const stringProgress = {
        ...numericProgress,
        payload: {progressToken: 'string-token'},
      } as unknown as Sent;
      yield* protocol.send(7, numericProgress);
      yield* protocol.send(7, stringProgress);
      yield* protocol.send(7, {
        _tag: 'Exit',
        exit: {_tag: 'Success', value: 'string'},
        requestId: normalizedString.id,
      });
      yield* protocol.send(7, {
        _tag: 'Exit',
        exit: {_tag: 'Success', value: 'numeric'},
        requestId: normalizedNumeric.id,
      });
      expect(sent).toEqual([
        {_tag: 'Chunk', requestId: 9, values: ['numeric']},
        stringProgress,
        {_tag: 'Exit', exit: {_tag: 'Success', value: 'string'}, requestId: '9'},
      ]);

      yield* Fiber.interrupt(fiber);
    }),
  );

  effectIt.effect('does not emit or register progress when the request has no token', () =>
    Effect.gen(function* () {
      const notifications: McpProgressNotificationPayload[] = [];
      const progress = makeMcpToolProgress(undefined, notification =>
        Effect.sync(() => notifications.push(notification)),
      );

      yield* progress.report({message: 'Resolving recall scope.', phase: 'recall.workspace-context'});

      expect(progress.enabled).toBe(false);
      expect(notifications).toEqual([]);
    }),
  );

  effectIt.effect('installs the request bridge once and preserves the original callTool receiver', () =>
    Effect.gen(function* () {
      const server = fakeEffectMcpServer();
      const original = server.callTool;

      expect(installCallToolProgressBridge(server)).toBe(true);
      const installed = server.callTool;
      expect(installed).not.toBe(original);
      expect(installCallToolProgressBridge(server)).toBe(true);
      expect(server.callTool).toBe(installed);
      expect(Object.getOwnPropertyDescriptor(server, 'initializedClients')).toMatchObject({
        configurable: false,
        writable: false,
      });

      const result = yield* server
        .callTool({arguments: {}, name: 'fixture'} as Parameters<EffectMcpServer['callTool']>[0])
        .pipe(Effect.provideService(McpSchema.McpServerClient, fixtureMcpServerClient(17)));

      expect(result.content).toEqual([{type: 'text', text: 'receiver-preserved'}]);
      expect(server.initializedClients.size).toBe(0);
    }),
  );

  it('leaves a frozen Effect service unchanged when the bridge cannot be installed safely', () => {
    const server = Object.freeze(fakeEffectMcpServer());
    const original = server.callTool;

    expect(installCallToolProgressBridge(server)).toBe(false);
    expect(server.callTool).toBe(original);
  });

  it('leaves a non-writable Effect service unchanged when the bridge cannot be installed safely', () => {
    const server = fakeEffectMcpServer();
    const original = server.callTool;
    Object.defineProperty(server, 'callTool', {writable: false});

    expect(installCallToolProgressBridge(server)).toBe(false);
    expect(server.callTool).toBe(original);
    expect(server.initializedClients).toEqual(new Set());
  });

  it('restores the exact callTool method when binding the stdio recipient set fails', () => {
    const target = fakeEffectMcpServer();
    const original = target.callTool;
    const server = new Proxy(target, {
      defineProperty(object, property, descriptor) {
        if (property === 'initializedClients') throw new Error('fixture rejects recipient binding');
        return Reflect.defineProperty(object, property, descriptor);
      },
      set(object, property, value) {
        return Reflect.set(object, property, value, object);
      },
    });

    expect(installCallToolProgressBridge(server)).toBe(false);
    expect(target.callTool).toBe(original);
    expect(target.initializedClients).toEqual(new Set());
  });

  it('refuses an already multi-client service without mutating either adapter property', () => {
    const server = fakeEffectMcpServer();
    const originalCallTool = server.callTool;
    const originalInitializedClients = server.initializedClients;
    originalInitializedClients.add(11);
    originalInitializedClients.add(22);

    expect(installCallToolProgressBridge(server)).toBe(false);
    expect(server.callTool).toBe(originalCallTool);
    expect(server.initializedClients).toBe(originalInitializedClients);
    expect(server.initializedClients).toEqual(new Set([11, 22]));
  });

  effectIt.effect('refuses a second client without leaking its token or mutating the routing set', () =>
    Effect.gen(function* () {
      const initializedClients = new Set([11]);
      const notifications: McpProgressNotificationPayload[] = [];
      const admitted = admitMcpProgressToken('second-client-token', 22, initializedClients);
      const progress = makeMcpToolProgress(admitted, notification =>
        Effect.sync(() => notifications.push(notification)),
      );

      yield* progress.report({message: 'Resolving recall scope.', phase: 'recall.workspace-context'});

      expect(admitted).toBeUndefined();
      expect(progress.enabled).toBe(false);
      expect(initializedClients).toEqual(new Set([11]));
      expect(notifications).toEqual([]);
    }),
  );

  it('admits only the first/current client on an empty or current-only stdio routing set', () => {
    const initializedClients = new Set<number>();

    expect(admitMcpProgressToken('first-token', 11, initializedClients)).toBe('first-token');
    expect(initializedClients).toEqual(new Set([11]));
    expect(admitMcpProgressToken('same-client-token', 11, initializedClients)).toBe('same-client-token');
    expect(admitMcpProgressToken('foreign-token', 22, initializedClients)).toBeUndefined();
    expect(initializedClients).toEqual(new Set([11]));
  });

  it('keeps an enqueued notification isolated when a foreign client appears before queue drain', () => {
    const initializedClients = new StdioSingleClientSet();
    initializedClients.add(11);
    const queued = [{progressToken: 'client-11-token'}];

    // The Effect beta.102 queue reads recipients only when it drains. The
    // stdio registry therefore has to reject a foreign add after enqueue, not
    // merely check the set before the notification is offered.
    initializedClients.add(22);
    const deliveries = queued.flatMap(notification =>
      [...initializedClients].map(clientId => ({clientId, notification})),
    );

    expect(deliveries).toEqual([{clientId: 11, notification: {progressToken: 'client-11-token'}}]);
    initializedClients.delete(11);
    initializedClients.add(22);
    expect([...initializedClients]).toEqual([]);
  });

  effectIt.effect('preserves the opaque token and emits monotonic canonical payloads', () =>
    Effect.gen(function* () {
      const notifications: McpProgressNotificationPayload[] = [];
      const progress = makeMcpToolProgress('opaque-fixture-token', notification =>
        Effect.sync(() => notifications.push(notification)),
      );

      yield* progress.report({message: 'Refreshing shared memories.', phase: 'recall.shared-sync'});
      yield* progress.report({message: 'Searching memory indexes.', phase: 'recall.semantic-retrieval'});

      expect(notifications).toEqual([
        {
          _meta: {[MCP_PROGRESS_METADATA_KEY]: {phase: 'recall.shared-sync', version: 1}},
          message: 'Refreshing shared memories.',
          progress: 1,
          progressToken: 'opaque-fixture-token',
        },
        {
          _meta: {[MCP_PROGRESS_METADATA_KEY]: {phase: 'recall.semantic-retrieval', version: 1}},
          message: 'Searching memory indexes.',
          progress: 2,
          progressToken: 'opaque-fixture-token',
        },
      ]);
    }),
  );

  effectIt.effect('runs a long phase once, heartbeats at a bounded cadence, and preserves cancellation', () =>
    Effect.gen(function* () {
      const notifications: McpProgressNotificationPayload[] = [];
      let phaseInvocations = 0;
      let phaseInterruptions = 0;
      const phaseStarted = yield* Deferred.make<void>();
      const progress = makeMcpToolProgress(42, notification => Effect.sync(() => notifications.push(notification)));
      const phase = Effect.sync(() => {
        phaseInvocations += 1;
      }).pipe(
        Effect.andThen(Deferred.succeed(phaseStarted, undefined)),
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Effect.sync(() => (phaseInterruptions += 1))),
      );
      const fiber = yield* withMcpProgressHeartbeat(
        progress,
        {message: 'Refreshing shared memories.', phase: 'recall.shared-sync'},
        phase,
        1_000,
      ).pipe(Effect.forkChild);
      yield* Deferred.await(phaseStarted);
      yield* Effect.yieldNow;

      for (let tick = 0; tick < 3; tick += 1) {
        yield* TestClock.adjust(1_000);
        for (let spin = 0; spin < 16 && notifications.length < tick + 2; spin += 1) {
          yield* Effect.yieldNow;
        }
        expect(notifications).toHaveLength(tick + 2);
        // Let the heartbeat fiber schedule its next virtual sleep before the
        // next clock adjustment; parallel test-file load can otherwise advance
        // the clock while the reporter is still completing its bounded yields.
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
      }
      expect(phaseInvocations).toBe(1);
      expect(notifications.map(notification => notification.progress)).toEqual([1, 2, 3, 4]);

      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      const notificationCount = notifications.length;
      yield* TestClock.adjust(10_000);

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(phaseInterruptions).toBe(1);
      expect(notifications).toHaveLength(notificationCount);
    }),
  );

  effectIt.effect('re-fails cancellation while a progress notification is being sent', () =>
    Effect.gen(function* () {
      const progress = makeMcpToolProgress('blocked-token', () => Effect.never);
      const fiber = yield* progress
        .report({message: 'Searching memory indexes.', phase: 'recall.semantic-retrieval'})
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }),
  );

  effectIt.effect('keeps tool work alive when the client rejects an optional progress notification', () =>
    Effect.gen(function* () {
      let phaseInvocations = 0;
      const progress = makeMcpToolProgress('disconnected-token', () =>
        Effect.fail(new Error('/private/progress-transport-fixture')),
      );

      const result = yield* withMcpProgressHeartbeat(
        progress,
        {message: 'Searching memory indexes.', phase: 'recall.semantic-retrieval'},
        Effect.sync(() => {
          phaseInvocations += 1;
          return 'completed';
        }),
      );

      expect(result).toBe('completed');
      expect(phaseInvocations).toBe(1);
    }),
  );

  it('bounds arbitrary progress fields while preserving any valid opaque token', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.double({noDefaultInfinity: true, noNaN: true})),
        fc.string(),
        fc.string(),
        fc.integer(),
        (token, message, phase, sequence) => {
          const notification = mcpProgressNotification(token, sequence, {
            message,
            phase,
          });
          const metadata = notification._meta[MCP_PROGRESS_METADATA_KEY];

          expect(notification.progressToken).toBe(token);
          expect(notification.progress).toBe(Number.isSafeInteger(sequence) && sequence > 0 ? sequence : 1);
          expect(new TextEncoder().encode(notification.message).byteLength).toBeLessThanOrEqual(
            MCP_PROGRESS_MESSAGE_MAX_BYTES,
          );
          expect(
            [...notification.message].some(character => {
              const codePoint = character.codePointAt(0) ?? 0;
              return codePoint <= 31 || codePoint === 127;
            }),
          ).toBe(false);
          expect(metadata.phase.length).toBeLessThanOrEqual(64);
          expect(metadata.phase).toMatch(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u);
          expect(metadata).not.toHaveProperty('retryAfterMilliseconds');
        },
      ),
      {numRuns: 100},
    );
  });

  effectIt.effect('keeps 128 concurrent progress streams token-local', () =>
    Effect.gen(function* () {
      const notifications: McpProgressNotificationPayload[] = [];
      yield* Effect.all(
        Array.from({length: 128}, (_, index) => {
          const progress = makeMcpToolProgress(`token-${index}`, notification =>
            Effect.sync(() => notifications.push(notification)),
          );
          return progress
            .report({message: 'Resolving recall scope.', phase: 'recall.workspace-context'})
            .pipe(Effect.andThen(progress.report({message: 'Preparing recall results.', phase: 'recall.finalizing'})));
        }),
        {concurrency: 'unbounded'},
      );

      expect(notifications).toHaveLength(256);
      for (let index = 0; index < 128; index += 1) {
        expect(
          notifications
            .filter(notification => notification.progressToken === `token-${index}`)
            .map(notification => notification.progress),
        ).toEqual([1, 2]);
      }
    }),
  );
});

function fakeEffectMcpServer(): EffectMcpServer {
  const server = {
    initializedClients: new Set<number>(),
    marker: 'receiver-preserved',
    notifications: {'notifications/progress': () => Effect.void},
    callTool(this: {readonly marker: string}) {
      return Effect.succeed(new McpSchema.CallToolResult({content: [{type: 'text', text: this.marker}]}));
    },
  };
  return server as unknown as EffectMcpServer;
}

function fixtureMcpServerClient(clientId: number): McpSchema.McpServerClient['Service'] {
  return McpSchema.McpServerClient.of({
    clientId,
    getClient: Effect.never as McpSchema.McpServerClient['Service']['getClient'],
    initializePayload: {} as McpSchema.McpServerClient['Service']['initializePayload'],
  });
}
