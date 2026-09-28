/* oxlint-disable effecttsgo/node-builtin-import -- Git and Bazel are external process boundaries used before the graph is available. */
import {appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {bazelDiffPath, bazelPath} from '../bazel/cli-tools.mjs';
import {selectTargets} from './selection.mjs';

const root = resolve(import.meta.dir, '../..');
const option = name => process.argv[process.argv.indexOf(name) + 1];
const base = process.argv.includes('--base') ? option('--base') : undefined;
const output = resolve(root, process.argv.includes('--output') ? option('--output') : '.context/bazel-selection');
mkdirSync(output, {recursive: true});
const inventory = JSON.parse(readFileSync(join(root, 'tools/bazel/targets.json'), 'utf8'));
const run = async (args, cwd = root) => {
  const child = Bun.spawn(args, {cwd, stdout: 'pipe', stderr: 'pipe'});
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${args[0]} ${args[1]} failed (${code}): ${stderr.slice(-1500)}`);
  return stdout.trim();
};
const prepare = async cwd => {
  const script = join(cwd, 'apps/website/tools/site-prepared-metadata.ts');
  if (existsSync(script))
    await run([process.execPath, script, '--output', join(cwd, 'apps/website/.bazel-inputs/metadata.json')], cwd);
};
let changedFiles = [];
let impacted = [];
let failure;
let baseInventory;
let directory;
let executable;
try {
  if (!base || !/^[a-zA-Z0-9_./-]+$/u.test(base)) throw new Error('Missing or invalid baseline revision');
  const revision = await run(['git', 'rev-parse', '--verify', `${base}^{commit}`]);
  const tracked = await run(['git', 'diff', '--name-only', '--no-renames', '-z', revision]);
  const untracked = await run(['git', 'ls-files', '--others', '--exclude-standard', '-z']);
  changedFiles = [...new Set([tracked, untracked].flatMap(value => value.split('\0').filter(Boolean)))].sort();
  directory = mkdtempSync(join(tmpdir(), 'threadnote-bazel-base-'));
  await run(['git', 'worktree', 'add', '--detach', directory, revision]);
  if (!existsSync(join(directory, 'MODULE.bazel')) || !existsSync(join(directory, 'tools/bazel/targets.json')))
    throw new Error('Baseline has no modeled Bazel graph');
  await prepare(root);
  await run([process.execPath, 'tools/bazel/generate.mjs', '--check']);
  executable = await bazelPath(root);
  const diff = await bazelDiffPath(root);
  await run([process.execPath, 'install', '--frozen-lockfile', '--ignore-scripts'], directory);
  await prepare(directory);
  await run([process.execPath, 'tools/bazel/generate.mjs'], directory);
  baseInventory = JSON.parse(readFileSync(join(directory, 'tools/bazel/targets.json'), 'utf8'));
  for (const [name, cwd] of [
    ['base', directory],
    ['head', root],
  ]) {
    await run([
      diff,
      'generate-hashes',
      '-w',
      cwd,
      '-b',
      executable,
      '--bazelCommandOptions=--noshow_progress --lockfile_mode=off',
      join(output, `${name}.json`),
    ]);
  }
  await run([
    diff,
    'get-impacted-targets',
    '-w',
    root,
    '-b',
    executable,
    '--excludeExternalTargets=true',
    '--startingHashes',
    join(output, 'base.json'),
    '--finalHashes',
    join(output, 'head.json'),
    '-o',
    join(output, 'impacted.txt'),
  ]);
  impacted = readFileSync(join(output, 'impacted.txt'), 'utf8')
    .split('\n')
    .map(value => value.trim())
    .filter(Boolean);
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  if (directory) {
    if (executable) {
      try {
        await run([executable, 'shutdown'], directory);
      } catch {
        // Preserve the conservative selection result if the baseline server already exited.
      }
    }
    try {
      await run(['git', 'worktree', 'remove', '--force', directory]);
    } catch {
      rmSync(directory, {recursive: true, force: true});
    }
  }
}
const modeledInputs = [...inventory.targets, ...(baseInventory?.targets ?? [])].flatMap(target => target.inputs);
const declarations = [...inventory.targets, ...(baseInventory?.targets ?? [])].map(target => {
  const packagePath = target.label.slice(2).split(':')[0];
  return packagePath ? `${packagePath}/BUILD.bazel` : 'BUILD.bazel';
});
const result = selectTargets({
  inventory: inventory.targets.map(target => target.label),
  impacted,
  changedFiles,
  knownInputs: [...modeledInputs, ...declarations, 'tools/bazel/targets.json'],
  targetDependencies: Object.fromEntries(inventory.targets.map(target => [target.label, target.dependsOn ?? []])),
  targetInputs: Object.fromEntries(inventory.targets.map(target => [target.label, target.inputs])),
  failure,
});
writeFileSync(
  join(output, 'selection.json'),
  JSON.stringify({...result, base, changedFiles, modeledTargetCount: inventory.targets.length}, null, 2) + '\n',
);
writeFileSync(join(output, 'targets.txt'), result.targets.join('\n') + (result.targets.length ? '\n' : ''));
if (process.env.GITHUB_OUTPUT) {
  const selected = new Set(result.targets);
  const lanes = new Set(
    inventory.targets.flatMap(target => (target.kind === 'ci' && target.lane ? [target.lane] : [])),
  );
  for (const lane of [...lanes].sort()) {
    const enabled = inventory.targets.some(target => target.lane === lane && selected.has(target.label));
    appendFileSync(process.env.GITHUB_OUTPUT, `${lane}=${enabled}\n`);
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `targets=${JSON.stringify(result.targets)}\n`);
}
process.stdout.write(
  `${result.mode}: ${result.targets.length}/${inventory.targets.length} modeled targets (${result.reason})\n`,
);
