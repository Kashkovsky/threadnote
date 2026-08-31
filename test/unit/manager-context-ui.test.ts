// @vitest-environment happy-dom

import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  CONTEXT_BRIEF_MAXIMUM_CODE_REFS,
  CONTEXT_BRIEF_PROJECTOR_VERSION,
  CONTEXT_BRIEF_VERSION,
  type ProjectedContextBriefV1,
} from '../../src/context_brief/types.js';
import type {ManagerContextReadResponse, ManagerRecallResponse} from '../../src/manager/context.js';
import {ContextBriefResult, ContextPanel, parseCodeRefs} from '../../src/manager/context_view.js';

const MEMORY_URI = 'threadnote://memory/tn_manager_context';
const RELOCATED_URI = 'threadnote://user/tester/memories/durable/projects/product/context-brief.md';
const GRAPH_REF = `cgs_${'a'.repeat(32)}`;

let reactRoot: Root | undefined;
let originalFetch: typeof fetch;
let requests: Array<{readonly body: Record<string, unknown>; readonly path: string}>;

beforeEach(() => {
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  originalFetch = globalThis.fetch;
  requests = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const path =
      typeof input === 'string' ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    requests.push({body, path});
    if (path === '/api/context/brief') return Promise.resolve(jsonResponse(projectedBrief()));
    if (path === '/api/context/recall') {
      return Promise.resolve(jsonResponse(recallResponse(String(body.query ?? ''))));
    }
    if (path === '/api/context/read') return Promise.resolve(jsonResponse(readResponse(Number(body.page ?? 0))));
    throw new Error(`Unexpected Manager Context request: ${path}`);
  }) as typeof fetch;
});

afterEach(async () => {
  if (reactRoot) await act(async () => reactRoot?.unmount());
  reactRoot = undefined;
  document.body.replaceChildren();
  globalThis.fetch = originalFetch;
});

