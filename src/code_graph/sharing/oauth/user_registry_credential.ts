import {Effect, Path} from 'effect';
import {fromPromiseInterruptibleAwaiting} from '../../../effect/errors.js';
import {SystemInfo} from '../../../effect/system.js';
import {getRegistryOAuthUserCredential, type OAuthUserBackend} from './user.js';
import {graphSharingFailure} from '../errors.js';

export interface OAuthUserRegistryHelperIO {
  readonly stdin: AsyncIterable<Uint8Array | string>;
  readonly writeStderr: (text: string) => void;
  readonly writeStdout: (text: string) => void;
}

/** Docker's get protocol sends an exact registry host, never an URL or repository path. */
export const runOAuthUserRegistryCredentialHelper = Effect.fn('codeGraph.sharing.oauthUserRegistryCredentialHelper')(
  function* (arguments_: readonly string[], io: OAuthUserRegistryHelperIO, backendOverride?: OAuthUserBackend) {
    const system = yield* SystemInfo;
    const path = yield* Path.Path;
    const home = system.environment().THREADNOTE_HOME ?? path.join(system.homeDirectory, '.threadnote');
    const unavailable = () => {
      io.writeStderr('OAuth registry credential unavailable.\n');
      return 1;
    };
    if (arguments_.length !== 1 || arguments_[0] !== 'get' || !path.isAbsolute(home)) return unavailable();
    const result = yield* fromPromiseInterruptibleAwaiting(
      async () => {
        const chunks: Uint8Array[] = [];
        let length = 0;
        for await (const chunk of io.stdin) {
          const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
          length += bytes.length;
          if (length > 512) throw graphSharingFailure('Registry helper request is too large.');
          chunks.push(bytes);
        }
        const value = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks));
        if (!value.endsWith('\n') || value.indexOf('\n') !== value.length - 1)
          throw graphSharingFailure('Registry helper request is invalid.');
        const server = value.slice(0, -1);
        if (!/^[a-z0-9.-]+(?::[1-9][0-9]{0,4})?$/u.test(server))
          throw graphSharingFailure('Registry helper request is invalid.');
        return server;
      },
      () => graphSharingFailure('Registry helper request is invalid.'),
    ).pipe(
      Effect.flatMap(server => getRegistryOAuthUserCredential(home, server, backendOverride)),
      Effect.option,
    );
    if (result._tag === 'None') return unavailable();
    io.writeStdout(
      `${JSON.stringify({
        Secret: result.value.accessToken,
        ServerURL: result.value.audience,
        Username: 'zot',
      })}\n`,
    );
    return 0;
  },
);
