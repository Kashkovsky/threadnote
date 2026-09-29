// @vitest-environment happy-dom

import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ContextHealthPanel, ReviewsPanel} from '@threadnote/manager/attention-view';

let reactRoot: Root | undefined;
let contextHealthRequests: string[];
let bulkRequests: string[];
let bulkPreviewCategories: string[];
let bulkPreviewGate: Promise<void> | undefined;
let bulkApplyGate: Promise<void> | undefined;
let backgroundRepairStarted: boolean;
let backgroundRepairPollFailures: number;
let backgroundRepairScenario:
  'count-drift' | 'delayed-start' | 'failed' | 'immediate-completion' | 'poll-retry' | 'running';
let backgroundRepairStartGate: Promise<void> | undefined;

beforeEach(() => {
  contextHealthRequests = [];
  bulkRequests = [];
  bulkPreviewCategories = [];
  bulkPreviewGate = undefined;
  bulkApplyGate = undefined;
  backgroundRepairStarted = false;
  backgroundRepairPollFailures = 0;
  backgroundRepairScenario = 'running';
  backgroundRepairStartGate = undefined;
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://manager.test');
      if (url.pathname === '/api/reviews') {
        return response({
          items: [
            {
              candidates: [
                {
                  candidateId: 'candidate-1',
                  categories: ['decision'],
                  comparison: 'new',
                  confidence: 0.9,
                  proposedText: 'Preserve the reviewed contract.',
                  reason: 'The decision is reusable.',
                  recommendation: 'create',
                  state: 'pending',
                },
              ],
              createdAt: '2026-09-28T10:00:00.000Z',
              project: 'threadnote',
              reviewId: 'review-1',
              revision: 1,
              task: 'Ship the reviewed workflow',
              topic: 'workflow',
            },
          ],
          pendingCount: 1,
          project: 'threadnote',
          version: 1,
        });
      }
      if (url.pathname === '/api/context-health/citations/preview') {
        bulkRequests.push(url.pathname);
        const body = JSON.parse(String(init?.body)) as {readonly findingCategory?: string};
        bulkPreviewCategories.push(body.findingCategory ?? 'all');
        await bulkPreviewGate;
        return response({
          items: [
            {
              category: 'citation-changed',
              citationId: `tncc_${'1'.repeat(40)}`,
              findingId: 'finding-1',
              path: 'src/example.ts',
              proposalId: `health-repair-${'4'.repeat(40)}`,
              replacementId: `tncc_${'2'.repeat(40)}`,
              revision: '5'.repeat(64),
              sourceCommit: '3'.repeat(40),
              subjectUri: 'threadnote://user/tester/memories/example.md',
              targetKind: 'file',
            },
          ],
          project: 'threadnote',
          repairableCount: 1,
          requiresGraphCount: 2,
          truncated: false,
          version: 1,
        });
      }
      if (url.pathname === '/api/context-health/citations/jobs') {
        if (init?.method === 'POST') {
          await backgroundRepairStartGate;
          backgroundRepairStarted = true;
          if (backgroundRepairScenario === 'immediate-completion') {
            return response({job: backgroundRepairJob('completed')});
          }
        } else if (backgroundRepairScenario === 'delayed-start') {
          return response({job: null});
        } else if (
          backgroundRepairStarted &&
          backgroundRepairScenario === 'poll-retry' &&
          backgroundRepairPollFailures === 0
        ) {
          backgroundRepairPollFailures += 1;
          throw new Error('Temporary repair status failure.');
        }
        return response({
          job: backgroundRepairStarted
            ? backgroundRepairJob(
                backgroundRepairScenario === 'running' || backgroundRepairScenario === 'delayed-start'
                  ? 'running'
                  : backgroundRepairScenario === 'failed'
                    ? 'failed'
                    : 'completed',
                backgroundRepairScenario === 'count-drift' ? 150 : undefined,
              )
            : null,
        });
      }
      if (url.pathname === '/api/context-health/citations/rebuild') {
        bulkRequests.push(url.pathname);
        return response({output: 'Ready'});
      }
      if (url.pathname === '/api/context-health/citations/apply') {
        bulkRequests.push(url.pathname);
        await bulkApplyGate;
        return response({appliedCount: 1, failedCount: 0, results: [], version: 1});
      }
      contextHealthRequests.push(url.search);
      const after = url.searchParams.get('after');
      if (url.searchParams.get('project') === 'memory-only') {
        return response({
          findings: [],
          limit: 100,
          omittedFindings: 0,
          project: 'memory-only',
          recordPreviews: [],
          recordsScanned: 3,
          repositoryEvidence: {reason: 'project-not-configured', state: 'unavailable'},
          semanticCompleteness: {state: 'unavailable'},
          status: 'unknown',
          version: 1,
        });
      }
      if (url.searchParams.get('project') === 'grouped') {
        const findings = healthFindings(1, 2).map(finding => ({
          ...finding,
          repair: {...finding.repair, subjectUri: 'threadnote://memory/grouped'},
          uris: ['threadnote://memory/grouped'],
        }));
        return response({
          findings,
          limit: 100,
          omittedFindings: 0,
          project: 'grouped',
          recordPreviews: [
            {
              code: [
                {
                  citationId: `tncc_${'0'.repeat(39)}1`,
                  excerpt: 'export const grouped = true;',
                  findingIds: ['finding-1'],
                  line: 1,
                  path: 'src/grouped.ts',
                },
              ],
              excerpt: 'Both issues belong to this readable memory.',
              kind: 'durable',
              title: 'Grouped memory',
              uri: 'threadnote://memory/grouped',
            },
          ],
          recordsScanned: 1,
          repositoryEvidence: {state: 'available'},
          semanticCompleteness: {reason: 'complete', state: 'complete'},
          status: 'findings',
          version: 1,
        });
      }
      const start = after ? 101 : 1;
      const count = after ? 1 : 100;
      return response({
        findings: healthFindings(start, count),
        limit: 100,
        ...(after ? {remainingFindings: 0} : {nextCursor: `hcx1_2s_${'a'.repeat(40)}`, remainingFindings: 1}),
        omittedFindings: after ? 100 : 1,
        project: 'threadnote',
        recordPreviews: healthPreviews(start, count),
        recordsScanned: 12,
        repositoryEvidence: {state: 'available'},
        semanticCompleteness: {reason: 'complete', state: 'complete'},
        status: 'findings',
        version: 1,
      });
    }),
  );
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) {
    this.open = true;
  });
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) {
    this.open = false;
  });
});

