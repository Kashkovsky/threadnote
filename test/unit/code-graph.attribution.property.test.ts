import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {sha256HexSync} from '../../src/crypto/sha256.js';
import {createCachedCodeGraphFactsAttributor} from '../../src/code_graph/indexer.js';
import type {CodeGraphFileFacts, CodeGraphInventoryFile} from '../../src/code_graph/types.js';
import {discoverManifestWorkspace} from '../../src/code_graph/workspace.js';

const attributionCase = FC.record({
  batchWidth: FC.integer({max: 5, min: 1}),
  packageCount: FC.integer({max: 12, min: 1}),
  rotation: FC.integer({max: 31, min: 0}),
});

const batchReuseCase = FC.record({
  batchWidth: FC.integer({max: 5, min: 1}),
  hitMask: FC.array(FC.boolean(), {maxLength: 24, minLength: 1}),
  packageCount: FC.integer({max: 12, min: 1}),
  rotation: FC.integer({max: 31, min: 0}),
});

describe('code graph repository-attribution properties', () => {
  it.prop(
    'matches one-shot attribution across arbitrary cache-batch boundaries and multi-package references',
    {scenario: attributionCase},
    ({scenario}) => {
      const files = repositoryFiles(scenario.packageCount);
      const workspace = discoverManifestWorkspace(files);
      const raw = syntheticFacts(files);
      const rotation = scenario.rotation % raw.length;
      const reordered = [...raw.slice(rotation), ...raw.slice(0, rotation)];
      const attributeBatch = createCachedCodeGraphFactsAttributor(files, workspace);
      const expected = attributeBatch(raw);
      const streamed: CodeGraphFileFacts[] = [];

      for (let index = 0; index < reordered.length; index += scenario.batchWidth) {
        streamed.push(...attributeBatch(reordered.slice(index, index + scenario.batchWidth)));
      }

      expect(normalizeFacts(streamed)).toEqual(normalizeFacts(expected));
      for (let index = 0; index < scenario.packageCount; index += 1) {
        const prefix = `packages/p${index}/`;
        expect(
          streamed
            .filter(file => file.path.startsWith(prefix))
            .flatMap(file => file.symbols)
            .every(symbol => symbol.packageName === `package-${index}`),
        ).toBe(true);
      }
    },
    {fastCheck: {numRuns: 100}},
  );

  it.prop(
    'matches canonical batch attribution when only complete final-shard batches are reused',
    {scenario: batchReuseCase},
    ({scenario}) => {
      const files = repositoryFiles(scenario.packageCount);
      const workspace = discoverManifestWorkspace(files);
      const raw = syntheticFacts(files);
      const attributeBatch = createCachedCodeGraphFactsAttributor(files, workspace);
      const rotation = scenario.rotation % raw.length;
      const reordered = [...raw.slice(rotation), ...raw.slice(0, rotation)];
      const rawBatches: (readonly CodeGraphFileFacts[])[] = [];
      for (let index = 0; index < reordered.length; index += scenario.batchWidth) {
        rawBatches.push(reordered.slice(index, index + scenario.batchWidth));
      }
      const canonicalBatches = rawBatches.map(batch => attributeBatch(batch));
      const expected = canonicalBatches.flat();
      const hitPaths = new Set(
        expected.filter((_, index) => scenario.hitMask[index % scenario.hitMask.length]).map(file => file.path),
      );
      const merged = rawBatches.flatMap((batch, index) => {
        const canonical = canonicalBatches[index];
        return canonical.every(file => hitPaths.has(file.path)) ? canonical : attributeBatch(batch);
      });

      expect(normalizeFacts(merged)).toEqual(normalizeFacts(expected));
    },
    {fastCheck: {numRuns: 100}},
  );
});

function repositoryFiles(packageCount: number): readonly CodeGraphInventoryFile[] {
  const files: CodeGraphInventoryFile[] = [sourceFile('package.json', '{"name":"root-package"}\n')];
  for (let index = 0; index < packageCount; index += 1) {
    const target = (index + 1) % packageCount;
    files.push(
      sourceFile(`packages/p${index}/package.json`, `{"name":"package-${index}"}\n`),
      sourceFile(`packages/p${index}/src/value.ts`, `export const value${index} = ${index};\n`),
      sourceFile(
        `packages/p${index}/src/consumer.ts`,
        `import {value${target}} from "../../p${target}/src/value.js";\n` +
          `export const consumer${index} = value${target};\n`,
      ),
    );
  }
  return files;
}

function sourceFile(path: string, content: string): CodeGraphInventoryFile {
  const contentHash = sha256HexSync(content);
  return {
    blobId: contentHash,
    content,
    contentHash,
    language: path.endsWith('.ts') ? 'typescript' : 'json',
    mode: '100644',
    path,
    size: new TextEncoder().encode(content).byteLength,
    source: 'commit',
  };
}

function syntheticFacts(files: readonly CodeGraphInventoryFile[]): readonly CodeGraphFileFacts[] {
  const sourceFiles = files.filter(file => file.path.endsWith('.ts'));
  return sourceFiles.map((file, index) => {
    const symbolName = file.path.includes('/consumer.ts')
      ? `consumer${Math.floor(index / 2)}`
      : `value${Math.floor(index / 2)}`;
    const targetName = `value${(Math.floor(index / 2) + 1) % Math.max(1, sourceFiles.length / 2)}`;
    const symbolId = `symbol-${index}`;
    const edgeId = `edge-${index}`;
    const span = {column: 1, endColumn: 12, endLine: 1, line: 1};
    return {
      diagnostics: [],
      edges: [
        {
          confidence: 0.8,
          evidencePath: file.path,
          evidenceSpan: span,
          id: edgeId,
          provenance: 'syntactic',
          relation: 'references',
          sourceId: symbolId,
          sourceName: symbolName,
          targetName,
        },
      ],
      path: file.path,
      references: [
        {
          edgeId,
          evidencePath: file.path,
          evidenceSpan: span,
          lookupTiers: [[targetName]],
          provenance: 'syntactic',
          relation: 'references',
          resolutionDomain: 'typescript',
          sourceId: symbolId,
          sourceName: symbolName,
          targetName,
        },
      ],
      symbols: [
        {
          contentHash: file.contentHash,
          exported: true,
          id: symbolId,
          kind: 'variable',
          language: 'typescript',
          lookupKeys: [symbolName],
          name: symbolName,
          path: file.path,
          qualifiedName: symbolName,
          resolutionDomain: 'typescript',
          span,
        },
      ],
    };
  });
}

function normalizeFacts(facts: readonly CodeGraphFileFacts[]): readonly CodeGraphFileFacts[] {
  return [...facts].sort((left, right) => left.path.localeCompare(right.path));
}
