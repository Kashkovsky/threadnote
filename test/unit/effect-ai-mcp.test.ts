import {describe, expect, it, vi} from 'vitest';
import {makeInitializeInstructionsTransform} from '../../src/effect/ai/mcp.js';

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
});