afterEach(async () => {
  if (reactRoot) await act(async () => reactRoot?.unmount());
  reactRoot = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Manager attention views', () => {
  it('shows the exact pending review instead of routing the user to the Library', async () => {
    await render(
      <ReviewsPanel
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
        project="threadnote"
        projects={['threadnote']}
        refreshGeneration={0}
      />,
    );
    await waitFor('Preserve the reviewed contract.');
    expect(document.body.textContent).toContain('Ship the reviewed workflow');
    expect(document.body.textContent).toContain('pending');
  });

  it('shows project context findings and repair guidance in their own view', async () => {
    await render(
      <ContextHealthPanel
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
        project="threadnote"
        projects={['threadnote']}
        refreshGeneration={0}
      />,
    );
    await waitFor('Memory 1');
    expect(document.body.textContent).toContain('A readable memory preview 1.');
    expect(document.body.textContent).toContain('src/example-1.ts');
    expect(document.body.textContent).toContain('Compare the memory with the current source excerpt');
    expect(document.body.textContent).not.toContain('Review the changed citation.');
    expect(document.body.textContent).toContain('12');
    expect(document.body.textContent).toContain('The source code cited by this memory has changed');
  });

  it('loads every context-health page and reruns when Manager refreshes', async () => {
    await render(
      <ContextHealthPanel
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
        project="threadnote"
        projects={['threadnote']}
        refreshGeneration={0}
      />,
    );
    await waitFor('Memory 100');
    await clickButton('Load 1 findings');
    await waitFor('Memory 101');
    expect(contextHealthRequests).toContain(`?project=threadnote&after=hcx1_2s_${'a'.repeat(40)}`);
    expect(metricValue('Issues')).toBe('101');
    expect(buttonWithText('Load')).toBeUndefined();

    await rerender(
      <ContextHealthPanel
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
        project="threadnote"
        projects={['threadnote']}
        refreshGeneration={1}
      />,
    );
    await waitForRequestCount(3);
  });

  it('explains when repository evidence and repairs are unavailable', async () => {
    await render(
      <ContextHealthPanel
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
        project="memory-only"
        projects={['memory-only']}
        refreshGeneration={0}
      />,
    );
    await waitFor('Repository evidence is unavailable');
    expect(document.body.textContent).toContain('configured local checkout');
    expect(document.body.textContent).not.toContain('No actionable context findings');
  });

  it('groups several issues under a readable memory and code preview', async () => {
    await render(
      <ContextHealthPanel
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
        project="grouped"
        projects={['grouped']}
        refreshGeneration={0}
      />,
    );
    await waitFor('Grouped memory');
    expect(document.body.textContent).toContain('2 issues');
    expect(document.body.textContent).toContain('Both issues belong to this readable memory.');
    expect(document.body.textContent).toContain('src/grouped.ts');
    expect(document.body.textContent).toContain('export const grouped = true;');
    expect(document.querySelectorAll('.health-record')).toHaveLength(1);
    expect(document.body.textContent).not.toContain(`tncc_${'0'.repeat(39)}1`);
  });

  it('previews current-graph citation repairs, rebuilds evidence, and applies the reviewed batch', async () => {
    await render(
      <ContextHealthPanel
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
        project="threadnote"
        projects={['threadnote']}
        refreshGeneration={0}
      />,
    );
    await waitFor('Memory 1');
    const previewGate = Promise.withResolvers<void>();
    bulkPreviewGate = previewGate.promise;
    await clickButton('Review citation repairs');
    await waitFor('Matching stored citations against the current project graph');
    expect(document.body.textContent).toContain('one update per affected memory');
    previewGate.resolve();
    await waitFor('src/example.ts');
    expect(document.body.textContent).toContain('Need graph evidence');
    await clickButton('Rebuild project graph and retry');
    await waitForRequest('/api/context-health/citations/rebuild');
    const applyGate = Promise.withResolvers<void>();
    bulkApplyGate = applyGate.promise;
    await clickButton('Apply 1 citation repair');
    await waitFor('Applying citation repairs · 0 of 1');
    applyGate.resolve();
    await waitFor('Repaired 1 citation.');
    expect(bulkRequests).toEqual([
      '/api/context-health/citations/preview',
      '/api/context-health/citations/rebuild',
      '/api/context-health/citations/preview',
      '/api/context-health/citations/apply',
    ]);
    expect(bulkPreviewCategories).toEqual(['all', 'all']);
  });

  it('starts a full background repair and explains that the browser can close', async () => {
    await render(
      <ContextHealthPanel
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
        project="threadnote"
        projects={['threadnote']}
        refreshGeneration={0}
      />,
    );
    await waitFor('Memory 1');
    await clickButton('Repair all in background');
    await waitFor('Repairing citations in background');
    expect(document.body.textContent).toContain('Scanning every citation issue for threadnote.');
    expect(document.body.textContent).toContain('2 pages scanned');
    expect(document.body.textContent).toContain('You can close this browser window');
    expect(buttonWithText('Repair running')?.disabled).toBe(true);
  });

  it('refreshes context health when the start response is already complete', async () => {
    backgroundRepairScenario = 'immediate-completion';
    await render(
      <ContextHealthPanel
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
        project="threadnote"
        projects={['threadnote']}
        refreshGeneration={0}
      />,
    );
    await waitFor('Memory 1');
    await clickButton('Repair all in background');
    await waitForRequestCount(2);
    await waitFor('Automatic citation repair finished');
    expect(document.body.textContent).toContain('41 citation issues at start');
    expect(document.body.textContent).toContain('37 citation updates applied');
    expect(document.body.textContent).toContain('0 citation issues remain');
    expect(document.body.textContent).toContain('Current health total:');
    expect(document.body.textContent).toContain('41 citation issues cleared');
    expect(document.body.textContent).toContain('one write is not necessarily one cleared issue');
  });

  it('retries a transient status failure and refreshes after completion', async () => {
    vi.useFakeTimers();
    backgroundRepairScenario = 'poll-retry';
    await render(
      <ContextHealthPanel
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
        project="threadnote"
        projects={['threadnote']}
        refreshGeneration={0}
      />,
    );
    await waitFor('Memory 1');
    await clickButton('Repair all in background');
    await waitFor('Temporary repair status failure.');
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    await waitFor('Automatic citation repair finished');
    await waitForRequestCount(2);
    expect(backgroundRepairPollFailures).toBe(1);
    vi.useRealTimers();
  });

  it('labels a failed partial scan without presenting exact issue arithmetic', async () => {
    backgroundRepairScenario = 'failed';
    await render(
      <ContextHealthPanel
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
        project="threadnote"
        projects={['threadnote']}
        refreshGeneration={0}
      />,
    );
    await waitFor('Memory 1');
    await clickButton('Repair all in background');
    await waitFor('Automatic citation repair stopped');
    expect(document.body.textContent).toContain('4 citation issues observed before stop');
    expect(document.body.textContent).toContain('The stopped scan is partial');
    expect(document.body.textContent).not.toContain('citation issues +');
  });

  it('does not force an exact breakdown when completed counts drift beyond current health', async () => {
    backgroundRepairScenario = 'count-drift';
    await render(
      <ContextHealthPanel
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
        project="threadnote"
        projects={['threadnote']}
        refreshGeneration={0}
      />,
    );
    await waitFor('Memory 1');
    await clickButton('Repair all in background');
    await waitFor('Automatic citation repair finished');
    expect(document.body.textContent).toContain('150 citation issues remain');
    expect(document.body.textContent).toContain('citation breakdown is no longer exact');
    expect(document.body.textContent).not.toContain('citation issues +');
  });

  it('discards a delayed start response after switching projects', async () => {
    backgroundRepairScenario = 'delayed-start';
    const startGate = Promise.withResolvers<void>();
    backgroundRepairStartGate = startGate.promise;
    await render(
      <ContextHealthPanel
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
        project="threadnote"
        projects={['threadnote', 'grouped']}
        refreshGeneration={0}
      />,
    );
    await waitFor('Memory 1');
    await clickButton('Repair all in background');
    await rerender(
      <ContextHealthPanel
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
        project="grouped"
        projects={['threadnote', 'grouped']}
        refreshGeneration={0}
      />,
    );
    await waitFor('Grouped memory');
    startGate.resolve();
    await act(async () => Promise.resolve());
    expect(document.body.textContent).not.toContain('Repairing citations in background');
    expect(buttonWithText('Repair all in background')?.disabled).toBe(false);
  });
});

