import {Database} from 'bun:sqlite';
import fc from 'fast-check';
import {afterEach, describe, expect, it} from 'vitest';
import {sha256HexSync} from '../../src/crypto/sha256.js';
import {
  CODE_GRAPH_WORKSET_CATALOG_SCHEMA_VERSION,
  codeGraphWorksetCatalogDatabasePath,
} from '../../src/code_graph/workset_catalog/layout.js';
import {
  codeGraphWorksetCatalogGenerationIdentity,
  createCodeGraphWorksetRoutingProjection,
} from '../../src/code_graph/workset_catalog/projection.js';
import {
  ensureCodeGraphWorksetCatalog,
  inspectCodeGraphWorksetCatalog,
  maintainCodeGraphWorksetCatalog,
  appendCodeGraphWorksetCatalogProjectionPage,
  beginCodeGraphWorksetCatalogProjection,
  codeGraphWorksetCatalogProjectionContainsNode,
  completeCodeGraphWorksetCatalogProjection,
  publishCodeGraphWorksetCatalogGeneration,
  readCodeGraphWorksetCatalogRoutingSymbols,
  readPublishedCodeGraphWorksetCatalogGeneration,
  recoverCodeGraphWorksetCatalog,
  stageCodeGraphWorksetCatalogGeneration,
  stageCodeGraphWorksetCatalogGenerationFromReceipts,
} from '../../src/code_graph/workset_catalog/store.js';
import {
  CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION,
  CodeGraphWorksetCatalogError,
  type CodeGraphWorksetCatalogGenerationInputV1,
  type CodeGraphWorksetCatalogGenerationMemberV1,
  type CodeGraphWorksetRoutingProjectionV1,
} from '../../src/code_graph/workset_catalog/types.js';
import {join, mkdir, mkdtemp, readFile, rm, stat, writeFile} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';

