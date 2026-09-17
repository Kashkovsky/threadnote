import {Effect} from 'effect';
import {resolveRepositoryIdentity} from '../code_graph/repository.js';
import {CommandExecutor} from '../effect/command.js';
import {writeFinalCliOutput} from '../effect/cli_output.js';
import {SystemInfo} from '../effect/system.js';
import {readActiveProjectMemoryRecords} from '../memory/maintenance_records.js';
import {buildContextHealthReport} from '../memory/context_health.js';
import {collectContextHealth} from '../memory/context_health_commands.js';
import type {MemoryRecord} from '../memory/document.js';
import type {RuntimeConfig} from '../types.js';
import {buildContextCheckReport, projectContextCheckReportSarif, type ContextCheckReportV1} from './index.js';

export interface ContextCheckOptions {
  readonly base?: string;
  readonly format?: 'json' | 'sarif' | 'text';
  readonly json?: boolean;
  readonly project: string;
  readonly sarif?: boolean;
}

/** Path-scoped CI checks do not imply coverage of uncited memories or transitive dependencies. */
export const runContextCheck = Effect.fn('contextCheck.command')(function* (
  config: RuntimeConfig,
  options: ContextCheckOptions,
) {
  const system = yield* SystemInfo;
  const project = options.project.trim();
  const formats = new Set([
    ...(options.format === undefined ? [] : [options.format]),
    ...(options.json === true ? (['json'] as const) : []),
    ...(options.sarif === true ? (['sarif'] as const) : []),
  ]);
  const format = formats.size === 0 ? 'text' : [...formats][0];
  const invalid = project.length === 0 || formats.size > 1;
  const report = invalid
    ? unavailableReport(project, 'invalid')
    : yield* checkRepository(config, project, options.base ?? 'HEAD', system.currentDirectory());
  const output =
    format === 'sarif'
      ? JSON.stringify(projectContextCheckReportSarif(report))
      : format === 'json'
        ? JSON.stringify(report)
        : `Context check: ${report.exitClassification}; ${report.findings.length} finding(s), ${report.omittedFindings} omitted. Scope: direct citations of changed files. Exit ${report.exitCode}.`;
  yield* writeFinalCliOutput(output);
  yield* Effect.sync(() => system.setExitCode(report.exitCode));
});

const checkRepository = Effect.fn('contextCheck.repository')(function* (
  config: RuntimeConfig,
  project: string,
  base: string,
  cwd: string,
) {
  const selection = yield* changedRepositoryPaths(cwd, base).pipe(Effect.option);
  if (selection._tag === 'None') return unavailableReport(project, 'changed-path-evidence-unavailable');
  const {paths, repositoryId, repoRoot, caseMode} = selection.value;
  return yield* Effect.gen(function* () {
    const records = yield* readActiveProjectMemoryRecords(config, project);
    // Invalid citation headers cannot prove absence from this change's scope.
    if (paths.length > 0 && records.some(record => (record.metadata.citationErrors?.length ?? 0) > 0)) {
      return unavailableReport(project, 'affected-memory-evidence-unavailable');
    }
    const affected = selectAffectedMemories(records, repositoryId, paths, caseMode);
    const healthReport = yield* collectContextHealth(config, project, records, repoRoot);
    return buildContextCheckReport({
      healthReport,
      selection: {affectedMemoryUris: affected.map(record => record.uri), changedPaths: paths, status: 'available'},
    });
  }).pipe(Effect.orElseSucceed(() => unavailableReport(project, 'affected-memory-evidence-unavailable')));
});

/** Repository identity is essential: an equal path in another repository is unrelated. */
export function selectAffectedMemories(
  records: readonly MemoryRecord[],
  repositoryId: string,
  changedPaths: readonly string[],
  caseMode: 'insensitive' | 'sensitive' = 'sensitive',
): readonly MemoryRecord[] {
  const pathKey = (value: string) => (caseMode === 'insensitive' ? value.toLowerCase() : value);
  const paths = new Set(changedPaths.map(pathKey));
  return records.filter(record =>
    record.metadata.codeCitations?.some(
      citation => citation.repositoryId === repositoryId && paths.has(pathKey(citation.path)),
    ),
  );
}

const changedRepositoryPaths = Effect.fn('contextCheck.changedPaths')(function* (cwd: string, base: string) {
  const repository = yield* resolveRepositoryIdentity(cwd);
  const command = yield* CommandExecutor;
  const bounded = {cwd: repository.repoRoot, maxOutputBytes: 1_048_576, timeoutMs: 30_000};
  const verified = yield* command.execute(
    'git',
    ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`],
    bounded,
  );
  const commit = verified.stdout.trim();
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit)) return yield* Effect.fail('invalid-base');
  const [tracked, untracked] = yield* Effect.all(
    [
      // Disabling rename detection includes both deleted and added paths, preserving old citations.
      command.execute('git', ['diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', commit, '--'], bounded),
      command.execute('git', ['ls-files', '--others', '--exclude-standard', '-z'], bounded),
    ],
    {concurrency: 2},
  );
  const paths = [...new Set(`${tracked.stdout}\0${untracked.stdout}`.split('\0').filter(Boolean))].sort();
  return {paths, repositoryId: repository.repositoryId, repoRoot: repository.repoRoot, caseMode: repository.caseMode};
});

function unavailableReport(
  project: string,
  reason: 'invalid' | 'affected-memory-evidence-unavailable' | 'changed-path-evidence-unavailable',
): ContextCheckReportV1 {
  const healthReport = buildContextHealthReport({now: new Date(0), project, records: []});
  const report = buildContextCheckReport({
    healthReport,
    selection: {reason: reason === 'invalid' ? 'changed-path-evidence-unavailable' : reason, status: 'unavailable'},
  });
  if (reason !== 'invalid') return report;
  return {...report, evidenceReason: undefined, evidenceStatus: 'invalid'};
}
