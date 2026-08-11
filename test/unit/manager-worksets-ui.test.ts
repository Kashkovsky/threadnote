// @vitest-environment happy-dom

import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {ManagerDialogProvider} from '../../src/manager_dialog.js';
import {WorksetsPanel} from '../../src/manager_worksets_view.js';
import {readFile} from '../helpers/node-fs-promises.js';
import {join} from '../helpers/node-path.js';

interface PendingQuery {
  readonly signal?: AbortSignal;
  readonly resolve: (response: Response) => void;
}

const REVISION = 'a'.repeat(64);
let reactRoot: Root | undefined;
let fetchOriginal: typeof fetch;
let pendingQueries: PendingQuery[];
let catalogRevision: string;
let definitionProjects: Map<string, readonly string[]>;
let definitionMutationBodies: Record<string, unknown>[];
let projectInventory: readonly string[];
let statusUnavailable: boolean;

beforeEach(() => {
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  fetchOriginal = globalThis.fetch;
  pendingQueries = [];
  catalogRevision = REVISION;
  definitionMutationBodies = [];
  definitionProjects = new Map([
    ['alpha', ['alpha']],
    ['beta', ['beta']],
  ]);
  projectInventory = ['alpha', 'beta'];
  statusUnavailable = false;
  const fetchStub = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
    if (url === '/api/worksets') return Promise.resolve(jsonResponse(catalog()));
    if (url === '/api/worksets/jobs') return Promise.resolve(jsonResponse({jobs: []}));
    if (url === '/api/worksets/definitions') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      definitionMutationBodies.push(body);
      const operation = body.operation;
      if (operation === 'delete') {
        definitionProjects.delete(String(body.workset));
      } else {
        const name = String(body.name);
        const originalName = operation === 'update' ? String(body.workset) : undefined;
        if (originalName !== undefined && originalName !== name) definitionProjects.delete(originalName);
        definitionProjects.set(name, Array.isArray(body.projects) ? body.projects.map(String) : []);
      }
      catalogRevision = String.fromCharCode(98 + definitionMutationBodies.length - 1).repeat(64);
      return Promise.resolve(jsonResponse({catalog: catalog(), changed: true, warnings: []}));
    }
    if (url.startsWith('/api/worksets/definition')) {
      const name = new URL(url, 'http://manager.test').searchParams.get('workset') ?? 'alpha';
      return Promise.resolve(jsonResponse(definition(name)));
    }
    if (url.startsWith('/api/worksets/status')) {
      if (statusUnavailable)
        return Promise.resolve(
          jsonResponse(
            {code: 'maintenance-busy', error: 'Graph maintenance is active.', retryAfterMilliseconds: 1_000},
            409,
          ),
        );
      const name = new URL(url, 'http://manager.test').searchParams.get('workset') ?? 'alpha';
      return Promise.resolve(jsonResponse(status(name)));
    }
    if (url === '/api/worksets/query') {
      return new Promise<Response>(resolve => pendingQueries.push({resolve, signal: init?.signal ?? undefined}));
    }
    throw new Error(`Unexpected Worksets request: ${url}`);
  };
  globalThis.fetch = Object.assign(fetchStub, {preconnect: fetchOriginal.preconnect});
});

afterEach(async () => {
  await act(async () => reactRoot?.unmount());
  reactRoot = undefined;
  document.body.replaceChildren();
  globalThis.fetch = fetchOriginal;
});