describe('code graph workset catalog', () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
  });

  it('uses an independent private schema with indexed normalized routing surfaces', async () => {
    const home = await temporaryHome(homes);
    await runEffect(ensureCodeGraphWorksetCatalog(home));
    const databasePath = catalogPath(home);

    expect(databasePath).toBe(
      join(home, 'indexes', 'code-graph', 'worksets', `catalog-v${CODE_GRAPH_WORKSET_CATALOG_SCHEMA_VERSION}.sqlite`),
    );
    if (process.platform !== 'win32') expect((await stat(databasePath)).mode & 0o777).toBe(0o600);

    const database = new Database(databasePath, {readonly: true, strict: true});
    try {
      const symbolColumns = database
        .query<{readonly name: string}, []>('PRAGMA table_info(routing_symbols)')
        .all()
        .map(row => row.name);
      expect(symbolColumns).not.toEqual(expect.arrayContaining(['documentation', 'signature', 'source']));
      expect(
        database
          .query<{readonly name: string}, []>('PRAGMA table_info(routing_lookup_keys)')
          .all()
          .map(row => row.name),
      ).toEqual(expect.arrayContaining(['lookup_key', 'node_id', 'projection_digest']));
      const exactPlan = database
        .query<{readonly detail: string}, [string]>(
          'EXPLAIN QUERY PLAN SELECT node_id FROM routing_lookup_keys WHERE lookup_key = ?',
        )
        .all('exact.lookup');
      expect(exactPlan.some(row => row.detail.includes('routing_lookup_keys_exact'))).toBe(true);
    } finally {
      database.close(false);
    }
  });

  it('keeps staged data invisible and swaps only a validated generation pointer', async () => {
    const home = await temporaryHome(homes);
    const first = generationInput('engineering', 'manifest-a', [member(1, 'producer')]);
    const firstStage = await runEffect(stageCodeGraphWorksetCatalogGeneration(home, first));

    expect(await runEffect(readPublishedCodeGraphWorksetCatalogGeneration(home, 'engineering'))).toBeUndefined();
    await runEffect(
      publishCodeGraphWorksetCatalogGeneration(home, {
        generationId: firstStage.id,
        worksetName: 'engineering',
      }),
    );
    const publishedFirst = await runEffect(readPublishedCodeGraphWorksetCatalogGeneration(home, 'engineering'));
    expect(publishedFirst?.members.map(entry => entry.repositoryKey)).toEqual(['producer']);

    const second = generationInput('engineering', 'manifest-b', [member(2, 'consumer'), member(3, 'schema')]);
    const secondStage = await runEffect(stageCodeGraphWorksetCatalogGeneration(home, second));
    expect((await runEffect(readPublishedCodeGraphWorksetCatalogGeneration(home, 'engineering')))?.id).toBe(
      firstStage.id,
    );

    await runEffect(
      publishCodeGraphWorksetCatalogGeneration(home, {
        generationId: secondStage.id,
        worksetName: 'engineering',
      }),
    );
    const publishedSecond = await runEffect(readPublishedCodeGraphWorksetCatalogGeneration(home, 'engineering'));
    expect(publishedSecond).toMatchObject({id: secondStage.id, manifestDigest: digest('manifest-b')});
    expect(publishedSecond?.members.map(entry => entry.repositoryKey)).toEqual(['consumer', 'schema']);

    const firstPage = await runEffect(
      readCodeGraphWorksetCatalogRoutingSymbols(home, {limit: 1, worksetName: 'engineering'}),
    );
    expect(firstPage?.symbols).toHaveLength(1);
    expect(firstPage?.symbols[0]).toMatchObject({repositoryKey: 'consumer'});
    expect(firstPage?.symbols[0]?.terms).toEqual(expect.arrayContaining([{term: 'symbol-2', weight: 4}]));
    expect(firstPage?.symbols[0]?.lookupKeys).toEqual([`exact.symbol.2`, `symbol.2`]);
    const secondPage = await runEffect(
      readCodeGraphWorksetCatalogRoutingSymbols(home, {
        after: firstPage?.next,
        limit: 1,
        worksetName: 'engineering',
      }),
    );
    expect(secondPage?.symbols[0]?.repositoryKey).toBe('schema');
    expect(secondPage?.next).toBeUndefined();
  });

  it('checks a qualified node against one exact projection without scanning the generation', async () => {
    const home = await temporaryHome(homes);
    const input = generationInput('engineering', 'manifest-node-membership', [member(1, 'producer')]);
    await runEffect(stageCodeGraphWorksetCatalogGeneration(home, input));
    const projection = input.members[0]!.projection;

    expect(
      await runEffect(
        codeGraphWorksetCatalogProjectionContainsNode(home, {
          nodeId: projection.symbols[0]!.nodeId,
          projectionDigest: projection.projectionDigest,
        }),
      ),
    ).toBe(true);
    expect(
      await runEffect(
        codeGraphWorksetCatalogProjectionContainsNode(home, {
          nodeId: `cgs_${'f'.repeat(32)}`,
          projectionDigest: projection.projectionDigest,
        }),
      ),
    ).toBe(false);
  });

  it('refuses a corrupted staged projection without replacing the published generation', async () => {
    const home = await temporaryHome(homes);
    const first = await publish(home, generationInput('engineering', 'manifest-a', [member(1, 'producer')]));
    const secondInput = generationInput('engineering', 'manifest-b', [member(2, 'consumer')]);
    const second = await runEffect(stageCodeGraphWorksetCatalogGeneration(home, secondInput));
    const database = new Database(catalogPath(home), {strict: true});
    try {
      database
        .query('UPDATE routing_symbols SET name = ? WHERE projection_digest = ?')
        .run('tampered', secondInput.members[0]!.projection.projectionDigest);
    } finally {
      database.close(false);
    }

    await expect(
      runEffect(
        publishCodeGraphWorksetCatalogGeneration(home, {
          generationId: second.id,
          worksetName: 'engineering',
        }),
      ),
    ).rejects.toMatchObject({reason: 'corrupt'} satisfies Partial<CodeGraphWorksetCatalogError>);
    expect((await runEffect(readPublishedCodeGraphWorksetCatalogGeneration(home, 'engineering')))?.id).toBe(first.id);
  });

  it('makes incremental publication converge to the same normalized catalog view as a clean rebuild', async () => {
    const cleanHome = await temporaryHome(homes);
    const incrementalHome = await temporaryHome(homes);
    const members = [member(3, 'schema'), member(1, 'producer'), member(2, 'consumer')];
    const full = generationInput('engineering', 'manifest-full', members);
    await publish(cleanHome, full);
    await publish(incrementalHome, generationInput('engineering', 'manifest-one', members.slice(0, 1)));
    await publish(incrementalHome, generationInput('engineering', 'manifest-two', members.slice(0, 2)));
    await publish(incrementalHome, full);

    expect(await runEffect(readPublishedCodeGraphWorksetCatalogGeneration(incrementalHome, 'engineering'))).toEqual(
      await runEffect(readPublishedCodeGraphWorksetCatalogGeneration(cleanHome, 'engineering')),
    );
    expect(await collectSymbols(incrementalHome, 'engineering')).toEqual(
      await collectSymbols(cleanHome, 'engineering'),
    );
  });

  it('streams bounded projection pages to the same generation and never publishes an incomplete stream', async () => {
    const wholeHome = await temporaryHome(homes);
    const streamedHome = await temporaryHome(homes);
    const input = generationInput('engineering', 'manifest-stream', [member(3, 'schema'), member(1, 'producer')]);
    const whole = await publish(wholeHome, input);

    await fc.assert(
      fc.asyncProperty(fc.integer({min: 1, max: 3}), async pageSize => {
        const propertyHome = await temporaryHome(homes);
        await runEffect(ensureCodeGraphWorksetCatalog(propertyHome));
        for (const entry of input.members) {
          const receipt = projectionReceipt(entry.projection);
          const begun = await runEffect(beginCodeGraphWorksetCatalogProjection(propertyHome, receipt));
          if (begun.state === 'staging') {
            for (let offset = 0; offset < entry.projection.symbols.length; offset += pageSize) {
              await runEffect(
                appendCodeGraphWorksetCatalogProjectionPage(propertyHome, {
                  projectionDigest: receipt.projectionDigest,
                  symbols: entry.projection.symbols.slice(offset, offset + pageSize),
                }),
              );
            }
            await runEffect(completeCodeGraphWorksetCatalogProjection(propertyHome, receipt.projectionDigest));
          }
        }
        const staged = await runEffect(
          stageCodeGraphWorksetCatalogGenerationFromReceipts(propertyHome, {
            manifestDigest: input.manifestDigest,
            members: input.members.map(entry => ({
              projectionDigest: entry.projection.projectionDigest,
              repositoryId: entry.projection.repositoryId,
              repositoryKey: entry.repositoryKey,
              snapshotId: entry.projection.snapshotId,
            })),
            worksetName: input.worksetName,
          }),
        );
        await runEffect(
          publishCodeGraphWorksetCatalogGeneration(propertyHome, {
            generationId: staged.id,
            worksetName: input.worksetName,
          }),
        );
        expect(staged.id).toBe(whole.id);
        expect(await collectSymbols(propertyHome, input.worksetName)).toEqual(
          await collectSymbols(wholeHome, input.worksetName),
        );
      }),
      {numRuns: 8},
    );

    const staged = await runEffect(stageCodeGraphWorksetCatalogGeneration(streamedHome, input));
    await runEffect(
      publishCodeGraphWorksetCatalogGeneration(streamedHome, {
        generationId: staged.id,
        worksetName: input.worksetName,
      }),
    );

    const previous = await runEffect(readPublishedCodeGraphWorksetCatalogGeneration(streamedHome, 'engineering'));
    const incomplete = projection(99);
    await runEffect(beginCodeGraphWorksetCatalogProjection(streamedHome, projectionReceipt(incomplete)));
    await expect(
      runEffect(completeCodeGraphWorksetCatalogProjection(streamedHome, incomplete.projectionDigest)),
    ).rejects.toMatchObject({reason: 'corrupt'} satisfies Partial<CodeGraphWorksetCatalogError>);
    expect((await runEffect(readPublishedCodeGraphWorksetCatalogGeneration(streamedHome, 'engineering')))?.id).toBe(
      previous?.id,
    );
  });

  it('retires old generations in bounded pages and rebuilds only the corrupt disposable catalog', async () => {
    const home = await temporaryHome(homes);
    await publish(home, generationInput('engineering', 'manifest-a', [member(1, 'producer')]));
    await publish(home, generationInput('engineering', 'manifest-b', [member(2, 'consumer')]));
    expect(await runEffect(inspectCodeGraphWorksetCatalog(home))).toMatchObject({
      projectionCount: 2,
      publishedWorksets: 1,
      readyGenerations: 1,
      state: 'ok',
    });

    expect(await runEffect(maintainCodeGraphWorksetCatalog(home, {generationLimit: 1, projectionLimit: 1}))).toEqual({
      projectionsDeleted: 1,
      retiredGenerationsDeleted: 1,
      stagingGenerationsRetired: 0,
    });
    expect(await runEffect(inspectCodeGraphWorksetCatalog(home))).toMatchObject({projectionCount: 1, state: 'ok'});

    const repositorySentinel = join(home, 'indexes', 'code-graph', 'repositories', 'sentinel', 'graph-v3.sqlite');
    await mkdir(join(home, 'indexes', 'code-graph', 'repositories', 'sentinel'), {recursive: true});
    await writeFile(repositorySentinel, 'repository graph remains authoritative');
    await rm(`${catalogPath(home)}-wal`, {force: true});
    await rm(`${catalogPath(home)}-shm`, {force: true});
    await writeFile(catalogPath(home), 'not a sqlite catalog');

    expect(await runEffect(inspectCodeGraphWorksetCatalog(home))).toMatchObject({state: 'corrupt'});
    expect(await runEffect(recoverCodeGraphWorksetCatalog(home))).toEqual({previousState: 'corrupt', rebuilt: true});
    expect(await readFile(repositorySentinel, 'utf8')).toBe('repository graph remains authoritative');
    expect(await runEffect(inspectCodeGraphWorksetCatalog(home))).toMatchObject({
      projectionCount: 0,
      state: 'ok',
    });
  });

  it('keeps generation identity and canonical repository order independent of input order', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({min: 0, max: 200}), {maxLength: 12}), seeds => {
        const members = seeds.map(seed => member(seed, `repository-${seed}`));
        const forward = codeGraphWorksetCatalogGenerationIdentity(
          generationInput('property-workset', 'property-manifest', members),
        );
        const reversed = codeGraphWorksetCatalogGenerationIdentity(
          generationInput('property-workset', 'property-manifest', [...members].reverse()),
        );

        expect(reversed.id).toBe(forward.id);
        expect(reversed.digest).toBe(forward.digest);
        expect(reversed.members.map(entry => entry.repositoryKey)).toEqual(
          [...forward.members.map(entry => entry.repositoryKey)].sort(compareText),
        );
      }),
      {numRuns: 100},
    );
  });
});

