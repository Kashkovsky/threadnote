import {BunRuntime} from '@effect/platform-bun';
import {Effect, FileSystem, Path} from 'effect';
import {ApplicationLayer} from '../src/effect/runtime.js';

export interface MixedNxBazelGateEvidence {
  readonly analysisMilliseconds: number;
  readonly analysisPeakRssBytes: number;
  readonly boundedStaleReadMilliseconds: number;
  readonly coldIndexMilliseconds: number;
  readonly crashRecoveryForegroundMilliseconds: number;
  readonly currentQueryMilliseconds: number;
  readonly inventoryMilliseconds: number;
  readonly movingTarget: {
    readonly newestRefreshCoalesced: boolean;
    readonly postTargetMaterializationMode: 'incremental-clean' | 'incremental-overlay' | 'full';
    readonly stagedFiles: number;
    readonly targetCommitExposed: boolean;
    readonly totalFiles: number;
  };
  readonly oneFileIncrementalMilliseconds: number;
  readonly oneFileIncrementalPeakRssBytes: number;
  readonly postChurnStorageGrowthPercent: number;
  readonly stableNoopMilliseconds: number;
}

export interface MixedNxBazelGateBudgets {
  readonly maximum: Omit<Record<keyof MixedNxBazelGateEvidence, number>, 'movingTarget'>;
}

export function validateMixedNxBazelGate(evidence: MixedNxBazelGateEvidence, budgets: MixedNxBazelGateBudgets): void {
  const failures: string[] = [];
  for (const [name, maximum] of Object.entries(budgets.maximum)) {
    const value = evidence[name as keyof Omit<MixedNxBazelGateEvidence, 'movingTarget'>];
    if (!Number.isFinite(maximum) || !Number.isFinite(value) || value > maximum) {
      failures.push(`${name} ${String(value)} exceeds ${String(maximum)}`);
    }
  }
  const target = evidence.movingTarget;
  if (!target.targetCommitExposed) failures.push('moving target commit was not exposed');
  if (!target.newestRefreshCoalesced) failures.push('moving target refreshes were not coalesced');
  if (target.postTargetMaterializationMode === 'full') failures.push('post-target refresh replayed a full graph');
  if (
    !Number.isSafeInteger(target.stagedFiles) ||
    !Number.isSafeInteger(target.totalFiles) ||
    target.stagedFiles < 0 ||
    target.totalFiles < 1 ||
    target.stagedFiles >= target.totalFiles
  ) {
    failures.push('post-target closure was not bounded');
  }
  if (failures.length > 0) throw new Error(`Mixed Nx/Bazel P2 gate failed: ${failures.join('; ')}`);
}

const run = Effect.fn('mixedNxBazelGate.run')(function* (args: readonly string[] = process.argv.slice(2)) {
  let evidencePath: string | undefined;
  let budgetsPath = 'test/evaluation/baselines/code-graph-v1/mixed-nx-bazel-budgets.json';
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--evidence') evidencePath = args[++index];
    else if (args[index] === '--budgets') budgetsPath = args[++index]!;
    else throw new Error(`Unknown mixed-monorepo gate option: ${args[index]}`);
  }
  if (!evidencePath) throw new Error('--evidence requires a JSON artifact.');
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const [evidence, budgets] = yield* Effect.all([
    fs.readFileString(path.resolve(evidencePath)).pipe(Effect.map(JSON.parse)),
    fs.readFileString(path.resolve(budgetsPath)).pipe(Effect.map(JSON.parse)),
  ]);
  validateMixedNxBazelGate(evidence as MixedNxBazelGateEvidence, budgets as MixedNxBazelGateBudgets);
});

if (import.meta.main) BunRuntime.runMain(run().pipe(Effect.provide(ApplicationLayer)));
