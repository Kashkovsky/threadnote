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
const canaryExclusionPredicate = 'resource.service.version != "0.0.0-canary"';
const graphSchemaPredicate =
  '(resource.threadnote.telemetry.schema_version = 2 || resource.threadnote.telemetry.schema_version = 3)';

const graphLifecyclePredicates = [
  canaryExclusionPredicate,
  graphSchemaPredicate,
  'span.threadnote.event = "lifecycle"',
  'span.threadnote.operation = "graph-build"',
  'span.threadnote.outcome = "success"',
];

const genericSchemaPredicate =
  '(resource.threadnote.telemetry.schema_version = 1 || resource.threadnote.telemetry.schema_version = 2 || resource.threadnote.telemetry.schema_version = 3)';

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

const dashboardGraphAttributes = terminalGraphAttributes.filter(
  attribute =>
    attribute !== 'threadnote.graph.deleted_files_bucket' && attribute !== 'threadnote.graph.extracted_files_bucket',
);

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
        expect(query.length).toBeLessThanOrEqual(tempoQueryLengthLimit);
        if (query.includes(inefficientGraphBuildPredicate)) {
          expect(query).toContain(basePredicates[0]);
          expect(query).toContain(graphSchemaPredicate);
          expect(query).toContain(canaryExclusionPredicate);
          expect(query).not.toContain('resource.threadnote.telemetry.schema_version = 1');
        } else {
          for (const predicate of basePredicates) expect(query).toContain(predicate);
        }
        if (query.includes('span.threadnote.operation = "graph-build"')) {
          for (const predicate of graphLifecyclePredicates) expect(query).toContain(predicate);
          expect(query).not.toContain('resource.threadnote.telemetry.schema_version = 1');
        } else if (query.includes('span.threadnote.operation = "auto-update-worker"')) {
          expect(query).toContain('resource.threadnote.telemetry.schema_version = 3');
          expect(query).toContain(canaryExclusionPredicate);
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

      for (const panel of panels.filter(candidate => candidate.type !== 'table')) {
        const metricQueries = panel.targets.map(target => target.query).join('\n');
        expect(metricQueries).not.toContain('session.id');
        expect(metricQueries).not.toContain('invocation.id');
        const rename = metricRenames.get(panel.id);
        if (rename === undefined) {
          expect(panel.transformations ?? []).toEqual([]);
          continue;
        }
        const expectedTransformationCount = panel.type === 'bargauge' ? 4 : 1;
        expect(panel.transformations).toHaveLength(expectedTransformationCount);
        const transformation = panel.transformations?.[0];
        expect(transformation?.id).toBe('renameByRegex');
        expect(typeof transformation?.options.regex).toBe('string');
        expect(typeof transformation?.options.renamePattern).toBe('string');
        expect(
          rename.raw.replace(new RegExp(transformation!.options.regex!, 'u'), transformation!.options.renamePattern!),
        ).toBe(rename.rendered);
      }
      expect(metricRenames.size).toBe(6);
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
      for (const panel of [operationDuration, phaseElapsed]) {
        expect(panel?.transformations?.slice(1)).toEqual(descendingGaugeTransforms);
      }
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
          expression: '$A / $B * 100',
          type: 'math',
        }),
      );

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
        ...dashboardGraphAttributes.map(attribute => `span.${attribute}`),
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
      expect(graphQueries.every(query => query.includes(canaryExclusionPredicate))).toBe(true);

      const recentInefficient = panels.find(panel => panel.id === 20);
      expect(recentInefficient?.type).toBe('table');
      expect(recentInefficient?.targets).toHaveLength(1);
      const inefficientQuery = recentInefficient?.targets[0]?.query;
      expect(inefficientQuery).toContain(inefficientGraphBuildPredicate);
      expect(inefficientQuery?.length).toBeLessThanOrEqual(tempoQueryLengthLimit);
      for (const attribute of [
        'resource.service.version',
        ...dashboardGraphAttributes.map(attribute => `span.${attribute}`),
        'span.threadnote.duration_ms',
      ]) {
        expect(inefficientQuery).toContain(attribute);
      }
      expect(inefficientQuery).not.toContain('session.id');
      expect(inefficientQuery).not.toContain('invocation.id');
      expect(inefficientQuery).toContain('with (most_recent=true)');

      const automaticUpdates = panels.find(panel => panel.id === 21);
      expect(automaticUpdates?.title).toBe('Automatic update results');
      expect(automaticUpdates?.type).toBe('timeseries');
      expect(automaticUpdates?.targets).toHaveLength(1);
      expect(automaticUpdates?.transformations).toEqual([]);
      const automaticUpdateQuery = automaticUpdates?.targets[0]?.query;
      expect(automaticUpdateQuery).toContain('resource.threadnote.telemetry.schema_version = 3');
      expect(automaticUpdateQuery).toContain(canaryExclusionPredicate);
      expect(automaticUpdateQuery).toContain('span.threadnote.operation = "auto-update-worker"');
      expect(automaticUpdateQuery).toContain('span.threadnote.auto_update.result != nil');
      expect(automaticUpdateQuery).toContain(
        'by (span.threadnote.auto_update.result, span.threadnote.auto_update.repair_required)',
      );

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
      const [commands, telemetryDocs, websiteDocs, readme] = yield* Effect.all(
        [
          fileSystem.readFileString(`${process.cwd()}/src/telemetry/commands.ts`),
          fileSystem.readFileString(`${process.cwd()}/docs/telemetry.md`),
          fileSystem.readFileString(`${process.cwd()}/website/src/content/docsTelemetry.ts`),
          fileSystem.readFileString(`${process.cwd()}/README.md`),
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
      expect(commands).toContain('endpoint === DEFAULT_TELEMETRY_ENDPOINT');
    }).pipe(provideTestLayer(BunFileSystem.layer)),
  );
});
