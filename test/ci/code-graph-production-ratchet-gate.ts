import {enforceCodeGraphBenchmarkRatchet} from '../../scripts/benchmark-code-graph.js';
import {parseBenchmarkArtifactV1} from '../../src/evaluation/benchmark.js';

interface GateArguments {
  readonly artifactPath: string;
  readonly controlPath?: string;
  readonly expectedControlCommit?: string;
  readonly ratchetPath: string;
}

function requiredValue(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

export function parseCodeGraphProductionRatchetGateArguments(args: readonly string[]): GateArguments {
  const known = new Set(['--artifact', '--control', '--expected-control-commit', '--ratchet']);
  for (let index = 0; index < args.length; index += 2) {
    if (!known.has(args[index] ?? '') || args[index + 1] === undefined) {
      throw new Error(`Unknown or incomplete production ratchet gate argument: ${args[index] ?? '<missing>'}`);
    }
  }
  const artifactPath = requiredValue(args, '--artifact');
  const ratchetPath = requiredValue(args, '--ratchet');
  const controlPath = args.includes('--control') ? requiredValue(args, '--control') : undefined;
  const expectedControlCommit = args.includes('--expected-control-commit')
    ? requiredValue(args, '--expected-control-commit')
    : undefined;
  if ((controlPath === undefined) !== (expectedControlCommit === undefined)) {
    throw new Error('--control and --expected-control-commit must be provided together.');
  }
  return {artifactPath, controlPath, expectedControlCommit, ratchetPath};
}

async function readJson(path: string): Promise<unknown> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`Production ratchet gate input does not exist: ${path}`);
  return file.json() as Promise<unknown>;
}

export async function runCodeGraphProductionRatchetGate(args: readonly string[]): Promise<void> {
  const options = parseCodeGraphProductionRatchetGateArguments(args);
  const [artifactValue, ratchet, controlValue] = await Promise.all([
    readJson(options.artifactPath),
    readJson(options.ratchetPath),
    options.controlPath ? readJson(options.controlPath) : Promise.resolve(undefined),
  ]);
  const artifact = parseBenchmarkArtifactV1(artifactValue);
  const pairedControl =
    controlValue === undefined || options.expectedControlCommit === undefined
      ? undefined
      : {
          artifact: parseBenchmarkArtifactV1(controlValue),
          expectedCommit: options.expectedControlCommit,
        };
  enforceCodeGraphBenchmarkRatchet(artifact, ratchet, pairedControl);
}

if (import.meta.main) await runCodeGraphProductionRatchetGate(Bun.argv.slice(2));
