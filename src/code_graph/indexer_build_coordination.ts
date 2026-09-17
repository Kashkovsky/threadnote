import type {Effect} from 'effect';
import {estimatedMaterializationStorageBytes} from './indexer_materialization.js';
import type {CodeGraphBuildAndActivateInput} from './indexer_types.js';

export function coordinateCodeGraphBuild<A, E, R>(
  input: CodeGraphBuildAndActivateInput,
  build: (input: CodeGraphBuildAndActivateInput) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | unknown, R> {
  const splitPreparation =
    input.persistentOwnerToken !== undefined &&
    input.incrementalPrepared !== true &&
    input.incrementalAssessment?.mode !== 'eligible';
  if (!splitPreparation && input.legacyBuildAdmission) {
    return input.legacyBuildAdmission(build({...input, legacyBuildAdmission: undefined}));
  }
  if (splitPreparation && input.preparedSpoolBudgetGate) {
    const sourceBytes = input.inventory.files.reduce(
      (total, file) => Math.min(Number.MAX_SAFE_INTEGER, total + file.size),
      0,
    );
    const estimate = estimatedMaterializationStorageBytes(undefined, sourceBytes, 'direct-persistent');
    const preparedBytes = Math.min(
      Number.MAX_SAFE_INTEGER,
      estimate.estimatedDurableSnapshotBytes + estimate.estimatedJournalBytes,
    );
    return input.preparedSpoolBudgetGate(
      preparedBytes,
      input.building.id,
      build({...input, preparedSpoolBudgetGate: undefined}),
    );
  }
  return build(input);
}
