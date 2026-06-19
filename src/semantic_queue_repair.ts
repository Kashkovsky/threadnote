import {existsSync} from 'node:fs';
import {copyFile, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {findOpenVikingServer, runStart, runStop} from './lifecycle.js';
import type {RepairSemanticQueueOptions, RuntimeConfig} from './types.js';
import {errorMessage, expandPath, findExecutable, runCommand} from './utils.js';

// Temporary bridge for the OpenViking semantic-queue poison loop (#2734): a
// memory FILE reindexed with mode=semantic_and_vectors enqueues a directory-level
// semantic message; OpenViking's _process_memory_directory lists the file, fails,
// and the AGFS-persisted message re-enqueues forever. This patches the installed
// OpenViking to skip non-directory/missing memory URIs (upstream PR #2735).
//
// REMOVE-WHEN: DEFAULT_OPENVIKING_VERSION (src/constants.ts) is bumped to an
// OpenViking release that includes PR #2735. Then delete this module, its
// `repair-semantic-queue` command, the post-update migration entry, and the docs
// note.

const HOTFIX_MARKER = 'THREADNOTE-HOTFIX-2734';
const ENV_OVERRIDE = 'THREADNOTE_OPENVIKING_SEMANTIC_PROCESSOR';

export type SemanticPatchResult =
  | {readonly status: 'patched'; readonly source: string}
  | {readonly status: 'already-fixed'}
  | {readonly status: 'no-anchor'};

/**
 * Insert the upstream #2735 guard into OpenViking's semantic_processor.py source
 * so a context_type="memory" message whose URI is a file (or a vanished
 * directory) is skipped instead of re-enqueued forever. Pure and idempotent:
 * returns `already-fixed` when a stat(dir_uri) guard (or this hot-fix marker) is
 * already present, and `no-anchor` when the expected _process_memory_directory /
 * ls(dir_uri) shape is missing so the caller makes no changes.
 */
export function patchSemanticProcessorSource(source: string): SemanticPatchResult {
  if (source.includes(HOTFIX_MARKER)) {
    return {status: 'already-fixed'};
  }
  const lines = source.split('\n');
  const defIndex = lines.findIndex(line => /^\s*async def _process_memory_directory\b/.test(line));
  if (defIndex < 0) {
    return {status: 'no-anchor'};
  }

  const lsPattern = /^(\s+)entries = await viking_fs\.ls\(dir_uri\b/;
  let lsIndex = -1;
  let lsIndent = '';
  for (let i = defIndex + 1; i < lines.length; i += 1) {
    const match = lsPattern.exec(lines[i]);
    if (match) {
      lsIndex = i;
      lsIndent = match[1];
      break;
    }
    if (/^\s*async def \w/.test(lines[i])) {
      break; // left the method without finding the anchor
    }
  }
  if (lsIndex < 0) {
    return {status: 'no-anchor'};
  }

  // A stat(dir_uri) guard already above the ls (e.g. the upstream fix) means done.
  if (lines.slice(defIndex, lsIndex).some(line => line.includes('viking_fs.stat(dir_uri'))) {
    return {status: 'already-fixed'};
  }

  // The first meaningful line above the ls must be the `try:` that wraps it.
  let tryIndex = -1;
  let base = '';
  for (let j = lsIndex - 1; j > defIndex; j -= 1) {
    const text = lines[j];
    if (text.trim() === '' || text.trimStart().startsWith('#')) {
      continue;
    }
    const match = /^(\s*)try:\s*$/.exec(text);
    if (match && match[1].length < lsIndent.length) {
      tryIndex = j;
      base = match[1];
    }
    break; // only the first meaningful line above the ls is considered
  }
  if (tryIndex < 0) {
    return {status: 'no-anchor'};
  }

  const unit = ' '.repeat(lsIndent.length - base.length);
  const at = (level: number, text: string): string => `${base}${unit.repeat(level)}${text}`;
  const guard = [
    at(0, `# ${HOTFIX_MARKER}: skip non-directory / missing memory URIs so a memory file`),
    at(0, '# reindexed with mode=semantic_and_vectors cannot poison the semantic queue.'),
    at(0, '# Temporary local hot-fix; superseded once OpenViking ships upstream PR #2735.'),
    at(0, 'try:'),
    at(1, '_tn_dir_stat = await viking_fs.stat(dir_uri, ctx=ctx)'),
    at(0, 'except Exception as _tn_err:'),
    at(1, 'if isinstance(_tn_err, FileNotFoundError) or "not found" in str(_tn_err).lower():'),
    at(2, '_mark_done()'),
    at(2, 'return'),
    at(1, '_tn_dir_stat = None'),
    at(0, 'if _tn_dir_stat is not None and not _tn_dir_stat.get("isDir", _tn_dir_stat.get("is_dir", False)):'),
    at(1, '_mark_done()'),
    at(1, 'return'),
  ];
  const patched = [...lines.slice(0, tryIndex), ...guard, ...lines.slice(tryIndex)].join('\n');
  return {status: 'patched', source: patched};
}

async function semanticProcessorCandidates(root: string): Promise<readonly string[]> {
  const lib = join(root, 'lib');
  if (!existsSync(lib)) {
    return [];
  }
  let entries: string[];
  try {
    entries = await readdir(lib);
  } catch {
    return [];
  }
  return entries
    .filter(name => name.startsWith('python'))
    .map(name => join(lib, name, 'site-packages', 'openviking', 'storage', 'queuefs', 'semantic_processor.py'));
}

export async function locateSemanticProcessorPath(): Promise<string | undefined> {
  const override = process.env[ENV_OVERRIDE]?.trim();
  if (override) {
    const resolved = expandPath(override);
    if (existsSync(resolved)) {
      return resolved;
    }
  }

  const roots: string[] = [];
  const server = await findOpenVikingServer();
  if (server) {
    roots.push(dirname(dirname(server))); // <venv>/bin/openviking-server -> <venv>
  }
  roots.push(join(homedir(), '.local', 'share', 'uv', 'tools', 'openviking'));
  roots.push(join(homedir(), '.local', 'pipx', 'venvs', 'openviking'));

  for (const root of roots) {
    for (const candidate of await semanticProcessorCandidates(root)) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  // Last resort: ask the OpenViking venv python where the package lives.
  if (server) {
    const venvPython = join(dirname(server), process.platform === 'win32' ? 'python.exe' : 'python3');
    if (existsSync(venvPython)) {
      const result = await runCommand(
        venvPython,
        [
          '-c',
          'import openviking, os; print(os.path.join(os.path.dirname(openviking.__file__), "storage", "queuefs", "semantic_processor.py"))',
        ],
        {allowFailure: true},
      );
      const path = result.stdout.trim();
      if (result.exitCode === 0 && path && existsSync(path)) {
        return path;
      }
    }
  }
  return undefined;
}

async function assertPatchedSourceCompiles(source: string): Promise<void> {
  const python = await findExecutable(['python3', 'python']);
  if (!python) {
    console.warn('WARN python3 not found; skipping compile validation of the patched OpenViking source.');
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'threadnote-ov-patch-'));
  const file = join(dir, 'semantic_processor_patched.py');
  try {
    await writeFile(file, source, 'utf8');
    const result = await runCommand(python, ['-m', 'py_compile', file], {allowFailure: true});
    if (result.exitCode !== 0) {
      throw new Error(`patched OpenViking source failed to compile: ${result.stderr.trim() || result.stdout.trim()}`);
    }
  } finally {
    await rm(dir, {force: true, recursive: true});
  }
}

export async function runRepairSemanticQueue(
  config: RuntimeConfig,
  options: RepairSemanticQueueOptions,
): Promise<void> {
  const apply = options.apply === true && options.dryRun !== true;

  const path = await locateSemanticProcessorPath();
  if (!path) {
    console.error(
      'Could not locate the installed OpenViking semantic_processor.py. ' +
        `Set ${ENV_OVERRIDE}=/path/to/openviking/storage/queuefs/semantic_processor.py and retry.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`OpenViking semantic processor: ${path}`);

  let original: string;
  try {
    original = await readFile(path, 'utf8');
  } catch (err: unknown) {
    console.error(`Could not read ${path}: ${errorMessage(err)}`);
    process.exitCode = 1;
    return;
  }

  const result = patchSemanticProcessorSource(original);
  if (result.status === 'already-fixed') {
    console.log('OpenViking already guards non-directory memory URIs (#2734/#2735); nothing to patch.');
    return;
  }
  if (result.status === 'no-anchor') {
    console.warn(
      'WARN Could not find the _process_memory_directory ls(dir_uri) anchor; this OpenViking layout is ' +
        'unexpected, so no changes were made.',
    );
    return;
  }

  if (!apply) {
    console.log('Dry run: would patch OpenViking to skip non-directory/missing memory URIs, then restart the server.');
    console.log('Re-run with --apply to perform it.');
    return;
  }

  await assertPatchedSourceCompiles(result.source);

  const backup = `${path}.threadnote-bak`;
  if (!existsSync(backup)) {
    await copyFile(path, backup);
  }
  await writeFile(path, result.source, 'utf8');
  console.log(`Patched OpenViking semantic processor (backup: ${backup}).`);

  console.log('Restarting the OpenViking server so the patch loads and any stuck message drains...');
  await runStop(config, {});
  await runStart(config, {});
  console.log('Done. A stuck semantic message drains on the next dequeue; verify with: ov observer queue');
}
