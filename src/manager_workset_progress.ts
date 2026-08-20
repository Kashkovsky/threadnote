import {Effect} from 'effect';
import type {CodeGraphWorksetPrepareProgressV1} from './code_graph/workset_catalog/workset.js';
import type {ManagerWorksetPrepareJob} from './manager_worksets.js';

/** Project one core progress event into the bounded Manager job snapshot. */
export function managerWorksetProgressFromEvent(progress: CodeGraphWorksetPrepareProgressV1) {
  return {
    ...(progress.activity === undefined ? {} : {activity: progress.activity}),
    ...(progress.attempt === undefined ? {} : {attempt: progress.attempt}),
    completed: progress.completed,
    elapsedMilliseconds: progress.elapsedMilliseconds,
    ...(progress.maxAttempts === undefined ? {} : {maxAttempts: progress.maxAttempts}),
    message: progress.message,
    phase: progress.phase,
    ...(progress.project === undefined ? {} : {project: progress.project}),
    total: progress.total,
  };
}

export function updateManagerWorksetPrepareProgress(
  entry: {job: ManagerWorksetPrepareJob},
  progress: CodeGraphWorksetPrepareProgressV1,
) {
  return Effect.sync(() => {
    if (entry.job.status === 'running') entry.job = {...entry.job, progress: managerWorksetProgressFromEvent(progress)};
  });
}
