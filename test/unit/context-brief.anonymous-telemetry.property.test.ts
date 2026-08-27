import {it as effectIt} from '@effect/vitest';
import fc from 'fast-check';
import {Cause, Effect, Exit, Tracer} from 'effect';
import {describe, expect, it} from 'vitest';
import {
  compileContextBriefWith,
  instrumentContextBriefCompilerDependencies,
  projectContextBrief,
  summarizeContextBriefCitationTelemetry,
  type ContextBriefCitationValidationReasonV2,
  type ContextBriefMemoryCandidateV1,
} from '../../src/context_brief/index.js';
import {anonymousTelemetryTestLayer, withAnonymousTelemetry} from '../../src/effect/telemetry.js';
import type {SystemInfoShape} from '../../src/effect/system.js';
import type {MemoryCodeCitationV1} from '../../src/memory_code_citation.js';
import {
  contextBriefCitationTelemetryFields,
  contextBriefTelemetryQuantityBucket,
  makeContextBriefAnonymousTelemetryReporter,
  type ContextBriefCitationTelemetrySummary,
} from '../../src/telemetry/context_brief.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestError} from '../helpers/test-error.js';

describe('Context Brief anonymous telemetry', () => {
  it('uses monotone power-of-two buckets and rejects invalid exact counts', () => {
    fc.assert(
      fc.property(
        fc.integer({max: Number.MAX_SAFE_INTEGER, min: 0}),
        fc.integer({max: Number.MAX_SAFE_INTEGER, min: 0}),
        (first, second) => {
          const lower = Math.min(first, second);
          const upper = Math.max(first, second);
          expect(bucketOrdinal(contextBriefTelemetryQuantityBucket(lower))).toBeLessThanOrEqual(
            bucketOrdinal(contextBriefTelemetryQuantityBucket(upper)),
          );
        },
      ),
      {numRuns: 100},
    );
    expect(contextBriefTelemetryQuantityBucket(0)).toBe('0');
    expect(contextBriefTelemetryQuantityBucket(1)).toBe('2^0');
    expect(contextBriefTelemetryQuantityBucket(7)).toBe('2^2');
    expect(contextBriefTelemetryQuantityBucket(8)).toBe('2^3');
    expect(contextBriefTelemetryQuantityBucket(-1)).toBeUndefined();
    expect(contextBriefTelemetryQuantityBucket(1.5)).toBeUndefined();
    expect(contextBriefTelemetryQuantityBucket(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it('derives the closed result from status counts and projects no private values or exact counts', () => {
    fc.assert(
      fc.property(
        fc.string().map(value => `private-path:${value}`),
        fc.string().map(value => `private-memory:${value}`),
        fc.string().map(value => `private-repository:${value}`),
        (path, memory, repository) => {
          const fields = contextBriefCitationTelemetryFields('workset', {
            cacheHits: 5,
            citations: 8,
            citedMemories: 4,
            coverage: 'partial',
            exactCitations: 4,
            memory,
            path,
            relocatedCitations: 2,
            repositoriesValidated: 3,
            repository,
            staleCitations: 1,
            unknownCitations: 1,
            unknownReason: 'mixed',
          } as ContextBriefCitationTelemetrySummary);

          expect(fields).toEqual({
            contextBriefCacheHitsBucket: '2^2',
            contextBriefCitationCoverage: 'partial',
            contextBriefCitationResult: 'mixed',
            contextBriefCitationUnknownReason: 'mixed',
            contextBriefCitationsBucket: '2^3',
            contextBriefCitedMemoriesBucket: '2^2',
            contextBriefExactCitationsBucket: '2^2',
            contextBriefRelocatedCitationsBucket: '2^1',
            contextBriefRepositoriesValidatedBucket: '2^1',
            contextBriefScope: 'workset',
            contextBriefStaleCitationsBucket: '2^0',
            contextBriefUnknownCitationsBucket: '2^0',
          });
          const serialized = JSON.stringify(fields);
          expect(serialized).not.toContain(path);
          expect(serialized).not.toContain(memory);
          expect(serialized).not.toContain(repository);
          for (const exactCount of [3, 5, 8]) expect(Object.values(fields ?? {})).not.toContain(exactCount);
        },
      ),
      {numRuns: 100},
    );
  });

  it.each([
    {exactCitations: 0, relocatedCitations: 0, result: 'none', staleCitations: 0, unknownCitations: 0},
    {exactCitations: 8, relocatedCitations: 0, result: 'exact-only', staleCitations: 0, unknownCitations: 0},
    {exactCitations: 6, relocatedCitations: 2, result: 'relocated', staleCitations: 0, unknownCitations: 0},
    {exactCitations: 6, relocatedCitations: 0, result: 'stale', staleCitations: 2, unknownCitations: 0},
    {exactCitations: 6, relocatedCitations: 0, result: 'unknown', staleCitations: 0, unknownCitations: 2},
    {exactCitations: 4, relocatedCitations: 0, result: 'mixed', staleCitations: 2, unknownCitations: 2},
  ])('derives $result without accepting a caller-provided result', example => {
    const citations =
      example.exactCitations + example.relocatedCitations + example.staleCitations + example.unknownCitations;
    const fields = contextBriefCitationTelemetryFields('local', {
      cacheHits: 0,
      citations,
      citedMemories: citations === 0 ? 0 : 2,
      coverage:
        citations === 0
          ? 'none'
          : example.unknownCitations === 0
            ? 'complete'
            : example.unknownCitations === citations
              ? 'unavailable'
              : 'partial',
      exactCitations: example.exactCitations,
      relocatedCitations: example.relocatedCitations,
      repositoriesValidated: citations === 0 ? 0 : 1,
      staleCitations: example.staleCitations,
      unknownCitations: example.unknownCitations,
      ...(example.unknownCitations === 0 ? {} : {unknownReason: 'unsupported' as const}),
    });
    expect(fields?.contextBriefCitationResult).toBe(example.result);
  });

  it('abstains on inconsistent summaries instead of exporting a partial quality surface', () => {
    const baseline = summary();
    for (const invalid of [
      {...baseline, citations: -1},
      {...baseline, citations: 1.5},
      {...baseline, citations: Number.MAX_SAFE_INTEGER + 1},
      {...baseline, citedMemories: baseline.citations + 1},
      {...baseline, cacheHits: baseline.citations + 1},
      {...baseline, repositoriesValidated: baseline.citations + 1},
      {...baseline, exactCitations: baseline.exactCitations - 1},
      {...baseline, coverage: 'none' as const},
      {...baseline, coverage: 'complete' as const},
      {...baseline, unknownCitations: 0},
      {...baseline, unknownReason: undefined},
      {...baseline, coverage: 'unavailable' as const, exactCitations: 4, unknownCitations: 4},
    ]) {
      expect(contextBriefCitationTelemetryFields('local', invalid)).toBeUndefined();
    }
  });

  it('projects uncited legacy memories as an empty, fully bounded telemetry surface', () => {
    expect(summarizeContextBriefCitationTelemetry([candidate('legacy')], [])).toEqual({
      cacheHits: 0,
      citations: 0,
      citedMemories: 0,
      coverage: 'none',
      exactCitations: 0,
      relocatedCitations: 0,
      repositoriesValidated: 0,
      staleCitations: 0,
      unknownCitations: 0,
    });
  });

  it('treats missing receipts and malformed citations as unavailable with closed reasons', () => {
    const missing = citation('1');
    expect(summarizeContextBriefCitationTelemetry([candidate('missing', [missing])], [])).toMatchObject({
      citations: 1,
      citedMemories: 1,
      coverage: 'unavailable',
      unknownCitations: 1,
      unknownReason: 'repository-unavailable',
    });
    expect(
      summarizeContextBriefCitationTelemetry([{...candidate('malformed'), citationErrorCount: 2}], []),
    ).toMatchObject({
      citations: 2,
      citedMemories: 1,
      coverage: 'unavailable',
      unknownCitations: 2,
      unknownReason: 'invalid-citation',
    });
    expect(
      summarizeContextBriefCitationTelemetry([{...candidate('mixed', [citation('2')]), citationErrorCount: 1}], []),
    ).toMatchObject({coverage: 'unavailable', unknownReason: 'mixed'});
  });

  it.each([
    ['ambiguous-relocation', 'ambiguous-relocation'],
    ['citation-limit', 'budget-exhausted'],
    ['extractor-mismatch', 'unsupported'],
    ['graph-incomplete', 'snapshot-unavailable'],
    ['graph-stale', 'snapshot-not-current'],
    ['malformed-citation', 'invalid-citation'],
    ['repository-ambiguous', 'repository-unavailable'],
    ['repository-unavailable', 'repository-unavailable'],
    ['validation-error', 'store-failure'],
  ] as const)('maps private receipt reason %s to closed reason %s', (reason, expected) => {
    const cited = citation('3');
    const projected = summarizeContextBriefCitationTelemetry(
      [candidate('reason', [cited])],
      [
        {
          receipts: [unknownReceipt(cited.id, reason)],
          uri: candidateUri('reason'),
        },
      ],
    );
    expect(projected).toMatchObject({
      coverage: 'unavailable',
      unknownCitations: 1,
      unknownReason: expected,
    });
  });

  it('clamps cache hits and counts only distinct repositories observed through receipts', () => {
    const citations = [citation('4'), citation('5'), citation('6')];
    expect(
      summarizeContextBriefCitationTelemetry(
        [candidate('cached', citations)],
        [
          {
            cacheHits: 99,
            receipts: [
              receipt(citations[0]!.id, 'exact', 'exact', 'repository-a'),
              receipt(citations[1]!.id, 'relocated', 'relocated', 'repository-a'),
              receipt(citations[2]!.id, 'changed', 'source-changed', 'repository-b'),
            ],
            uri: candidateUri('cached'),
          },
        ],
      ),
    ).toEqual({
      cacheHits: 3,
      citations: 3,
      citedMemories: 1,
      coverage: 'complete',
      exactCitations: 1,
      relocatedCitations: 1,
      repositoriesValidated: 2,
      staleCitations: 1,
      unknownCitations: 0,
    });
  });

  effectIt.effect('emits four closed phase checkpoints and one complete successful terminal sample', () => {
    const capture = capturingTracer();
    const reporter = makeContextBriefAnonymousTelemetryReporter('workset');

    return Effect.gen(function* () {
      const result = yield* withAnonymousTelemetry(
        {component: 'mcp', operation: 'context_brief'},
        Effect.gen(function* () {
          yield* reporter.annotate;
          yield* reporter.graph(Effect.void);
          yield* reporter.memory(Effect.void);
          yield* reporter.citationValidation(Effect.succeed('validated'), summary());
          return yield* reporter.projection(Effect.succeed('brief'), true);
        }),
      );

      expect(result).toBe('brief');
      expect(capture.spans).toHaveLength(5);
      expect(capture.spans.slice(0, 4).map(span => spanAttributes(span)['threadnote.phase'])).toEqual([
        'context.brief.graph',
        'context.brief.memory',
        'context.brief.citation-validation',
        'context.brief.projection',
      ]);
      const citation = spanAttributes(capture.spans[2]!);
      expect(citation).toMatchObject({
        'threadnote.context_brief.citation_coverage': 'partial',
        'threadnote.context_brief.citation_result': 'unknown',
        'threadnote.context_brief.citation_unknown_reason': 'unsupported',
        'threadnote.context_brief.citations_bucket': '2^3',
        'threadnote.context_brief.scope': 'workset',
        'threadnote.event': 'checkpoint',
        'threadnote.phase.outcome': 'success',
      });
      expect(citation).not.toHaveProperty('threadnote.context_brief.output_truncated');
      const projection = spanAttributes(capture.spans[3]!);
      expect(projection).toMatchObject({
        'threadnote.context_brief.output_truncated': true,
        'threadnote.context_brief.scope': 'workset',
        'threadnote.phase': 'context.brief.projection',
      });
      expect(projection).not.toHaveProperty('threadnote.context_brief.citation_result');
      const completion = spanAttributes(capture.spans[4]!);
      expect(completion).toMatchObject({
        'threadnote.context_brief.cache_hits_bucket': '2^1',
        'threadnote.context_brief.citation_coverage': 'partial',
        'threadnote.context_brief.citation_result': 'unknown',
        'threadnote.context_brief.citation_unknown_reason': 'unsupported',
        'threadnote.context_brief.citations_bucket': '2^3',
        'threadnote.context_brief.output_truncated': true,
        'threadnote.context_brief.scope': 'workset',
        'threadnote.event': 'completion',
        'threadnote.outcome': 'success',
        'threadnote.phase': 'context.brief.projection',
      });
    }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})));
  });

  effectIt.effect('preserves failures and strips successful citation results from a failed terminal envelope', () => {
    const capture = capturingTracer();
    const reporter = makeContextBriefAnonymousTelemetryReporter('local');
    const original = new TestError('private projection failure at /private/repository');

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        withAnonymousTelemetry(
          {component: 'mcp', operation: 'context_brief'},
          Effect.gen(function* () {
            yield* reporter.annotate;
            yield* reporter.citationValidation(Effect.succeed('validated'), summary());
            return yield* reporter.projection(Effect.fail(original), false);
          }),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(original);
      expect(capture.spans).toHaveLength(3);
      const failedProjection = spanAttributes(capture.spans[1]!);
      const completion = spanAttributes(capture.spans[2]!);
      expect(failedProjection).toMatchObject({
        'threadnote.context_brief.scope': 'local',
        'threadnote.outcome': 'failure',
        'threadnote.phase': 'context.brief.projection',
      });
      expect(completion).toMatchObject({
        'threadnote.context_brief.scope': 'local',
        'threadnote.outcome': 'failure',
      });
      expect(completion).not.toHaveProperty('threadnote.phase');
      for (const attributes of [failedProjection, completion]) {
        for (const key of Object.keys(attributes)) {
          expect(key).not.toMatch(/^threadnote\.context_brief\.(?:citation_|.*_bucket|output_truncated)/u);
        }
      }
      expect(JSON.stringify(capture.spans.map(spanAttributes))).not.toContain('/private/repository');
    }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})));
  });

  effectIt.effect(
    'downgrades invalid result selectors without breaking the application or retaining partial fields',
    () => {
      const capture = capturingTracer();
      const reporter = makeContextBriefAnonymousTelemetryReporter('local');

      return Effect.gen(function* () {
        const result = yield* withAnonymousTelemetry(
          {component: 'mcp', operation: 'context_brief'},
          Effect.gen(function* () {
            yield* reporter.annotate;
            yield* reporter.citationValidation(Effect.succeed('validated'), {...summary(), citations: -1});
            return yield* reporter.projection(Effect.succeed('brief'), true);
          }),
        );

        expect(result).toBe('brief');
        expect(capture.spans).toHaveLength(3);
        expect(spanAttributes(capture.spans[0]!)).toMatchObject({
          'threadnote.context_brief.scope': 'local',
          'threadnote.phase': 'context.brief.citation-validation',
          'threadnote.phase.outcome': 'unavailable',
        });
        expect(spanAttributes(capture.spans[1]!)).toMatchObject({
          'threadnote.context_brief.output_truncated': true,
          'threadnote.phase': 'context.brief.projection',
          'threadnote.phase.outcome': 'success',
        });
        const completion = spanAttributes(capture.spans[2]!);
        expect(completion).toMatchObject({
          'threadnote.context_brief.scope': 'local',
          'threadnote.event': 'completion',
          'threadnote.outcome': 'success',
        });
        expect(completion).not.toHaveProperty('threadnote.phase');
        for (const key of Object.keys(completion)) {
          expect(key).not.toMatch(/^threadnote\.context_brief\.(?:citation_|.*_bucket|output_truncated)/u);
        }
      }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})));
    },
  );

  effectIt.effect('records raw source failures before the compiler returns a successful fail-soft brief', () => {
    const capture = capturingTracer();
    const reporter = makeContextBriefAnonymousTelemetryReporter('local');
    const privateFailure = new TestError('private source failure at /private/repository');

    return Effect.gen(function* () {
      const result = yield* withAnonymousTelemetry(
        {component: 'mcp', operation: 'context_brief'},
        Effect.gen(function* () {
          yield* reporter.annotate;
          return yield* compileContextBriefWith(
            instrumentContextBriefCompilerDependencies(
              reporter,
              {
                citationValidation: () => Effect.fail(privateFailure),
                graphEvidence: () => Effect.fail(privateFailure),
                memoryEvidence: () => Effect.fail(privateFailure),
                projection: (logical, maximumEstimatedTokens) =>
                  Effect.sync(() => projectContextBrief(logical, maximumEstimatedTokens)),
              },
              1,
            ),
            {
              budgetTokens: 1_250,
              mode: 'brief',
              scope: {callerCwd: '/workspace/threadnote', kind: 'repository', project: 'threadnote'},
              task: 'Compile a bounded brief while evidence sources are unavailable.',
            },
          );
        }),
      );

      expect(result.structuredContent.coverage.gaps).toEqual(
        expect.arrayContaining(['graph-query-unavailable', 'memory-recall-unavailable']),
      );
      const attributes = capture.spans.map(spanAttributes);
      for (const phase of ['context.brief.graph', 'context.brief.memory', 'context.brief.citation-validation']) {
        expect(attributes.find(item => item['threadnote.phase'] === phase)).toMatchObject({
          'threadnote.context_brief.scope': 'local',
          'threadnote.outcome': 'failure',
          'threadnote.phase': phase,
        });
      }
      expect(attributes.find(item => item['threadnote.phase'] === 'context.brief.projection')).toMatchObject({
        'threadnote.outcome': 'success',
        'threadnote.phase.outcome': 'success',
      });
      expect(attributes.find(item => item['threadnote.event'] === 'completion')).toMatchObject({
        'threadnote.outcome': 'success',
      });
      expect(JSON.stringify(attributes)).not.toContain('/private/repository');
    }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})));
  });
});

