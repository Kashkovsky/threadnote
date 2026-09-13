import {execFile} from '../helpers/node-child-process.js';
import {promisify} from '../helpers/node-util.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {describe, expect, it} from 'vitest';
import {mkdir, mkdtemp, readFile, rm, writeFile} from '../helpers/node-fs-promises.js';
import {tmpdir} from '../helpers/node-os.js';
import {join} from '../helpers/node-path.js';
import {canonicalJson} from '../../src/code_graph/checkpoint/canonical_json.js';
import {sha256Digest, sha256HexFromDigest} from '../../src/code_graph/sharing/digest.js';
import {defaultGraphShareProfile, graphShareProfileDigest} from '../../src/code_graph/sharing/profile.js';

describe('MCP-owned signed graph contribution', () => {
  it('queues and delivers a signed candidate from an ordinary graph query without a contribute command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-signed-mcp-index-'));
    const home = join(root, 'home');
    const cas = join(root, 'cas');
    const repository = join(root, 'repository');
    const repositoryId = sha256HexFromDigest(sha256Digest('repository-v1\ngithub.com/acme/signed-mcp-index'));
    const command = promisify(execFile);
    const requests: string[] = [];
    const registryBlobs = new Map<string, Uint8Array>();
    const registryManifests = new Map<string, Uint8Array>();
    let delivered = false;
    const coordinator = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async request => {
        const url = new URL(request.url);
        requests.push(`${request.method} ${url.pathname}`);
        if (url.pathname === '/v1/enroll') {
          const body = (await request.json()) as {
            profileDigest: string;
            repositoryId: string;
            signingPublicKey: string;
          };
          return Response.json(
            {
              expiresAt: Math.floor(Date.now() / 1000) + 3600,
              principalId: sha256Digest(JSON.stringify(['https://identity.example.test/', 'signed-mcp-fixture'])),
              profileDigest: body.profileDigest,
              repositoryId: body.repositoryId,
              schemaVersion: 1,
              signingPublicKey: body.signingPublicKey,
              workerId: `gw_${'1'.repeat(32)}`,
            },
            {status: 201},
          );
        }
        if (url.pathname === '/v1/results') {
          const body = (await request.json()) as {body: {idempotencyKey: string}};
          delivered = true;
          return Response.json({idempotencyKey: body.body.idempotencyKey, status: 'accepted'}, {status: 201});
        }
        if (url.pathname.startsWith('/v2/acme/worker/')) {
          const suffix = url.pathname.slice('/v2/acme/worker/'.length);
          if (request.method === 'POST' && suffix === 'blobs/uploads/')
            return new Response(null, {
              status: 202,
              headers: {location: '/v2/acme/worker/blobs/uploads/fixture?_state=opaque'},
            });
          if (request.method === 'PUT') {
            const bytes = new Uint8Array(await request.arrayBuffer());
            const digest = sha256Digest(bytes);
            if (suffix.startsWith('blobs/uploads/')) {
              if (url.searchParams.get('digest') !== digest) return new Response(null, {status: 400});
              registryBlobs.set(digest, bytes);
            } else if (suffix.startsWith('manifests/')) {
              registryManifests.set(suffix.slice('manifests/'.length), bytes);
            } else return new Response(null, {status: 400});
            return new Response(null, {status: 201, headers: {'docker-content-digest': digest}});
          }
          const isManifest = suffix.startsWith('manifests/');
          const bytes = (isManifest ? registryManifests : registryBlobs).get(
            suffix.slice(isManifest ? 'manifests/'.length : 'blobs/'.length),
          );
          if (bytes === undefined) return new Response(null, {status: 404});
          return new Response(request.method === 'HEAD' ? null : Uint8Array.from(bytes), {
            headers: {
              'content-length': String(bytes.length),
              'content-type': isManifest ? 'application/vnd.oci.image.manifest.v1+json' : 'application/octet-stream',
              'docker-content-digest': sha256Digest(bytes),
            },
          });
        }
        return Response.json({
          generation: 1,
          organization: 'acme',
          phase: 'idle',
          publishedFrontier: null,
          repositoryId,
          receipts: [],
        });
      },
    });
    let client: Client | undefined;
    try {
      await mkdir(join(home, 'graph-sharing'), {recursive: true});
      await mkdir(join(cas, 'sha256'), {recursive: true});
      await mkdir(join(repository, 'src'), {recursive: true});
      await mkdir(join(root, 'helpers'), {recursive: true});
      await mkdir(join(root, 'docker'), {recursive: true});
      await writeFile(join(home, 'seed-manifest.yaml'), 'version: 1\nprojects: []\n');
      await writeFile(
        join(root, 'docker', 'config.json'),
        JSON.stringify({credHelpers: {'registry.example.test': 'fixture'}}),
      );
      await writeFile(
        join(root, 'helpers', 'threadnote-credential-fixture'),
        `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({
  accessToken: 'synthetic-token',
  audience: 'https://control.example.test/',
  expiresAt: Math.floor(Date.now() / 1000) + 600,
  issuer: 'https://identity.example.test/',
  schemaVersion: 1,
  subject: 'signed-mcp-fixture',
}));
`,
      );
      await writeFile(
        join(root, 'helpers', 'docker-credential-fixture'),
        `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({Username: 'synthetic-publisher', Secret: 'fixture-only'}));
`,
      );
      await command('chmod', [
        '+x',
        join(root, 'helpers', 'threadnote-credential-fixture'),
        join(root, 'helpers', 'docker-credential-fixture'),
      ]);
      await writeFile(
        join(root, 'preload.js'),
        `const nativeFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== 'https://control.example.test' && url.origin !== 'https://registry.example.test') {
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')
      throw new Error('Unexpected external network request in synthetic graph fixture');
    return nativeFetch(input, init);
  }
  const rewritten = new Request(process.env.THREADNOTE_TEST_GRAPH_SYNTHETIC_ORIGIN + url.pathname + url.search, request);
  return nativeFetch(rewritten);
}, {preconnect: () => undefined});
`,
      );
      await writeFile(join(repository, 'src', 'index.ts'), 'export function signedMcpTarget() { return 42; }\n');
      await command('git', ['init', '-q', '--initial-branch=main', repository]);
      await command('git', [
        '-C',
        repository,
        'remote',
        'add',
        'origin',
        'https://github.com/acme/signed-mcp-index.git',
      ]);
      await command('git', ['-C', repository, 'add', '.']);
      await command('git', [
        '-C',
        repository,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        'fixture',
      ]);
      const {stdout: sourceCommit} = await command('git', ['-C', repository, 'rev-parse', 'HEAD']);
      const coordinatorUrl = 'https://control.example.test';
      const publisherKeyFingerprint = sha256Digest('synthetic publisher');
      const profile = {
        ...defaultGraphShareProfile({
          branch: 'main',
          canonicalRemote: 'github.com/acme/signed-mcp-index',
          coordinatorUrl,
          organization: 'acme',
          publisherKeyFingerprint,
          repositoryId,
        }),
        registry: {
          canonical: 'oci://registry.example.test/acme/canonical',
          worker: 'oci://registry.example.test/acme/worker',
        },
      };
      const profileBytes = new TextEncoder().encode(canonicalJson(profile));
      const profileDigest = graphShareProfileDigest(profile);
      await writeFile(join(cas, 'sha256', sha256HexFromDigest(profileDigest)), profileBytes);
      await writeFile(
        join(home, 'graph-sharing', 'trust-receipts.json'),
        JSON.stringify({
          receipts: [
            {
              accessMode: 'join',
              client: {casRoot: cas, contributionMode: 'passive', coordinatorUrl},
              organization: 'acme',
              policyVersion: 1,
              profileDigest,
              publisherKeyFingerprint,
              registryCanonical: profile.registry.canonical,
              repositoryId,
            },
          ],
          schemaVersion: 1,
        }),
      );
      await writeFile(
        join(home, 'graph-sharing', 'control-credentials.json'),
        JSON.stringify({
          bindings: [
            {
              audience: 'https://control.example.test/',
              coordinatorUrl,
              helper: 'fixture',
              issuer: 'https://identity.example.test/',
              organization: 'acme',
            },
          ],
          schemaVersion: 1,
        }),
      );

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [`--preload=${join(root, 'preload.js')}`, join(process.cwd(), 'src/standalone.ts'), 'mcp-server'],
        cwd: process.cwd(),
        stderr: 'pipe',
        env: {
          ...process.env,
          THREADNOTE_HOME: home,
          THREADNOTE_MANIFEST: join(home, 'seed-manifest.yaml'),
          THREADNOTE_ACCOUNT: 'local',
          THREADNOTE_USER: 'tester',
          THREADNOTE_TELEMETRY: '0',
          THREADNOTE_MCP_TOOLSET: 'cursor-cloud-local',
          THREADNOTE_TEST_GRAPH_SYNTHETIC_ORIGIN: `http://127.0.0.1:${coordinator.port}`,
          DOCKER_CONFIG: join(root, 'docker'),
          PATH: `${join(root, 'helpers')}:${process.env.PATH ?? ''}`,
        },
      });
      client = new Client({name: 'signed-mcp-index-fixture', version: '1'});
      await client.connect(transport);
      const result = await client.callTool({
        name: 'inspect_code_graph',
        arguments: {callerCwd: repository, operation: 'query', query: 'signedMcpTarget', budgetTokens: 800},
      });
      expect(result.isError).not.toBe(true);

      const candidatePath = join(home, 'graph-sharing', 'signed-candidates', `${repositoryId}.json`);
      const candidates = await waitForCandidates(candidatePath);
      const packageVersion = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')).version;
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        casRoot: cas,
        organization: 'acme',
        partialCoverage: false,
        profileDigest,
        releaseIdentity: packageVersion,
        resourceLimits: [],
        sourceCommit: sourceCommit.trim(),
      });
      expect(candidates[0].graphAbi).toMatch(/^[0-9a-f]{64}$/u);
      expect(candidates[0].snapshotId).toMatch(/^cgsn_[0-9a-f]{40}/u);
      await waitFor(() => delivered, 20_000);
      expect(requests).toContain('POST /v1/enroll');
      expect(requests).toContain('POST /v1/results');
      expect(registryBlobs.size).toBeGreaterThan(0);
      expect(registryManifests.size).toBeGreaterThan(0);
      await waitFor(async () => (await readJournalCandidates(candidatePath)).length === 0, 5_000);
    } finally {
      await client?.close();
      await coordinator.stop(true);
      await rm(root, {recursive: true, force: true});
    }
  }, 60_000);
});

async function waitForCandidates(path: string): Promise<Array<Record<string, unknown>>> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const candidates = await readJournalCandidates(path);
    if (candidates.length > 0) return candidates;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for an automatically queued signed graph candidate.');
}

async function readJournalCandidates(path: string): Promise<Array<Record<string, unknown>>> {
  const manifestText = await readFile(path, 'utf8').catch(() => undefined);
  if (manifestText === undefined) return [];
  const manifest = JSON.parse(manifestText);
  const pages = await Promise.all(
    manifest.segments.map((segment: {id: string}) => readFile(join(`${path}.d`, `${segment.id}.json`), 'utf8')),
  );
  return pages.flatMap(page => JSON.parse(page).candidates);
}

async function waitFor(predicate: () => boolean | Promise<boolean>, milliseconds: number): Promise<void> {
  const until = Date.now() + milliseconds;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for passive signed graph delivery.');
}
