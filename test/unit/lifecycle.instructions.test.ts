import {expect, it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe} from 'vitest';
import {captureConsole} from '../../src/effect/console.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {SystemInfo} from '../../src/effect/system.js';
import {runInstall, userAgentInstructionsChecks} from '../../src/lifecycle.js';
import type {RuntimeConfig} from '../../src/types.js';

describe('agent instruction lifecycle', () => {
  it.effect('install and repair paths upsert managed instructions and report every target', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-instructions-'});
        const userHome = path.join(root, 'user');
        const threadnoteHome = path.join(userHome, '.threadnote');
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: threadnoteHome,
          agentId: 'threadnote',
          manifestPath: path.join(threadnoteHome, 'seed-manifest.yaml'),
          user: 'tester',
        };
        const testSystem = SystemInfo.of({...system, homeDirectory: userHome});
        const installed = yield* captureConsole(runInstall(config, {printNextSteps: false, start: false})).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );

        expect(installed.output).toContain(`Wrote agent instructions: ${path.join(userHome, '.codex', 'AGENTS.md')}`);
        expect(yield* fs.readFileString(path.join(userHome, '.codex', 'AGENTS.md'))).toContain(
          '<!-- BEGIN THREADNOTE USER INSTRUCTIONS -->',
        );
        expect(yield* fs.readFileString(path.join(userHome, '.claude', 'CLAUDE.md'))).toContain(
          '<!-- BEGIN THREADNOTE USER INSTRUCTIONS -->',
        );
        expect(yield* fs.readFileString(path.join(userHome, '.cursor', 'rules', 'threadnote.md'))).toContain(
          'threadnote://',
        );
        expect(
          yield* fs.readFileString(path.join(userHome, '.copilot', 'instructions', 'threadnote.instructions.md')),
        ).toContain('applyTo: "**"');

        const checks = yield* userAgentInstructionsChecks().pipe(Effect.provideService(SystemInfo, testSystem));
        expect(checks).toHaveLength(4);
        expect(checks.every(check => check.status === 'ok')).toBe(true);
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );
});