describe('Manager Worksets interaction fencing', () => {
  it('aborts stale selection work, clears cancellation immediately, and permits a clean rerun', async () => {
    await renderWorksets();
    const input = await waitForElement<HTMLInputElement>('input[placeholder="checkout ownership or parseManifest"]');
    await changeInput(input, 'ownership');
    await clickButton('Search published workset');
    expect(pendingQueries).toHaveLength(1);

    await clickButtonStartingWith('beta');
    expect(pendingQueries[0]?.signal?.aborted).toBe(true);
    pendingQueries[0]!.resolve(jsonResponse(evidence('alpha', 'AlphaOnlySymbol')));
    await flush();
    expect(document.body.textContent).toContain('beta');
    expect(document.body.textContent).not.toContain('AlphaOnlySymbol');

    await clickButton('Search published workset');
    expect(pendingQueries).toHaveLength(2);
    await clickButton('Cancel request');
    expect(pendingQueries[1]?.signal?.aborted).toBe(true);
    expect(findButton('Cancel request')).toBeUndefined();
    expect(findButton('Search published workset')?.disabled).toBe(false);

    await clickButton('Search published workset');
    expect(pendingQueries).toHaveLength(3);
    pendingQueries[2]!.resolve(jsonResponse(evidence('beta', 'BetaOwnership')));
    await flush();
    expect(document.body.textContent).toContain('BetaOwnership');
    expect(document.body.textContent).toContain('observed branch main');

    await clickButton('Use as From');
    await flush();
    expect(document.querySelector<HTMLButtonElement>('#worksets-tab-traversal')?.getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(document.querySelector<HTMLInputElement>('#worksets-traversal-from')?.value).toBe('cgr_example');
  });

  it('reloads a retained definition at the new revision and clears stale readiness and query results', async () => {
    await renderWorksets();
    const queryInput = await waitForElement<HTMLInputElement>(
      'input[placeholder="checkout ownership or parseManifest"]',
    );
    await changeInput(queryInput, 'ownership');
    await clickButton('Search published workset');
    pendingQueries[0]!.resolve(jsonResponse(evidence('alpha', 'OldGenerationSymbol')));
    await flush();
    expect(document.body.textContent).toContain('OldGenerationSymbol');
    expect(document.body.textContent).toContain('Current members');

    catalogRevision = 'd'.repeat(64);
    definitionProjects.set('alpha', ['alpha', 'beta']);
    await clickButton('Refresh definitions');
    await waitForText('2 members');
    expect(document.body.textContent).not.toContain('OldGenerationSymbol');
    await waitForButtonEnabled('Edit');
    await clickButton('Edit');
    await waitForText('2 selected');

    await clickButton('Cancel');
    statusUnavailable = true;
    await clickButton('Refresh');
    await waitForText('Readiness is temporarily unavailable');
    expect(document.body.textContent).not.toContain('Current members');
  });

  it('keeps more than 250 selected projects searchable and pageable', async () => {
    projectInventory = Array.from({length: 320}, (_, index) => `project-${String(index).padStart(3, '0')}`);
    definitionProjects = new Map([
      ['alpha', projectInventory.slice(0, 300)],
      ['beta', ['project-319']],
    ]);
    await renderWorksets();
    await waitForButtonEnabled('Edit');
    await clickButton('Edit');
    const filter = await waitForElement<HTMLInputElement>('input[placeholder="Filter manifest projects"]');
    await changeInput(filter, 'project-299');
    await waitForText('project-299');
    expect(document.querySelector<HTMLInputElement>('.worksets-project-picker input[type="checkbox"]')?.checked).toBe(
      true,
    );

    await changeInput(filter, '');
    await clickButton('Show selected only');
    await clickButton('Next');
    await waitForText('Page 2 of 2');
    expect(document.body.textContent).toContain('project-299');
  });

  it('creates and confirmed-deletes a Workset through the visible definition controls', async () => {
    await renderWorksets();
    const create = await waitForElement<HTMLButtonElement>('button[aria-label="Create workset"]');
    await act(async () => create.click());
    await flush();

    const name = await waitForElement<HTMLInputElement>(
      '.worksets-editor input:not([type="search"]):not([type="checkbox"])',
    );
    await changeInput(name, 'gamma');
    const firstProject = await waitForElement<HTMLInputElement>('.worksets-project-picker input[type="checkbox"]');
    await act(async () => firstProject.click());
    await flush();
    await clickButton('Save definition');
    await waitForText('Workset definition saved.');

    expect(definitionMutationBodies[0]).toMatchObject({
      expectedRevision: REVISION,
      name: 'gamma',
      operation: 'create',
      projects: ['alpha'],
    });
    expect(document.body.textContent).toContain('gamma');

    await clickButton('Delete');
    await flush();
    await clickButton('Delete definition');
    await waitForText('Workset definition deleted.');
    expect(definitionMutationBodies[1]).toMatchObject({
      confirm: true,
      expectedRevision: 'b'.repeat(64),
      operation: 'delete',
      workset: 'gamma',
    });
  });

  it('links operation tabs to panels and supports arrow-key navigation', async () => {
    await renderWorksets();
    const queryTab = await waitForElement<HTMLButtonElement>('#worksets-tab-query');
    expect(queryTab.getAttribute('aria-controls')).toBe('worksets-panel-query');
    expect(document.querySelector('#worksets-panel-query')?.getAttribute('aria-labelledby')).toBe('worksets-tab-query');

    await act(async () => queryTab.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, key: 'ArrowRight'})));
    await flush();
    const traversalTab = document.querySelector<HTMLButtonElement>('#worksets-tab-traversal');
    expect(traversalTab?.getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('#worksets-panel-traversal')?.getAttribute('aria-labelledby')).toBe(
      'worksets-tab-traversal',
    );
  });

  it('keeps the six-section nav and Worksets editor usable at narrow widths', async () => {
    const css = await readFile(join(process.cwd(), 'manager', 'app.css'), 'utf8');
    expect(css).toMatch(
      /@media \(max-width: 980px\)[\s\S]*\.worksets-workspace\s*\{[\s\S]*grid-template-columns: 1fr/u,
    );
    expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]*\.primary-nav\s*\{[\s\S]*repeat\(3,/u);
    expect(css).toMatch(/\.worksets-editor\s*\{[\s\S]*max-height: calc\(100dvh - 16px\);[\s\S]*overflow-y: auto/u);
  });
});

