import {Effect, FileSystem, Option, Path} from 'effect';
import {graphSharingFailure} from './errors.js';

export const writePrivateJsonFile = Effect.fn('codeGraph.sharing.writePrivateJsonFile')(function* (
  destination: string,
  value: unknown,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const parent = path.dirname(destination);
  yield* fs.makeDirectory(parent, {recursive: true, mode: 0o700});
  if (Option.isSome(yield* fs.readLink(destination).pipe(Effect.option))) {
    return yield* graphSharingFailure(`Refusing to replace a graph-sharing symbolic link: ${destination}`);
  }
  const temporary = `${destination}.tmp`;
  yield* fs.writeFileString(temporary, `${JSON.stringify(value)}\n`, {mode: 0o600});
  yield* fs
    .rename(temporary, destination)
    .pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
});

export const writePrivateBytesFile = Effect.fn('codeGraph.sharing.writePrivateBytesFile')(function* (
  destination: string,
  bytes: Uint8Array,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const parent = path.dirname(destination);
  yield* fs.makeDirectory(parent, {recursive: true, mode: 0o700});
  if (Option.isSome(yield* fs.readLink(destination).pipe(Effect.option))) {
    return yield* graphSharingFailure(`Refusing to replace a graph-sharing symbolic link: ${destination}`);
  }
  const temporary = `${destination}.tmp`;
  yield* fs.writeFile(temporary, bytes, {mode: 0o600});
  yield* fs
    .rename(temporary, destination)
    .pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
});

export const readJsonFile = Effect.fn('codeGraph.sharing.readJsonFile')(function* (target: string) {
  const fs = yield* FileSystem.FileSystem;
  if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option))) {
    return yield* graphSharingFailure(`Refusing to read a graph-sharing symbolic link: ${target}`);
  }
  const text = yield* fs.readFileString(target);
  return yield* Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: cause => graphSharingFailure('Graph-sharing metadata is not valid JSON.', cause),
  });
});
