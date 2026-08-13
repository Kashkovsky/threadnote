import {Encoding, Result} from 'effect';
import {sha256HexSync} from '../crypto/sha256.js';
import type {EnabledTelemetryConfiguration} from './config.js';

export const TELEMETRY_AGENT_SESSION_ENVIRONMENT_VARIABLE = 'THREADNOTE_TELEMETRY_SESSION_ID';
export const TELEMETRY_CONSENT_GENERATION_ENVIRONMENT_VARIABLE = 'THREADNOTE_TELEMETRY_CONSENT_GENERATION';
export const TELEMETRY_CHILD_ENVIRONMENT_VARIABLE = 'THREADNOTE_TELEMETRY_CHILD';
export const TELEMETRY_PROVIDER_ENVIRONMENT_VARIABLE = 'THREADNOTE_AGENT_SESSION_PROVIDER';
export const TELEMETRY_PROVIDER_SESSION_TOKEN_ENVIRONMENT_VARIABLE = 'THREADNOTE_AGENT_SESSION_TOKEN';

const AGENT_SESSION_ID_PREFIX = 'tns_';
const AGENT_SESSION_RANDOM_BYTES = 16;
const HMAC_SHA256_BLOCK_BYTES = 64;
const MINIMUM_CONSENT_SALT_BYTES = 32;
const CONSENT_SALT_BYTES = 32;
const MAXIMUM_PROVIDER_SESSION_TOKEN_BYTES = 4_096;
const CONSENT_GENERATION_PREFIX = 'tng_';

export type AgentSessionProvider = 'claude' | 'codex' | 'copilot' | 'cursor';
export type TelemetryChildKind =
  'auto-update-worker' | 'graph-builder' | 'local-model-worker' | 'mcp-broker-runtime' | 'mcp-server' | 'parser-worker';

export interface ResolvedAgentSession {
  readonly consentGeneration?: string;
  readonly correlationScope: 'broker' | 'invocation' | 'provider-session';
  readonly id: string;
}

export interface PreparedAgentSession {
  readonly consentGeneration: string;
  readonly id: string;
}

interface ConsumedAgentSessionEnvironment {
  readonly childKind?: string;
  readonly consentGeneration?: string;
  readonly inheritedSessionId?: string;
  readonly provider?: string;
  readonly providerSessionToken?: string;
}

/**
 * Creates an anonymous correlation id for one process-owned agent session.
 * The id is ephemeral: creating it does not imply consent to export it.
 */
export function anonymousAgentSessionId(randomBytes: Uint8Array): string {
  if (randomBytes.byteLength !== AGENT_SESSION_RANDOM_BYTES) {
    throw new RangeError(`Anonymous agent session ids require exactly ${AGENT_SESSION_RANDOM_BYTES} random bytes.`);
  }
  return `${AGENT_SESSION_ID_PREFIX}${hex(randomBytes)}`;
}

/**
 * Derives a stable pseudonym only when the caller supplies a persisted salt
 * created behind explicit telemetry consent. Raw provider tokens are neither
 * returned nor retained by this helper.
 */
export function deriveConsentedAgentSessionPseudonym(options: {
  readonly consentSalt: Uint8Array | undefined;
  readonly provider: AgentSessionProvider;
  readonly providerSessionToken: string | undefined;
}): string | undefined {
  const {consentSalt, provider, providerSessionToken} = options;
  if (consentSalt === undefined || consentSalt.byteLength < MINIMUM_CONSENT_SALT_BYTES) return undefined;
  if (
    providerSessionToken === undefined ||
    providerSessionToken.length === 0 ||
    providerSessionToken.length > MAXIMUM_PROVIDER_SESSION_TOKEN_BYTES
  ) {
    return undefined;
  }
  const tokenBytes = new TextEncoder().encode(providerSessionToken);
  if (tokenBytes.byteLength > MAXIMUM_PROVIDER_SESSION_TOKEN_BYTES) return undefined;
  const message = new TextEncoder().encode(`threadnote-agent-session-v1\0${provider}\0${providerSessionToken}`);
  return `${AGENT_SESSION_ID_PREFIX}${hmacSha256Hex(consentSalt, message).slice(0, AGENT_SESSION_RANDOM_BYTES * 2)}`;
}

