import {Effect} from 'effect';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {RuntimeConfig} from '../../src/types.js';
import {startManagerTestServer, type ManagerTestServer} from '../helpers/manager-test-server.js';
import {mkdir, mkdtemp, rm, writeFile} from '../helpers/node-fs-promises.js';
import {tmpdir} from '../helpers/node-os.js';
import {join} from '../helpers/node-path.js';

const mocks = vi.hoisted(() => ({
  prepareIsolated: vi.fn(),
}));

vi.mock('../../src/code_graph/workset_catalog/isolated_prepare.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/code_graph/workset_catalog/isolated_prepare.js')>()),
  prepareManagerCodeGraphWorksetIsolated: mocks.prepareIsolated,
}));

let activeRoot: string | undefined;
let activeServer: ManagerTestServer | undefined;
let releasePreparation: (() => void) | undefined;

afterEach(async () => {
  releasePreparation?.();
  releasePreparation = undefined;
  await activeServer?.close();
  activeServer = undefined;
  if (activeRoot) await rm(activeRoot, {force: true, recursive: true});
  activeRoot = undefined;
  mocks.prepareIsolated.mockReset();
});

describe('Manager workset process isolation over HTTP', () => {
  it('serves jobs and graph status before a default isolated preparation is released', async () => {
    activeRoot = await mkdtemp(join(tmpdir(), 'threadnote-manager-isolated-http-'));
    const home = join(activeRoot, 'home');
    const manifestPath = join(activeRoot, 'threadnote.yaml');
    await mkdir(home, {recursive: true});
    await writeFile(
      manifestPath,
      [
        'version: 1',
        'projects:',
        '  - name: api',
        `    path: ${join(activeRoot, 'api')}`,
        '    uri: threadnote://resources/repos/api',
        '    seed: []',
        'worksets:',
        '  - name: platform',
        '    projects: [api]',
        '',
      ].join('\n'),
    );
    const config = {
      account: 'local',
      agentContextHome: home,
      agentId: 'threadnote',
      manifestPath,
      user: 'manager-test',
    } satisfies RuntimeConfig;
    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => (signalStarted = resolve));
    const release = new Promise<void>(resolve => (releasePreparation = resolve));
    mocks.prepareIsolated.mockImplementation((_config, workset: string) =>
      Effect.promise(async () => {
        signalStarted();
        await release;
        return {
          coverage: {complete: true, excluded: 0, failed: 0, missing: 0, ready: 1, requested: 1},
          manifestDigest: 'a'.repeat(64),
          members: [
            {
              project: 'api',
              projectionDigest: 'b'.repeat(64),
              repositoryId: 'c'.repeat(64),
              snapshotId: `cgsn_${'d'.repeat(40)}`,
              state: 'ready' as const,
              symbolCount: 1,
            },
          ],
          state: 'ready' as const,
          type: 'code-graph-workset-prepare' as const,
          version: 1 as const,
          workset,
        };
      }),
    );
    activeServer = await startManagerTestServer(config, 'isolation-secret');
    const headers = {authorization: 'Bearer isolation-secret'};
    const prepare = await fetch(`${activeServer.url}/api/worksets/prepare`, {
      body: JSON.stringify({concurrency: 2, workset: 'platform'}),
      headers: {...headers, 'content-type': 'application/json'},
      method: 'POST',
      signal: AbortSignal.timeout(2_000),
    });
    expect(prepare.status).toBe(202);
    const id = ((await prepare.json()) as {readonly job: {readonly id: string}}).job.id;
    await started;
    expect(mocks.prepareIsolated).toHaveBeenCalledOnce();
    expect(mocks.prepareIsolated.mock.calls[0]?.[2]).toMatchObject({concurrency: 2});

    const [job, jobs, graphStatus] = await Promise.all(
      [`/api/worksets/jobs/${id}`, '/api/worksets/jobs', '/api/graphs/status'].map(path =>
        fetch(`${activeServer!.url}${path}`, {headers, signal: AbortSignal.timeout(2_000)}),
      ),
    );

    expect([job.status, jobs.status, graphStatus.status]).toEqual([200, 200, 200]);
    expect(await job.json()).toMatchObject({job: {id, status: 'running'}});
    expect(await jobs.json()).toMatchObject({jobs: [expect.objectContaining({id, status: 'running'})]});
    expect(await graphStatus.json()).toMatchObject({builds: expect.any(Array)});
  });
});
