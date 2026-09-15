import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import fc from 'fast-check';
import {expect} from 'vitest';
import {fcEffectProp} from '../helpers/fast-check-property.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {CommandExecutor, CommandSpawnFailed} from '../../src/effect/command.js';
import {HttpService} from '../../src/effect/http.js';
import {SystemInfo} from '../../src/effect/system.js';
import {GITHUB_RELEASES_URL, githubReleaseHeaders} from '../../src/release/github_auth.js';
import {fetchThreadnoteReleaseNotes} from '../../src/release/notes.js';
import {fetchLatestVersion} from '../../src/release/update.js';

effectIt.effect('prefers GH_TOKEN over GITHUB_TOKEN without starting gh', () =>
  Effect.gen(function* () {
    const baseSystem = yield* SystemInfo;
    const system = SystemInfo.of({
      ...baseSystem,
      environment: () => ({GH_TOKEN: 'first-token', GITHUB_TOKEN: 'second-token'}),
    });
    const command = CommandExecutor.of({
      execute: () => Effect.die('gh should not run when an environment token is available'),
      executeStreaming: () => Effect.die('not used'),
    });
    const headers = yield* githubReleaseHeaders(GITHUB_RELEASES_URL).pipe(
      Effect.provideService(SystemInfo, system),
      Effect.provideService(CommandExecutor, command),
    );
    expect(headers).toHaveProperty('authorization', 'Bearer first-token');
  }).pipe(provideTestLayer(SystemInfo.layer)),
);

effectIt.effect('uses a stored github.com gh identity when no environment token exists', () =>
  Effect.gen(function* () {
    const baseSystem = yield* SystemInfo;
    const system = SystemInfo.of({...baseSystem, environment: () => ({})});
    let calls = 0;
    const command = CommandExecutor.of({
      execute: (executable, args, options) =>
        Effect.sync(() => {
          calls += 1;
          expect(executable).toBe('gh');
          expect(args).toEqual(['auth', 'token', '--hostname', 'github.com']);
          expect(options?.env?.GH_PROMPT_DISABLED).toBe('1');
          return {exitCode: 0, stderr: '', stdout: 'stored-token\n'};
        }),
      executeStreaming: () => Effect.die('not used'),
    });
    const headers = yield* githubReleaseHeaders(GITHUB_RELEASES_URL).pipe(
      Effect.provideService(SystemInfo, system),
      Effect.provideService(CommandExecutor, command),
    );
    expect(headers).toHaveProperty('authorization', 'Bearer stored-token');
    expect(calls).toBe(1);
  }).pipe(provideTestLayer(SystemInfo.layer)),
);

effectIt.effect('keeps the public release request available when gh authentication is unavailable', () =>
  Effect.gen(function* () {
    const baseSystem = yield* SystemInfo;
    const system = SystemInfo.of({...baseSystem, environment: () => ({})});
    const command = CommandExecutor.of({
      execute: () =>
        Effect.fail(
          CommandSpawnFailed.make({
            args: ['auth', 'token', '--hostname', 'github.com'],
            cause: new Error('gh unavailable'),
            executable: 'gh',
            message: 'gh unavailable',
          }),
        ),
      executeStreaming: () => Effect.die('not used'),
    });
    const headers = yield* githubReleaseHeaders(GITHUB_RELEASES_URL).pipe(
      Effect.provideService(SystemInfo, system),
      Effect.provideService(CommandExecutor, command),
    );
    expect(headers).not.toHaveProperty('authorization');
    expect(headers.accept).toBe('application/vnd.github+json');
  }).pipe(provideTestLayer(SystemInfo.layer)),
);

effectIt.effect('authenticates updater and release notes requests but never a custom source', () =>
  Effect.gen(function* () {
    const baseSystem = yield* SystemInfo;
    const system = SystemInfo.of({...baseSystem, environment: () => ({GH_TOKEN: 'fixture-token'})});
    const requests: Array<{readonly authorization?: string; readonly url: string}> = [];
    const release = {
      assets: [],
      draft: false,
      immutable: true,
      name: '4.7.3',
      prerelease: false,
      tag_name: 'v4.7.3',
    };
    const http = HttpService.of({
      downloadToFile: () => Effect.die('not used'),
      getJson: (url, options) =>
        Effect.sync(() => {
          requests.push({authorization: options?.headers?.authorization, url: String(url)});
          return {body: [release], status: 200};
        }),
      getStatus: () => Effect.die('not used'),
      getText: () => Effect.die('not used'),
    });
    const command = CommandExecutor.of({
      execute: () => Effect.die('gh should not run when an environment token is available'),
      executeStreaming: () => Effect.die('not used'),
    });
    const [version, notes, customVersion] = yield* Effect.all([
      fetchLatestVersion(),
      fetchThreadnoteReleaseNotes(),
      fetchLatestVersion('https://mirror.example/releases'),
    ]).pipe(
      Effect.provideService(SystemInfo, system),
      Effect.provideService(CommandExecutor, command),
      Effect.provideService(HttpService, http),
    );
    expect(version).toBe('4.7.3');
    expect(notes.map(note => note.version)).toEqual(['4.7.3']);
    expect(customVersion).toBe('4.7.3');
    expect(requests).toEqual([
      {authorization: 'Bearer fixture-token', url: GITHUB_RELEASES_URL},
      {authorization: 'Bearer fixture-token', url: GITHUB_RELEASES_URL},
      {authorization: undefined, url: 'https://mirror.example/releases'},
    ]);
  }).pipe(provideTestLayer(SystemInfo.layer)),
);

fcEffectProp(
  effectIt,
  'never forwards a GitHub credential to generated custom release sources',
  {host: fc.domain()},
  ({host}) =>
    Effect.gen(function* () {
      const source = `https://${host}/releases`;
      const headers = yield* githubReleaseHeaders(source);
      expect(headers).not.toHaveProperty('authorization');
      expect(headers['user-agent']).toBe('threadnote-cli');
    }),
  {fastCheck: {numRuns: 100}},
);