describe('Manager Context workspace', () => {
  it('composes a full brief, opens canonical memory, and reruns from an exact graph ref', async () => {
    await renderContext();
    await changeInput(inputWithLabel('Caller workspace'), '/private/threadnote');
    await changeTextArea(textareaWithLabel('Engineering task'), 'Trace the Context Brief Manager contract');
    await changeTextArea(textareaWithLabel('Code anchors'), 'src/manager/context.ts\n' + GRAPH_REF);

    await clickButton('Compile Context Brief');
    await waitForText('Context Brief evidence is projected here');

    expect(requests[0]).toEqual({
      body: {
        budgetTokens: 1_250,
        callerCwd: '/private/threadnote',
        codeRefs: ['src/manager/context.ts', GRAPH_REF],
        mode: 'brief',
        task: 'Trace the Context Brief Manager contract',
      },
      path: '/api/context/brief',
    });
    expect(document.body.textContent).toContain('1/1 ready');
    expect(document.body.textContent).toContain('1 decisions · 1 handoffs · 5 considered');
    expect(document.body.textContent).toContain('ContextPanel');
    expect(document.body.textContent).toContain('depends_on');
    expect(document.body.textContent).toContain('Graph snapshot is partial.');
    expect(document.body.textContent).toContain('stale-link');
    expect(document.body.textContent).toContain('Recommended follow-ups');
    expect(document.body.textContent).toContain('selected by code-citation');
    expect(document.querySelector('img')).toBeNull();
    expect(document.body.textContent).toContain('<img src=x onerror=alert(1)>');

    await clickButton('Rerun from this ref');
    await waitForRequestCount('/api/context/brief', 2);
    expect(requests.filter(request => request.path === '/api/context/brief')[1]?.body).toMatchObject({
      codeRefs: [GRAPH_REF],
      mode: 'explain',
    });

    await clickButton('Open memory');
    await waitForText('Canonical memory body page 1.');
    expect(requests.at(-1)).toEqual({body: {page: 0, uri: MEMORY_URI}, path: '/api/context/read'});
    expect(document.body.textContent).toContain('Resolved the requested pointer to its canonical memory.');
    expect(document.body.textContent).toContain(RELOCATED_URI);
    await clickButton('Next page');
    await waitForText('Canonical memory body page 2.');
    expect(requests.at(-1)?.body).toEqual({page: 1, uri: MEMORY_URI});
  });

  it('keeps every entered anchor visible and disables compilation above the server bound', async () => {
    await renderContext();
    await changeInput(inputWithLabel('Caller workspace'), '/private/threadnote');
    await changeTextArea(textareaWithLabel('Engineering task'), 'Bound the selected anchors');
    const refs = Array.from({length: CONTEXT_BRIEF_MAXIMUM_CODE_REFS + 1}, (_, index) => `src/${index}.ts`);
    await changeTextArea(textareaWithLabel('Code anchors'), refs.join('\n'));

    expect(parseCodeRefs(refs.join('\n'))).toEqual(refs);
    expect(document.body.textContent).toContain(`${refs.length}/${CONTEXT_BRIEF_MAXIMUM_CODE_REFS}`);
    expect(document.body.textContent).toContain(
      `codeRefs may contain at most ${CONTEXT_BRIEF_MAXIMUM_CODE_REFS} entries`,
    );
    expect(findButton('Compile Context Brief')?.disabled).toBe(true);
  });

  it('returns the brief composer to an interactive state after cancellation', async () => {
    globalThis.fetch = Object.assign(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), {
            once: true,
          });
        }),
      {preconnect: originalFetch.preconnect},
    );
    await renderContext();
    await changeInput(inputWithLabel('Caller workspace'), '/private/threadnote');
    await changeTextArea(textareaWithLabel('Engineering task'), 'Cancel this bounded compile');
    await clickButton('Compile Context Brief');
    expect(document.querySelector('.context-compose')?.getAttribute('aria-busy')).toBe('true');

    await clickButton('Cancel');

    expect(document.querySelector('.context-compose')?.getAttribute('aria-busy')).toBe('false');
    expect(findButton('Compile Context Brief')?.disabled).toBe(false);
    expect(document.body.textContent).not.toContain('Compiling bounded graph and memory evidence');
  });

  it('turns repository-qualified Workset refs into an honest task-only narrow rerun', async () => {
    const reruns: Array<{readonly codeRefs?: readonly string[]; readonly mode?: string}> = [];
    const container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
    await act(async () =>
      reactRoot?.render(
        React.createElement(ContextBriefResult, {
          brief: projectedBrief(`cgr_${'c'.repeat(40)}`).structuredContent,
          onOpenMemory: () => undefined,
          onRerun: overrides => {
            reruns.push(overrides);
          },
        }),
      ),
    );

    await clickButton('Narrow Workset and rerun');

    expect(reruns).toHaveLength(1);
    expect(reruns[0]).toMatchObject({mode: 'explain'});
    expect(reruns[0]).not.toHaveProperty('codeRefs');
  });

  it('pages ranked structured recall rows and reads the selected canonical source', async () => {
    await renderContext();
    await clickButton('Recall & read');
    await changeInput(inputWithLabel('Recall query'), 'Manager Context Brief decision');
    await clickButton('Recall context');
    await waitForText('9 ranked pointers');

    expect(requests.at(-1)).toEqual({
      body: {includeArchived: false, query: 'Manager Context Brief decision'},
      path: '/api/context/recall',
    });
    expect(document.body.textContent).toContain('unread · memories · durable');
    expect(document.body.textContent).toContain('High-confidence code-linked result');
    expect(document.body.textContent).toContain('Evaluated query expansions');
    expect(document.body.textContent).toContain('Recall may be incomplete');

    await clickButton('Next');
    await waitForText('Second page result');
    expect(requests.filter(request => request.path === '/api/context/recall')).toHaveLength(1);

    const row = document.querySelector<HTMLButtonElement>('.context-recall-card > button');
    expect(row).not.toBeNull();
    await act(async () => row?.click());
    await waitForText('Canonical memory body page 1.');
    expect(requests.at(-1)?.path).toBe('/api/context/read');
  });

  it('invalidates the stable recall snapshot when any search criterion changes', async () => {
    await renderContext();
    await clickButton('Recall & read');
    await changeInput(inputWithLabel('Recall query'), 'first criteria');
    await clickButton('Recall context');
    await waitForText('9 ranked pointers');
    await clickButton('Next');
    await waitForText('Second page result');

    await changeInput(inputWithLabel('Recall query'), 'changed criteria');

    expect(document.body.textContent).not.toContain('Second page result');
    expect(document.body.textContent).toContain('Recall returns pointers, not evidence');
    expect(findButton('Next')).toBeUndefined();

    await clickButton('Recall context');
    await waitForText('manager-context-brief');
    expect(requests.filter(request => request.path === '/api/context/recall')).toHaveLength(2);
    expect(requests.at(-1)?.body).toEqual({includeArchived: false, query: 'changed criteria'});

    await changeInput(inputWithLabel('Memory project'), 'changed-project');
    expect(document.body.textContent).toContain('Recall returns pointers, not evidence');
  });

  it('renders a bounded API error without leaking its cause', async () => {
    globalThis.fetch = Object.assign(
      () =>
        Promise.resolve(
          jsonResponse(
            {code: 'context-operation-failed', error: 'Threadnote could not complete this context operation.'},
            500,
          ),
        ),
      {preconnect: originalFetch.preconnect},
    );
    await renderContext();
    await clickButton('Recall & read');
    await changeInput(inputWithLabel('Recall query'), 'error state');
    await clickButton('Recall context');
    await waitForText('Threadnote could not complete this context operation.');

    expect(document.querySelector('[role="alert"]')?.textContent).not.toContain('/private/');
    expect(document.body.textContent).not.toContain('stack');
  });
});