async function temporaryHome(homes: string[]): Promise<string> {
  const home = await mkdtemp('threadnote-workset-catalog-');
  homes.push(home);
  return home;
}

async function publish(home: string, input: CodeGraphWorksetCatalogGenerationInputV1) {
  const staged = await runEffect(stageCodeGraphWorksetCatalogGeneration(home, input));
  return runEffect(
    publishCodeGraphWorksetCatalogGeneration(home, {
      generationId: staged.id,
      worksetName: input.worksetName,
    }),
  );
}

async function collectSymbols(home: string, worksetName: string) {
  const symbols = [];
  let after: {readonly nodeId: string; readonly ordinal: number} | undefined;
  for (;;) {
    const page = await runEffect(readCodeGraphWorksetCatalogRoutingSymbols(home, {after, limit: 2, worksetName}));
    if (page === undefined) return symbols;
    symbols.push(...page.symbols);
    if (page.next === undefined) return symbols;
    after = page.next;
  }
}

function generationInput(
  worksetName: string,
  manifestSeed: string,
  members: readonly CodeGraphWorksetCatalogGenerationMemberV1[],
): CodeGraphWorksetCatalogGenerationInputV1 {
  return {manifestDigest: digest(manifestSeed), members, worksetName};
}

function member(seed: number, repositoryKey: string): CodeGraphWorksetCatalogGenerationMemberV1 {
  return {projection: projection(seed), repositoryKey};
}

