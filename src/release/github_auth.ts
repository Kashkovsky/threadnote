import {Effect, Option} from 'effect';
import {CommandExecutor} from '../effect/command.js';
import {SystemInfo} from '../effect/system.js';

export const GITHUB_RELEASES_URL = 'https://api.github.com/repos/Kashkovsky/threadnote/releases?per_page=100';

const RELEASE_HEADERS = {
  accept: 'application/vnd.github+json',
  'user-agent': 'threadnote-cli',
} as const;

/** Only the official GitHub API may receive the machine's GitHub credential. */
export const githubReleaseHeaders = Effect.fn('githubReleaseHeaders')(function* (source: string) {
  if (source !== GITHUB_RELEASES_URL) return RELEASE_HEADERS;

  const system = yield* Effect.serviceOption(SystemInfo);
  if (Option.isNone(system)) return RELEASE_HEADERS;
  const environment = system.value.environment();
  let token = validToken(environment.GH_TOKEN) ?? validToken(environment.GITHUB_TOKEN);
  if (!token) {
    const command = yield* Effect.serviceOption(CommandExecutor);
    if (Option.isSome(command)) {
      const result = yield* command.value
        .execute('gh', ['auth', 'token', '--hostname', 'github.com'], {
          env: {...environment, GH_PROMPT_DISABLED: '1'},
          maxOutputBytes: 4096,
          timeoutMs: 2000,
        })
        .pipe(Effect.orElseSucceed(() => undefined));
      token = validToken(result?.stdout);
    }
  }

  return token ? {...RELEASE_HEADERS, authorization: `Bearer ${token}`} : RELEASE_HEADERS;
});

function validToken(value: string | undefined): string | undefined {
  const token = value?.trim();
  return token && token.length <= 4096 && /^[\x21-\x7e]+$/.test(token) ? token : undefined;
}
