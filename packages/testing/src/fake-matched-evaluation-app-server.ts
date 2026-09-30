#!/usr/bin/env bun

import {createInterface} from 'node:readline';

if (process.argv[2] === '--version') {
  process.stdout.write('codex-cli matched-evaluation-test-v1\n');
  process.exit(0);
}
if (process.argv[2] !== 'app-server') {
  process.stderr.write('expected app-server\n');
  process.exit(2);
}

const lines = createInterface({input: process.stdin});
let turnIndex = 0;

lines.on('line', line => {
  const request = JSON.parse(line) as {id?: number; method?: string; params?: Record<string, unknown>};
  if (request.method === 'initialized') return;
  if (request.method === 'initialize') {
    respond(request.id, {serverInfo: {name: 'fake-matched-evaluation-app-server', version: 'test-v1'}});
    return;
  }
  if (request.method === 'thread/start') {
    const params = request.params ?? {};
    const threadId = `thr_matched_${turnIndex}`;
    respond(request.id, {
      approvalPolicy: params.approvalPolicy,
      approvalsReviewer: params.approvalsReviewer,
      cwd: params.cwd,
      instructionSources: [],
      model: params.model,
      modelProvider: params.modelProvider,
      reasoningEffort: 'medium',
      runtimeWorkspaceRoots: [params.cwd],
      sandbox: {networkAccess: false, type: params.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite'},
      thread: {id: threadId},
    });
    notify('thread/started', {thread: {id: threadId}});
    if (process.argv.includes('--failed-context')) {
      notify('mcpServer/startupStatus/updated', {threadId, name: 'matched_evaluation_context', status: 'ready'});
    }
    return;
  }
  if (request.method === 'mcpServerStatus/list') {
    respond(request.id, {
      data: [
        {
          name: 'matched_evaluation_context',
          tools: {context_brief: {name: 'context_brief'}},
          resources: [],
          resourceTemplates: [],
        },
      ],
      nextCursor: null,
    });
    return;
  }
  if (request.method === 'turn/start') {
    const params = request.params ?? {};
    const threadId = String(params.threadId);
    const turnId = `turn_matched_${turnIndex++}`;
    const schema = params.outputSchema as {properties?: Record<string, unknown>} | undefined;
    const judge = schema?.properties !== undefined && 'scoreMilli' in schema.properties;
    const taskFailure = judge && JSON.stringify(params.input).includes('provider-token-budget');
    const final = judge
      ? {
          authorizationLeaks: 0,
          citations: [],
          completed: !taskFailure,
          failureReasons: taskFailure ? ['fixture task-quality failure'] : [],
          falseCurrentOutcomes: taskFailure ? 1 : 0,
          harmfulActions: 0,
          recalledEvidenceIds: [],
          scoreMilli: taskFailure ? 620 : 1_000,
          supportedEvidenceIds: [],
        }
      : {citations: [], completed: true, summary: 'completed by fake app-server'};
    const usage = judge
      ? {cachedInputTokens: 5, inputTokens: 50, outputTokens: 25, reasoningOutputTokens: 10, totalTokens: 75}
      : {cachedInputTokens: 10, inputTokens: 100, outputTokens: 50, reasoningOutputTokens: 20, totalTokens: 150};
    respond(request.id, {turn: {error: null, id: turnId, items: [], status: 'inProgress'}});
    notify('turn/started', {threadId, turn: {error: null, id: turnId, items: [], status: 'inProgress'}});
    notify('thread/tokenUsage/updated', {
      threadId,
      tokenUsage: {
        last: usage,
        modelContextWindow: 200_000,
        total: usage,
      },
      turnId,
    });
    if (!judge && process.argv.includes('--failed-context')) {
      const failed = {
        id: 'context_failed',
        type: 'mcpToolCall',
        server: 'matched_evaluation_context',
        tool: 'context_brief',
        status: 'failed',
        error: null,
        result: {
          isError: true,
          content: [{type: 'text', text: 'Context request task differs from the sealed task prompt.'}],
        },
      };
      notify('item/started', {item: {...failed, status: 'inProgress', result: null}, threadId, turnId});
      notify('item/completed', {item: failed, threadId, turnId});
    }
    const item = {
      id: `item_matched_${turnIndex}`,
      phase: 'final_answer',
      text: JSON.stringify(final),
      type: 'agentMessage',
    };
    notify('item/started', {item, threadId, turnId});
    notify('item/completed', {item, threadId, turnId});
    notify('turn/completed', {threadId, turn: {error: null, id: turnId, items: [], status: 'completed'}});
    return;
  }
  respondError(request.id, -32_601, 'unsupported fake request');
});

function notify(method: string, params: unknown): void {
  process.stdout.write(`${JSON.stringify({method, params})}\n`);
}

function respond(id: number | undefined, result: unknown): void {
  process.stdout.write(`${JSON.stringify({id, result})}\n`);
}

function respondError(id: number | undefined, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({error: {code, message}, id})}\n`);
}
