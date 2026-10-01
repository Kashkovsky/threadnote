type GraphAgentRecord = Readonly<Record<string, unknown>>;

export function graphAgentRecord(value: unknown): GraphAgentRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as GraphAgentRecord) : undefined;
}

export function graphAgentString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function graphAgentNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function graphAgentScope(value: GraphAgentRecord): GraphAgentRecord | undefined {
  const coverage = graphAgentRecord(value.projectCoverage);
  if (coverage !== undefined) {
    const kind = graphAgentString(coverage.kind);
    const completeness = graphAgentString(coverage.completeness);
    const negativeProof = graphAgentString(coverage.negativeProof);
    if (kind === 'project' || completeness !== 'complete' || negativeProof === 'unavailable') {
      const roots = Array.isArray(coverage.configuredRoots)
        ? coverage.configuredRoots.filter((root): root is string => typeof root === 'string').slice(0, 2)
        : [];
      const omittedRoots =
        (graphAgentNumber(coverage.configuredRootsOmitted) ?? 0) +
        (Array.isArray(coverage.configuredRoots) ? Math.max(0, coverage.configuredRoots.length - roots.length) : 0);
      return {
        ...(graphAgentString(coverage.project) === undefined ? {} : {project: graphAgentString(coverage.project)}),
        ...(kind === undefined ? {} : {kind}),
        ...(completeness === undefined ? {} : {completeness}),
        ...(negativeProof === undefined ? {} : {negativeProof}),
        ...(roots.length === 0 ? {} : {configuredRoots: roots}),
        ...(omittedRoots > 0 ? {configuredRootsOmitted: omittedRoots} : {}),
      };
    }
  }
  const project = graphAgentString(value.project);
  return project === undefined ? undefined : {project};
}

/**
 * Render only provenance that changes how an agent may use graph evidence.
 * Stable transport/schema identities remain available through explicit dual
 * responses without charging every ordinary model-facing read for them.
 */
export function renderCodeGraphAgentProvenance(value: unknown): string {
  const record = graphAgentRecord(value);
  if (record === undefined) return '';
  const evidence: Record<string, unknown> = {};
  const freshness = graphAgentString(record.freshness);
  if (freshness !== undefined && freshness !== 'current') evidence.freshness = freshness;
  const snapshot = graphAgentRecord(record.snapshot);
  if (snapshot?.dirty === true) evidence.dirty = true;
  if (Object.keys(evidence).length > 0) {
    const commit = graphAgentString(snapshot?.commit);
    if (commit !== undefined) evidence.commit = commit.slice(0, 12);
  }
  const refresh = graphAgentRecord(record.refresh);
  const refreshState = graphAgentString(refresh?.state);
  if (refresh !== undefined && refreshState !== undefined && refreshState !== 'idle') {
    const failure = graphAgentRecord(refresh.failure);
    evidence.refresh = {
      state: refreshState,
      ...(graphAgentNumber(refresh.retryAfterMilliseconds) === undefined
        ? {}
        : {retryAfterMilliseconds: graphAgentNumber(refresh.retryAfterMilliseconds)}),
      ...(failure === undefined
        ? {}
        : {
            failure: {
              ...(graphAgentString(failure.code) === undefined ? {} : {code: graphAgentString(failure.code)}),
              ...(typeof failure.retryable === 'boolean' ? {retryable: failure.retryable} : {}),
              ...(graphAgentString(failure.recovery) === undefined
                ? {}
                : {recovery: graphAgentString(failure.recovery)}),
            },
          }),
    };
  }
  const lines: string[] = [];
  if (Object.keys(evidence).length > 0) lines.push(`evidence\t${JSON.stringify(evidence)}`);
  const scope = graphAgentScope(record);
  if (scope !== undefined) lines.push(`projectScope\t${JSON.stringify(scope)}`);
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}
