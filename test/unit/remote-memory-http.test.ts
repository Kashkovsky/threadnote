import {describe, expect, it} from 'vitest';
import type {RemoteMemoryReceiptV1} from '../../src/memory_domain/receipts.js';
import type {AuthorizedRemotePrincipal} from '../../src/remote_memory/authorization.js';
import type {RemoteMemoryServiceConfig} from '../../src/remote_memory/config.js';
import {remoteMemoryError} from '../../src/remote_memory/errors.js';
import {createRemoteMemoryHttpHandler} from '../../src/remote_memory/http_transport.js';
import type {OAuthPrincipalClaims} from '../../src/remote_memory/oauth.js';
import type {
  RemoteMemoryServiceDependencies,
  RemoteMemoryServiceRepository,
} from '../../src/remote_memory/service_types.js';
import {REMOTE_MEMORY_TOOL_NAMES} from '../../src/remote_memory/tools.js';

const PROTOCOL_VERSION = '2025-06-18';

interface Fixture {
  readonly calls: string[];
  readonly handler: (request: Request) => Promise<Response>;
}

function fixture(
  options: {
    readonly allowedProjects?: ReadonlySet<string> | 'all';
    readonly capabilities?: readonly string[];
    readonly rateLimitFailure?: boolean;
    readonly ready?: boolean;
    readonly receipt?: Partial<RemoteMemoryReceiptV1>;
    readonly repositoryFailure?: Error;
    readonly serviceEnabled?: boolean;
    readonly trackRateLimits?: boolean;
  } = {},
): Fixture {
  const calls: string[] = [];
  const OAuth: OAuthPrincipalClaims = {
    issuer: 'https://auth.example.test',
    scopes: new Set(options.capabilities ?? ['memory:read', 'memory:write:durable', 'memory:write:handoff']),
    subject: 'oauth-subject',
  };
  const principal: AuthorizedRemotePrincipal = {
    allowedProjects: options.allowedProjects ?? 'all',
    attestationRequiredForWrites: false,
    capabilities: new Set(
      options.capabilities ?? ['memory:read', 'memory:write:durable', 'memory:write:handoff'],
    ) as AuthorizedRemotePrincipal['capabilities'],
    cursorOwnerIds: new Set(),
    cursorSubjects: new Set(),
    featureFlags: new Set([
      'remote_memory_read',
      'remote_memory_durable_write',
      'remote_memory_handoff_write',
      'remote_memory_ga',
    ]),
    OAuth,
    policyVersion: 'policy-v1',
    policyDigest: 'digest-v1',
    principalId: 'principal-1',
    repositoryBindings: new Set(),
    repositoriesByProject: new Map(),
    shareId: 'share-1',
    sharePolicyDigest: 'share-digest-v1',
    sharePolicyVersion: 'share-policy-v1',
    tenantId: 'tenant-1',
  };
  const receipt = {...receiptFixture(), ...options.receipt};
  const repository: RemoteMemoryServiceRepository = {
    list: async (_principal, _input, requestId) => {
      calls.push(`list:${requestId}`);
      return {entries: [], receipt: {...receipt, requestId}};
    },
    read: async (_principal, input, requestId) => {
      calls.push(`read:${requestId}`);
      if (options.repositoryFailure) throw options.repositoryFailure;
      return {
        content: 'MEMORY\nkind: durable\n\nFixture body',
        kind: 'durable',
        project: 'threadnote',
        receipt: {...receipt, requestId, uri: input.uri},
        status: 'active',
        topic: 'fixture',
        uri: input.uri,
      };
    },
    recall: async (_principal, input, requestId) => {
      calls.push(`recall:${requestId}:${input.query}`);
      return {receipt: {...receipt, requestId}, results: []};
    },
    remember: async (_principal, input, requestId) => {
      calls.push(`remember:${requestId}:${input.operationId}`);
      return {...receipt, requestId, revision: 'revision-2'};
    },
    status: async (_principal, requestId) => {
      calls.push(`status:${requestId}`);
      return {receipt: {...receipt, requestId}, writable: {durable: true, handoff: true}};
    },
    transitionHandoff: async (_principal, input, requestId) => {
      calls.push(`transition:${requestId}:${input.operation}`);
      return {...receipt, requestId, revision: 'revision-3', uri: input.uri};
    },
  };
  const dependencies: RemoteMemoryServiceDependencies = {
    attestations: {
      consumeChallenge: async () => undefined,
      createChallenge: async challenge => void calls.push(`challenge:${challenge.challengeId}`),
      claimChallengeAttempt: async () => undefined,
      getValidAttestation: async () => undefined,
      principalForChallenge: async () => undefined,
    },
    authorization: {
      authorize: async (_claims, shareId) => {
        calls.push(`authorize:${shareId ?? 'none'}`);
        return shareId === principal.shareId ? principal : undefined;
      },
    },
    cursorTokens: {verify: async () => Promise.reject(new Error('not used'))},
    oauthTokens: {
      verify: async token => {
        calls.push(`oauth:${token}`);
        return OAuth;
      },
    },
    readiness: async () => options.ready ?? true,
    rateLimits: {
      consume: async (_principal, operation) => {
        if (options.trackRateLimits) calls.push(`rate:${operation}`);
        if (options.rateLimitFailure) {
          throw remoteMemoryError('rate_limited', 'The remote memory operation rate limit was exceeded.', {
            retryAfterSeconds: 17,
          });
        }
      },
    },
    repository,
  };
  return {
    calls,
    handler: createRemoteMemoryHttpHandler({
      config: {...configFixture(), globallyEnabled: options.serviceEnabled ?? true},
      dependencies,
    }),
  };
}

