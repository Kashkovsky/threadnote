import type {ThreadnoteProcessDiagnostic} from './process_diagnostics.js';

export function orderThreadnoteProcessesByAttention<T extends ThreadnoteProcessDiagnostic>(
  processes: readonly T[],
): readonly T[] {
  return processes
    .map((process, inputIndex) => ({inputIndex, process}))
    .sort(
      (left, right) =>
        processAttentionRank(left.process) - processAttentionRank(right.process) ||
        left.process.startedAt.localeCompare(right.process.startedAt) ||
        left.process.processId - right.process.processId ||
        left.inputIndex - right.inputIndex,
    )
    .map(entry => entry.process);
}

function processAttentionRank(process: ThreadnoteProcessDiagnostic): number {
  if (process.role === 'legacy') return 2;
  if (
    process.activityRole !== undefined ||
    (process.currentOperation !== undefined && !isProcessBaselineOperation(process))
  ) {
    return 0;
  }
  return 1;
}

function isProcessBaselineOperation(process: ThreadnoteProcessDiagnostic): boolean {
  switch (process.role) {
    case 'manager':
      return process.currentOperation === 'manager-ui';
    case 'mcp':
      return process.currentOperation === 'mcp-server';
    case 'mcp-broker':
      return process.currentOperation === 'mcp-broker';
    case 'local-model-worker':
      return process.currentOperation === 'model-stdio';
    case 'graph-parser-worker':
      return process.currentOperation === 'parser-stdio';
    default:
      return false;
  }
}
