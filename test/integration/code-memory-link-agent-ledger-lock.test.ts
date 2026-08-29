import {provideTestLayer} from '../helpers/effect-layer.js';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {runCommandEffect} from '../../src/effect/command.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';

describe('Code Memory Link agent trial ledger lock', () => {
  effectIt.effect('holds one canonical lock across a delayed external execution and receipt write', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-code-memory-link-lock-'});
      const child = path.join(process.cwd(), 'test/helpers/code-memory-link-agent-lock-child.ts');
      const results = yield* Effect.all(
        [
          runCommandEffect(process.execPath, [child, root], {timeoutMs: 15_000}),
          runCommandEffect(process.execPath, [child, root], {timeoutMs: 15_000}),
        ],
        {concurrency: 2},
      );

      expect(results.map(result => result.exitCode)).toEqual([0, 0]);
      expect(
        (yield* fs.readDirectory(path.join(root, 'external-executions'))).filter(name => name.endsWith('.marker')),
      ).toHaveLength(1);
      expect((yield* fs.readFileString(path.join(root, 'trials.jsonl'))).trim().split(/\r?\n/u)).toHaveLength(1);
      expect(yield* fs.exists(path.join(root, 'trials.jsonl.lock'))).toBe(false);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );
});
