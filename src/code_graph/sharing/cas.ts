import {Effect, FileSystem, Option, Path} from 'effect';
import {sha256FileHex} from '../../effect/digest.js';
import {writePrivateBytesFile} from './atomic.js';
import {parseSha256Digest, sha256Digest, sha256HexFromDigest} from './digest.js';
import {graphSharingFailure} from './errors.js';
import {graphSharingCasBlobPath} from './layout.js';

export const putCasBytes = Effect.fn('codeGraph.sharing.putCasBytes')(function* (casRoot: string, bytes: Uint8Array) {
  const path = yield* Path.Path;
  const digest = sha256Digest(bytes);
  const destination = graphSharingCasBlobPath(path, casRoot, sha256HexFromDigest(digest));
  const fs = yield* FileSystem.FileSystem;
  if (yield* fs.exists(destination)) {
    const existing = yield* verifyCasBlob(casRoot, digest);
    if (existing.length !== bytes.length) {
      return yield* graphSharingFailure(`CAS object already exists with a different size: ${digest}`);
    }
    return digest;
  }
  yield* writePrivateBytesFile(destination, bytes);
  return digest;
});

export const putCasFile = Effect.fn('codeGraph.sharing.putCasFile')(function* (casRoot: string, sourcePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (Option.isSome(yield* fs.readLink(sourcePath).pipe(Effect.option))) {
    return yield* graphSharingFailure('CAS source must not be a symbolic link.');
  }
  const hex = yield* sha256FileHex(sourcePath);
  const digest = parseSha256Digest(hex);
  const destination = graphSharingCasBlobPath(path, casRoot, hex);
  if (yield* fs.exists(destination)) {
    yield* verifyCasBlob(casRoot, digest);
    return digest;
  }
  const bytes = yield* fs.readFile(sourcePath);
  yield* writePrivateBytesFile(destination, bytes);
  return digest;
});

export const verifyCasBlob = Effect.fn('codeGraph.sharing.verifyCasBlob')(function* (casRoot: string, digest: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const expected = parseSha256Digest(digest, 'CAS digest');
  const target = graphSharingCasBlobPath(path, casRoot, sha256HexFromDigest(expected));
  if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option))) {
    return yield* graphSharingFailure(`CAS object must not be a symbolic link: ${expected}`);
  }
  if (!(yield* fs.exists(target))) {
    return yield* graphSharingFailure(`CAS object is missing: ${expected}`);
  }
  const actual = parseSha256Digest(yield* sha256FileHex(target), 'CAS digest');
  if (actual !== expected) {
    return yield* graphSharingFailure(`CAS object digest mismatch: ${expected}`);
  }
  return yield* fs.readFile(target);
});

export const casBlobPath = Effect.fn('codeGraph.sharing.casBlobPath')(function* (casRoot: string, digest: string) {
  const path = yield* Path.Path;
  return graphSharingCasBlobPath(path, casRoot, sha256HexFromDigest(digest));
});
