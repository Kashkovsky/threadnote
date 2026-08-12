// @vitest-environment happy-dom

import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {ManagerDialogProvider} from '../../src/manager_dialog.js';
import {ProcessesPanel} from '../../src/manager_processes_view.js';
import {readFile} from '../helpers/node-fs-promises.js';
import {join} from '../helpers/node-path.js';

let reactRoot: Root | undefined;
let fetchOriginal: typeof fetch;
let requests: Array<{readonly body?: Record<string, unknown>; readonly path: string}>;

beforeEach(() => {
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  fetchOriginal = globalThis.fetch;
  requests = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const path =
      typeof input === 'string' ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    requests.push({body, path});
    if (path === '/api/processes/terminate') {
      return Promise.resolve(jsonResponse({processId: 80297, state: 'terminated'}));
    }
    return Promise.resolve(
      jsonResponse({
        processes: [
          {
            ageMilliseconds: 540_000,
            currentOperation: 'compact-graph-storage',
            parentProcessId: 80276,
            parentRole: 'manager',
            processId: 80297,
            processRef: `tnp_${'a'.repeat(64)}`,
            role: 'graph-compaction-worker',
            rssBytes: 100 * 1_024 * 1_024,
            startedAt: '2026-08-12T00:00:00.000Z',
            terminable: true,
          },
          {
            activityRole: 'graph-builder',
            ageMilliseconds: 10_000,
            currentOperation: 'index-repository',
            parentProcessId: 1,
            processId: 80300,
            processRef: `tnp_${'b'.repeat(64)}`,
            role: 'mcp',
            startedAt: '2026-08-12T00:00:00.000Z',
            terminable: true,
          },
          {
            ageMilliseconds: 5_000,
            currentOperation: 'manager-ui',
            parentProcessId: 1,
            processId: 80276,
            role: 'manager',
            startedAt: '2026-08-12T00:00:00.000Z',
            terminable: false,
            terminationBlockedReason: 'current-manager',
          },
        ],
        schemaVersion: 1,
        truncated: false,
      }),
    );
  }) as typeof fetch;
});

afterEach(async () => {
  if (reactRoot) await act(async () => reactRoot?.unmount());
  document.body.replaceChildren();
  globalThis.fetch = fetchOriginal;
  reactRoot = undefined;
});

describe('Manager Processes panel', () => {
  it('shows compaction and activity roles without exposing opaque control data as text', async () => {
    await renderProcesses();
    const processList = document.querySelector('[aria-label="Threadnote process inventory"]');
    expect(processList?.getAttribute('role')).toBe('list');
    expect(processList?.querySelectorAll('[role="listitem"]')).toHaveLength(3);
    expect(document.body.textContent).toContain('Graph compaction worker');
    expect(document.body.textContent).toContain('Compact graph storage');
    expect(document.body.textContent).toContain('Manager · PID 80276');
    expect(document.body.textContent).toContain('MCP server');
    expect(document.body.textContent).toContain('Graph builder activity');
    expect(document.body.textContent).not.toContain(`tnp_${'a'.repeat(64)}`);

    const stop = document.querySelector<HTMLButtonElement>(
      '[aria-label="Terminate Graph compaction worker process 80297"]',
    );
    const managerStop = document.querySelector<HTMLButtonElement>('[aria-label="Terminate Manager process 80276"]');
    expect(stop?.title).toBe('Terminate Graph compaction worker');
    expect(stop?.disabled).toBe(false);
    expect(managerStop?.title).toBe('The current Manager process is protected');
    expect(managerStop?.disabled).toBe(true);
  });

  it('confirms termination and posts the exact opaque process reference with the PID', async () => {
    await renderProcesses();
    const stop = document.querySelector<HTMLButtonElement>(
      '[aria-label="Terminate Graph compaction worker process 80297"]',
    )!;
    await act(async () => stop.click());
    const confirm = await waitForElement<HTMLButtonElement>('dialog.manager-dialog button.danger');
    expect(document.querySelector('dialog.manager-dialog')?.textContent).toContain('PID 80297');
    await act(async () => confirm.click());
    await flush();
    expect(requests.find(request => request.path === '/api/processes/terminate')?.body).toEqual({
      confirm: true,
      processId: 80297,
      processRef: `tnp_${'a'.repeat(64)}`,
    });
  });

  it('keeps process rows content-sized and lets metadata wrap responsively', async () => {
    const css = await readFile(join(process.cwd(), 'manager', 'app.css'), 'utf8');
    expect(css).toMatch(
      /\.process-workspace\s*\{[\s\S]*?align-content: start;[\s\S]*?grid-auto-rows: max-content;[\s\S]*?min-height: 0;/u,
    );
    expect(css).toMatch(
      /\.process-list\s*\{[\s\S]*?align-content: start;[\s\S]*?grid-auto-rows: max-content;[\s\S]*?min-height: 0;/u,
    );
    expect(css).toMatch(/\.process-card dl\s*\{[\s\S]*?repeat\(auto-fit, minmax\(min\(140px, 100%\), 1fr\)\)/u);
    expect(css).toMatch(/\.process-card dd\s*\{[\s\S]*?overflow-wrap: anywhere;/u);
  });
});

async function renderProcesses(): Promise<void> {
  const container = document.createElement('div');
  document.body.append(container);
  reactRoot = createRoot(container);
  await act(async () => {
    reactRoot?.render(React.createElement(ManagerDialogProvider, undefined, React.createElement(ProcessesPanel)));
  });
  await waitForElement('[aria-label="Terminate Graph compaction worker process 80297"]');
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise(resolve => window.setTimeout(resolve, 0));
  });
}

async function waitForElement<T extends Element>(selector: string): Promise<T> {
  for (let index = 0; index < 20; index += 1) {
    const element = document.querySelector<T>(selector);
    if (element) return element;
    await flush();
  }
  throw new Error(`Element did not render: ${selector}`);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {headers: {'content-type': 'application/json'}, status});
}