async function renderWorksets(): Promise<void> {
  const container = document.createElement('div');
  document.body.append(container);
  reactRoot = createRoot(container);
  await act(async () => {
    reactRoot?.render(React.createElement(ManagerDialogProvider, undefined, React.createElement(WorksetsPanel)));
  });
  await waitForElement('#worksets-tab-query');
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

async function waitForText(text: string): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (document.body.textContent?.includes(text)) return;
    await flush();
  }
  throw new Error(`Text did not render: ${text}`);
}

async function waitForButtonEnabled(label: string): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    const button = findButton(label);
    if (button && !button.disabled) return;
    await flush();
  }
  throw new Error(`Button did not become enabled: ${label}`);
}

async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await flush();
}

async function clickButton(label: string): Promise<void> {
  const button = findButton(label);
  expect(button).toBeDefined();
  await act(async () => button?.click());
}

async function clickButtonStartingWith(label: string): Promise<void> {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(candidate =>
    candidate.textContent?.trim().startsWith(label),
  );
  expect(button).toBeDefined();
  await act(async () => button?.click());
  await flush();
}

function findButton(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    candidate => candidate.textContent?.trim() === label,
  );
}

function jsonResponse(body: unknown, statusCode = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: {'content-type': 'application/json'},
    status: statusCode,
  });
}

function catalog() {
  return {
    definitions: [...definitionProjects].map(([name, projects]) => ({
      description: `${name[0]!.toUpperCase()}${name.slice(1)} services`,
      memberCount: projects.length,
      name,
    })),
    definitionSource: 'seed-manifest',
    editability: {state: 'editable'},
    projects: projectInventory.map(project),
    readOnly: false,
    revision: catalogRevision,
    type: 'manager-workset-catalog',
    version: 1,
  };
}

function project(name: string) {
  return {
    branch: 'main',
    branchState: 'current',
    folder: `${name}-service`,
    name,
    path: `/workspace/${name}-service`,
  };
}

function definition(name: string) {
  const projects = definitionProjects.get(name) ?? [name];
  return {
    configuredMembers: projects.length,
    description: `${name} services`,
    members: projects.map(member => ({...project(member), configured: true, project: member})),
    name,
    unresolvedMembers: 0,
  };
}

function status(name: string) {
  return {
    catalog: {state: 'missing'},
    coverage: {
      current: 0,
      requested: 1,
      states: {current: 0, deferred: 0, excluded: 0, failed: 0, missing: 1, stale: 0, uncatalogued: 0},
    },
    manifestDigest: 'b'.repeat(64),
    members: [{project: name, reason: 'no-ready-snapshot', state: 'missing'}],
    type: 'code-graph-workset-status',
    version: 1,
    warnings: [],
    workset: name,
  };
}

function evidence(repositoryKey: string, qualifiedName: string) {
  return {
    maximumBytes: 4_096,
    measurement: {},
    structuredContent: {
      cards: [
        {
          id: `card-${repositoryKey}`,
          reason: {score: 1, signals: [], summary: 'Exact graph match'},
          ref: 'cgr_example',
          relationships: [],
          repositoryKey,
          symbol: {
            kind: 'function',
            language: 'typescript',
            name: qualifiedName,
            path: 'src/index.ts',
            qualifiedName,
            span: {column: 0, endColumn: 1, endLine: 1, line: 1},
          },
        },
      ],
      coverage: {
        cataloguedRepositories: 1,
        complete: true,
        consideredRepositories: 1,
        deepQueriedRepositories: 1,
        requestedRepositories: 1,
        states: {current: 1, deferred: 0, excluded: 0, failed: 0, missing: 0, stale: 0},
        stopReason: 'exhaustion',
      },
      output: {omittedCards: 0, projectorVersion: 1, returnedCards: 1, totalCards: 1, truncated: false},
      repositories: {},
      trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
      type: 'code-graph-workset-query',
      version: 2,
      warnings: [],
      workset: {generation: {digest: 'c'.repeat(64), id: 'cgwg_example'}, name: repositoryKey},
    },
    text: '',
  };
}
