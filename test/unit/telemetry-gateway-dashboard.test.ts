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

type Panel = Readonly<{
  datasource: Readonly<{type: string; uid: string}>;
  id: number;
  targets: ReadonlyArray<Target>;
  title: string;
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

      for (const panel of panels.filter(candidate => candidate.type !== 'table')) {
        const metricQueries = panel.targets.map(target => target.query).join('\n');
        expect(metricQueries).not.toContain('session.id');
        expect(metricQueries).not.toContain('invocation.id');
      }
      const tables = panels.filter(panel => panel.type === 'table');
      expect(tables).not.toHaveLength(0);
      for (const panel of tables) {
        for (const target of panel.targets) {
          expect(target.query).toContain('with (most_recent=true)');
          expect(target.tableType).toBe('spans');
        }
      }
      const scopedAttribute = /(?:resource|span)\.([A-Za-z_][A-Za-z0-9_.]*)/gu;
      const attributes = new Set(
        queries.flatMap(query => Array.from(query.matchAll(scopedAttribute), match => match[1]!)),
      );
      expect(attributes.size).toBeGreaterThan(10);
      for (const attribute of attributes) expect(collector).toContain(`"${attribute}"`);
    }).pipe(provideTestLayer(BunFileSystem.layer)),
  );
});
