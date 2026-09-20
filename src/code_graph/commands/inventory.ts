import {Effect} from 'effect';
import {writeFinalCliOutput} from '../../effect/cli_output.js';
import type {RuntimeConfig} from '../../types.js';
import {previewCodeGraphInventory, type CodeGraphInventoryPreview} from '../inventory.js';
import {resolveRepositoryIdentity} from '../repository.js';
import {resolveCodeGraphScopeRoute} from '../scope/routing.js';
import {SystemInfo} from '../../effect/system.js';

export const runCodeGraphInventory = Effect.fn('codeGraph.command.inventory')(function* (
  config: RuntimeConfig,
  options: {readonly cwd?: string; readonly json?: boolean; readonly project?: string},
) {
  const system = yield* SystemInfo;
  const cwd = options.cwd?.trim() || system.currentDirectory();
  const route = yield* resolveCodeGraphScopeRoute(config.manifestPath, cwd, options.project);
  const identity = yield* resolveRepositoryIdentity(cwd);
  const preview = yield* previewCodeGraphInventory(identity, {
    ...(route.state === 'selected' ? {project: route.project} : {}),
  });
  yield* writeFinalCliOutput(options.json ? JSON.stringify(preview) : renderCodeGraphInventoryPreview(preview));
});

function renderCodeGraphInventoryPreview(preview: CodeGraphInventoryPreview): string {
  const source = `${preview.commit.slice(0, 12)}${preview.dirty ? ' + worktree changes' : ' (clean)'}`;
  const lines = [
    'Code graph inventory admission preview',
    `Source: ${source}`,
    `Policy: v${preview.policyVersion} · aggregate metadata only · repository paths and content omitted`,
    `Repository: ${formatCount(preview.totals.repository)}`,
    `Eligible: ${formatCount(preview.totals.eligible)}`,
    `Skipped: ${formatCount(preview.totals.skipped)}`,
  ];
  if (preview.omittedUnsafeWorktreeFiles > 0) {
    lines.push(
      `Omitted: ${preview.omittedUnsafeWorktreeFiles} changed unsafe/non-regular worktree path(s) are outside byte totals.`,
    );
  }
  lines.push('', 'DISPOSITION\tLANGUAGE\tROLE\tCLASSIFIER\tREASON\tFILES\tBYTES');
  for (const group of preview.groups) {
    lines.push(
      [group.disposition, group.language, group.role, group.classifier, group.reason, group.files, group.bytes].join(
        '\t',
      ),
    );
  }
  return `${lines.join('\n')}\n`;
}

function formatCount(count: {readonly bytes: number; readonly files: number}): string {
  return `${count.files} file(s) · ${count.bytes} bytes (${formatBytes(count.bytes)})`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'] as const;
  let value = bytes / 1024;
  let unit: (typeof units)[number] = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index]!;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${unit}`;
}
