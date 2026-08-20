import {provideTestLayer} from '../helpers/effect-layer.js';
import {BunFileSystem} from '@effect/platform-bun';
import {describe, expect, it} from '@effect/vitest';
import {Effect, FileSystem} from 'effect';

type Target = Readonly<{
  datasource: Readonly<{type: string; uid: string}>;
  expression?: string;
  metricsQueryType?: string;
  query?: string;
  queryType?: string;
  tableType?: string;
  type?: string;
}>;

type FieldOverride = Readonly<{
  matcher: Readonly<{id: string; options: string}>;
  properties: ReadonlyArray<Readonly<{id: string; value: unknown}>>;
}>;

type Transformation = Readonly<{
  id: string;
  options: Readonly<{
    regex?: string;
    renamePattern?: string;
    [key: string]: unknown;
  }>;
}>;

type Panel = Readonly<{
  datasource: Readonly<{type: string; uid: string}>;
  description?: string;
  fieldConfig: Readonly<{
    overrides: ReadonlyArray<FieldOverride>;
  }>;
  id: number;
  targets: ReadonlyArray<Target>;
  title: string;
  transformations?: ReadonlyArray<Transformation>;
  type: string;
}>;

type Dashboard = Readonly<{
  __inputs: ReadonlyArray<Readonly<{name: string; pluginId: string; type: string}>>;
  panels: ReadonlyArray<Panel>;
  schemaVersion: number;
  uid: string;
}>;

const basePredicates = ['resource.service.name = "threadnote"', 'span:name = "threadnote.anonymous-diagnostic"'];

const graphLifecyclePredicates = [
  '(resource.threadnote.telemetry.schema_version = 2 || resource.threadnote.telemetry.schema_version = 3)',
  'span.threadnote.event = "lifecycle"',
  'span.threadnote.operation = "graph-build"',
  'span.threadnote.outcome = "success"',
];

const genericSchemaPredicate =
  '(resource.threadnote.telemetry.schema_version = 1 || resource.threadnote.telemetry.schema_version = 2 || resource.threadnote.telemetry.schema_version = 3)';
const querySchemaPredicate = 'resource.threadnote.telemetry.schema_version = 3';
const syntheticCanaryExclusion = 'resource.service.version != "0.0.0-canary"';

const tempoQueryLengthLimit = 1024;
const inefficientGraphBuildPredicate = 'span.threadnote.graph.efficiency_class =~ "(small|high|critical).*full"';

const terminalGraphAttributes = [
  'threadnote.graph.build_kind',
  'threadnote.graph.materialization_mode',
  'threadnote.graph.fallback_reason',
  'threadnote.graph.resolution_closure',
  'threadnote.graph.efficiency_class',
  'threadnote.graph.changed_files_bucket',
  'threadnote.graph.deleted_files_bucket',
  'threadnote.graph.delta_files_bucket',
  'threadnote.graph.extracted_files_bucket',
  'threadnote.graph.reused_files_bucket',
  'threadnote.graph.staged_files_bucket',
  'threadnote.graph.total_files_bucket',
  'threadnote.graph.cached_fact_replay_bytes_bucket',
  'threadnote.graph.changed_fact_bytes_bucket',
  'threadnote.graph.final_fact_bytes_bucket',
  'threadnote.graph.rewrite_amplification_bucket',
  'threadnote.graph.fact_replay_amplification_bucket',
] as const;