function summary(): ContextBriefCitationTelemetrySummary {
  return {
    cacheHits: 3,
    citations: 8,
    citedMemories: 4,
    coverage: 'partial',
    exactCitations: 6,
    relocatedCitations: 0,
    repositoriesValidated: 2,
    staleCitations: 0,
    unknownCitations: 2,
    unknownReason: 'unsupported',
  };
}

function candidateUri(name: string): string {
  return `threadnote://user/test/memories/durable/projects/threadnote/${name}.md`;
}

function candidate(name: string, codeCitations: readonly MemoryCodeCitationV1[] = []): ContextBriefMemoryCandidateV1 {
  return {
    citationErrorCount: 0,
    codeCitations,
    excerpt: 'Bounded test evidence.',
    kind: 'durable',
    rank: 0,
    uri: candidateUri(name),
  };
}

function citation(suffix: string): MemoryCodeCitationV1 {
  return {
    extractorSet: 'test',
    fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
    id: `tncc_${suffix.repeat(40)}`,
    path: 'src/private.ts',
    repositoryId: 'b'.repeat(64),
    repositoryIdentityKind: 'local',
    sourceCommit: 'c'.repeat(40),
    sourceDirty: false,
    sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
    target: {kind: 'file'},
    version: 1,
  };
}

function receipt(
  citationId: string,
  status: 'changed' | 'exact' | 'relocated',
  reason: 'exact' | 'relocated' | 'source-changed',
  repositoryId: string,
) {
  return {
    candidateCount: 1,
    citationId,
    coverage: 'current-complete' as const,
    kind: 'file' as const,
    observedAt: '2026-08-26T00:00:00.000Z',
    reason,
    repositoryId,
    snapshotId: `cgsn_${'e'.repeat(40)}`,
    status,
    strategy: 'file-path' as const,
    validatorVersion: 1 as const,
  };
}

