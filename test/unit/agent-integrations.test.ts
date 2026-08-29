import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {
  agentIntegrationDoctorChecks,
  installAgentIntegration,
  migrateLegacyAgentIntegrations,
  readAgentIntegrationRegistry,
  removeAgentIntegrations,
  repairAgentIntegrations,
} from '../../src/agent-integrations.js';
import {repairableAgentClients} from '../../src/agent-integration-registry.js';
import {USER_INSTRUCTIONS_END_MARKER, USER_INSTRUCTIONS_START_MARKER} from '../../src/constants.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {SystemInfo} from '../../src/effect/system.js';
import type {AgentClient, RuntimeConfig} from '../../src/types.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const agents = ['codex', 'claude', 'cursor', 'copilot'] as const;

function config(home: string): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: `${home}/seed-manifest.yaml`,
    user: 'tester',
  };
}

describe('agent integrations', () => {
  effectIt.effect('registers one selected host with its bootstrap and skills', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-integration-'});
        const userHome = path.join(root, 'user');
        const threadnoteHome = path.join(userHome, '.threadnote');
        const testSystem = SystemInfo.of({...system, homeDirectory: userHome});

        yield* installAgentIntegration(config(threadnoteHome), 'cursor', {
          dryRun: false,
          name: 'threadnote',
          toolset: 'core',
        }).pipe(Effect.provideService(SystemInfo, testSystem));

        const registry = yield* readAgentIntegrationRegistry(config(threadnoteHome));
        expect(Object.keys(registry?.hosts ?? {})).toEqual(['cursor']);
        expect(registry?.hosts.cursor).toMatchObject({
          mcp: {name: 'threadnote', toolset: 'core'},
          status: 'current',
        });
        const cursorRule = yield* fs.readFileString(path.join(userHome, '.cursor', 'rules', 'threadnote.mdc'));
        expect(cursorRule).toContain('alwaysApply: true');
        expect(cursorRule).toContain('Use the installed Threadnote skills');
        for (const skill of ['threadnote-context', 'threadnote-code-graph', 'threadnote-memory']) {
          expect(yield* fs.readFileString(path.join(userHome, '.cursor', 'skills', skill, 'SKILL.md'))).toContain(
            `name: ${skill}`,
          );
        }
        expect(yield* fs.exists(path.join(userHome, '.codex', 'AGENTS.md'))).toBe(false);
        expect(yield* fs.exists(path.join(userHome, '.claude', 'CLAUDE.md'))).toBe(false);
        expect(yield* fs.exists(path.join(userHome, '.copilot', 'instructions', 'threadnote.instructions.md'))).toBe(
          false,
        );
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('writes each host bundle to its documented personal locations', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-targets-'});
        const userHome = path.join(root, 'user');
        const threadnoteHome = path.join(userHome, '.threadnote');
        const testSystem = SystemInfo.of({...system, homeDirectory: userHome});

        for (const agent of agents) {
          yield* installAgentIntegration(config(threadnoteHome), agent, {
            dryRun: false,
            name: 'threadnote',
            scope: agent === 'claude' ? 'user' : undefined,
            toolset: 'core',
          }).pipe(Effect.provideService(SystemInfo, testSystem));
        }

        expect(yield* fs.readFileString(path.join(userHome, '.codex', 'AGENTS.md'))).toContain(
          'Use the installed Threadnote skills',
        );
        expect(yield* fs.readFileString(path.join(userHome, '.claude', 'CLAUDE.md'))).toContain(
          'Use the installed Threadnote skills',
        );
        expect(yield* fs.readFileString(path.join(userHome, '.cursor', 'rules', 'threadnote.mdc'))).toContain(
          'alwaysApply: true',
        );
        expect(
          yield* fs.readFileString(path.join(userHome, '.copilot', 'instructions', 'threadnote.instructions.md')),
        ).toContain('applyTo: "**"');
        expect(yield* fs.exists(path.join(userHome, '.agents', 'AGENTS.md'))).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('serializes concurrent host registration without losing receipts', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-concurrent-'});
        const userHome = path.join(root, 'user');
        const threadnoteHome = path.join(userHome, '.threadnote');
        const testSystem = SystemInfo.of({...system, homeDirectory: userHome});

        yield* Effect.all(
          agents.map(agent =>
            installAgentIntegration(config(threadnoteHome), agent, {
              dryRun: false,
              name: `threadnote-${agent}`,
              scope: agent === 'claude' ? 'project' : undefined,
              toolset: 'full',
            }).pipe(Effect.provideService(SystemInfo, testSystem)),
          ),
          {concurrency: 'unbounded'},
        ).pipe(TestClock.withLive);

        const registry = yield* readAgentIntegrationRegistry(config(threadnoteHome));
        expect(Object.keys(registry?.hosts ?? {}).sort()).toEqual([...agents].sort());
        for (const agent of agents) {
          expect(registry?.hosts[agent]).toMatchObject({
            mcp: {name: `threadnote-${agent}`, repair: true, toolset: 'full'},
            status: 'current',
          });
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('migrates only inferred MCP hosts and preserves unrelated instruction content', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-migration-'});
        const userHome = path.join(root, 'user');
        const threadnoteHome = path.join(userHome, '.threadnote');
        const codexInstructions = path.join(userHome, '.codex', 'AGENTS.md');
        const claudeInstructions = path.join(userHome, '.claude', 'CLAUDE.md');
        const legacyBlock = `${USER_INSTRUCTIONS_START_MARKER}\nLegacy dense instructions.\n${USER_INSTRUCTIONS_END_MARKER}`;
        yield* fs.makeDirectory(path.dirname(codexInstructions), {recursive: true});
        yield* fs.makeDirectory(path.dirname(claudeInstructions), {recursive: true});
        yield* fs.writeFileString(codexInstructions, `Keep this Codex note.\n\n${legacyBlock}\n`);
        yield* fs.writeFileString(claudeInstructions, `Keep this Claude note.\n\n${legacyBlock}\n`);
        const testSystem = SystemInfo.of({...system, homeDirectory: userHome});

        yield* migrateLegacyAgentIntegrations(config(threadnoteHome), ['claude'], false).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );

        expect(yield* fs.readFileString(codexInstructions)).toBe('Keep this Codex note.\n');
        const migratedClaude = yield* fs.readFileString(claudeInstructions);
        expect(migratedClaude).toContain('Keep this Claude note.');
        expect(migratedClaude).toContain('Use the installed Threadnote skills');
        expect(Object.keys((yield* readAgentIntegrationRegistry(config(threadnoteHome)))?.hosts ?? {})).toEqual([
          'claude',
        ]);
        const receipt = (yield* readAgentIntegrationRegistry(config(threadnoteHome)))?.hosts.claude;
        expect(receipt?.mcp).toEqual({name: 'threadnote', repair: false});
        expect(repairableAgentClients(yield* readAgentIntegrationRegistry(config(threadnoteHome)))).toEqual([]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('records every inferred host as pending before migration writes artifacts', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-pending-migration-'});
        const userHome = path.join(root, 'user');
        const threadnoteHome = path.join(userHome, '.threadnote');
        const conflictingSkill = path.join(userHome, '.agents', 'skills', 'threadnote-context', 'SKILL.md');
        yield* fs.makeDirectory(path.dirname(conflictingSkill), {recursive: true});
        yield* fs.writeFileString(conflictingSkill, 'User-owned skill.\n');
        const testSystem = SystemInfo.of({...system, homeDirectory: userHome});

        const migration = yield* migrateLegacyAgentIntegrations(
          config(threadnoteHome),
          ['codex', 'claude'],
          false,
        ).pipe(Effect.provideService(SystemInfo, testSystem), Effect.exit);
        expect(migration._tag).toBe('Failure');
        const pending = yield* readAgentIntegrationRegistry(config(threadnoteHome));
        expect(Object.keys(pending?.hosts ?? {})).toEqual(['codex', 'claude']);
        expect(pending?.hosts.codex?.status).toBe('pending');
        expect(pending?.hosts.claude?.status).toBe('pending');

        yield* fs.remove(conflictingSkill);
        yield* repairAgentIntegrations(config(threadnoteHome), false).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        const repaired = yield* readAgentIntegrationRegistry(config(threadnoteHome));
        expect(repaired?.hosts.codex?.status).toBe('current');
        expect(repaired?.hosts.claude?.status).toBe('current');
        expect(repairableAgentClients(repaired)).toEqual([]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('preserves unrelated Cursor rule text while migrating its managed block', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-cursor-preserve-'});
        const userHome = path.join(root, 'user');
        const threadnoteHome = path.join(userHome, '.threadnote');
        const cursorRule = path.join(userHome, '.cursor', 'rules', 'threadnote.mdc');
        yield* fs.makeDirectory(path.dirname(cursorRule), {recursive: true});
        yield* fs.writeFileString(
          cursorRule,
          [
            '---',
            'description: User-maintained Cursor rule',
            'alwaysApply: true',
            '---',
            '',
            'Keep this user preface.',
            '',
            USER_INSTRUCTIONS_START_MARKER,
            'Legacy dense instructions.',
            USER_INSTRUCTIONS_END_MARKER,
            '',
            'Keep this user appendix.',
            '',
          ].join('\n'),
        );
        const testSystem = SystemInfo.of({...system, homeDirectory: userHome});

        yield* migrateLegacyAgentIntegrations(config(threadnoteHome), ['cursor'], false).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );

        const migrated = yield* fs.readFileString(cursorRule);
        expect(migrated).toContain('description: User-maintained Cursor rule');
        expect(migrated).toContain('Keep this user preface.');
        expect(migrated).toContain('Keep this user appendix.');
        expect(migrated).toContain('Use the installed Threadnote skills');
        expect(migrated).not.toContain('Legacy dense instructions.');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('uses an installed Cursor Marketplace rule without adding a duplicate user rule', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-cursor-plugin-'});
        const userHome = path.join(root, 'user');
        const threadnoteHome = path.join(userHome, '.threadnote');
        const pluginRoot = path.join(userHome, '.cursor', 'plugins', 'cache', 'threadnote', '1.1.0');
        const directRule = path.join(userHome, '.cursor', 'rules', 'threadnote.mdc');
        yield* fs.copy(path.join(process.cwd(), 'cursor-plugin'), pluginRoot, {overwrite: true});
        yield* fs.makeDirectory(path.dirname(directRule), {recursive: true});
        yield* fs.writeFileString(
          directRule,
          `Keep this note.\n\n${USER_INSTRUCTIONS_START_MARKER}\nDuplicate.\n${USER_INSTRUCTIONS_END_MARKER}\n`,
        );
        const testSystem = SystemInfo.of({...system, homeDirectory: userHome});

        yield* installAgentIntegration(config(threadnoteHome), 'cursor', {
          dryRun: false,
          name: 'threadnote',
          toolset: 'core',
        }).pipe(Effect.provideService(SystemInfo, testSystem));

        expect(yield* fs.readFileString(directRule)).toBe('Keep this note.\n');
        const receipt = (yield* readAgentIntegrationRegistry(config(threadnoteHome)))?.hosts.cursor;
        expect(Object.keys(receipt?.artifacts ?? {})).not.toContain(directRule);
        expect(Object.keys(receipt?.artifacts ?? {})).toHaveLength(3);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('plans removal without mutation, then removes only managed artifacts and its receipt', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-removal-'});
        const userHome = path.join(root, 'user');
        const threadnoteHome = path.join(userHome, '.threadnote');
        const instructions = path.join(userHome, '.codex', 'AGENTS.md');
        const skill = path.join(userHome, '.agents', 'skills', 'threadnote-context', 'SKILL.md');
        yield* fs.makeDirectory(path.dirname(instructions), {recursive: true});
        yield* fs.writeFileString(instructions, 'Keep this user instruction.\n');
        const testSystem = SystemInfo.of({...system, homeDirectory: userHome});
        yield* installAgentIntegration(config(threadnoteHome), 'codex', {
          dryRun: false,
          name: 'custom-threadnote',
          toolset: 'full',
        }).pipe(Effect.provideService(SystemInfo, testSystem));
        const installedInstructions = yield* fs.readFileString(instructions);

        yield* removeAgentIntegrations(config(threadnoteHome), true).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(yield* fs.readFileString(instructions)).toBe(installedInstructions);
        expect(yield* fs.exists(skill)).toBe(true);
        expect(yield* readAgentIntegrationRegistry(config(threadnoteHome))).toBeDefined();

        yield* removeAgentIntegrations(config(threadnoteHome), false).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(yield* fs.readFileString(instructions)).toBe('Keep this user instruction.\n');
        expect(yield* fs.exists(skill)).toBe(false);
        expect(yield* readAgentIntegrationRegistry(config(threadnoteHome))).toBeUndefined();
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect.prop(
    'installing and removing a block round-trips bounded surrounding user content',
    {
      prefix: fc.stringMatching(/^[A-Za-z0-9._-]{1,24}$/u),
      suffix: fc.stringMatching(/^[A-Za-z0-9._-]{1,24}$/u),
    },
    ({prefix, suffix}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const system = yield* SystemInfo;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-roundtrip-'});
          const userHome = path.join(root, 'user');
          const threadnoteHome = path.join(userHome, '.threadnote');
          const instructions = path.join(userHome, '.codex', 'AGENTS.md');
          const original = `${prefix}\n\n${suffix}\n`;
          yield* fs.makeDirectory(path.dirname(instructions), {recursive: true});
          yield* fs.writeFileString(instructions, original);
          const testSystem = SystemInfo.of({...system, homeDirectory: userHome});

          yield* installAgentIntegration(config(threadnoteHome), 'codex', {
            dryRun: false,
            name: 'threadnote',
            toolset: 'core',
          }).pipe(Effect.provideService(SystemInfo, testSystem));
          yield* removeAgentIntegrations(config(threadnoteHome), false).pipe(
            Effect.provideService(SystemInfo, testSystem),
          );

          expect(yield* fs.readFileString(instructions)).toBe(original);
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 12}},
  );

  effectIt.effect.prop(
    'doctor reports exactly the registered host subset',
    {selected: fc.uniqueArray(fc.constantFrom<AgentClient>(...agents), {maxLength: agents.length})},
    ({selected}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const system = yield* SystemInfo;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-doctor-'});
          const userHome = path.join(root, 'user');
          const threadnoteHome = path.join(userHome, '.threadnote');
          const testSystem = SystemInfo.of({...system, homeDirectory: userHome});
          for (const agent of selected) {
            yield* installAgentIntegration(config(threadnoteHome), agent, {
              dryRun: false,
              name: 'threadnote',
              scope: agent === 'claude' ? 'user' : undefined,
              toolset: 'core',
            }).pipe(Effect.provideService(SystemInfo, testSystem));
          }

          const checks = yield* agentIntegrationDoctorChecks(config(threadnoteHome)).pipe(
            Effect.provideService(SystemInfo, testSystem),
          );
          const checkedHosts = new Set(
            checks.map(check => agents.find(agent => check.name.startsWith(`${agent} `))).filter(Boolean),
          );
          expect([...checkedHosts].sort()).toEqual([...selected].sort());
          expect(checks.every(check => check.status === 'ok')).toBe(true);
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 20}},
  );
});