async function render(element: React.ReactElement): Promise<void> {
  const container = document.createElement('div');
  document.body.append(container);
  reactRoot = createRoot(container);
  await act(async () => reactRoot?.render(element));
}

async function rerender(element: React.ReactElement): Promise<void> {
  await act(async () => reactRoot?.render(element));
}

async function waitFor(text: string): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (document.body.textContent?.includes(text)) return;
    await act(async () => Promise.resolve());
  }
  throw new Error(`Text did not render: ${text}`);
}

async function clickButton(label: string): Promise<void> {
  const button = [...document.querySelectorAll('button')].find(item => item.textContent === label);
  if (!button) throw new Error(`Button did not render: ${label}`);
  await act(async () => button.click());
}

function buttonWithText(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find(item => item.textContent?.includes(text));
}

function metricValue(label: string): string | undefined {
  return [...document.querySelectorAll('.attention-metrics > div')]
    .find(item => item.querySelector('span')?.textContent === label)
    ?.querySelector('strong')?.textContent;
}

async function waitForRequestCount(count: number): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (contextHealthRequests.length >= count) return;
    await act(async () => Promise.resolve());
  }
  throw new Error(`Context health request count did not reach ${count}.`);
}

async function waitForRequest(path: string): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (bulkRequests.includes(path)) return;
    await act(async () => Promise.resolve());
  }
  throw new Error(`Bulk request did not run: ${path}`);
}

