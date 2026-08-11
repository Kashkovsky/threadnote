import {Effect} from 'effect';
import {writeFinalCliOutput} from '../effect/cli_output.js';
import {SystemInfo} from '../effect/system.js';
import type {RuntimeConfig} from '../types.js';
import {compileContextBrief} from './index.js';
import type {ContextBriefMode} from './types.js';

export interface RunContextBriefOptionsV1 {
  readonly budgetTokens?: number;
  readonly cwd?: string;
  readonly json?: boolean;
  readonly mode?: ContextBriefMode;
  readonly project?: string;
  readonly task: string;
  readonly workset?: string;
}

export const runContextBrief = Effect.fn('contextBrief.command.compile')(function* (
  config: RuntimeConfig,
  options: RunContextBriefOptionsV1,
) {
  const workset = options.workset?.trim();
  const cwd = options.cwd?.trim() || (yield* SystemInfo).currentDirectory();
  const projected = yield* compileContextBrief(config, {
    ...(options.budgetTokens === undefined ? {} : {budgetTokens: options.budgetTokens}),
    ...(options.mode === undefined ? {} : {mode: options.mode}),
    scope: workset
      ? {kind: 'workset', name: workset, ...(options.project?.trim() ? {project: options.project.trim()} : {})}
      : {callerCwd: cwd, kind: 'repository', ...(options.project?.trim() ? {project: options.project.trim()} : {})},
    task: options.task,
  });
  yield* writeFinalCliOutput(options.json ? JSON.stringify(projected.structuredContent) : projected.text.trimEnd());
});