function configFixture(): RemoteMemoryServiceConfig {
  return {
    accessTokenAudience: 'https://memory.example.test/mcp',
    accessTokenIssuer: 'https://auth.example.test',
    accessTokenJwksUrl: new URL('https://auth.example.test/jwks'),
    autoMigrate: false,
    allowedHosts: ['memory.example.test'],
    allowedOrigins: ['https://cursor.com'],
    attestationAudience: 'https://memory.example.test/attest/cursor',
    cursorIssuer: 'https://api.cursor.com',
    cursorJwksUrl: new URL('https://api.cursor.com/jwks'),
    databaseUrl: 'redacted-fixture',
    globallyEnabled: true,
    host: '127.0.0.1',
    maxBodyBytes: 4096,
    port: 8787,
    publicBaseUrl: new URL('https://memory.example.test'),
    readRequestsPerMinute: 300,
    requestTimeoutMilliseconds: 1000,
    writeRequestsPerMinute: 60,
  };
}

function receiptFixture(): RemoteMemoryReceiptV1 {
  return {
    consistency: 'current',
    indexedGeneration: 1,
    policyVersion: 'policy-v1',
    sharePolicyVersion: 'share-policy-v1',
    requestId: 'fixture-request',
    shareGeneration: 1,
    shareId: 'share-1',
    tenantId: 'tenant-1',
    version: 1,
  };
}

