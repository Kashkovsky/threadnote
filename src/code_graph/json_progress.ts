import {Clock, Console, Effect, Ref, Semaphore} from 'effect';
import type {CodeGraphProgress} from './types.js';

export const CODE_GRAPH_JSON_PROGRESS_INTERVAL_MILLISECONDS = 2_000;

export interface CodeGraphJsonProgressState {
  readonly lastEmittedAtMilliseconds?: number;
  readonly lastTerminal?: string;
  readonly phase?: CodeGraphProgress['phase'];
  readonly seenSubstages?: readonly string[];
}

export interface CodeGraphJsonProgressDecision {
  readonly emit: boolean;
  readonly state: CodeGraphJsonProgressState;
}

interface CodeGraphJsonProgressRepository {
  readonly displayName: string;
  readonly repositoryId: string;
}

export function codeGraphJsonProgressDecision(
  state: CodeGraphJsonProgressState,
  progress: CodeGraphProgress,
  nowMilliseconds: number,
  intervalMilliseconds = CODE_GRAPH_JSON_PROGRESS_INTERVAL_MILLISECONDS,
): CodeGraphJsonProgressDecision {
  const substage = codeGraphJsonProgressSubstage(progress);
  const terminal = codeGraphJsonProgressTerminal(progress);
  const phaseChanged = state.phase !== progress.phase;
  const seenSubstages = phaseChanged ? [] : (state.seenSubstages ?? []);
  // Emit each finite substage once per phase. Repeated stage oscillation then
  // stays on the time bound instead of defeating coalescing on every chunk.
  const firstSubstageObservation = !seenSubstages.includes(substage);
  const clockMovedBackward =
    state.lastEmittedAtMilliseconds !== undefined && nowMilliseconds < state.lastEmittedAtMilliseconds;
  const intervalElapsed =
    state.lastEmittedAtMilliseconds === undefined ||
    nowMilliseconds - state.lastEmittedAtMilliseconds >= Math.max(1, intervalMilliseconds);
  const emit =
    state.lastEmittedAtMilliseconds === undefined ||
    phaseChanged ||
    firstSubstageObservation ||
    (terminal !== undefined && state.lastTerminal !== terminal) ||
    clockMovedBackward ||
    intervalElapsed;
  const lastEmittedAtMilliseconds = emit ? nowMilliseconds : state.lastEmittedAtMilliseconds;
  const lastTerminal = terminal ?? state.lastTerminal;

  return {
    emit,
    state: {
      ...(lastEmittedAtMilliseconds === undefined ? {} : {lastEmittedAtMilliseconds}),
      ...(lastTerminal === undefined ? {} : {lastTerminal}),
      phase: progress.phase,
      seenSubstages: firstSubstageObservation ? [...seenSubstages, substage] : seenSubstages,
    },
  };
}

export const makeCodeGraphJsonProgressReporter = Effect.fn('codeGraph.command.makeJsonProgressReporter')(function* (
  repository?: CodeGraphJsonProgressRepository,
) {
  const state = yield* Ref.make<CodeGraphJsonProgressState>({});
  const semaphore = yield* Semaphore.make(1);
  return (progress: CodeGraphProgress) =>
    semaphore.withPermit(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const decision = codeGraphJsonProgressDecision(yield* Ref.get(state), progress, now);
        yield* Ref.set(state, decision.state);
        if (!decision.emit) return;
        yield* Console.error(
          JSON.stringify({
            type: 'code-graph-progress',
            version: 2,
            ...(repository === undefined ? {} : {repository}),
            ...progress,
          }),
        );
      }),
    );
});

function codeGraphJsonProgressSubstage(progress: CodeGraphProgress): string {
  if ('subphase' in progress && progress.subphase !== undefined) return `${progress.phase}/${progress.subphase}`;
  switch (progress.phase) {
    case 'activating':
      return `${progress.phase}/${progress.activity?.stage ?? 'snapshot'}`;
    case 'embedding':
      return `${progress.phase}/vectors`;
    case 'materializing':
      return `${progress.phase}/${progress.activity?.stage ?? 'facts'}`;
    case 'registering':
      return `${progress.phase}/${progress.activity?.stage ?? 'registration'}`;
    case 'reclaiming':
      return `${progress.phase}/superseded-snapshots`;
    case 'scanning':
      return `${progress.phase}/${progress.activity?.stage ?? 'inventory'}`;
    case 'waiting':
      return `${progress.phase}/${progress.reason ?? 'repository-lock'}`;
  }
}

function codeGraphJsonProgressTerminal(progress: CodeGraphProgress): string | undefined {
  switch (progress.phase) {
    case 'scanning':
    case 'materializing':
    case 'embedding':
    case 'reclaiming':
      return progress.completed >= progress.total ? progress.phase : undefined;
    case 'resolving':
      return progress.subphase === 'complete' ? `${progress.phase}/${progress.subphase}` : undefined;
    case 'activating':
      return progress.subphase === 'complete' ? `${progress.phase}/${progress.subphase}` : undefined;
    case 'registering':
    case 'waiting':
      return undefined;
  }
}
