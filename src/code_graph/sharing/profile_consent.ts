import {Effect} from 'effect';
import {SystemInfo, type SystemInfoShape} from '../../effect/system.js';
import {effectiveGraphShareContributionMode} from './contribution.js';
import {SHA256_DIGEST, type Sha256Digest} from './digest.js';
import {graphSharingFailure} from './errors.js';
import {
  parseGraphShareCoordinatorUrl,
  parseGraphShareProfilePointer,
  type GraphShareEnrollmentV2,
  type GraphShareProfileV1,
} from './profile.js';
import {parseGraphShareRegistryTarget} from './registry_reference.js';
import type {GraphShareAccessMode} from './trust.js';

export interface GraphShareOciRootApproval {
  readonly publisherKeyFingerprint: Sha256Digest;
  readonly registryCanonical: string;
}

export interface GraphShareOciProfileAccessPrompt {
  /** The final destination after applying the verified profile and any permitted CLI fallback. */
  readonly effectiveCoordinatorUrl?: string;
  readonly json?: boolean;
  readonly profile: GraphShareProfileV1;
  readonly readOnly?: boolean;
}

function requireInteractiveTerminal(system: SystemInfoShape, json: boolean | undefined) {
  if (json === true || !system.stdinIsTTY || !system.stdoutIsTTY)
    throw graphSharingFailure('Interactive OCI graph approval requires a TTY and non-JSON output.');
}

function promptLine(system: SystemInfoShape, prompt: string) {
  return Effect.callback<string>(resume => {
    const cleanup = system.readLine(prompt, line => resume(Effect.succeed(line)));
    return Effect.sync(cleanup);
  });
}

/** Confirm an independent root before any OCI registry or credential-helper access. */
export const promptGraphShareOciTrustRoot = Effect.fn('codeGraph.sharing.promptOciTrustRoot')(function* (input: {
  readonly enrollment: GraphShareEnrollmentV2;
  readonly json?: boolean;
}) {
  const system = yield* SystemInfo;
  yield* Effect.try({
    try: () => requireInteractiveTerminal(system, input.json),
    catch: () => graphSharingFailure('Interactive OCI graph approval requires a TTY and non-JSON output.'),
  });
  const pointer = yield* Effect.try({
    try: () => parseGraphShareProfilePointer(input.enrollment.profile),
    catch: () => graphSharingFailure('OCI graph enrollment pointer is invalid.'),
  });
  if (input.enrollment.schemaVersion !== 2 || pointer.kind !== 'oci')
    return yield* graphSharingFailure('OCI graph enrollment pointer is invalid.');
  if (!SHA256_DIGEST.test(input.enrollment.publisherKeyFingerprint))
    return yield* graphSharingFailure('OCI graph publisher fingerprint is invalid.');

  const namespace = yield* promptLine(
    system,
    `This repository requests the OCI profile namespace ${pointer.registryReference}.\n` +
      'Verify it with your organization administrator before continuing.\n' +
      'Type the exact trusted OCI namespace: ',
  );
  if (namespace !== pointer.registryReference)
    return yield* graphSharingFailure('OCI graph profile namespace was not independently confirmed.');
  const fingerprint = yield* promptLine(
    system,
    `This repository requests publisher fingerprint ${input.enrollment.publisherKeyFingerprint}.\n` +
      'Verify the full fingerprint with your organization administrator.\n' +
      'Type the exact trusted publisher fingerprint: ',
  );
  if (fingerprint !== input.enrollment.publisherKeyFingerprint)
    return yield* graphSharingFailure('OCI graph publisher fingerprint was not independently confirmed.');
  return {
    publisherKeyFingerprint: fingerprint as Sha256Digest,
    registryCanonical: pointer.registryReference,
  } satisfies GraphShareOciRootApproval;
});

/** Approve the verified profile's effective destinations and actual contribution behavior. */
export const promptGraphShareOciProfileAccess = Effect.fn('codeGraph.sharing.promptOciProfileAccess')(function* (
  input: GraphShareOciProfileAccessPrompt,
) {
  const system = yield* SystemInfo;
  yield* Effect.try({
    try: () => requireInteractiveTerminal(system, input.json),
    catch: () => graphSharingFailure('Interactive OCI graph approval requires a TTY and non-JSON output.'),
  });
  const effectiveCoordinator = input.effectiveCoordinatorUrl ?? input.profile.coordinator?.url;
  const coordinatorUrl =
    effectiveCoordinator === undefined
      ? undefined
      : yield* Effect.try({
          try: () => parseGraphShareCoordinatorUrl(effectiveCoordinator),
          catch: () => graphSharingFailure('Effective graph coordinator URL is invalid.'),
        });
  const profile = input.profile;
  const joinMode = effectiveGraphShareContributionMode('join', profile.contribution.defaultMode);
  const contributionBehavior =
    joinMode === 'off'
      ? 'off: joining does not upload graph results until contribution mode is changed'
      : 'passive: ordinary graph indexing/use may build results and the MCP monitor delivers them automatically';
  const prompt = [
    'Verified organization graph profile:',
    `  Organization: ${profile.organization}`,
    `  Effective coordinator: ${coordinatorUrl ?? '(none)'}`,
    `  Canonical registry: ${profile.registry.canonical}`,
    `  Worker registry: ${profile.registry.worker}`,
    `  Source remote: ${profile.source.canonicalRemote}`,
    `  Source branches: ${profile.source.branches.join(', ')}`,
    `  Declared default contribution mode: ${profile.contribution.defaultMode}`,
    `  Actual join behavior: ${contributionBehavior}`,
    ...(profile.contribution.defaultMode === 'idle' || profile.contribution.defaultMode === 'dedicated'
      ? ['  Idle and dedicated currently map to passive work on graph use; no idle/dedicated scheduler is active.']
      : []),
    '  Declared resource settings are not currently enforced scheduling controls:',
    `    AC power only: ${profile.contribution.activeOnlyOnAcPower}`,
    `    Idle only: ${profile.contribution.activeOnlyWhenIdle}`,
    `    Maximum CPUs: ${profile.contribution.maximumCpus}`,
    `    Maximum memory bytes: ${profile.contribution.maximumMemoryBytes}`,
    `    Maximum upload bytes/second: ${profile.contribution.maximumUploadBytesPerSecond}`,
    '  Read-only disables contributions. Join permits the actual behavior above.',
    input.readOnly === true
      ? 'Type read-only to approve this profile, or anything else to deny: '
      : 'Type read-only or join to approve this profile, or anything else to deny: ',
  ].join('\n');
  const answer = yield* promptLine(system, prompt);
  if (answer === 'read-only') return 'read-only' as const satisfies GraphShareAccessMode;
  if (answer !== 'join' || input.readOnly === true)
    return yield* graphSharingFailure('OCI graph profile access was not approved.');
  if (coordinatorUrl === undefined) return yield* graphSharingFailure('Joining requires an approved coordinator URL.');
  const canonical = yield* Effect.try({
    try: () => parseGraphShareRegistryTarget(profile.registry.canonical),
    catch: () => graphSharingFailure('Canonical OCI registry is invalid.'),
  });
  const worker = yield* Effect.try({
    try: () => parseGraphShareRegistryTarget(profile.registry.worker),
    catch: () => graphSharingFailure('Worker OCI registry is invalid.'),
  });
  if (canonical.origin === worker.origin && canonical.repository === worker.repository)
    return yield* graphSharingFailure('Joining requires distinct canonical and worker OCI namespaces.');
  return 'join' as const satisfies GraphShareAccessMode;
});
