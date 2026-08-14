import {provideTestLayer} from '../helpers/effect-layer.js';
import {BunFileSystem} from '@effect/platform-bun';
import {describe, expect, it} from '@effect/vitest';
import {Effect, FileSystem} from 'effect';

type Target = Readonly<{
  datasource: Readonly<{type: string; uid: string}>;
  metricsQueryType?: string;
  query: string;
  queryType: string;
  tableType: string;
}>;

type FieldOverride = Readonly<{
  matcher: Readonly<{id: string; options: string}>;
  properties: ReadonlyArray<Readonly<{id: string; value: unknown}>>;
}>;

type Transformation = Readonly<{
  id: string;
  options: Readonly<{regex: string; renamePattern: string}>;
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

const basePredicates = [
  'resource.service.name = "threadnote"',
  'resource.threadnote.telemetry.schema_version = 1',
  'span:name = "threadnote.anonymous-diagnostic"',
];

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
      const queries = targets.map(target => target.query);

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
          expect(target.datasource).toEqual({type: 'tempo', uid: '${DS_TEMPO}'});
          expect(target.queryType).toBe('traceql');
        }
      }
      for (const query of queries) {
        for (const predicate of basePredicates) expect(query).toContain(predicate);
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
        expect(panel.transformations).toHaveLength(1);
        const transformation = panel.transformations?.[0];
        expect(transformation?.id).toBe('renameByRegex');
        expect(
          rename.raw.replace(new RegExp(transformation!.options.regex, 'u'), transformation!.options.renamePattern),
        ).toBe(rename.rendered);
      }
      expect(metricRenames.size).toBe(6);
      const tables = panels.filter(panel => panel.type === 'table');
      expect(tables).not.toHaveLength(0);
      for (const panel of tables) {
        for (const target of panel.targets) {
          expect(target.query).toContain('with (most_recent=true)');
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
      const [commands, telemetryDocs, websiteDocs] = yield* Effect.all(
        [
          fileSystem.readFileString(`${process.cwd()}/src/telemetry/commands.ts`),
          fileSystem.readFileString(`${process.cwd()}/docs/telemetry.md`),
          fileSystem.readFileString(`${process.cwd()}/website/src/content/docsTelemetry.ts`),
        ],
        {concurrency: 'unbounded'},
      );

      for (const source of [commands, telemetryDocs, websiteDocs]) {
        expect(source).toContain('14-day');
        expect(source).toContain('Grafana Cloud EU');
        expect(source).toMatch(/source IP|IP addresses/u);
      }
      expect(telemetryDocs).toContain('https://telemetry.threadnote.io/v1/traces');
      expect(commands).toContain('endpoint === DEFAULT_TELEMETRY_ENDPOINT');
    }).pipe(provideTestLayer(BunFileSystem.layer)),
  );
});
