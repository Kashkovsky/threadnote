import {execFile} from '../helpers/node-child-process.js';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from '../helpers/node-fs-promises.js';
import {tmpdir} from '../helpers/node-os.js';
import {join} from '../helpers/node-path.js';
import {promisify} from '../helpers/node-util.js';
import {withoutOmpPathSelectors} from '../helpers/omp-environment.js';
import {expect, it} from 'vitest';

const execute = promisify(execFile);
const entry = join(process.cwd(), 'src/standalone.ts');

it('stores an OMP state-only pre-compaction snapshot without reading Claude hook input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threadnote-omp-cli-'));
  try {
    const home = join(root, 'threadnote-home');
    const userHookCwd = join(root, 'user-home', '.omp');
    const repo = join(root, 'omp-hook-workspace');
    const transcript = join(root, 'claude-transcript.jsonl');
    await mkdir(userHookCwd, {recursive: true});
    await mkdir(home, {recursive: true});
    await execute('git', ['init', '--initial-branch=omp-smoke', repo]);
    await writeFile(transcript, 'This Claude transcript must not be read by the OMP hook.');
    await writeFile(
      join(home, '.update-state.json'),
      JSON.stringify({version: 3, channel: 'latest', checkedAt: new Date().toISOString(), latestVersion: '0.0.0'}),
    );
    const memoryRoot = join(home, 'data/local/user/local/memories/handoffs/active/omp-hook-workspace');
    const env = {
      ...withoutOmpPathSelectors(process.env),
      HOME: join(root, 'user-home'),
      USERPROFILE: join(root, 'user-home'),
      THREADNOTE_HOME: home,
      THREADNOTE_USER: 'local',
      THREADNOTE_CALLER_CWD: repo,
      THREADNOTE_AUTO_UPDATE: '0',
      NO_COLOR: '1',
    };
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [entry, 'pre-compact-hook', '--source-agent-client', 'omp'],
        {cwd: userHookCwd, env, timeout: 20_000},
        error => (error ? reject(error) : resolve()),
      );
      child.stdin!.end(JSON.stringify({session_id: 'claude-session', transcript_path: transcript}));
    });

    const snapshots = await readdir(memoryRoot);
    expect(snapshots).toHaveLength(1);
    const snapshot = await readFile(join(memoryRoot, snapshots[0]), 'utf8');
    expect(snapshot).toContain('source_agent_client: omp');
    expect(snapshot).toContain('Auto-snapshot captured at OMP preCompact');
    expect(snapshot).not.toContain('claude-session');
    expect(snapshot).not.toContain('must not be read');
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}, 45_000);