/** Resolves an explicit host integration only behind valid persisted consent. */
export function resolveAgentSession(options: {
  readonly configuration: Pick<EnabledTelemetryConfiguration, 'endpoint' | 'sessionSalt'> | undefined;
  readonly environment: NodeJS.ProcessEnv;
  readonly fallbackScope?: 'broker' | 'invocation';
  readonly randomBytes: Uint8Array;
}): ResolvedAgentSession {
  const inputs = consumeAgentSessionEnvironment(options.environment);
  const random = (consentGeneration?: string): ResolvedAgentSession => ({
    ...(consentGeneration === undefined ? {} : {consentGeneration}),
    correlationScope: options.fallbackScope ?? 'broker',
    id: anonymousAgentSessionId(options.randomBytes),
  });
  if (options.configuration === undefined) return random();
  const salt = Encoding.decodeBase64Url(options.configuration.sessionSalt);
  if (
    !Result.isSuccess(salt) ||
    salt.success.byteLength !== CONSENT_SALT_BYTES ||
    Encoding.encodeBase64Url(salt.success) !== options.configuration.sessionSalt
  ) {
    return random();
  }
  const consentGeneration = telemetryConsentGeneration(options.configuration);
  if (
    isTelemetryChildKind(inputs.childKind) &&
    inputs.consentGeneration === consentGeneration &&
    inputs.inheritedSessionId !== undefined &&
    isAnonymousAgentSessionId(inputs.inheritedSessionId)
  ) {
    return {consentGeneration, correlationScope: 'broker', id: inputs.inheritedSessionId};
  }
  const provider = agentSessionProvider(inputs.provider);
  if (provider === undefined) return random(consentGeneration);
  const id = deriveConsentedAgentSessionPseudonym({
    consentSalt: salt.success,
    provider,
    providerSessionToken: inputs.providerSessionToken,
  });
  return id === undefined ? random(consentGeneration) : {consentGeneration, correlationScope: 'provider-session', id};
}

/** Opaque marker binding a child alias to the exact endpoint and local consent salt generation. */
export function telemetryConsentGeneration(
  configuration: Pick<EnabledTelemetryConfiguration, 'endpoint' | 'sessionSalt'>,
): string {
  return `${CONSENT_GENERATION_PREFIX}${sha256HexSync(
    `threadnote-telemetry-consent-generation-v1\0${configuration.endpoint}\0${configuration.sessionSalt}`,
  ).slice(0, 32)}`;
}

/** Copies an environment while explicitly admitting one intended Threadnote child. */
export function withAgentSessionEnvironment(
  environment: NodeJS.ProcessEnv,
  session: Pick<ResolvedAgentSession, 'consentGeneration' | 'id'>,
  childKind: TelemetryChildKind,
): NodeJS.ProcessEnv {
  const childEnvironment = withoutTelemetrySessionEnvironment(environment);
  if (session.consentGeneration === undefined) return childEnvironment;
  if (!isAnonymousAgentSessionId(session.id)) {
    throw new TypeError('Threadnote agent session id has an invalid format.');
  }
  if (!isTelemetryConsentGeneration(session.consentGeneration)) {
    throw new TypeError('Threadnote telemetry consent generation has an invalid format.');
  }
  childEnvironment[TELEMETRY_AGENT_SESSION_ENVIRONMENT_VARIABLE] = session.id;
  childEnvironment[TELEMETRY_CONSENT_GENERATION_ENVIRONMENT_VARIABLE] = session.consentGeneration;
  childEnvironment[TELEMETRY_CHILD_ENVIRONMENT_VARIABLE] = childKind;
  return childEnvironment;
}

/** Preserves the current opaque alias only for an explicitly selected Threadnote child. */
export function withCurrentAgentSessionEnvironment(
  environment: NodeJS.ProcessEnv,
  childKind: TelemetryChildKind,
): NodeJS.ProcessEnv {
  const id = environment[TELEMETRY_AGENT_SESSION_ENVIRONMENT_VARIABLE];
  const consentGeneration = environment[TELEMETRY_CONSENT_GENERATION_ENVIRONMENT_VARIABLE];
  if (
    id === undefined ||
    consentGeneration === undefined ||
    !isAnonymousAgentSessionId(id) ||
    !isTelemetryConsentGeneration(consentGeneration)
  ) {
    return withoutTelemetrySessionEnvironment(environment);
  }
  return withAgentSessionEnvironment(environment, {consentGeneration, id}, childKind);
}

/** Installs only the current opaque alias and marker; generic child launchers still scrub both. */
export function retainCurrentAgentSessionEnvironment(
  environment: NodeJS.ProcessEnv,
  session: ResolvedAgentSession,
  childKind?: TelemetryChildKind,
): void {
  clearTelemetrySessionEnvironment(environment);
  if (session.consentGeneration === undefined) return;
  environment[TELEMETRY_AGENT_SESSION_ENVIRONMENT_VARIABLE] = session.id;
  environment[TELEMETRY_CONSENT_GENERATION_ENVIRONMENT_VARIABLE] = session.consentGeneration;
  if (childKind !== undefined) environment[TELEMETRY_CHILD_ENVIRONMENT_VARIABLE] = childKind;
}

/** Generic external subprocesses inherit neither raw provider input nor Threadnote correlation state. */
export function withoutTelemetrySessionEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = {...environment};
  clearTelemetrySessionEnvironment(sanitized);
  return sanitized;
}

