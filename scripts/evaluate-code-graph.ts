import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Effect, FileSystem, Path} from 'effect';
import {codeGraphLayout} from '../src/code_graph/layout.js';
import {CodeGraphIndexer} from '../src/code_graph/indexer.js';
import {CodeGraphQueryService} from '../src/code_graph/query.js';
import {resolveRepositoryIdentity} from '../src/code_graph/repository.js';
import {CodeGraphStore} from '../src/code_graph/store.js';
import type {CodeGraphQueryResult} from '../src/code_graph/types.js';
import {ApplicationLayer} from '../src/effect/runtime.js';
import {
  CODE_GRAPH_BASELINE_VERSION,
  codeGraphEdgeKey,
  codeGraphEvaluationFixtureHash,
  evaluateCodeGraphObservations,
  parseCodeGraphEvaluationFixtureV1,
  type CodeGraphEvaluationBaselineV1,
} from '../src/evaluation/code-graph.js';
import {atomicWrite, printJson, readJsonFile, scriptArguments} from './effect/script.js';
import {git, prepareCodeGraphFixture} from './code-graph-fixture.js';

const evaluateNativeCodeGraph = Effect.scoped(
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const options = parseArguments(yield* scriptArguments());
    const fixturePath = yield* path.fromFileUrl(
      new URL(`../test/evaluation/fixtures/${options.fixture}/fixture.json`, import.meta.url),
    );
    const fixture = parseCodeGraphEvaluationFixtureV1(yield* readJsonFile(fixturePath));
    const prepared = yield* prepareCodeGraphFixture(options.fixture);
    const indexer = yield* CodeGraphIndexer;
    const query = yield* CodeGraphQueryService;
    const store = yield* CodeGraphStore;
    const summary = yield* indexer.index({
      cwd: prepared.repository,
      threadnoteHome: prepared.home,
    });
    const observations = [];
    for (const contract of fixture.queries) {
      const result = yield* query.inspect({
        cwd: prepared.repository,
        from: contract.from,
        operation: contract.operation,
        query: contract.query,
        refresh: false,
        threadnoteHome: prepared.home,
        to: contract.to,
      });
      observations.push(observation(contract.id, contract.answerable, result));
    }
    const worktreeRoot = path.join(prepared.root, 'worktrees');
    const worktreeA = path.join(worktreeRoot, 'branch-a');
    const worktreeB = path.join(worktreeRoot, 'branch-b');
    yield* fs.makeDirectory(worktreeRoot, {recursive: true});
    yield* git(prepared.repository, ['branch', 'evaluation-branch-a']);
    yield* git(prepared.repository, ['branch', 'evaluation-branch-b']);
    yield* git(prepared.repository, ['worktree', 'add', worktreeA, 'evaluation-branch-a']);
    yield* git(prepared.repository, ['worktree', 'add', worktreeB, 'evaluation-branch-b']);
    for (const contract of fixture.worktreeContracts) {
      yield* replaceContractSymbol(
        fs,
        path.join(worktreeA, contract.basePath),
        contract.baseSymbol,
        contract.branchAReplacement,
      );
      yield* replaceContractSymbol(
        fs,
        path.join(worktreeB, contract.basePath),
        contract.baseSymbol,
        contract.branchBReplacement,
      );
    }
    let worktreeLeakageCount = 0;
    let worktreeObservationCount = 0;
    const worktreeFailures: string[] = [];
    for (const contract of fixture.worktreeContracts) {
      for (const variant of [
        {allowed: contract.branchAReplacement, forbidden: contract.branchBReplacement, root: worktreeA},
        {allowed: contract.branchBReplacement, forbidden: contract.branchAReplacement, root: worktreeB},
      ]) {
        const [allowed, forbidden] = yield* Effect.all(
          [
            query.inspect({
              cwd: variant.root,
              operation: 'query',
              query: variant.allowed,
              threadnoteHome: prepared.home,
            }),
            query.inspect({
              cwd: variant.root,
              operation: 'query',
              query: variant.forbidden,
              refresh: false,
              threadnoteHome: prepared.home,
            }),
          ],
          {concurrency: 1},
        );
        if (!allowed.nodes.some(node => node.name === variant.allowed)) {
          worktreeFailures.push(`worktree overlay did not expose ${variant.allowed}`);
        }
        if (contract.forbiddenCrossBranch) {
          worktreeObservationCount += 1;
          if (forbidden.nodes.some(node => node.name === variant.forbidden)) worktreeLeakageCount += 1;
        }
      }
    }
    const identity = yield* resolveRepositoryIdentity(prepared.repository);
    const layout = codeGraphLayout(path, prepared.home, identity.checkoutId, identity.worktreeId);
    const graph = yield* store.loadGraph(layout.databasePath, summary.snapshot.id);
    const actualAuthoritativeEdges = graph.edges
      .filter(edge => edge.provenance === 'declared' || edge.provenance === 'resolved')
      .map(edge =>
        codeGraphEdgeKey({
          provenance: edge.provenance,
          relation: edge.relation,
          source: edge.sourceName,
          target: edge.targetName,
        }),
      );
    const metrics = evaluateCodeGraphObservations(fixture, observations, {
      actualAuthoritativeEdges,
      allowedAuthoritativeEdgeKeys: fixture.allowedAuthoritativeEdges.map(codeGraphEdgeKey),
      extractedEdgeKeys: graph.edges.map(edge =>
        codeGraphEdgeKey({
          provenance: edge.provenance,
          relation: edge.relation,
          source: edge.sourceName,
          target: edge.targetName,
        }),
      ),
      worktreeLeakageCount,
      worktreeObservationCount,
    });
    const gateFailures = [...nativeGateFailures(metrics), ...worktreeFailures];
    if (gateFailures.length > 0) {
      yield* printJson({
        actualAuthoritativeEdges,
        expectedEdges: fixture.expectedEdges.map(codeGraphEdgeKey),
        metrics,
        observations,
      });
      return yield* Effect.fail(new Error(gateFailures.join('\n')));
    }
    const baseline: CodeGraphEvaluationBaselineV1 = {
      createdAt: options.createdAt,
      fixture: {
        hash: codeGraphEvaluationFixtureHash(fixture),
        id: fixture.id,
        queries: fixture.queries.length,
        version: fixture.version,
      },
      metrics,
      source: {
        name: 'threadnote-native-code-graph',
        version: '4.0.0',
      },
      version: CODE_GRAPH_BASELINE_VERSION,
    };
    if (options.outputPath) yield* atomicWrite(options.outputPath, `${JSON.stringify(baseline, undefined, 2)}\n`);
    yield* printJson(baseline);
  }),
);