const metricRenames = new Map<number, Readonly<{raw: string; rendered: string}>>([
  [
    1,
    {
      raw: '{span.threadnote.component="cli", span.threadnote.outcome="failure"}',
      rendered: 'cli: failure',
    },
  ],
  [
    3,
    {
      raw: '{span.threadnote.operation="graph.index", span.threadnote.outcome="success"}',
      rendered: 'graph.index: success',
    },
  ],
  [
    4,
    {
      raw: '{span.threadnote.operation="graph.index", span.threadnote.outcome="failure"}',
      rendered: 'graph.index: failure',
    },
  ],
  [
    5,
    {
      raw: '{p=0.95, span.threadnote.operation="graph.index"}',
      rendered: 'graph.index: p0.95',
    },
  ],
  [
    6,
    {
      raw: '{p=0.95, span.threadnote.phase="graph.resolving"}',
      rendered: 'graph.resolving: p0.95',
    },
  ],
  [
    7,
    {
      raw: '{span.threadnote.phase="recall.shared-sync", span.threadnote.phase.outcome="success"}',
      rendered: 'recall.shared-sync: success',
    },
  ],
  [
    21,
    {
      raw: '{p=0.95, span.threadnote.graph.request_kind="inspect.query"}',
      rendered: 'inspect.query: p0.95',
    },
  ],
  [
    22,
    {
      raw: '{p=0.95, span.threadnote.graph.request_kind="inspect.query", span.threadnote.phase="graph.query.execute"}',
      rendered: 'inspect.query / graph.query.execute: p0.95',
    },
  ],
  [
    23,
    {
      raw: '{p=0.95, span.threadnote.graph.request_kind="inspect.query", span.threadnote.graph.snapshot_files_bucket="2^12"}',
      rendered: 'inspect.query / files 2^12: p0.95',
    },
  ],
  [
    24,
    {
      raw: '{span.threadnote.graph.snapshot_selection="active", span.threadnote.graph.snapshot_freshness="current"}',
      rendered: 'active: current',
    },
  ],
]);

