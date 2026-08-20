import {describe, expect, it} from 'vitest';
import {
  dirtyOverlayAmplificationEvidence,
  dirtyOverlayChangedSource,
  dirtyOverlayReplayEvidence,
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

  it('projects the local physical replay split and rejects inconsistent benchmark evidence', () => {
    const metrics = {
      attributedFilesCompleted: 7,
      batchesCompleted: 1,
      batchesTotal: 1,
      cachedFactReplayBytesCompleted: 4_096,
      changedFactBytesCompleted: 256,
      crossGenerationShardFilesCompleted: 0,
      exactGenerationShardFilesCompleted: 5,
      materializedShardReplayBytesCompleted: 3_072,
      rawFactReplayBytesCompleted: 1_024,
      sourceBytesCompleted: 2_048,
      sourceBytesTotal: 2_048,
    };

    expect(dirtyOverlayReplayEvidence(metrics, 256)).toEqual({
      attributedFiles: 7,
      cachedFactReplayBytes: 4_096,
      changedFactBytes: 256,
      crossGenerationShardFiles: 0,
      exactGenerationShardFiles: 5,
      materializedShardReplayBytes: 3_072,
      rawFactReplayBytes: 1_024,
    });
    expect(() => dirtyOverlayReplayEvidence({...metrics, cachedFactReplayBytesCompleted: 4_095}, 256)).toThrow(
      'replay-byte split is inconsistent',
    );
    expect(() => dirtyOverlayReplayEvidence({...metrics, rawFactReplayBytesCompleted: undefined}, 256)).toThrow(
      'did not retain complete physical replay evidence',
    );
    expect(() => dirtyOverlayReplayEvidence(undefined, 0)).toThrow('did not retain complete physical replay evidence');
    expect(() => dirtyOverlayReplayEvidence(metrics, 255)).toThrow('changed-fact byte evidence is inconsistent');
  });
});
