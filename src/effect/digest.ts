import {createHash} from 'node:crypto';
import {Effect, FileSystem, Stream} from 'effect';
import {sha256HexSync} from '../crypto/sha256.js';

export const sha256Hex = Effect.fn('digest.sha256Hex')((value: string | Uint8Array) =>
  Effect.sync(() => sha256HexSync(value)),
);

export const sha256FileHex = Effect.fn('digest.sha256FileHex')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const hash = createHash('sha256');
  yield* fs.stream(path).pipe(Stream.runForEach(chunk => Effect.sync(() => hash.update(chunk))));
  return hash.digest('hex');
});
