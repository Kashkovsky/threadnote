import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Effect} from 'effect';
import {ApplicationLayer} from '../src/effect/runtime.js';
import {parseBenchmarkArtifactV1, type BenchmarkArtifactV1} from '../src/evaluation/benchmark.js';
import {createCodeGraphProductionRatchet} from './benchmark-code-graph.js';
import {atomicWrite, printJson, readJsonFile, scriptArguments} from './effect/script.js';

const generate = Effect.gen(function* () {
  const {artifacts, outputPath} = parseArguments(yield* scriptArguments());
  const parsed: BenchmarkArtifactV1[] = [];
  for (const artifactPath of artifacts) {
    parsed.push(parseBenchmarkArtifactV1(yield* readJsonFile(artifactPath)));
  }
  const ratchet = createCodeGraphProductionRatchet(parsed);
  yield* atomicWrite(outputPath, `${JSON.stringify(ratchet, undefined, 2)}\n`);
  yield* printJson(ratchet);
});

function parseArguments(args: readonly string[]): {readonly artifacts: readonly string[]; readonly outputPath: string} {
  const artifacts: string[] = [];
  let outputPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--output') {
      const value = args[++index];
      if (!value?.trim()) throw new ScriptError('--output requires a path.');
      outputPath = value;
    } else if (argument.startsWith('-')) {
      throw new ScriptError(`Unknown production ratchet generator option: ${argument}`);
    } else {
      artifacts.push(argument);
    }
  }
  if (outputPath === undefined) throw new ScriptError('Production ratchet generation requires --output.');
  if (artifacts.length < 3) throw new ScriptError('Production ratchet generation requires at least three artifacts.');
  return {artifacts, outputPath};
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(generate, ApplicationLayer));
