import {
  boundedText,
  exactKeys,
  invalid,
  matchingHash,
  protocolDigest,
  record,
} from './code-memory-link-agent-protocol-primitives.js';

export const CODE_MEMORY_LINK_CODEX_APP_SERVER_VERSION = '0.144.5' as const;

export interface CodeMemoryLinkExpectedCodexClientV1 {
  readonly appServerVersion: typeof CODE_MEMORY_LINK_CODEX_APP_SERVER_VERSION;
  readonly model: string;
  readonly modelProvider: string;
  readonly reasoningEffort: string;
}

export interface CodeMemoryLinkProxyToolV1 {
  readonly server: string;
  readonly tool: string;
}

export interface CodeMemoryLinkExpectedCodexClientProjectionV1 {
  readonly appServerVersion: typeof CODE_MEMORY_LINK_CODEX_APP_SERVER_VERSION;
  readonly effectiveModel: string;
  readonly modelProviderDigest: string;
  readonly proxyToolDigest: string;
  readonly reasoningEffortDigest: string;
}

export function parseCodeMemoryLinkExpectedCodexClientV1(value: unknown): CodeMemoryLinkExpectedCodexClientV1 {
  const client = record(value, 'expected Codex client');
  exactKeys(client, ['appServerVersion', 'model', 'modelProvider', 'reasoningEffort'], 'expected Codex client');
  if (client.appServerVersion !== CODE_MEMORY_LINK_CODEX_APP_SERVER_VERSION) {
    invalid(`Codex app-server version must be ${CODE_MEMORY_LINK_CODEX_APP_SERVER_VERSION}`);
  }
  return {
    appServerVersion: CODE_MEMORY_LINK_CODEX_APP_SERVER_VERSION,
    model: boundedText(client.model, 'expected model', 128),
    modelProvider: boundedText(client.modelProvider, 'expected model provider', 128),
    reasoningEffort: boundedText(client.reasoningEffort, 'expected reasoning effort', 64),
  };
}

export function parseCodeMemoryLinkProxyToolV1(value: unknown): CodeMemoryLinkProxyToolV1 {
  const tool = record(value, 'Context Brief proxy tool');
  exactKeys(tool, ['server', 'tool'], 'Context Brief proxy tool');
  return {
    server: boundedText(tool.server, 'Context Brief proxy server', 128),
    tool: boundedText(tool.tool, 'Context Brief proxy tool', 128),
  };
}

export function projectCodeMemoryLinkExpectedCodexClientV1(input: {
  readonly expectedClient: unknown;
  readonly proxyTool: unknown;
}): CodeMemoryLinkExpectedCodexClientProjectionV1 {
  const client = parseCodeMemoryLinkExpectedCodexClientV1(input.expectedClient);
  const proxyTool = parseCodeMemoryLinkProxyToolV1(input.proxyTool);
  return {
    appServerVersion: client.appServerVersion,
    effectiveModel: client.model,
    modelProviderDigest: protocolDigest('model-provider', client.modelProvider),
    proxyToolDigest: protocolDigest('proxy-tool', proxyTool),
    reasoningEffortDigest: protocolDigest('reasoning-effort', client.reasoningEffort),
  };
}

export function assertCodeMemoryLinkExpectedCodexClientProjectionV1(input: {
  readonly expectedClient: unknown;
  readonly proxyTool: unknown;
  readonly retainedIdentity: unknown;
}): CodeMemoryLinkExpectedCodexClientProjectionV1 {
  const expected = projectCodeMemoryLinkExpectedCodexClientV1(input);
  const retained = record(input.retainedIdentity, 'retained Codex client identity');
  exactKeys(
    retained,
    ['appServerVersion', 'effectiveModel', 'modelProviderDigest', 'proxyToolDigest', 'reasoningEffortDigest'],
    'retained Codex client identity',
  );
  const observed = {
    appServerVersion: retained.appServerVersion,
    effectiveModel: boundedText(retained.effectiveModel, 'retained effective model', 128),
    modelProviderDigest: matchingHash(retained.modelProviderDigest, 'retained model provider'),
    proxyToolDigest: matchingHash(retained.proxyToolDigest, 'retained proxy tool'),
    reasoningEffortDigest: matchingHash(retained.reasoningEffortDigest, 'retained reasoning effort'),
  };
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    invalid('retained Codex client identity differs from the reviewed client and proxy descriptor');
  }
  return expected;
}
