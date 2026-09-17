import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {getAgentAdapter} from '../../src/agent_integration/adapters.js';
import {planAgentSurface} from '../../src/agent_integration/surfaces.js';
import {CommandExecutor} from '../../src/effect/command.js';
import {runAgentCliAction, setupCompletionForRegistration} from '../../src/effect/agents_cli.js';
import {SystemInfo} from '../../src/effect/system.js';
import type {RuntimeConfig} from '../../src/types.js';
import {readLocalValueEvents, summarizeLocalValueEvents} from '../../src/value_report/events.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const commandLayer = CommandExecutor.layer.pipe(Layer.provideMerge(BunServices.layer), Layer.provide(SystemInfo.layer));
const testLayer = Layer.mergeAll(BunServices.layer, SystemInfo.layer, commandLayer);
const runtime = (home: string): RuntimeConfig => ({
  account: 'local',
  agentContextHome: home,
  agentId: 'threadnote',
  manifestPath: `${home}/manifest.yaml`,
  user: 'tester',
});
const reportPeriod = {
  from: new Date('2000-01-01T00:00:00.000Z'),
  to: new Date('2100-01-01T00:00:00.000Z'),
} as const;

describe('agent setup value events', () => {
  it('classifies only a newly registered target and reports reuse iff another registration existed', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({maxLength: 12}), {maxLength: 12}),
        fc.array(fc.string({maxLength: 12}), {maxLength: 12}),
        fc.string({maxLength: 12}),
        (before, after, target) => {
          const completion = setupCompletionForRegistration(before, after, target);
          const beforeSet = new Set(before);
          const expectedCompletion = !beforeSet.has(target) && new Set(after).has(target);
          expect(completion !== undefined).toBe(expectedCompletion);
          if (completion !== undefined) {
            expect(completion).toEqual({supportedAgentReuse: beforeSet.size > 0});
            expect(Object.keys(completion)).toEqual(['supportedAgentReuse']);
          }
        },
      ),
      {numRuns: 100},
    );
  });

  effectIt.effect('records fresh applied installs but not previews, reinstalls, repairs, or removals', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-value-'});
        const home = path.join(root, 'user');
        const config = runtime(path.join(home, '.threadnote'));
        const testSystem = SystemInfo.of({
          ...system,
          homeDirectory: home,
          environment: () => ({...system.environment(), XDG_CONFIG_HOME: path.join(root, 'config')}),
        });

        yield* Effect.gen(function* () {
          const gemini = getAgentAdapter('gemini-cli')!;
          const amp = getAgentAdapter('amp-cli')!;

          yield* runAgentCliAction(config, gemini, 'install', false);
          expect(yield* readLocalValueEvents(config.agentContextHome)).toEqual([]);

          yield* runAgentCliAction(config, gemini, 'install', true);
          yield* runAgentCliAction(config, gemini, 'install', true);
          yield* runAgentCliAction(config, gemini, 'repair', true);
          yield* runAgentCliAction(config, gemini, 'remove', false);
          yield* runAgentCliAction(config, amp, 'install', true);
          yield* runAgentCliAction(config, gemini, 'remove', true);

          const events = yield* readLocalValueEvents(config.agentContextHome);
          expect(events).toHaveLength(2);
          expect(events.map(event => (event.kind === 'setup' ? event.supportedAgentReuse : undefined))).toEqual([0, 1]);
          for (const event of events) {
            expect(Object.keys(event).sort()).toEqual(
              ['completed', 'kind', 'supportedAgentReuse', 'timestamp', 'version'].sort(),
            );
          }
          const serialized = JSON.stringify(events);
          expect(serialized).not.toContain('gemini');
          expect(serialized).not.toContain('amp-cli');
          expect(serialized).not.toContain(home);
          expect(
            summarizeLocalValueEvents(events, {
              from: reportPeriod.from,
              project: 'project-filter-does-not-enter-setup-events',
              to: reportPeriod.to,
            }).setup,
          ).toEqual({completed: 2, supportedAgentReuse: 1});
        }).pipe(Effect.provideService(SystemInfo, testSystem));
      }),
    ).pipe(TestClock.withLive, provideTestLayer(testLayer)),
  );

  effectIt.effect('does not record an applied install that fails before registration', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-value-failure-'});
        const home = path.join(root, 'user');
        const config = runtime(path.join(home, '.threadnote'));
        const testSystem = SystemInfo.of({...system, homeDirectory: home});

        yield* Effect.gen(function* () {
          const gemini = getAgentAdapter('gemini-cli')!;
          const plan = yield* planAgentSurface(config, gemini);
          yield* fs.makeDirectory(path.dirname(plan.mcpPath), {recursive: true});
          yield* fs.writeFileString(plan.mcpPath, '{"mcpServers":{"threadnote":{"command":"unowned"}}}');

          const exit = yield* runAgentCliAction(config, gemini, 'install', true).pipe(Effect.exit);

          expect(exit._tag).toBe('Failure');
          expect(yield* readLocalValueEvents(config.agentContextHome)).toEqual([]);
        }).pipe(Effect.provideService(SystemInfo, testSystem));
      }),
    ).pipe(TestClock.withLive, provideTestLayer(testLayer)),
  );
});
