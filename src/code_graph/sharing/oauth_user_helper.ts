import {Effect, Path} from 'effect';
import {fromPromiseInterruptibleAwaiting} from '../../effect/errors.js';
import {SystemInfo} from '../../effect/system.js';
import {getGraphOAuthUserCredential} from './oauth_user.js';
import {graphSharingFailure} from './errors.js';

export interface GraphOAuthUserHelperIO {
  readonly stdin: AsyncIterable<Uint8Array | string>;
  readonly writeStderr: (text: string) => void;
  readonly writeStdout: (text: string) => void;
}

export const runGraphOAuthUserHelper = Effect.fn('codeGraph.sharing.oauthUserHelper')(function* (
  arguments_: readonly string[],
  io: GraphOAuthUserHelperIO,
) {
  const system = yield* SystemInfo;
  const path = yield* Path.Path;
  const home = system.environment().THREADNOTE_HOME;
  const unavailable = () => {
    io.writeStderr('Graph OAuth credential helper is unavailable.\n');
    return 1;
  };
  if (arguments_.length !== 1 || arguments_[0] !== 'get' || !home || !path.isAbsolute(home)) {
    return unavailable();
  }
  const result = yield* fromPromiseInterruptibleAwaiting(
    async () => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of io.stdin) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > 8_192) throw graphSharingFailure('Graph OAuth helper request is too large.');
        chunks.push(bytes);
      }
      return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks))) as unknown;
    },
    () => graphSharingFailure('Graph OAuth helper request is invalid.'),
  ).pipe(
    Effect.flatMap(input => getGraphOAuthUserCredential(home, input)),
    Effect.option,
  );
  if (result._tag === 'None') return unavailable();
  io.writeStdout(`${JSON.stringify(result.value)}\n`);
  return 0;
});