function mcpRequest(
  message: Readonly<Record<string, unknown>>,
  options: {readonly host?: string; readonly origin?: string; readonly token?: string} = {},
): Request {
  return new Request('https://memory.example.test/mcp', {
    body: JSON.stringify({jsonrpc: '2.0', ...message}),
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${options.token ?? 'fixture-token'}`,
      'content-type': 'application/json',
      host: options.host ?? 'memory.example.test',
      'mcp-protocol-version': PROTOCOL_VERSION,
      origin: options.origin ?? 'https://cursor.com',
      'threadnote-share-id': 'share-1',
      'x-request-id': 'request-123',
    },
    method: 'POST',
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('remote memory HTTP transport', () => {
  // These examples exercise the Web Request/Response and official SDK Promise boundary.
  it('serves protected-resource metadata and bounded health/readiness endpoints without authentication', async () => {
    const test = fixture({ready: false});
    const headers = {host: 'memory.example.test'};

    const metadata = await test.handler(
      new Request('https://memory.example.test/.well-known/oauth-protected-resource', {headers}),
    );
    expect(metadata.status).toBe(200);
    expect(await json(metadata)).toMatchObject({
      authorization_servers: ['https://auth.example.test'],
      resource: 'https://memory.example.test/mcp',
    });
    expect((await test.handler(new Request('https://memory.example.test/healthz', {headers}))).status).toBe(200);
    expect((await test.handler(new Request('https://memory.example.test/readyz', {headers}))).status).toBe(503);
    expect(test.calls).toEqual([]);
  });

  it('rejects Host and Origin before OAuth verification or body dispatch', async () => {
    const test = fixture();
    const badHost = await test.handler(mcpRequest({id: 1, method: 'tools/list', params: {}}, {host: 'evil.test'}));
    const badOrigin = await test.handler(
      mcpRequest({id: 2, method: 'tools/list', params: {}}, {origin: 'https://evil.test'}),
    );

    expect(badHost.status).toBe(403);
    expect(badOrigin.status).toBe(403);
    expect(test.calls).toEqual([]);
  });

  it('keeps health endpoints available while the environment-wide kill switch rejects MCP traffic', async () => {
    const test = fixture({serviceEnabled: false});
    const health = await test.handler(
      new Request('https://memory.example.test/healthz', {headers: {host: 'memory.example.test'}}),
    );
    const mcp = await test.handler(mcpRequest({id: 23, method: 'tools/list', params: {}}));

    expect(health.status).toBe(200);
    expect(mcp.status).toBe(503);
    expect(test.calls).toEqual([]);
  });

  it.each(['https://cursor.com/path', 'https://user:password@cursor.com'])(
    'requires an exact credential-free Origin header: %s',
    async origin => {
      const test = fixture();
      const response = await test.handler(mcpRequest({id: 21, method: 'tools/list', params: {}}, {origin}));

      expect(response.status).toBe(403);
      expect(test.calls).toEqual([]);
    },
  );

  it('requires OAuth and returns protected-resource discovery on 401', async () => {
    const test = fixture();
    const request = mcpRequest({id: 1, method: 'initialize', params: {}}, {token: ''});
    request.headers.delete('authorization');
    const response = await test.handler(request);

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource');
    expect(test.calls).toEqual([]);
  });

  it('negotiates stateless Streamable HTTP and publishes exactly the remote tool surface', async () => {
    const test = fixture();
    const initialized = await test.handler(
      mcpRequest({
        id: 1,
        method: 'initialize',
        params: {
          capabilities: {},
          clientInfo: {name: 'remote-fixture', version: '1.0.0'},
          protocolVersion: PROTOCOL_VERSION,
        },
      }),
    );
    expect(initialized.status).toBe(200);
    expect(initialized.headers.get('mcp-session-id')).toBeNull();
    expect(await json(initialized)).toMatchObject({
      id: 1,
      result: {protocolVersion: PROTOCOL_VERSION, serverInfo: {name: 'threadnote-memory'}},
    });

    const listed = await test.handler(mcpRequest({id: 2, method: 'tools/list', params: {}}));
    const payload = await json(listed);
    const result = payload.result as {readonly tools: readonly {readonly name: string}[]};
    expect(result.tools.map(tool => tool.name)).toEqual(REMOTE_MEMORY_TOOL_NAMES);
    expect(test.calls).toEqual([
      'oauth:fixture-token',
      'authorize:share-1',
      'oauth:fixture-token',
      'authorize:share-1',
    ]);
  });

  it('passes request-scoped principal and correlation to tools without a process-global identity', async () => {
    const test = fixture({trackRateLimits: true});
    const response = await test.handler(
      mcpRequest({id: 3, method: 'tools/call', params: {arguments: {version: 1}, name: 'memory_status'}}),
    );
    const payload = await json(response);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      id: 3,
      result: {
        structuredContent: {
          receipt: {
            policyVersion: 'policy-v1',
            requestId: 'request-123',
            shareId: 'share-1',
            sharePolicyVersion: 'share-policy-v1',
            tenantId: 'tenant-1',
          },
        },
      },
    });
    expect(test.calls).toContain('status:request-123');
    expect(test.calls).toContain('rate:memory_status');
  });

  it.each([{policyVersion: 'wrong-grant-policy'}, {sharePolicyVersion: 'wrong-share-policy'}])(
    'rejects a repository receipt whose grant/share policy attestation differs: %#',
    async receipt => {
      const test = fixture({receipt});
      const response = await test.handler(
        mcpRequest({id: 301, method: 'tools/call', params: {arguments: {version: 1}, name: 'memory_status'}}),
      );

      expect(await json(response)).toMatchObject({
        id: 301,
        result: {isError: true, structuredContent: {code: 'service_unavailable'}},
      });
    },
  );

  it('rejects extra tool fields before rate limiting or storage dispatch', async () => {
    const test = fixture({trackRateLimits: true});
    const response = await test.handler(
      mcpRequest({
        id: 31,
        method: 'tools/call',
        params: {arguments: {unexpected: 'must-not-be-ignored', version: 1}, name: 'memory_status'},
      }),
    );
    const payload = await json(response);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({id: 31, result: {isError: true}});
    expect(JSON.stringify(payload)).toContain('unexpected');
    expect(JSON.stringify(payload)).not.toContain('must-not-be-ignored');
    expect(test.calls.some(call => call.startsWith('rate:') || call.startsWith('status:'))).toBe(false);
  });

  it('reads canonical resources through the same share, scope, rate, and correlation boundary', async () => {
    const test = fixture({trackRateLimits: true});
    const uri = 'threadnote://share/share-1/memories/durable/threadnote/fixture.md';
    const response = await test.handler(mcpRequest({id: 32, method: 'resources/read', params: {uri}}));
    const payload = await json(response);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      id: 32,
      result: {
        contents: [
          {
            mimeType: 'text/markdown',
            text: expect.stringContaining('Fixture body'),
            uri,
          },
        ],
      },
    });
    expect(test.calls).toContain('rate:read_context');
    expect(test.calls).toContain('read:request-123');
  });

  it('rejects resource traversal to a different share without reading storage', async () => {
    const test = fixture({trackRateLimits: true});
    const response = await test.handler(
      mcpRequest({
        id: 33,
        method: 'resources/read',
        params: {uri: 'threadnote://share/share-2/memories/durable/threadnote/fixture.md'},
      }),
    );
    const payload = await json(response);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({error: {code: -32_603}, id: 33});
    expect(JSON.stringify(payload)).not.toContain('Fixture body');
    expect(test.calls.some(call => call.startsWith('rate:') || call.startsWith('read:'))).toBe(false);
  });

  it('confines read tools and resources to authorized URI projects before storage dispatch', async () => {
    const test = fixture({allowedProjects: new Set(['threadnote']), trackRateLimits: true});
    const crossProjectUri = 'threadnote://share/share-1/memories/durable/private-project/fixture.md';
    const toolResponse = await test.handler(
      mcpRequest({
        id: 331,
        method: 'tools/call',
        params: {arguments: {uri: crossProjectUri, version: 1}, name: 'read_context'},
      }),
    );
    const resourceResponse = await test.handler(
      mcpRequest({id: 332, method: 'resources/read', params: {uri: crossProjectUri}}),
    );

    expect(await json(toolResponse)).toMatchObject({
      id: 331,
      result: {isError: true, structuredContent: {code: 'forbidden'}},
    });
    expect(await json(resourceResponse)).toMatchObject({error: {code: -32_603}, id: 332});
    expect(test.calls.some(call => call.startsWith('read:'))).toBe(false);
  });

  it('returns a bounded rate-limit tool error without invoking storage', async () => {
    const test = fixture({rateLimitFailure: true, trackRateLimits: true});
    const response = await test.handler(
      mcpRequest({id: 34, method: 'tools/call', params: {arguments: {version: 1}, name: 'memory_status'}}),
    );
    const payload = await json(response);
    const serialized = JSON.stringify(payload);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      id: 34,
      result: {
        isError: true,
        structuredContent: {
          code: 'rate_limited',
          details: {retryAfterSeconds: 17},
          requestId: 'request-123',
        },
      },
    });
    expect(serialized.length).toBeLessThan(600);
    expect(test.calls).toContain('rate:memory_status');
    expect(test.calls.some(call => call.startsWith('status:'))).toBe(false);
  });

  it('maps unexpected storage failures to a generic error without leaking memory or bearer tokens', async () => {
    const secretToken = 'bearer-token-that-must-not-leak';
    const privateMemory = 'private memory body that must not leak';
    const test = fixture({repositoryFailure: new Error(`${secretToken}: ${privateMemory}`)});
    const uri = 'threadnote://share/share-1/memories/durable/threadnote/fixture.md';
    const response = await test.handler(
      mcpRequest(
        {id: 35, method: 'tools/call', params: {arguments: {uri, version: 1}, name: 'read_context'}},
        {token: secretToken},
      ),
    );
    const serialized = JSON.stringify(await json(response));

    expect(serialized).toContain('service_unavailable');
    expect(serialized).not.toContain(secretToken);
    expect(serialized).not.toContain(privateMemory);
    expect(serialized.length).toBeLessThan(600);
  });

  it('returns a bounded tool error when a write scope is missing and never reaches storage', async () => {
    const test = fixture({capabilities: ['memory:read']});
    const response = await test.handler(
      mcpRequest({
        id: 4,
        method: 'tools/call',
        params: {
          arguments: {
            kind: 'durable',
            operationId: 'operation-1',
            project: 'threadnote',
            text: 'bounded fixture',
            topic: 'remote',
            version: 1,
          },
          name: 'remember_context',
        },
      }),
    );
    const payload = await json(response);

    expect(payload).toMatchObject({
      result: {isError: true, structuredContent: {code: 'forbidden', requestId: 'request-123'}},
    });
    expect(test.calls.some(call => call.startsWith('remember:'))).toBe(false);
  });

  it('is POST-only and rejects declared oversized bodies before OAuth', async () => {
    const test = fixture();
    const get = await test.handler(
      new Request('https://memory.example.test/mcp', {headers: {host: 'memory.example.test'}, method: 'GET'}),
    );
    const oversized = mcpRequest({id: 5, method: 'tools/list', params: {}});
    oversized.headers.set('content-length', '999999');
    const rejected = await test.handler(oversized);

    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect(rejected.status).toBe(400);
    expect(test.calls).toEqual([]);
  });

  it('rejects extra attestation-completion fields without reflecting the workload token', async () => {
    const test = fixture();
    const token = 'cursor-workload-token-that-must-not-leak';
    const response = await test.handler(
      new Request('https://memory.example.test/attest/cursor/complete', {
        body: JSON.stringify({challengeId: 'challenge-1', token, unexpected: true}),
        headers: {
          'content-type': 'application/json',
          host: 'memory.example.test',
          origin: 'https://cursor.com',
        },
        method: 'POST',
      }),
    );
    const serialized = JSON.stringify(await json(response));

    expect(response.status).toBe(400);
    expect(serialized).toContain('unsupported fields');
    expect(serialized).not.toContain(token);
    expect(test.calls).toEqual([]);
  });
});