/** Snapshot provider/child inputs, then remove them from the live process before any fallible setup. */
export function takeTelemetrySessionEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const snapshot = {...environment};
  clearTelemetrySessionEnvironment(environment);
  return snapshot;
}

/**
 * Consumes the opaque alias prepared for one exact Threadnote runtime bridge.
 * Invalid, missing, or inaccessible telemetry state is treated as disabled.
 */
export function takePreparedAgentSessionEnvironment(
  environment: NodeJS.ProcessEnv,
  expectedChildKind: TelemetryChildKind,
): PreparedAgentSession | undefined {
  try {
    const inputs = consumeAgentSessionEnvironment(environment);
    if (
      inputs.childKind !== expectedChildKind ||
      inputs.consentGeneration === undefined ||
      inputs.inheritedSessionId === undefined ||
      !isTelemetryConsentGeneration(inputs.consentGeneration) ||
      !isAnonymousAgentSessionId(inputs.inheritedSessionId)
    ) {
      return undefined;
    }
    return {consentGeneration: inputs.consentGeneration, id: inputs.inheritedSessionId};
  } catch {
    clearTelemetrySessionEnvironmentFailSoft(environment);
    return undefined;
  }
}

export function isAnonymousAgentSessionId(value: string): boolean {
  return /^tns_[\da-f]{32}$/u.test(value);
}

export function isTelemetryConsentGeneration(value: string): boolean {
  return /^tng_[\da-f]{32}$/u.test(value);
}

function hmacSha256Hex(key: Uint8Array, message: Uint8Array): string {
  const normalizedKey = key.byteLength > HMAC_SHA256_BLOCK_BYTES ? fromHex(sha256HexSync(key)) : key;
  const keyBlock = new Uint8Array(HMAC_SHA256_BLOCK_BYTES);
  keyBlock.set(normalizedKey);
  const innerPad = keyBlock.map(value => value ^ 0x36);
  const outerPad = keyBlock.map(value => value ^ 0x5c);
  const innerDigest = fromHex(sha256HexSync(concatenate(innerPad, message)));
  return sha256HexSync(concatenate(outerPad, innerDigest));
}

function agentSessionProvider(value: string | undefined): AgentSessionProvider | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'claude' || normalized === 'codex' || normalized === 'copilot' || normalized === 'cursor'
    ? normalized
    : undefined;
}

function consumeAgentSessionEnvironment(environment: NodeJS.ProcessEnv): ConsumedAgentSessionEnvironment {
  const inputs = {
    childKind: environment[TELEMETRY_CHILD_ENVIRONMENT_VARIABLE],
    consentGeneration: environment[TELEMETRY_CONSENT_GENERATION_ENVIRONMENT_VARIABLE],
    inheritedSessionId: environment[TELEMETRY_AGENT_SESSION_ENVIRONMENT_VARIABLE],
    provider: environment[TELEMETRY_PROVIDER_ENVIRONMENT_VARIABLE],
    providerSessionToken: environment[TELEMETRY_PROVIDER_SESSION_TOKEN_ENVIRONMENT_VARIABLE],
  };
  clearTelemetrySessionEnvironment(environment);
  return inputs;
}

function clearTelemetrySessionEnvironment(environment: NodeJS.ProcessEnv): void {
  delete environment[TELEMETRY_PROVIDER_ENVIRONMENT_VARIABLE];
  delete environment[TELEMETRY_PROVIDER_SESSION_TOKEN_ENVIRONMENT_VARIABLE];
  delete environment[TELEMETRY_AGENT_SESSION_ENVIRONMENT_VARIABLE];
  delete environment[TELEMETRY_CONSENT_GENERATION_ENVIRONMENT_VARIABLE];
  delete environment[TELEMETRY_CHILD_ENVIRONMENT_VARIABLE];
}

function clearTelemetrySessionEnvironmentFailSoft(environment: NodeJS.ProcessEnv): void {
  for (const name of [
    TELEMETRY_PROVIDER_ENVIRONMENT_VARIABLE,
    TELEMETRY_PROVIDER_SESSION_TOKEN_ENVIRONMENT_VARIABLE,
    TELEMETRY_AGENT_SESSION_ENVIRONMENT_VARIABLE,
    TELEMETRY_CONSENT_GENERATION_ENVIRONMENT_VARIABLE,
    TELEMETRY_CHILD_ENVIRONMENT_VARIABLE,
  ]) {
    try {
      delete environment[name];
    } catch {
      // Telemetry state must never make the owning runtime fail.
    }
  }
}

function isTelemetryChildKind(value: string | undefined): value is TelemetryChildKind {
  return (
    value === 'auto-update-worker' ||
    value === 'graph-builder' ||
    value === 'local-model-worker' ||
    value === 'mcp-broker-runtime' ||
    value === 'mcp-server' ||
    value === 'parser-worker'
  );
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}

function hex(value: Uint8Array): string {
  return [...value].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from({length: value.length / 2}, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  );
}