function unknownReceipt(citationId: string, reason: ContextBriefCitationValidationReasonV2) {
  return {
    candidateCount: 0,
    citationId,
    coverage: 'incomplete' as const,
    kind: 'file' as const,
    observedAt: '2026-08-26T00:00:00.000Z',
    reason,
    status: 'unknown' as const,
    strategy: 'none' as const,
    validatorVersion: 1 as const,
  };
}

function bucketOrdinal(value: string | undefined): number {
  if (value === undefined) return Number.POSITIVE_INFINITY;
  return value === '0' ? -1 : Number(value.slice(2));
}

interface CapturedSpan {
  readonly span: Tracer.NativeSpan;
}

function capturingTracer(): {readonly spans: CapturedSpan[]; readonly tracer: Tracer.Tracer} {
  const spans: CapturedSpan[] = [];
  return {
    spans,
    tracer: Tracer.make({
      span(options) {
        return new (class extends Tracer.NativeSpan {
          override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
            super.end(endTime, exit);
            spans.push({span: this});
          }
        })(options);
      },
    }),
  };
}

function spanAttributes(captured: CapturedSpan): Record<string, unknown> {
  return Object.fromEntries(captured.span.attributes);
}

function systemInfoStub(): SystemInfoShape {
  return {
    architecture: 'arm64',
    availableDiskBytes: () => Effect.succeed(undefined),
    currentDirectory: () => '/',
    environment: () => ({}),
    executablePath: '/opt/threadnote/bin/threadnote',
    hardwareInfo: Effect.succeed({
      cpuModel: 'test',
      effectiveMemoryBytes: 1,
      memoryBytes: 1,
      operatingSystem: 'test',
    }),
    homeDirectory: '/home/test',
    isProcessRunning: () => false,
    memoryUsage: () => ({external: 0, heapUsed: 0, peakRss: 0, rss: 0}),
    pathDelimiter: ':',
    platform: 'darwin',
    processArguments: ['/opt/threadnote/bin/threadnote'],
    processId: 1,
    processStartIdentity: () => Effect.succeed(undefined),
    readLine: () => () => undefined,
    runtimeVersion: 'test',
    setEnvironmentVariable: () => undefined,
    setExitCode: () => undefined,
    signalProcess: () => undefined,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    tempDirectory: '/tmp',
    userName: 'test',
  };
}