describe('Threadnote Grafana dashboard', () => {
  it.effect('is reusable, privacy-scoped, and aligned with the gateway allowlist', () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const dashboard = JSON.parse(
        yield* fileSystem.readFileString(
          `${process.cwd()}/infra/telemetry-gateway/threadnote-anonymous-telemetry-dashboard.json`,
        ),
      ) as Dashboard;
      const collector = yield* fileSystem.readFileString(`${process.cwd()}/infra/telemetry-gateway/collector.yaml`);
      const panels = dashboard.panels;
      const targets = panels.flatMap(panel => panel.targets);
      const traceTargets = targets.filter(target => target.datasource.type === 'tempo');
      const queries = traceTargets.map(target => target.query!);

      expect(dashboard.schemaVersion).toBeGreaterThanOrEqual(39);
      expect(dashboard.uid).toBe('threadnote-telemetry');
      expect(dashboard.__inputs).toEqual([
        expect.objectContaining({name: 'DS_TEMPO', pluginId: 'tempo', type: 'datasource'}),
      ]);
      expect(new Set(panels.map(panel => panel.id)).size).toBe(panels.length);
      expect(panels.length).toBeGreaterThanOrEqual(10);
      for (const panel of panels) {
        expect(panel.datasource).toEqual({type: 'tempo', uid: '${DS_TEMPO}'});
        expect(panel.targets.length).toBeGreaterThan(0);
        for (const target of panel.targets) {
          if (target.datasource.type === '__expr__') {
            expect(panel.id).toBe(13);
            expect(target.datasource.uid).toBe('__expr__');
            expect(target.type).toBe('math');
            continue;
          }
          expect(target.datasource).toEqual({type: 'tempo', uid: '${DS_TEMPO}'});
          expect(target.queryType).toBe('traceql');
        }
      }
      for (const query of queries) {
        const isGraphQueryTelemetry = query.includes('span.threadnote.graph.request_kind');
        expect(query.length).toBeLessThanOrEqual(tempoQueryLengthLimit);
        expect(query.split(syntheticCanaryExclusion)).toHaveLength(2);
        if (query.includes(inefficientGraphBuildPredicate)) {
          expect(query).toContain(basePredicates[0]);
          expect(query).toContain(graphLifecyclePredicates[0]);
          expect(query).not.toContain('resource.threadnote.telemetry.schema_version = 1');
        } else {
          for (const predicate of basePredicates) expect(query).toContain(predicate);
        }
        if (query.includes('span.threadnote.operation = "graph-build"')) {
          for (const predicate of graphLifecyclePredicates) expect(query).toContain(predicate);
          expect(query).not.toContain('resource.threadnote.telemetry.schema_version = 1');
        } else if (isGraphQueryTelemetry) {
          expect(query).toContain(querySchemaPredicate);
          expect(query).not.toContain('resource.threadnote.telemetry.schema_version = 1');
          expect(query).not.toContain('resource.threadnote.telemetry.schema_version = 2');
        } else if (!query.includes(inefficientGraphBuildPredicate)) {
          expect(query).toContain(genericSchemaPredicate);
        }
        expect(query).not.toContain('span:status');
        expect(query).not.toContain('span:duration');
        expect(query).not.toContain('trace:duration');
      }
      const combined = queries.join('\n');
      for (const attribute of [
        'resource.service.version',
        'span.threadnote.component',
        'span.threadnote.operation',
        'span.threadnote.outcome',
        'span.threadnote.duration_ms',
        'span.threadnote.phase',
        'span.threadnote.phase.outcome',
        'span.error.type',
        'span.threadnote.memory.rss.end_bucket',
        'span.threadnote.memory.heap.end_bucket',
        'span.threadnote.memory.peak_rss.end_bucket',
      ]) {
        expect(combined).toContain(attribute);
      }
      expect(combined).toContain('quantile_over_time(span.threadnote.duration_ms, .5, .95, .99)');
      expect(combined).toContain('span.threadnote.event = "checkpoint"');

      const operationDuration = panels.find(panel => panel.id === 5);
      expect(operationDuration?.type).toBe('bargauge');
      expect(operationDuration?.targets[0]?.metricsQueryType).toBe('instant');
      expect(operationDuration?.targets[0]?.query).toContain('by (span.threadnote.operation)');
      expect(operationDuration?.targets[0]?.query).not.toContain('by (span.threadnote.component)');
      expect(operationDuration?.targets[0]?.query).toContain('span.threadnote.operation != "mcp-server"');
      expect(operationDuration?.targets[0]?.query).toContain('span.threadnote.operation != "mcp-broker"');
      expect(operationDuration?.targets[0]?.query).toContain('span.threadnote.operation != "manage"');

      const phaseElapsed = panels.find(panel => panel.id === 6);
      expect(phaseElapsed?.type).toBe('bargauge');
      expect(phaseElapsed?.targets[0]?.metricsQueryType).toBe('instant');
      expect(phaseElapsed?.targets[0]?.query).toContain('by (span.threadnote.phase)');

      const queryPanels = panels.filter(panel => panel.id >= 21 && panel.id <= 24);
      expect(queryPanels.map(panel => panel.title)).toEqual([
        'Graph request duration quantiles',
        'Graph query stage quantiles',
        'Graph request latency by snapshot size',
        'Graph snapshot selection and freshness',
      ]);
      const graphRequestDuration = panels.find(panel => panel.id === 21);
      expect(graphRequestDuration?.type).toBe('bargauge');
      expect(graphRequestDuration?.targets[0]?.metricsQueryType).toBe('instant');
      expect(graphRequestDuration?.targets[0]?.query).toContain(
        'quantile_over_time(span.threadnote.duration_ms, .5, .95, .99)',
      );
      expect(graphRequestDuration?.targets[0]?.query).toContain('by (span.threadnote.graph.request_kind)');

      const graphQueryStages = panels.find(panel => panel.id === 22);
      expect(graphQueryStages?.type).toBe('bargauge');
      expect(graphQueryStages?.targets).toHaveLength(2);
      expect(graphQueryStages?.targets[0]?.metricsQueryType).toBe('instant');
      expect(graphQueryStages?.targets[0]?.query).toContain(
        'quantile_over_time(span.threadnote.phase.elapsed_ms, .5, .95)',
      );
      expect(graphQueryStages?.targets[0]?.query).toContain(
        'by (span.threadnote.graph.request_kind, span.threadnote.phase)',
      );
      expect(graphQueryStages?.targets[0]?.query).toContain('span.threadnote.phase =~ "graph.query.*"');
      expect(graphQueryStages?.targets[0]?.query).toContain('span.threadnote.stage = nil');
      expect(graphQueryStages?.targets[1]?.metricsQueryType).toBe('instant');
      expect(graphQueryStages?.targets[1]?.query).toContain('span.threadnote.stage =~ "query-.*"');
      expect(graphQueryStages?.targets[1]?.query).toContain(
        'by (span.threadnote.graph.request_kind, span.threadnote.stage, span.threadnote.subphase)',
      );

      const graphLatencyBySize = panels.find(panel => panel.id === 23);
      expect(graphLatencyBySize?.type).toBe('bargauge');
      expect(graphLatencyBySize?.targets[0]?.query).toContain(
        'by (span.threadnote.graph.request_kind, span.threadnote.graph.snapshot_files_bucket)',
      );

      const graphSnapshotCounts = panels.find(panel => panel.id === 24);
      expect(graphSnapshotCounts?.type).toBe('timeseries');
      expect(graphSnapshotCounts?.targets[0]?.metricsQueryType).toBe('range');
      expect(graphSnapshotCounts?.targets[0]?.query).toContain(
        'by (span.threadnote.graph.snapshot_selection, span.threadnote.graph.snapshot_freshness)',
      );
      const queryTelemetryText = queryPanels
        .flatMap(panel => panel.targets)
        .map(target => target.query)
        .join('\n');
      for (const attribute of [
        'span.threadnote.graph.request_kind',
        'span.threadnote.graph.snapshot_files_bucket',
        'span.threadnote.graph.snapshot_selection',
        'span.threadnote.graph.snapshot_freshness',
      ]) {
        expect(queryTelemetryText).toContain(attribute);
      }
      for (const excludedField of [
        'session.id',
        'invocation.id',
        'repository',
        'commit',
        'file_path',
        'symbol_name',
        'query_text',
      ]) {
        expect(queryTelemetryText).not.toContain(excludedField);
      }

      for (const panel of panels.filter(candidate => candidate.type !== 'table')) {
        const metricQueries = panel.targets.map(target => target.query).join('\n');
        expect(metricQueries).not.toContain('session.id');
        expect(metricQueries).not.toContain('invocation.id');
        const rename = metricRenames.get(panel.id);
        if (rename === undefined) {
          expect(panel.transformations ?? []).toEqual([]);
          continue;
        }
        const expectedTransformationCount = panel.id === 22 ? 6 : panel.type === 'bargauge' ? 4 : 1;
        expect(panel.transformations).toHaveLength(expectedTransformationCount);
        const transformation = panel.transformations?.[0];
        expect(transformation?.id).toBe('renameByRegex');
        expect(typeof transformation?.options.regex).toBe('string');
        expect(typeof transformation?.options.renamePattern).toBe('string');
        expect(
          rename.raw.replace(new RegExp(transformation!.options.regex!, 'u'), transformation!.options.renamePattern!),
        ).toBe(rename.rendered);
      }
      expect(metricRenames.size).toBe(10);
      const descendingGaugeTransforms = [
        {
          id: 'reduce',
          options: {includeTimeField: false, mode: 'seriesToRows', reducers: ['lastNotNull']},
        },
        {
          id: 'sortBy',
          options: {fields: {}, sort: [{desc: true, field: 'Last *'}]},
        },
        {
          id: 'rowsToFields',
          options: {
            mappings: [
              {fieldName: 'Field', handlerKey: 'field.name'},
              {fieldName: 'Last *', handlerKey: 'field.value'},
            ],
          },
        },
      ];
      for (const panel of [operationDuration, phaseElapsed, graphRequestDuration, graphLatencyBySize]) {
        expect(panel?.transformations?.slice(1)).toEqual(descendingGaugeTransforms);
      }
      expect(graphQueryStages?.transformations?.slice(3)).toEqual(descendingGaugeTransforms);
      const stageWithSubphaseRename = graphQueryStages?.transformations?.[1];
      expect(
        '{p=0.95, span.threadnote.graph.request_kind="inspect.query", span.threadnote.stage="query-worktree-observation", span.threadnote.subphase="skipped"}'.replace(
          new RegExp(stageWithSubphaseRename!.options.regex!, 'u'),
          stageWithSubphaseRename!.options.renamePattern!,
        ),
      ).toBe('inspect.query / query-worktree-observation / skipped: p0.95');
      const stageRename = graphQueryStages?.transformations?.[2];
      expect(
        '{p=0.95, span.threadnote.graph.request_kind="inspect.query", span.threadnote.stage="query-serialization"}'.replace(
          new RegExp(stageRename!.options.regex!, 'u'),
          stageRename!.options.renamePattern!,
        ),
      ).toBe('inspect.query / query-serialization: p0.95');
      const tables = panels.filter(panel => panel.type === 'table');
      expect(tables).not.toHaveLength(0);
      for (const panel of tables) {
        for (const target of panel.targets) {
          expect(target.query!).toContain('with (most_recent=true)');
          expect(target.tableType).toBe('spans');
        }
      }
      const recentFailures = panels.find(panel => panel.id === 12);
      expect(recentFailures?.title).toBe('Recent operational failures');
      expect(recentFailures?.targets).toHaveLength(1);
      expect(recentFailures?.targets[0]?.query).toContain('span.threadnote.outcome != "success"');
      expect(recentFailures?.targets[0]?.query).toContain('span.threadnote.outcome != "interrupted"');
      const failureTableDisplayNames = Object.fromEntries(
        (recentFailures?.fieldConfig.overrides ?? []).map(override => [
          override.matcher.options,
          override.properties.find(property => property.id === 'displayName')?.value,
        ]),
      );
      expect(failureTableDisplayNames).toEqual({
        'error.type': 'Error type',
        'service.version': 'App version',
        'session.id': 'Session',
        'threadnote.component': 'Component',
        'threadnote.duration_ms': 'Duration',
        'threadnote.failure.code': 'Failure code',
        'threadnote.failure.domain': 'Failure domain',
        'threadnote.failure.recovery': 'Recovery',
        'threadnote.invocation.id': 'Invocation',
        'threadnote.operation': 'Operation',
        'threadnote.outcome': 'Outcome',
        'threadnote.session.scope': 'Session scope',
      });

      const unexpectedFull = panels.find(panel => panel.id === 13);
      expect(unexpectedFull?.title).toBe('Unexpected full-build percentage');
      expect(unexpectedFull?.description).toContain('zero-count buckets render as 0%');
      expect(unexpectedFull?.description).toContain('datasource-wide NoData remains visible');
      expect(unexpectedFull?.targets).toHaveLength(3);
      expect(unexpectedFull?.targets[0]?.query).toContain('small-delta-full');
      expect(unexpectedFull?.targets[0]?.query).toContain('high-amplification-full');
      expect(unexpectedFull?.targets[0]?.query).toContain('critical-amplification-full');
      expect(unexpectedFull?.targets[0]?.query).toContain('span.threadnote.graph.build_kind = "dirty"');
      expect(unexpectedFull?.targets[1]?.query).toContain('span.threadnote.graph.build_kind = "dirty"');
      expect(unexpectedFull?.targets[1]?.query).not.toContain('span.threadnote.graph.efficiency_class');
      expect(unexpectedFull?.targets[2]).toEqual(
        expect.objectContaining({
          datasource: {type: '__expr__', uid: '__expr__'},
          expression: '$A / ($B + ($B == 0)) * 100',
          type: 'math',
        }),
      );
      expect(unexpectedFull?.targets[0]?.query).toContain(syntheticCanaryExclusion);
      expect(unexpectedFull?.targets[1]?.query).toContain(syntheticCanaryExclusion);

      const graphPanels = panels.filter(panel => panel.id >= 13 && panel.id <= 20);
      expect(graphPanels.map(panel => panel.title)).toEqual([
        'Unexpected full-build percentage',
        'Graph builds by app version',
        'Graph builds by mode and efficiency',
        'Full-build fallback reasons',
        'Rewrite amplification buckets',
        'Cached fact replay bytes buckets',
        'Fact replay amplification buckets',
        'Recent inefficient graph materializations',
      ]);
      const graphQueries = graphPanels
        .flatMap(panel => panel.targets)
        .filter(target => target.datasource.type === 'tempo')
        .map(target => target.query!);
      const graphQueryText = graphQueries.join('\n');
      for (const attribute of [
        'resource.service.version',
        ...terminalGraphAttributes.map(attribute => `span.${attribute}`),
      ]) {
        expect(graphQueryText).toContain(attribute);
      }
      expect(panels.find(panel => panel.id === 17)?.targets[0]?.query).toContain(
        'span.threadnote.graph.delta_files_bucket != "0"',
      );
      expect(panels.find(panel => panel.id === 18)?.targets[0]?.query).toContain(
        'span.threadnote.graph.delta_files_bucket != "0"',
      );
      expect(panels.find(panel => panel.id === 19)?.targets[0]?.query).toContain(
        'span.threadnote.graph.changed_fact_bytes_bucket != "0"',
      );
      for (const id of [17, 18, 19]) {
        expect(panels.find(panel => panel.id === id)?.targets[0]?.query).toContain(
          'span.threadnote.graph.build_kind = "dirty"',
        );
      }
      expect(graphQueryText).not.toContain('session.id');
      expect(graphQueryText).not.toContain('invocation.id');
      expect(graphQueryText).not.toContain('repository');
      expect(graphQueryText).not.toContain('commit');
      expect(graphQueryText).not.toContain('path');

      const recentInefficient = panels.find(panel => panel.id === 20);
      expect(recentInefficient?.type).toBe('table');
      expect(recentInefficient?.targets).toHaveLength(1);
      const inefficientQuery = recentInefficient?.targets[0]?.query;
      expect(inefficientQuery).toContain(inefficientGraphBuildPredicate);
      expect(inefficientQuery?.length).toBeLessThanOrEqual(tempoQueryLengthLimit);
      for (const attribute of [
        'resource.service.version',
        ...terminalGraphAttributes
          .filter(
            attribute =>
              attribute !== 'threadnote.graph.build_kind' && attribute !== 'threadnote.graph.materialization_mode',
          )
          .map(attribute => `span.${attribute}`),
        'span.threadnote.duration_ms',
      ]) {
        expect(inefficientQuery).toContain(attribute);
      }
      expect(inefficientQuery).not.toContain('span.threadnote.graph.build_kind');
      expect(inefficientQuery).not.toContain('span.threadnote.graph.materialization_mode');
      expect(inefficientQuery).not.toContain('session.id');
      expect(inefficientQuery).not.toContain('invocation.id');
      expect(inefficientQuery).toContain('with (most_recent=true)');

      const scopedAttribute = /(?:resource|span)\.([A-Za-z_][A-Za-z0-9_.]*)/gu;
      const attributes = new Set(
        queries.flatMap(query => Array.from(query.matchAll(scopedAttribute), match => match[1]!)),
      );
      expect(attributes.size).toBeGreaterThan(10);
      for (const attribute of attributes) expect(collector).toContain(`"${attribute}"`);
    }).pipe(provideTestLayer(BunFileSystem.layer)),
  );

  it.effect('keeps the production consent documentation aligned with the operated destination', () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const [commands, telemetryDocs, websiteDocs, readme, gatewayReadme, productionRunbook] = yield* Effect.all(
        [
          fileSystem.readFileString(`${process.cwd()}/src/telemetry/commands.ts`),
          fileSystem.readFileString(`${process.cwd()}/docs/telemetry.md`),
          fileSystem.readFileString(`${process.cwd()}/website/src/content/docsTelemetry.ts`),
          fileSystem.readFileString(`${process.cwd()}/README.md`),
          fileSystem.readFileString(`${process.cwd()}/infra/telemetry-gateway/README.md`),
          fileSystem.readFileString(`${process.cwd()}/docs/operations/telemetry-production.md`),
        ],
        {concurrency: 'unbounded'},
      );

      for (const source of [commands, telemetryDocs, websiteDocs]) {
        expect(source).toContain('14-day');
        expect(source).toContain('Grafana Cloud EU');
        expect(source).toMatch(/source IP|IP addresses/u);
      }
      for (const source of [commands, telemetryDocs, websiteDocs, readme]) {
        for (const lifecycleTerm of ['successful', 'failed', 'interrupt', 'outcome']) {
          expect(source.toLowerCase()).toContain(lifecycleTerm);
        }
        for (const graphTerm of [
          'build',
          'materialization',
          'fallback',
          'closure',
          'efficiency',
          'file-count',
          'fact-byte',
          'amplification',
        ]) {
          expect(source.toLowerCase()).toContain(graphTerm);
        }
        for (const excludedIdentity of ['path', 'repository', 'commit']) {
          expect(source.toLowerCase()).toContain(excludedIdentity);
        }
      }
      for (const source of [commands, telemetryDocs, websiteDocs]) expect(source).toContain('delta');
      expect(telemetryDocs).toContain('https://telemetry.threadnote.io/v1/traces');
      expect(telemetryDocs).toContain('requires consent version 3');
      expect(telemetryDocs).toContain('version 1 or version 2 opt-in fails closed');
      for (const excludedQueryDetail of ['query text', 'symbol names', 'exact file/symbol/edge counts']) {
        expect(telemetryDocs).toContain(excludedQueryDetail);
      }
      expect(gatewayReadme).toContain('Existing operation panels admit schema versions 1, 2, and 3');
      expect(gatewayReadme).toContain('Graph-build panels admit versions 2 and 3');
      expect(gatewayReadme).toContain('Graph-query panels admit version 3 only');
      expect(gatewayReadme).toContain('before sending four traces');
      expect(productionRunbook).toContain('gateway, four-trace/three-version canary, and dashboard gates');
      expect(productionRunbook).toContain('until all four stored protobufs');
      expect(productionRunbook).toContain('consent-v1/v2 configurations must fail closed');
      expect(commands).toContain('endpoint === DEFAULT_TELEMETRY_ENDPOINT');
    }).pipe(provideTestLayer(BunFileSystem.layer)),
  );
});
