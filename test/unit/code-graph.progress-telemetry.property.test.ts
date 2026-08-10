import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  codeGraphExtractionPlanMetrics,
  codeGraphExtractionWorkUnits,
  codeGraphSourceSizeBucket,
  retainCodeGraphSlowFileTelemetry,
  type CodeGraphSlowFileTelemetry,
} from '../../src/code_graph/progress_telemetry.js';

describe('code graph progress telemetry properties', () => {
  it('keeps source-size bucket boundaries exact', () => {
    expect(codeGraphSourceSizeBucket(0)).toBe('0-16KiB');
    expect(codeGraphSourceSizeBucket(16 * 1_024)).toBe('0-16KiB');
    expect(codeGraphSourceSizeBucket(16 * 1_024 + 1)).toBe('16-64KiB');
    expect(codeGraphSourceSizeBucket(64 * 1_024 + 1)).toBe('64-256KiB');
    expect(codeGraphSourceSizeBucket(256 * 1_024 + 1)).toBe('256KiB-1MiB');
    expect(codeGraphSourceSizeBucket(1_024 * 1_024 + 1)).toBe('>1MiB');
  });

  it('keeps class-weighted extraction work deterministic, monotone, and path-free', () => {
    fc.assert(
      fc.property(fc.integer({max: 8 * 1_024 * 1_024, min: 0}), sourceBytes => {
        const bucket = codeGraphSourceSizeBucket(sourceBytes);
        const plain = codeGraphExtractionWorkUnits(sourceBytes, 'ruby', bucket);
        const typescript = codeGraphExtractionWorkUnits(sourceBytes, 'typescript', bucket);
        const structured = codeGraphExtractionWorkUnits(sourceBytes, 'json', bucket);
        const nextBytes = Math.min(8 * 1_024 * 1_024, sourceBytes + 1);

        expect(plain).toBeLessThanOrEqual(typescript);
        expect(typescript).toBeLessThanOrEqual(structured);
        expect(
          codeGraphExtractionWorkUnits(nextBytes, 'json', codeGraphSourceSizeBucket(nextBytes)),
        ).toBeGreaterThanOrEqual(structured);
        expect(
          codeGraphExtractionPlanMetrics([
            {language: 'typescript', size: sourceBytes},
            {language: 'json', size: nextBytes},
          ]),
        ).toEqual(
          codeGraphExtractionPlanMetrics([
            {language: 'typescript', size: sourceBytes},
            {language: 'json', size: nextBytes},
          ]),
        );
      }),
      {numRuns: 64},
    );
  });

  it('retains the same bounded top-slow evidence regardless of completion order', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            durationMilliseconds: fc.integer({max: 60_000, min: 0}),
            pathHash: fc.string({
              maxLength: 64,
              minLength: 64,
              unit: fc.constantFrom(...'0123456789abcdef'),
            }),
          }),
          {maxLength: 40, minLength: 1, selector: sample => sample.pathHash},
        ),
        samples => {
          const telemetry = samples.map(sample => fixtureTelemetry(sample));
          const forward = telemetry.reduce(
            (current, sample) => retainCodeGraphSlowFileTelemetry(current, sample),
            [] as readonly CodeGraphSlowFileTelemetry[],
          );
          const reverse = [...telemetry]
            .reverse()
            .reduce(
              (current, sample) => retainCodeGraphSlowFileTelemetry(current, sample),
              [] as readonly CodeGraphSlowFileTelemetry[],
            );

          expect(forward).toEqual(reverse);
          expect(forward.length).toBeLessThanOrEqual(10);
          expect(forward[0]?.durationMilliseconds).toBe(
            Math.max(...telemetry.map(sample => sample.durationMilliseconds)),
          );
          expect(
            forward.every(
              (sample, index) => index === 0 || sample.durationMilliseconds <= forward[index - 1]!.durationMilliseconds,
            ),
          ).toBe(true);
        },
      ),
      {numRuns: 64},
    );
  });
});

function fixtureTelemetry(
  sample: Pick<CodeGraphSlowFileTelemetry, 'durationMilliseconds' | 'pathHash'>,
): CodeGraphSlowFileTelemetry {
  return {
    classifier: 'typescript',
    durationMilliseconds: sample.durationMilliseconds,
    extension: '.ts',
    language: 'typescript',
    pathHash: sample.pathHash,
    role: 'source',
    sizeBucket: '0-16KiB',
    sourceBytes: 1_024,
  };
}