function projection(seed: number): CodeGraphWorksetRoutingProjectionV1 {
  return createCodeGraphWorksetRoutingProjection({
    checkoutId: digest(`checkout-${seed}`),
    commitId: digest(`commit-${seed}`).slice(0, 40),
    componentCount: seed % 3,
    extractorGeneration: 12,
    projectorVersion: CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION,
    repositoryId: digest(`repository-${seed}`),
    snapshotDigest: digest(`snapshot-digest-${seed}`),
    snapshotId: `cgsn_${digest(`snapshot-${seed}`).slice(0, 40)}`,
    symbols: [
      {
        exported: seed % 2 === 0,
        kind: 'function',
        language: 'typescript',
        lookupKeys: [`symbol.${seed}`, `exact.symbol.${seed}`],
        name: `symbol${seed}`,
        nodeId: `cgs_${digest(`node-${seed}`).slice(0, 40)}`,
        packageName: `@fixture/repository-${seed}`,
        path: `src/symbol-${seed}.ts`,
        qualifiedName: `fixture.symbol${seed}`,
        span: {column: 0, endColumn: 12, endLine: 1, line: 1},
        terms: [
          {term: `symbol-${seed}`, weight: 4},
          {term: 'fixture', weight: 1},
        ],
      },
    ],
    worktreeId: digest(`worktree-${seed}`),
  });
}

function projectionReceipt(projection: CodeGraphWorksetRoutingProjectionV1) {
  const {symbols, ...receipt} = projection;
  return {...receipt, symbolCount: symbols.length};
}

function catalogPath(home: string): string {
  return codeGraphWorksetCatalogDatabasePath({join} as never, home);
}

function digest(value: string): string {
  return sha256HexSync(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
