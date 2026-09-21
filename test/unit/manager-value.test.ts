import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {describe, expect} from 'vitest';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {handleManagerValueRequest} from '../../src/manager/value.js';
import type {RuntimeConfig} from '../../src/types.js';
import {aggregateValueReportV1} from '../../src/value_report/index.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const config: RuntimeConfig = {
  account: 'local',
  agentContextHome: '/tmp/threadnote-manager-value-test',
  agentId: 'threadnote',
  manifestPath: '/tmp/threadnote-manager-value-test/seed-manifest.yaml',
  user: 'tester',
};

describe('Manager value API', () => {
  effectIt.effect('routes bounded report, retention, and deletion requests', () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const report = aggregateValueReportV1({
        period: {from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z'},
      });
      const reportResponse = yield* handleManagerValueRequest({
        body: Effect.succeed({period: 30}),
        config,
        method: 'POST',
        report: (_config, body) => Effect.sync(() => (calls.push(`report:${String(body.period)}`), report)),
        url: new URL('http://manager.test/api/value/report'),
      });
      const retentionResponse = yield* handleManagerValueRequest({
        body: Effect.succeed({apply: false, days: 90}),
        config,
        method: 'POST',
        retention: (_config, body) =>
          Effect.sync(() => {
            calls.push(`retention:${String(body.days)}`);
            return {
              applied: false,
              feedback: {after: 1, applied: false, before: 2, removed: 1},
              retentionDays: 90,
              type: 'value-report-retention' as const,
              valueEvents: {after: 1, applied: false, before: 2, removed: 1},
              version: 1 as const,
            };
          }),
        url: new URL('http://manager.test/api/value/retention'),
      });
      const deleteResponse = yield* handleManagerValueRequest({
        body: Effect.succeed({apply: false, feedback: true}),
        config,
        deleteData: (_config, body) =>
          Effect.sync(() => {
            calls.push(`delete:${String(body.feedback)}`);
            return {
              applied: false,
              exports: {removed: 0, selected: false},
              feedback: {after: 0, applied: false, before: 1, removed: 1, selected: true},
              type: 'value-report-deletion' as const,
              valueEvents: {after: 0, applied: false, before: 0, removed: 0, selected: false},
              version: 1 as const,
            };
          }),
        method: 'POST',
        url: new URL('http://manager.test/api/value/delete'),
      });

      expect(calls).toEqual(['report:30', 'retention:90', 'delete:true']);
      expect(reportResponse).toEqual({body: report, status: 200});
      expect(retentionResponse?.status).toBe(200);
      expect(deleteResponse?.status).toBe(200);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects unselected deletion and unsupported fields without leaking internals', () =>
    Effect.gen(function* () {
      const empty = yield* handleManagerValueRequest({
        body: Effect.succeed({apply: false}),
        config,
        method: 'POST',
        url: new URL('http://manager.test/api/value/delete'),
      });
      const unsupported = yield* handleManagerValueRequest({
        body: Effect.succeed({path: '/private/repository'}),
        config,
        method: 'POST',
        url: new URL('http://manager.test/api/value/report'),
      });

      expect(empty).toEqual({
        body: {code: 'value-selection-required', error: 'Select feedback, value events, or exports.'},
        status: 400,
      });
      expect(unsupported).toEqual({
        body: {code: 'invalid-request', error: 'value report request has unsupported field path.'},
        status: 400,
      });
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
});