function observation(queryId: string, answerable: boolean, result: CodeGraphQueryResult) {
  return {
    answerable,
    edgeKeys: result.edges.map(edge =>
      codeGraphEdgeKey({
        provenance: edge.provenance,
        relation: edge.relation,
        source: edge.sourceName,
        target: edge.targetName,
      }),
    ),
    pathHits: [],
    queryId,
    symbolHits: result.nodes.map(node => `${node.name}\u0000${node.path}`),
  };
}

function nativeGateFailures(metrics: CodeGraphEvaluationBaselineV1['metrics']): readonly string[] {
  return [
    metrics.authoritativeFalseEdgeRate !== 0 ? 'authoritative false-edge rate must be zero' : '',
    metrics.worktreeLeakageRate !== 0 ? 'worktree leakage rate must be zero' : '',
    metrics.noAnswerPrecision !== 1 ? 'no-answer precision must be one' : '',
    metrics.noAnswerRecall !== 1 ? 'no-answer recall must be one' : '',
    metrics.edgeRecall !== 1 ? 'edge recall regressed below the reviewed native baseline' : '',
    metrics.symbolRecall !== 1 ? 'symbol recall regressed below the reviewed native baseline' : '',
    metrics.meanReciprocalRank !== 1 ? 'MRR regressed below the reviewed native baseline' : '',
  ].filter(Boolean);
}

function parseArguments(args: readonly string[]): {
  readonly createdAt: string;
  readonly fixture: string;
  readonly outputPath?: string;
} {
  let outputPath: string | undefined;
  let fixture = 'code-graph-v1';
  let createdAt = process.env.SOURCE_DATE_EPOCH
    ? new Date(Number.parseInt(process.env.SOURCE_DATE_EPOCH, 10) * 1_000).toISOString()
    : new Date().toISOString();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--output') outputPath = required(args[++index], argument);
    else if (argument === '--fixture') fixture = required(args[++index], argument);
    else if (argument === '--created-at') createdAt = new Date(required(args[++index], argument)).toISOString();
    else throw new Error(`Unknown code graph evaluation option: ${argument}`);
  }
  if (!/^code-graph-[a-z0-9-]+$/.test(fixture)) throw new Error(`Invalid code graph fixture name: ${fixture}.`);
  return {createdAt, fixture, outputPath};
}

function required(value: string | undefined, option: string): string {
  if (!value?.trim()) throw new Error(`${option} requires a value`);
  return value;
}

const replaceContractSymbol = Effect.fn('codeGraphEvaluation.replaceContractSymbol')(function* (
  fs: FileSystem.FileSystem,
  target: string,
  from: string,
  to: string,
) {
  const content = yield* fs.readFileString(target);
  if (!content.includes(from)) return yield* Effect.fail(new Error(`Evaluation fixture does not contain ${from}.`));
  yield* fs.writeFileString(target, content.replaceAll(from, to));
});

BunRuntime.runMain(evaluateNativeCodeGraph.pipe(Effect.provide(ApplicationLayer)));
