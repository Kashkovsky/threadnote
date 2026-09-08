import {execFile} from '../helpers/node-child-process.js';
import {promisify} from '../helpers/node-util.js';
import {graphShareContributionFixture} from '../helpers/graph-share-contribution.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {describe, expect, it} from 'vitest';
import {mkdir, mkdtemp, readFile, rm, writeFile} from '../helpers/node-fs-promises.js';
import {tmpdir} from '../helpers/node-os.js';
import {join} from '../helpers/node-path.js';
import {sha256Digest, sha256HexFromDigest} from '../../src/code_graph/sharing/digest.js';

describe('MCP-owned passive graph contribution retries', () => {
  it.each(['persisted queue', 'ordinary graph query'] as const)(
    'recovers automatically after an outage from %s',
    async source => {
      const root = await mkdtemp(join(tmpdir(), 'threadnote-mcp-contribution-retry-'));
      const home = join(root, 'home');
      const cas = join(root, 'cas');
      const repository = join(root, 'repository');
      const repositoryId = sha256HexFromDigest(sha256Digest('repository-v1\ngithub.com/acme/automatic-contribution'));
      const command = promisify(execFile);
      let healthy = false;
      let refusedRequests = 0;
      let deliveredRequests = 0;
      let refused!: () => void;
      let delivered!: () => void;
      const firstRefusal = new Promise<void>(resolve => {
        refused = resolve;
      });
      const firstDelivery = new Promise<void>(resolve => {
        delivered = resolve;
      });
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: async request => {
          await request.arrayBuffer();
          if (request.method === 'GET')
            return Response.json({
              generation: 1,
              organization: 'acme',
              phase: 'idle',
              publishedFrontier: null,
              repositoryId,
              receipts: [],
            });
          if (!healthy) {
            refusedRequests += 1;
            refused();
            return Response.json({}, {status: 503, headers: {'Retry-After': '1'}});
          }
          if (new URL(request.url).pathname === '/v1/results') {
            deliveredRequests += 1;
            delivered();
          }
          return Response.json({});
        },
      });
      let client: Client | undefined;
      try {
        await mkdir(join(home, 'graph-sharing', 'contribution'), {recursive: true});
        await mkdir(join(cas, 'sha256'), {recursive: true});
        await writeFile(join(home, 'seed-manifest.yaml'), 'version: 1\nprojects: []\n');
        if (source === 'ordinary graph query') {
          await mkdir(join(repository, 'src'), {recursive: true});
          await writeFile(
            join(repository, 'src', 'index.ts'),
            'export function automaticContributionTarget() { return 42; }\n',
          );
          await command('git', ['init', '-q', '--initial-branch=main', repository]);
          await command('git', [
            '-C',
            repository,
            'remote',
            'add',
            'origin',
            'https://github.com/acme/automatic-contribution.git',
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
        }
        const {announcement, resultBytes, attestationBytes} = graphShareContributionFixture(repositoryId);
        const {resultManifestDigest, attestationDigest} = announcement;
        await writeFile(join(cas, 'sha256', sha256HexFromDigest(resultManifestDigest)), resultBytes);
        await writeFile(join(cas, 'sha256', sha256HexFromDigest(attestationDigest)), attestationBytes);
        await writeFile(
          join(home, 'graph-sharing', 'trust-receipts.json'),
          JSON.stringify({
            schemaVersion: 1,
            receipts: [
              {
                accessMode: 'join',
                organization: 'acme',
                policyVersion: 1,
                profileDigest: sha256Digest('profile'),
                publisherKeyFingerprint: sha256Digest('publisher'),
                registryCanonical: 'cas://local',
                repositoryId,
                client: {casRoot: cas, contributionMode: 'passive', coordinatorUrl: `http://127.0.0.1:${server.port}`},
              },
            ],
          }),
        );
        const queuePath = join(home, 'graph-sharing', 'contribution', `${repositoryId}.json`);
        if (source === 'persisted queue')
          await writeFile(
            queuePath,
            JSON.stringify({
              schemaVersion: 1,
              mode: 'passive',
              announcements: [announcement],
            }),
          );
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [join(process.cwd(), 'src/standalone.ts'), 'mcp-server'],
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
          },
        });
        client = new Client({name: 'contribution-retry-fixture', version: '1'});
        await client.connect(transport);
        if (source === 'ordinary graph query') {
          const result = await client.callTool({
            name: 'inspect_code_graph',
            arguments: {
              callerCwd: repository,
              operation: 'query',
              query: 'automaticContributionTarget',
              budgetTokens: 800,
            },
          });
          expect(result.isError).not.toBe(true);
        }
        await within(firstRefusal, 20_000);
        expect(refusedRequests).toBe(1);
        expect(JSON.parse(await readFile(queuePath, 'utf8')).announcements.length).toBeGreaterThan(0);
        healthy = true;
        await within(firstDelivery, 20_000);
        expect(deliveredRequests).toBeGreaterThan(0);
      } finally {
        await client?.close();
        await server.stop(true);
        await rm(root, {recursive: true, force: true});
      }
    },
    45_000,
  );
});

async function within<A>(promise: Promise<A>, milliseconds: number): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Timed out waiting for automatic contribution progress.')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
