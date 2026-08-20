import {describe, expect, it} from 'vitest';
import {
  dirtyOverlayAmplificationEvidence,
  dirtyOverlayChangedSource,
  parseDirtyOverlayBenchmarkArguments,
} from '../../scripts/benchmark-code-graph-dirty-overlay.js';
import {generatedStaticReexportControlStatement} from '../../scripts/code-graph-fixture.js';

describe('code graph dirty-overlay benchmark evidence', () => {
  it('preserves the body-only default and opts into the static re-export case', () => {
    expect(parseDirtyOverlayBenchmarkArguments([])).toEqual({
      samples: 3,
      scaleSymbols: 10_000,
      scenario: 'body-only',
    });
    expect(
      parseDirtyOverlayBenchmarkArguments([
        '--scenario',
        'unchanged-static-reexport',
        '--scale-symbols',
        '101',
        '--samples',
        '1',
      ]),
    ).toEqual({samples: 1, scaleSymbols: 101, scenario: 'unchanged-static-reexport'});
  });

  it('moves only the static re-export evidence span', () => {
    const statement = generatedStaticReexportControlStatement();
    const committed = `export function value(): number { return 1; }\n${statement}\n`;

    expect(dirtyOverlayChangedSource('unchanged-static-reexport', committed)).toBe(
      `// Span-only benchmark edit; resolver input below is byte-identical.\n${committed}`,
    );
  });

  it('projects exact structural amplification without timing predicates', () => {
    expect(
      dirtyOverlayAmplificationEvidence({
        cachedFactReplayBytes: 0,
        changedFactBytes: 512,
        deltaFiles: 1,
        stagedFiles: 1,
      }),
    ).toEqual({factReplayAmplification: 0, rewriteAmplification: 1});
    expect(
      dirtyOverlayAmplificationEvidence({
        cachedFactReplayBytes: 65_536,
        changedFactBytes: 512,
        deltaFiles: 1,
        stagedFiles: 102,
      }),
    ).toEqual({factReplayAmplification: 128, rewriteAmplification: 102});
  });
});
