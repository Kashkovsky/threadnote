import {it as effectIt} from '@effect/vitest';
import {Cause, Effect, Exit, Fiber} from 'effect';
import {McpSchema} from 'effect/unstable/ai';
import {describe, expect, it, vi} from 'vitest';
import {
  MCP_RESOURCE_ERROR_DATA,
  makeInitializeInstructionsTransform,
  mcpResourceFailureResult,
  mcpToolFailureResult,
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
