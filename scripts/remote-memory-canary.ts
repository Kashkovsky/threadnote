import {parseRemoteShareAddress} from '../src/memory_domain/address.js';

const PROTOCOL_VERSION = '2025-06-18';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const EXPECTED_TOOLS = [
  'begin_cursor_attestation',
  'list_context',
  'memory_status',
  'read_context',
  'recall_context',
  'remember_context',
  'transition_handoff',
] as const;

type CanaryMode = 'concurrency' | 'read' | 'write';

interface JsonRpcResponse {
  readonly error?: {readonly code?: number};
  readonly result?: {
    readonly isError?: boolean;
    readonly structuredContent?: unknown;
    readonly tools?: readonly {readonly name?: string}[];
  };
}

class CanaryFailure extends Error {
  readonly name = 'CanaryFailure';
  constructor(readonly code: string) {
    super(code);
  }
}

const environment = process.env;
const endpoint = canaryEndpoint(required(environment.THREADNOTE_CANARY_ENDPOINT, 'endpoint'));
const shareId = portable(required(environment.THREADNOTE_CANARY_SHARE_ID, 'share id'), 'share id');
const token = required(environment.THREADNOTE_CANARY_ACCESS_TOKEN, 'access token');
if (Buffer.byteLength(token, 'utf8') > 64 * 1024) throw new CanaryFailure('access_token_too_large');
const project = portable(environment.THREADNOTE_CANARY_PROJECT?.trim() || 'threadnote-canary', 'project');
const mode = canaryMode(environment.THREADNOTE_CANARY_MODE);
const attestationId = optionalIdentifier(environment.THREADNOTE_CANARY_ATTESTATION_ID);
const expectedUri = environment.THREADNOTE_CANARY_EXPECT_URI?.trim();

async function run(): Promise<void> {
  const checks: {name: string; status: 'ok'}[] = [];
  const initialized = await rpc('initialize', {
    capabilities: {},
    clientInfo: {name: 'threadnote-remote-memory-canary', version: '1.0.0'},
    protocolVersion: PROTOCOL_VERSION,
  });
  requireResult(initialized, 'initialize_failed');
  checks.push({name: 'initialize', status: 'ok'});

  const tools = requireResult(await rpc('tools/list', {}), 'tools_list_failed').tools ?? [];
  const names = tools.flatMap(tool => (typeof tool.name === 'string' ? [tool.name] : [])).sort(compareCodeUnits);
  if (JSON.stringify(names) !== JSON.stringify([...EXPECTED_TOOLS].sort(compareCodeUnits))) {
    throw new CanaryFailure('unexpected_tool_surface');
  }
  checks.push({name: 'tool_surface', status: 'ok'});

  requireToolSuccess(await callTool('memory_status', {version: 1}), 'status_failed');
  checks.push({name: 'status', status: 'ok'});

  requireToolSuccess(
    await callTool('recall_context', {limit: 1, project, query: 'threadnote remote canary fixture', version: 1}),
    'recall_failed',
  );
  checks.push({name: 'bounded_recall', status: 'ok'});

  if (expectedUri) {
    const address = parseRemoteShareAddress(expectedUri);
    if (address.shareId !== shareId) throw new CanaryFailure('expected_uri_share_mismatch');
    requireToolSuccess(await callTool('read_context', {uri: expectedUri, version: 1}), 'expected_read_failed');
    checks.push({name: 'fresh_run_read', status: 'ok'});
  }

  if (mode === 'write' || mode === 'concurrency') {
    const marker = crypto.randomUUID();
    const topic = `canary-${marker}`;
    const written = requireToolSuccess(
      await callTool('remember_context', rememberArguments(topic, `Fixture canary ${marker}.`, marker)),
      'write_failed',
    );
    const uri = structuredUri(written);
    requireToolSuccess(await callTool('read_context', {uri, version: 1}), 'fresh_run_write_read_failed');
    checks.push({name: 'write_then_fresh_read', status: 'ok'});
  }

  if (mode === 'concurrency') {
    const race = crypto.randomUUID();
    const raceTopic = `race-${race}`;
    const raceResults = await Promise.all([
      callTool('remember_context', rememberArguments(raceTopic, `Fixture race A ${race}.`, `${race}-a`)),
      callTool('remember_context', rememberArguments(raceTopic, `Fixture race B ${race}.`, `${race}-b`)),
    ]);
    const winners = raceResults.filter(result => !result.result?.isError).length;
    const conflicts = raceResults.filter(result => toolErrorCode(result) === 'conflict').length;
    if (winners !== 1 || conflicts !== 1) throw new CanaryFailure('cas_race_contract_failed');
    checks.push({name: 'single_topic_cas_race', status: 'ok'});

    const independent = crypto.randomUUID();
    const independentResults = await Promise.all([
      callTool(
        'remember_context',
        rememberArguments(`independent-a-${independent}`, `Fixture independent A ${independent}.`, `${independent}-a`),
      ),
      callTool(
        'remember_context',
        rememberArguments(`independent-b-${independent}`, `Fixture independent B ${independent}.`, `${independent}-b`),
      ),
    ]);
    if (independentResults.some(result => result.result?.isError || result.error)) {
      throw new CanaryFailure('independent_write_progress_failed');
    }
    checks.push({name: 'independent_write_progress', status: 'ok'});
  }

  console.log(JSON.stringify({checks, mode, status: 'ok', version: 1}));
}

