export type ManagerDemoTabId = 'graph' | 'memory' | 'shares' | 'doctor' | 'tools';

export type ManagerDemoTone = 'azure' | 'teal' | 'violet' | 'amber' | 'rose';

export interface ManagerDemoGraphNode {
  readonly connections: number;
  readonly exported: boolean;
  readonly id: string;
  readonly kind: 'class' | 'function' | 'interface' | 'module' | 'protocol';
  readonly label: string;
  readonly language: 'Java' | 'Kotlin' | 'Swift' | 'TypeScript';
  readonly path: string;
  readonly project: string;
  readonly signature: string;
  readonly tone: ManagerDemoTone;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ManagerDemoGraphEdge {
  readonly confidence: number;
  readonly provenance: 'authoritative' | 'heuristic';
  readonly relation: 'calls' | 'conforms_to' | 'implements' | 'imports' | 'uses';
  readonly source: string;
  readonly target: string;
}

export const managerDemoTabs: readonly {
  readonly count: string;
  readonly id: ManagerDemoTabId;
  readonly label: string;
}[] = [
  {count: '18.2k', id: 'graph', label: 'Graph'},
  {count: '1,284', id: 'memory', label: 'Library'},
  {count: '3', id: 'shares', label: 'Sharing'},
  {count: '5/5', id: 'doctor', label: 'Health'},
  {count: '8', id: 'tools', label: 'Tools'},
];

export const managerDemoNodes: readonly ManagerDemoGraphNode[] = [
  {
    connections: 14,
    exported: true,
    id: 'request-retry-coordinator',
    kind: 'class',
    label: 'RequestRetryCoordinator',
    language: 'TypeScript',
    path: 'apps/web/src/network/RequestRetryCoordinator.ts',
    project: 'apps/web',
    signature: 'export class RequestRetryCoordinator',
    tone: 'violet',
    x: -3.7,
    y: 1.6,
    z: -0.2,
  },
  {
    connections: 11,
    exported: true,
    id: 'retry-failed-request',
    kind: 'function',
    label: 'retryFailedRequest',
    language: 'TypeScript',
    path: 'apps/web/src/network/retryFailedRequest.ts',
    project: 'apps/web',
    signature: 'export async function retryFailedRequest(request: RequestEnvelope)',
    tone: 'violet',
    x: -2.3,
    y: 0.7,
    z: 0.8,
  },
  {
    connections: 9,
    exported: true,
    id: 'web-auth-session',
    kind: 'function',
    label: 'useAuthSession',
    language: 'TypeScript',
    path: 'apps/web/src/auth/useAuthSession.ts',
    project: 'apps/web',
    signature: 'export function useAuthSession(): AuthSession',
    tone: 'violet',
    x: -3.2,
    y: -1.2,
    z: -0.4,
  },
  {
    connections: 17,
    exported: true,
    id: 'session-envelope',
    kind: 'interface',
    label: 'SessionEnvelope',
    language: 'TypeScript',
    path: 'libs/session-core/src/SessionEnvelope.ts',
    project: 'libs/session-core',
    signature: 'export interface SessionEnvelope',
    tone: 'teal',
    x: -0.8,
    y: -0.2,
    z: 0.2,
  },
  {
    connections: 10,
    exported: true,
    id: 'refresh-session',
    kind: 'function',
    label: 'refreshSession',
    language: 'TypeScript',
    path: 'libs/session-core/src/refreshSession.ts',
    project: 'libs/session-core',
    signature: 'export async function refreshSession(token: RefreshToken)',
    tone: 'teal',
    x: -0.7,
    y: 1.8,
    z: -0.6,
  },
  {
    connections: 13,
    exported: true,
    id: 'auth-contract',
    kind: 'interface',
    label: 'AuthContract',
    language: 'Java',
    path: 'libs/auth-contracts/src/main/java/dev/thread/AuthContract.java',
    project: 'libs/auth-contracts',
    signature: 'public interface AuthContract',
    tone: 'amber',
    x: 1.2,
    y: 0.2,
    z: 0.4,
  },
  {
    connections: 8,
    exported: true,
    id: 'token-codec',
    kind: 'class',
    label: 'TokenCodec',
    language: 'Java',
    path: 'libs/auth-contracts/src/main/java/dev/thread/TokenCodec.java',
    project: 'libs/auth-contracts',
    signature: 'public final class TokenCodec',
    tone: 'amber',
    x: 0.7,
    y: -1.8,
    z: -0.2,
  },
  {
    connections: 12,
    exported: true,
    id: 'auth-repository',
    kind: 'class',
    label: 'AuthRepository',
    language: 'Kotlin',
    path: 'apps/android/auth/src/main/kotlin/AuthRepository.kt',
    project: 'apps/android',
    signature: 'class AuthRepository(private val api: AuthApi)',
    tone: 'azure',
    x: 3.3,
    y: -1.2,
    z: 0.2,
  },
  {
    connections: 7,
    exported: false,
    id: 'token-refresh-worker',
    kind: 'class',
    label: 'TokenRefreshWorker',
    language: 'Kotlin',
    path: 'apps/android/auth/src/main/kotlin/TokenRefreshWorker.kt',
    project: 'apps/android',
    signature: 'internal class TokenRefreshWorker',
    tone: 'azure',
    x: 3.7,
    y: -2.7,
    z: -0.7,
  },
  {
    connections: 9,
    exported: true,
    id: 'session-store',
    kind: 'class',
    label: 'SessionStore',
    language: 'Swift',
    path: 'apps/ios/Sources/Auth/SessionStore.swift',
    project: 'apps/ios',
    signature: 'public final class SessionStore: ObservableObject',
    tone: 'rose',
    x: 3.4,
    y: 1.4,
    z: 0.1,
  },
  {
    connections: 6,
    exported: true,
    id: 'refresh-coordinator',
    kind: 'class',
    label: 'RefreshCoordinator',
    language: 'Swift',
    path: 'apps/ios/Sources/Auth/RefreshCoordinator.swift',
    project: 'apps/ios',
    signature: 'public actor RefreshCoordinator',
    tone: 'rose',
    x: 2.7,
    y: 2.8,
    z: -0.8,
  },
  {
    connections: 5,
    exported: true,
    id: 'auth-session-provider',
    kind: 'protocol',
    label: 'AuthSessionProviding',
    language: 'Swift',
    path: 'apps/ios/Sources/Auth/AuthSessionProviding.swift',
    project: 'apps/ios',
    signature: 'public protocol AuthSessionProviding',
    tone: 'rose',
    x: 1.6,
    y: 2.2,
    z: 0.9,
  },
];

export const managerDemoEdges: readonly ManagerDemoGraphEdge[] = [
  {
    confidence: 1,
    provenance: 'authoritative',
    relation: 'calls',
    source: 'request-retry-coordinator',
    target: 'retry-failed-request',
  },
  {
    confidence: 0.98,
    provenance: 'authoritative',
    relation: 'uses',
    source: 'retry-failed-request',
    target: 'web-auth-session',
  },
  {
    confidence: 1,
    provenance: 'authoritative',
    relation: 'calls',
    source: 'web-auth-session',
    target: 'refresh-session',
  },
  {
    confidence: 1,
    provenance: 'authoritative',
    relation: 'uses',
    source: 'refresh-session',
    target: 'session-envelope',
  },
  {
    confidence: 0.92,
    provenance: 'authoritative',
    relation: 'implements',
    source: 'session-envelope',
    target: 'auth-contract',
  },
  {
    confidence: 1,
    provenance: 'authoritative',
    relation: 'uses',
    source: 'token-codec',
    target: 'auth-contract',
  },
  {
    confidence: 0.97,
    provenance: 'authoritative',
    relation: 'implements',
    source: 'auth-repository',
    target: 'auth-contract',
  },
  {
    confidence: 1,
    provenance: 'authoritative',
    relation: 'calls',
    source: 'token-refresh-worker',
    target: 'auth-repository',
  },
  {
    confidence: 0.96,
    provenance: 'authoritative',
    relation: 'conforms_to',
    source: 'session-store',
    target: 'auth-session-provider',
  },
  {
    confidence: 0.91,
    provenance: 'heuristic',
    relation: 'implements',
    source: 'auth-session-provider',
    target: 'auth-contract',
  },
  {
    confidence: 1,
    provenance: 'authoritative',
    relation: 'calls',
    source: 'refresh-coordinator',
    target: 'session-store',
  },
  {
    confidence: 0.89,
    provenance: 'heuristic',
    relation: 'uses',
    source: 'refresh-coordinator',
    target: 'token-codec',
  },
  {
    confidence: 0.94,
    provenance: 'authoritative',
    relation: 'imports',
    source: 'web-auth-session',
    target: 'auth-contract',
  },
];

export const managerDemoMemories = [
  {
    project: 'mobile-auth',
    status: 'active',
    summary: 'Refresh tokens rotate once; callers retry through the shared session envelope.',
    topic: 'token-rotation-contract',
    updated: '2 min ago',
    uri: 'threadnote://user/demo/memories/shared/default-team/durable/projects/mobile-auth/token-rotation-contract.md',
  },
  {
    project: 'request-runtime',
    status: 'active',
    summary: 'Retries use bounded exponential backoff and preserve request identity across attempts.',
    topic: 'request-retry-policy',
    updated: '18 min ago',
    uri: 'threadnote://user/demo/memories/durable/projects/request-runtime/request-retry-policy.md',
  },
  {
    project: 'checkout',
    status: 'superseded',
    summary: 'Legacy checkout cutover notes retained for release archaeology.',
    topic: 'checkout-cutover',
    updated: 'May 12',
    uri: 'threadnote://user/demo/memories/shared/default-team/durable/projects/checkout/checkout-cutover.md',
  },
] as const;

export const managerDemoShares = [
  {
    addedAt: '2026-06-03T09:14:00.000Z',
    ahead: 0,
    behind: 0,
    default: true,
    direction: 'default · clean',
    dirty: false,
    gitdir: '~/.threadnote/share/default-team.git',
    label: 'default-team',
    memories: 428,
    name: 'default-team',
    remote: 'git@github.com:acme/threadnote-team.git',
    status: 'synced',
    updated: '12 seconds ago',
    worktree: '~/.threadnote/share/default-team',
  },
  {
    addedAt: '2026-06-18T13:40:00.000Z',
    ahead: 0,
    behind: 1,
    default: false,
    direction: 'behind 1 · clean',
    dirty: false,
    gitdir: '~/.threadnote/share/mobile-platform.git',
    label: 'mobile-platform',
    memories: 76,
    name: 'mobile-platform',
    remote: 'git@github.com:acme/mobile-platform-memory.git',
    status: 'behind',
    updated: '1 minute ago',
    worktree: '~/.threadnote/share/mobile-platform',
  },
  {
    addedAt: '2026-07-09T07:22:00.000Z',
    ahead: 0,
    behind: 0,
    default: false,
    direction: 'clean',
    dirty: false,
    gitdir: '~/.threadnote/share/incident-history.git',
    label: 'incident-history',
    memories: 193,
    name: 'incident-history',
    remote: 'git@github.com:acme/incident-history.git',
    status: 'synced',
    updated: '4 minutes ago',
    worktree: '~/.threadnote/share/incident-history',
  },
] as const;

export const managerDemoChecks = [
  {
    detail: '~/.threadnote/data · SQLite integrity OK',
    label: 'Canonical storage',
    status: 'healthy',
  },
  {
    detail: '1,284 lexical documents · 6,412 vector chunks',
    label: 'Recall indexes',
    status: 'healthy',
  },
  {
    detail: 'Embedding model installed · local inference ready',
    label: 'Local AI',
    status: 'healthy',
  },
  {
    detail: 'Codex and Claude Code connected',
    label: 'MCP integrations',
    status: 'healthy',
  },
  {
    detail: 'Agent instructions present and current',
    label: 'Instructions',
    status: 'healthy',
  },
] as const;

export const managerDemoTools = [
  {
    description: 'Recall durable context and handoffs for a project.',
    name: 'recall_context',
    surface: 'MCP',
  },
  {
    description: 'Query, explain, trace paths, or assess impact in the current code snapshot.',
    name: 'inspect_code_graph',
    surface: 'MCP',
  },
  {
    description: 'Store a durable decision or short-lived handoff.',
    name: 'remember_context',
    surface: 'MCP',
  },
  {
    description: 'Inspect storage, indexes, models, integrations, and instructions.',
    name: 'threadnote doctor',
    surface: 'CLI',
  },
  {
    description: 'Build or refresh a repository code graph.',
    name: 'threadnote graph index',
    surface: 'CLI',
  },
  {
    description: 'Synchronize explicitly configured team shares.',
    name: 'threadnote share sync',
    surface: 'CLI',
  },
  {
    description: 'Open the local Manager in the browser.',
    name: 'threadnote manage',
    surface: 'CLI',
  },
  {
    description: 'Project selected memories into an Obsidian vault.',
    name: 'threadnote projection sync',
    surface: 'CLI',
  },
] as const;
