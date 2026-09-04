import {ScriptError} from './errors.js';
import {Console, Effect, FileSystem, Path} from 'effect';
import {sha256Hex} from '../../src/effect/digest.js';
import {SystemInfo} from '../../src/effect/system.js';

export const scriptArguments = Effect.fn('script.arguments')(function* () {
  const system = yield* SystemInfo;
  return system.processArguments.slice(2);
});

export const resolveScriptPath = Effect.fn('script.resolvePath')(function* (value: string) {
  const path = yield* Path.Path;
  return path.resolve(value);
});

export const readJsonFile = Effect.fn('script.readJsonFile')(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(file);
  return yield* Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: cause => ScriptError.make({message: `Could not parse JSON file ${file}.`, cause}),
  });
});

export const atomicWrite = Effect.fn('script.atomicWrite')(function* (file: string, content: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const target = path.resolve(file);
  const temporary = `${target}.tmp-${system.processId}`;
  yield* fs.makeDirectory(path.dirname(target), {recursive: true});
  yield* Effect.gen(function* () {
    yield* fs.remove(temporary, {force: true});
    yield* fs.writeFileString(temporary, content, {flag: 'wx', mode: 0o600});
    yield* fs.rename(temporary, target);
  }).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
});

export const fixtureHash = Effect.fn('script.fixtureHash')((content: string) => sha256Hex(content));

export const printJson = Effect.fn('script.printJson')((value: unknown) =>
  Console.log(JSON.stringify(value, undefined, 2)),
);

export const markFailure = Effect.fn('script.markFailure')(function* () {
  const system = yield* SystemInfo;
  system.setExitCode(1);
});
