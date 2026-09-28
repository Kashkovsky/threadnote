export interface CodeGraphBuildOwnerIdentity {
  readonly buildId: string;
  readonly processId: number;
  readonly processStartIdentity?: string;
}

export interface CodeGraphBuildOwnerProcessObservation {
  readonly isRunning: boolean;
  readonly processStartIdentity?: string;
}

export type CodeGraphBuildOwnerLiveness = 'dead' | 'live' | 'unknown';

/**
 * Classify one exact process instance. A running PID is never treated as the
 * durable owner unless both process-start identities are available and equal.
 */
export function classifyCodeGraphBuildOwner(
  owner: CodeGraphBuildOwnerIdentity,
  observation: CodeGraphBuildOwnerProcessObservation,
): CodeGraphBuildOwnerLiveness {
  if (!observation.isRunning) return 'dead';
  if (owner.processStartIdentity === undefined || observation.processStartIdentity === undefined) return 'unknown';
  return owner.processStartIdentity === observation.processStartIdentity ? 'live' : 'dead';
}