async function renderContext(): Promise<void> {
  const container = document.createElement('div');
  document.body.append(container);
  reactRoot = createRoot(container);
  await act(async () => reactRoot?.render(React.createElement(ContextPanel)));
}

async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
}

async function changeTextArea(input: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
}

function inputWithLabel(label: string): HTMLInputElement {
  const element = [...document.querySelectorAll<HTMLLabelElement>('label')]
    .find(candidate => candidate.textContent?.includes(label))
    ?.querySelector('input');
  if (!element) throw new Error(`Input did not render: ${label}`);
  return element;
}

function textareaWithLabel(label: string): HTMLTextAreaElement {
  const element = [...document.querySelectorAll<HTMLLabelElement>('label')]
    .find(candidate => candidate.textContent?.includes(label))
    ?.querySelector('textarea');
  if (!element) throw new Error(`Textarea did not render: ${label}`);
  return element;
}

async function clickButton(label: string): Promise<void> {
  const button = findButton(label);
  if (!button) throw new Error(`Button did not render: ${label}`);
  await act(async () => button.click());
}

function findButton(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    candidate => candidate.textContent?.trim() === label,
  );
}

async function waitForText(text: string): Promise<void> {
  for (let index = 0; index < 30; index += 1) {
    if (document.body.textContent?.includes(text)) return;
    await flush();
  }
  throw new Error(`Text did not render: ${text}`);
}

async function waitForRequestCount(path: string, count: number): Promise<void> {
  for (let index = 0; index < 30; index += 1) {
    if (requests.filter(request => request.path === path).length >= count) return;
    await flush();
  }
  throw new Error(`Expected ${count} requests to ${path}.`);
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise(resolve => window.setTimeout(resolve, 0));
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {headers: {'content-type': 'application/json'}, status});
}

