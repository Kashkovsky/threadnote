import {Schema} from 'effect';
import {THREADNOTE_MCP_NAME} from '../constants.js';
import {COMPOSER_OAUTH_CLIENT_ID} from '../remote_memory/local_idp.js';
import {COMPOSER_OAUTH_SCOPES} from '../remote_memory/oauth.js';
import type {JsonObject} from '../types.js';

export const THREADNOTE_ORG_MCP_NAME = 'threadnote-org' as const;
export const THREADNOTE_COMPOSER_SHARE_ID_HEADER = 'threadnote-share-id';
const COMPOSER_SHARE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export const ORG_COMPOSER_POLICY = {
  canonicalStore: 'git',
  cursorOidc: 'optional-attribution',
  oauth: 'org-idp',
  shareBinding: 'header',
} as const;

export class ComposerAttachError extends Schema.TaggedError<ComposerAttachError>()('ComposerAttachError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

export interface ComposerShareBinding {
  readonly shareId: string;
  readonly url: string;
}

export interface ComposerMcpOAuthAuth {
  readonly CLIENT_ID: typeof COMPOSER_OAUTH_CLIENT_ID;
  readonly scopes: readonly (typeof COMPOSER_OAUTH_SCOPES)[number][];
}

export interface ComposerHttpMcpEntry {
  readonly [key: string]: unknown;
  readonly auth: ComposerMcpOAuthAuth;
  readonly headers: Readonly<{readonly [THREADNOTE_COMPOSER_SHARE_ID_HEADER]: string}>;
  readonly url: string;
}

export interface ComposerAttachOptions {
  readonly composerUrl?: string;
  readonly shareId?: string;
}

export function resolveComposerAttach(options: ComposerAttachOptions): ComposerShareBinding | undefined {
  const composerUrl = options.composerUrl?.trim();
  const shareId = options.shareId?.trim();
  if (!composerUrl && !shareId) return undefined;
  if (!composerUrl || !shareId) {
    throw ComposerAttachError.make({
      message: 'Organization composer attach requires both --composer-url and --share-id.',
    });
  }
  return {shareId: composerShareId(shareId), url: composerMcpUrl(composerUrl)};
}

export function resolveComposerServeShareId(teamName: string, shareId?: string): string {
  return composerShareId(shareId?.trim() || teamName);
}

export function composerShareId(shareId: string): string {
  const normalized = shareId.trim();
  if (!COMPOSER_SHARE_ID_PATTERN.test(normalized)) {
    throw ComposerAttachError.make({
      message:
        'The organization composer share ID must be an opaque identifier containing only letters, digits, dot, underscore, or hyphen.',
    });
  }
  return normalized;
}

export function composerMcpUrl(endpoint: string): string {
  const normalized = endpoint.trim();
  const hasUnsafeCharacter = [...normalized].some(character => {
    const codePoint = character.codePointAt(0) ?? 0;
    return /\s/u.test(character) || codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (!normalized || hasUnsafeCharacter) {
    throw ComposerAttachError.make({message: 'The organization composer endpoint must be a valid MCP URL.'});
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw ComposerAttachError.make({message: 'The organization composer endpoint must be a valid MCP URL.'});
  }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  if (
    (parsed.protocol !== 'https:' && !(loopback && parsed.protocol === 'http:')) ||
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0 ||
    parsed.search.length > 0 ||
    parsed.pathname !== '/mcp'
  ) {
    throw ComposerAttachError.make({
      message:
        'The organization composer endpoint must be the credential-free /mcp URL without a query or fragment; HTTPS is required outside loopback.',
    });
  }
  if (parsed.hostname === 'localhost') parsed.hostname = '127.0.0.1';
  return parsed.toString();
}

export function buildComposerHttpMcpEntry(url: string, shareId: string): ComposerHttpMcpEntry {
  return {
    auth: {
      CLIENT_ID: COMPOSER_OAUTH_CLIENT_ID,
      scopes: [...COMPOSER_OAUTH_SCOPES],
    },
    headers: {[THREADNOTE_COMPOSER_SHARE_ID_HEADER]: composerShareId(shareId)},
    url: composerMcpUrl(url),
  };
}

export function withComposerHttpMcpEntry(
  servers: Readonly<Record<string, JsonObject>>,
  stdioName: string,
  stdio: JsonObject,
  attach: ComposerShareBinding | undefined,
): Record<string, JsonObject> {
  if (attach && stdioName === THREADNOTE_ORG_MCP_NAME) {
    throw ComposerAttachError.make({
      message: 'Organization composer attach cannot use the reserved HTTP server name for the stdio Git adapter.',
    });
  }
  const next: Record<string, JsonObject> = {...servers, [stdioName]: stdio};
  if (attach) next[THREADNOTE_ORG_MCP_NAME] = buildComposerHttpMcpEntry(attach.url, attach.shareId);
  return next;
}

export function teamStdioServers(
  stdio: JsonObject,
  attach: ComposerShareBinding | undefined,
): Record<string, JsonObject> {
  return withComposerHttpMcpEntry({}, THREADNOTE_MCP_NAME, stdio, attach);
}

export function stdioEnvironmentCallsComposer(env: Readonly<Record<string, unknown>>): boolean {
  return typeof env.THREADNOTE_CURSOR_MEMORY_ENDPOINT === 'string' && env.THREADNOTE_CURSOR_MEMORY_ENDPOINT.length > 0;
}

export function composerHttpEntryMatches(actual: unknown, expected: ComposerHttpMcpEntry): boolean {
  return (
    isManagedComposerHttpEntry(actual) &&
    actual.url === expected.url &&
    actual.headers[THREADNOTE_COMPOSER_SHARE_ID_HEADER] === expected.headers[THREADNOTE_COMPOSER_SHARE_ID_HEADER] &&
    actual.auth.CLIENT_ID === expected.auth.CLIENT_ID &&
    actual.auth.scopes.length === expected.auth.scopes.length &&
    actual.auth.scopes.every((scope, index) => scope === expected.auth.scopes[index])
  );
}

export function isManagedComposerHttpEntry(actual: unknown): actual is ComposerHttpMcpEntry {
  if (!isRecord(actual) || typeof actual.url !== 'string' || !isRecord(actual.headers) || !isRecord(actual.auth)) {
    return false;
  }
  const shareId = actual.headers[THREADNOTE_COMPOSER_SHARE_ID_HEADER];
  if (typeof shareId !== 'string' || Object.keys(actual.headers).length !== 1) return false;
  if (actual.auth.CLIENT_ID !== COMPOSER_OAUTH_CLIENT_ID || !Array.isArray(actual.auth.scopes)) return false;
  if (actual.auth.scopes.length !== COMPOSER_OAUTH_SCOPES.length) return false;
  if (actual.auth.scopes.some((scope, index) => scope !== COMPOSER_OAUTH_SCOPES[index])) return false;
  try {
    composerMcpUrl(actual.url);
    composerShareId(shareId);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
