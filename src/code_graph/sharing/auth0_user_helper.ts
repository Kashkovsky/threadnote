import {Effect, Path} from 'effect';
import {fromPromiseInterruptibleAwaiting} from '../../effect/errors.js';
import {SystemInfo} from '../../effect/system.js';
import {getGraphAuth0UserCredential} from './auth0_user.js';
import {graphSharingFailure} from './errors.js';

export const runGraphAuth0UserHelper = Effect.fn('codeGraph.sharing.auth0UserHelper')(function* (
  arguments_: readonly string[],
) {
  const system = yield* SystemInfo;
  const path = yield* Path.Path;
  const home = system.environment().THREADNOTE_HOME;
  if (arguments_.length !== 1 || arguments_[0] !== 'get' || !home || !path.isAbsolute(home)) {
    process.stderr.write('Graph Auth0 credential helper is unavailable.\n');
    process.exitCode = 1;
    return;
  }
  const result = yield* fromPromiseInterruptibleAwaiting(
    async () => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > 8_192) throw graphSharingFailure('Graph Auth0 helper request is too large.');
        chunks.push(bytes);
      }
      return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks))) as unknown;
    },
    () => graphSharingFailure('Graph Auth0 helper request is invalid.'),
  ).pipe(
    Effect.flatMap(input => getGraphAuth0UserCredential(home, input)),
    Effect.catch(() =>
      Effect.sync(() => {
        process.stderr.write('Graph Auth0 credential helper is unavailable.\n');
        process.exitCode = 1;
        return undefined;
      }),
    ),
  );
  if (result !== undefined) process.stdout.write(`${JSON.stringify(result)}\n`);
});