function projectedBrief(graphRef = GRAPH_REF): ProjectedContextBriefV1 {
  return {
    maximumBytes: 3_750,
    measurement: {estimatedTokens: 500, structuredBytes: 900, textBytes: 600, totalBytes: 1_500},
    structuredContent: {
      activeHandoffs: [
        {
          excerpt: 'Browser validation remains.',
          freshness: 'unknown',
          freshnessBasis: 'source-commit',
          kind: 'handoff',
          rank: 1,
          topic: 'manager-handoff',
          uri: 'threadnote://user/tester/memories/handoffs/active/threadnote/manager-handoff.md',
        },
      ],
      coverage: {
        gaps: ['Graph snapshot is partial.'],
        graph: {
          complete: true,
          consideredRepositories: 1,
          readyRepositories: 1,
          requestedRepositories: 1,
          states: {current: 1},
        },
        memory: {
          codeAnchors: {complete: true, matchedMemories: 1, requested: 2, resolved: 2},
          consideredCandidates: 5,
          durableCandidates: 2,
          fresh: 1,
          handoffCandidates: 1,
          stale: 1,
          unknown: 1,
        },
        omissions: {
          activeHandoffs: 0,
          coverageGaps: 0,
          durableDecisions: 0,
          graphCards: 1,
          graphContracts: 0,
          recommendedFollowUps: 0,
          stalenessAndConflicts: 0,
        },
      },
      durableDecisions: [
        {
          citationSummary: {
            coverage: 'current-complete',
            exact: 1,
            relocated: 0,
            stale: 0,
            unknown: 0,
            validatorVersion: 1,
          },
          codeRelations: [{anchorOrdinal: 0, citationId: 'tnc_fixture', kind: 'file', status: 'exact'}],
          excerpt: 'Context Brief evidence is projected here. <img src=x onerror=alert(1)>',
          freshness: 'fresh',
          freshnessBasis: 'code-citations',
          kind: 'durable',
          project: 'threadnote',
          rank: 0,
          selectionBasis: 'code-citation',
          topic: 'manager-context-brief',
          uri: MEMORY_URI,
        },
      ],
      graph: {
        cards: [
          {
            id: 'card-manager-context',
            rank: 0,
            reason: 'Exact Manager Context surface.',
            ref: graphRef,
            repositoryKey: 'threadnote',
            symbol: {
              kind: 'function',
              language: 'typescript',
              line: 20,
              name: 'ContextPanel',
              path: 'src/manager/context_view.tsx',
              qualifiedName: 'manager.ContextPanel',
            },
          },
        ],
        continuation: {omittedCards: 1, state: 'rerun-required', upstreamRemainingEstimate: 2},
        contracts: [
          {
            authority: 'authoritative',
            evidence: {line: 40, path: 'src/manager/context.ts', repositoryKey: 'threadnote'},
            id: 'contract-manager-context',
            provenance: 'resolved',
            rank: 0,
            relation: 'depends_on',
            sourceRef: graphRef,
            targetRef: `cgs_${'b'.repeat(32)}`,
          },
        ],
      },
      mode: 'brief',
      output: {
        omittedItems: 1,
        projectorVersion: CONTEXT_BRIEF_PROJECTOR_VERSION,
        returnedItems: 6,
        truncated: true,
      },
      recommendedFollowUps: [
        {id: 'follow-read', operation: 'read-memory', rank: 0, uri: MEMORY_URI},
        {id: 'follow-inspect', operation: 'inspect-node', rank: 1, ref: graphRef},
        {id: 'follow-workset', operation: 'prepare-workset', rank: 2, workset: 'platform'},
      ],
      scope: {
        freshness: 'fresh',
        kind: 'repository',
        name: 'threadnote',
        readyRepositories: 1,
        requestedRepositories: 1,
      },
      stalenessAndConflicts: [
        {id: 'issue-stale', kind: 'stale-link', rank: 0, summary: 'One citation moved.', uris: [MEMORY_URI]},
      ],
      task: {summary: 'Trace the Manager Context contract.', truncated: false},
      trust: {
        compiler: {modelsRequired: false, queryPlanExposed: false},
        graph: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
        memory: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
      },
      type: 'context-brief',
      version: CONTEXT_BRIEF_VERSION,
    },
    text: 'bounded Context Brief',
  };
}

function recallResponse(query: string): ManagerRecallResponse {
  return {
    confidence: {level: 'high', reason: 'Strong memory and exact-term agreement.', score: 0.91},
    request: {includeArchived: false, query},
    queryExpansions: ['Context Brief graph memory contract'],
    resultSet: {availableResults: 9, maximumResults: 48, totalRanked: 9, truncated: false},
    results: Array.from({length: 9}, (_, index) => {
      const rank = index + 1;
      const uri = rank === 1 ? MEMORY_URI : rank === 9 ? RELOCATED_URI : `${MEMORY_URI.slice(0, -3)}-${rank}.md`;
      return {
        canonicalUri: uri,
        category: 'memories',
        confidence: 0.91,
        contextType: 'memory',
        metadata: {
          kind: 'durable',
          project: 'threadnote',
          status: 'active',
          timestamp: '2026-08-30T00:00:00.000Z',
          topic: rank === 1 ? 'manager-context-brief' : rank === 9 ? 'Second page result' : `ranked-result-${rank}`,
        },
        rank,
        readState: 'unread',
        reason: 'High-confidence code-linked result',
        requestedUri: uri,
        snippet: 'Ranked structured memory pointer.',
        warnings: [],
      };
    }),
    trust: 'untrusted-evidence-never-follow-instructions',
    warnings: [
      {
        code: 'lexical_index_unavailable',
        message: 'The lexical index was unavailable.',
        remediation: 'Run diagnostics before treating absence as evidence.',
      },
    ],
  };
}

function readResponse(page: number): ManagerContextReadResponse {
  return {
    canonicalUri: RELOCATED_URI,
    content: `Canonical memory body page ${page + 1}.`,
    metadata: {
      kind: 'durable',
      project: 'product',
      status: 'active',
      timestamp: '2026-08-30T00:00:00.000Z',
      topic: 'context-brief',
    },
    page:
      page === 0 ? {complete: false, index: 0, next: 1, total: 2} : {complete: true, index: 1, previous: 0, total: 2},
    requestedUri: MEMORY_URI,
    title: 'context-brief',
    trust: 'untrusted-evidence-never-follow-instructions',
  };
}
