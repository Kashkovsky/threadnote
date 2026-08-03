import {Option} from 'effect';
import {describe, expect, it} from 'vitest';
import {parseLexicalProductionBenchmarkArguments} from '../../scripts/benchmark-code-graph-lexical-production-arguments.js';

describe('code graph lexical production benchmark arguments', () => {
  it('retains an explicit evidence output path', () => {
    const parsed = parseLexicalProductionBenchmarkArguments([
      '--symbols',
      '100000',
      '--allow-large',
      '--output',
      '/tmp/lexical-evidence.json',
    ]);

    expect(Option.getOrThrow(parsed.outputPath)).toBe('/tmp/lexical-evidence.json');
  });

  it('rejects a missing evidence output path', () => {
    expect(() => parseLexicalProductionBenchmarkArguments(['--output'])).toThrow('--output requires a path');
  });
});