function rememberArguments(topic: string, text: string, operationId: string): Readonly<Record<string, unknown>> {
  return {
    ...(attestationId ? {attestationId} : {}),
    kind: 'durable',
    operationId,
    project,
    text,
    topic,
    version: 1,
  };
}

async function callTool(name: string, arguments_: Readonly<Record<string, unknown>>): Promise<JsonRpcResponse> {
  return rpc('tools/call', {arguments: arguments_, name});
}

async function rpc(method: string, params: Readonly<Record<string, unknown>>): Promise<JsonRpcResponse> {
  const response = await fetch(endpoint, {
    body: JSON.stringify({id: crypto.randomUUID(), jsonrpc: '2.0', method, params}),
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'mcp-protocol-version': PROTOCOL_VERSION,
      'threadnote-share-id': shareId,
      'user-agent': 'threadnote-remote-memory-canary/1',
    },
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new CanaryFailure(`http_${response.status}`);
  return boundedJson(response);
}

async function boundedJson(response: Response): Promise<JsonRpcResponse> {
  if (!response.body) throw new CanaryFailure('empty_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new CanaryFailure('response_too_large');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as JsonRpcResponse;
  } catch {
    throw new CanaryFailure('invalid_json_response');
  }
}

function requireResult(response: JsonRpcResponse, code: string): NonNullable<JsonRpcResponse['result']> {
  if (response.error || !response.result) throw new CanaryFailure(code);
  return response.result;
}

function requireToolSuccess(response: JsonRpcResponse, code: string): NonNullable<JsonRpcResponse['result']> {
  const result = requireResult(response, code);
  if (result.isError) throw new CanaryFailure(`${code}:${toolErrorCode(response) ?? 'tool_error'}`);
  return result;
}

function toolErrorCode(response: JsonRpcResponse): string | undefined {
  const structured = response.result?.structuredContent;
  if (!structured || typeof structured !== 'object' || !('code' in structured)) return undefined;
  return typeof structured.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(structured.code)
    ? structured.code
    : undefined;
}

function structuredUri(result: NonNullable<JsonRpcResponse['result']>): string {
  const structured = result.structuredContent;
  if (!structured || typeof structured !== 'object' || !('uri' in structured) || typeof structured.uri !== 'string') {
    throw new CanaryFailure('write_receipt_missing_uri');
  }
  const address = parseRemoteShareAddress(structured.uri);
  if (address.shareId !== shareId) throw new CanaryFailure('write_receipt_share_mismatch');
  return address.canonicalUri;
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new CanaryFailure(`missing_${name.replaceAll(' ', '_')}`);
  return normalized;
}

function portable(value: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u.test(value))
    throw new CanaryFailure(`invalid_${name.replaceAll(' ', '_')}`);
  return value;
}

function optionalIdentifier(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  return portable(value.trim(), 'attestation_id');
}

function canaryMode(value: string | undefined): CanaryMode {
  const normalized = value?.trim() || 'read';
  if (normalized === 'read' || normalized === 'write' || normalized === 'concurrency') return normalized;
  throw new CanaryFailure('invalid_mode');
}

function canaryEndpoint(value: string): URL {
  const url = new URL(value);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if ((!local && url.protocol !== 'https:') || (local && url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new CanaryFailure('insecure_endpoint');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/mcp') {
    throw new CanaryFailure('invalid_endpoint');
  }
  return url;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

run().catch(cause => {
  const code = cause instanceof CanaryFailure ? cause.code : 'unexpected_failure';
  console.error(JSON.stringify({error: code, status: 'failed', version: 1}));
  process.exitCode = 1;
});