function healthFindings(start: number, count: number) {
  return Array.from({length: count}, (_, index) => ({
    category: 'citation-changed' as const,
    confidence: 'high' as const,
    id: `finding-${start + index}`,
    repair: {
      kind: 'repair-citation' as const,
      subjectUri: `threadnote://memory/example-${start + index}`,
      summary: `Review and recapture citation tncc_${String(start + index).padStart(40, '0')}.`,
      targetUri: `threadnote://memory/example-${start + index}#tncc_${String(start + index).padStart(40, '0')}`,
    },
    repairability: 'reviewable' as const,
    severity: 'high' as const,
    summary: `Finding ${start + index}`,
    uris: [`threadnote://memory/example-${start + index}`],
  }));
}

function healthPreviews(start: number, count: number) {
  return Array.from({length: count}, (_, index) => ({
    code: [
      {
        citationId: `tncc_${String(start + index).padStart(40, '0')}`,
        excerpt: `export const example${start + index} = true;`,
        findingIds: [`finding-${start + index}`],
        line: 1,
        path: `src/example-${start + index}.ts`,
      },
    ],
    excerpt: `A readable memory preview ${start + index}.`,
    kind: 'durable',
    title: `Memory ${start + index}`,
    topic: 'workflow',
    uri: `threadnote://memory/example-${start + index}`,
  }));
}

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}, status: 200});
}

function backgroundRepairJob(status: 'completed' | 'failed' | 'running', unresolvedCount?: number) {
  return {
    createdAt: '2026-09-29T10:00:00.000Z',
    ...(status === 'completed' ? {finishedAt: '2026-09-29T10:00:01.000Z'} : {}),
    id: 'mcrj_example',
    progress: {
      batch: 1,
      failedCount: 0,
      initialCitationCount: 41,
      message:
        status === 'completed'
          ? 'Citation repair finished for threadnote.'
          : status === 'failed'
            ? 'Background citation repair stopped before the backlog was complete.'
            : 'Scanning every citation issue for threadnote.',
      pagesScanned: 2,
      phase:
        status === 'completed'
          ? ('completed' as const)
          : status === 'failed'
            ? ('failed' as const)
            : ('scanning' as const),
      repairableCount: 37,
      repairedCount: status === 'completed' ? 37 : 0,
      unresolvedCount: unresolvedCount ?? (status === 'completed' ? 0 : 4),
    },
    project: 'threadnote',
    status,
    ...(status === 'failed' ? {error: 'Unexpected citation scanner defect.'} : {}),
  };
}
