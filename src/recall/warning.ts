export const RECALL_OPERATIONAL_WARNING_LIMIT = 4;

export interface RecallOperationalWarning {
  readonly code: 'lexical_index_unavailable';
  readonly message: string;
  readonly remediation: string;
}

const LEXICAL_INDEX_UNAVAILABLE_WARNING = {
  code: 'lexical_index_unavailable',
  message: 'The lexical memory index could not be read or recovered; recall results may be incomplete.',
  remediation: 'Run `threadnote doctor --dry-run`, then `threadnote repair`, and retry recall.',
} as const satisfies RecallOperationalWarning;

export function lexicalIndexUnavailableWarning(): RecallOperationalWarning {
  return LEXICAL_INDEX_UNAVAILABLE_WARNING;
}

export function mergeRecallOperationalWarnings(
  ...warningSets: readonly (readonly RecallOperationalWarning[])[]
): readonly RecallOperationalWarning[] {
  const byCode = new Map<RecallOperationalWarning['code'], RecallOperationalWarning>();
  for (const warning of warningSets.flat()) {
    if (!byCode.has(warning.code)) byCode.set(warning.code, warning);
  }
  return [...byCode.values()].slice(0, RECALL_OPERATIONAL_WARNING_LIMIT);
}

export function renderRecallOperationalWarning(warning: RecallOperationalWarning): string {
  return `Recall index warning: ${warning.message} ${warning.remediation}`;
}
