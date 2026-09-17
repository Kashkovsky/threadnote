import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {captureConsole} from '../../src/effect/console.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import type {RuntimeConfig} from '../../src/types.js';
import {runValueReportExport, VALUE_REPORT_EXPORT_DIRECTORY} from '../../src/value_report/commands.js';
import {
  buildValueReportExportV1,
  parseValueReportExportV1,
  serializeValueReportExportV1,
  VALUE_REPORT_EXPORT_SCHEMA,
} from '../../src/value_report/export.js';
import {aggregateValueReportV1} from '../../src/value_report/index.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const period = {from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z'} as const;
const forbiddenKeys = new Set([
  'memoryText',
  'path',
  'project',
  'query',
  'rawLogs',
  'repository',
  'repositoryName',
  'sourceFragment',
  'stableUserId',
  'userId',
]);

describe('redacted value-report export', () => {
  it('uses a closed export schema at every level', () => {
    const bundle = buildValueReportExportV1(aggregateValueReportV1({period}));
    expect(parseValueReportExportV1(bundle)).toEqual(bundle);
    expect(() => parseValueReportExportV1({...bundle, path: '/private/repository'})).toThrow();
    expect(() =>
      parseValueReportExportV1({...bundle, report: {...bundle.report, project: 'private-project'}}),
    ).toThrow();
    expect(() =>
      parseValueReportExportV1({
        ...bundle,
        report: {
          ...bundle.report,
          contextBrief: {...bundle.report.contextBrief, attempts: 0, successful: 1},
        },
      }),
    ).toThrow('successful briefs cannot exceed attempts');
  });

  it('serializes deterministically without forbidden keys or caller labels', () => {
    fc.assert(
      fc.property(
        fc.record({
          attempts: fc.integer({min: 0, max: 20_000}),
          completed: fc.integer({min: 0, max: 20_000}),
          opened: fc.integer({min: 0, max: 20_000}),
          projectSuffix: fc.string({
            minLength: 8,
            maxLength: 24,
            unit: fc.constantFrom(...'0123456789abcdef'),
          }),
          proposed: fc.integer({min: 0, max: 20_000}),
        }),
        input => {
          const project = `private-project-${input.projectSuffix}`;
          const report = aggregateValueReportV1({
            counts: {
              contextBrief: {attempts: input.attempts},
              health: {opened: input.opened},
              knowledgeDelta: {proposed: input.proposed},
              setup: {completed: input.completed},
            },
            period,
            project,
          });
          const bundle = buildValueReportExportV1(report);
          const reordered = {
            version: bundle.version,
            type: bundle.type,
            schema: bundle.schema,
            report: bundle.report,
          };
          const serialized = serializeValueReportExportV1(bundle);
          expect(serialized).toBe(serializeValueReportExportV1(reordered));
          expect(serialized).not.toContain(project);
          expect([...objectKeys(JSON.parse(serialized))].filter(key => forbiddenKeys.has(key))).toEqual([]);
        },
      ),
      {numRuns: 50},
    );
  });

  effectIt.effect('previews without writing and applies the same private content-addressed bundle', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-value-export-'});
        const config = runtimeConfig(home);
        const options = {period: 7, project: 'private-project'} as const;

        const preview = yield* captureConsole(runValueReportExport(config, options));
        const previewBundle = parseValueReportExportV1(JSON.parse(preview.output));
        expect(previewBundle.schema).toBe(VALUE_REPORT_EXPORT_SCHEMA);
        expect(preview.output).not.toContain('private-project');
        expect(yield* fs.exists(path.join(home, ...VALUE_REPORT_EXPORT_DIRECTORY.split('/')))).toBe(false);

        const applied = yield* captureConsole(runValueReportExport(config, {...options, apply: true}));
        const outputPath = applied.output.match(/^Exported redacted ValueReportExportV1 to (.+)\.$/u)?.[1];
        expect(outputPath).toBeDefined();
        expect(outputPath?.startsWith(path.join(home, ...VALUE_REPORT_EXPORT_DIRECTORY.split('/')))).toBe(true);
        expect((yield* fs.readFileString(outputPath!)).trimEnd()).toBe(preview.output);
        expect((yield* fs.stat(outputPath!)).mode & 0o077).toBe(0);

        const repeated = yield* captureConsole(runValueReportExport(config, {...options, apply: true}));
        expect(repeated.output).toBe(applied.output);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function objectKeys(value: unknown, keys = new Set<string>()): ReadonlySet<string> {
  if (Array.isArray(value)) {
    for (const item of value) objectKeys(item, keys);
    return keys;
  }
  if (typeof value !== 'object' || value === null) return keys;
  for (const [key, item] of Object.entries(value)) {
    keys.add(key);
    objectKeys(item, keys);
  }
  return keys;
}

function runtimeConfig(home: string): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: `${home}/seed-manifest.yaml`,
    user: 'tester',
  };
}
