// @vitest-environment happy-dom

import {act} from 'react';
import {describe, expect, it} from 'vitest';

const firstUri = 'threadnote://user/test/memories/handoffs/active/threadnote/first.md';
const secondUri = 'threadnote://user/test/memories/handoffs/active/threadnote/second.md';

describe('Manager disconnect recovery', () => {
  it('preserves new and selected drafts, then gates a changed canonical record until reviewed', async () => {
    (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
    const originalFetch = globalThis.fetch;
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = true;
      },
    });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = false;
      },
    });
    let online = true;
    let firstContent = 'Original handoff';
    const root = document.createElement('div');
    root.id = 'root';
    document.body.append(root);
    globalThis.fetch = (async input => {
      if (!online) throw new TypeError('Manager is unavailable');
      const url = new URL(String(input), 'http://localhost');
      const path = url.pathname;
      if (path === '/api/state')
        return json({
          agents: [],
          autoUpdate: {effectivePolicy: 'notify'},
          config: {account: 'local', agentContextHome: '/tmp/threadnote-test', user: 'test'},
          updateAvailable: false,
          version: 'test',
        });
      if (path === '/api/tree')
        return json({
          resourcesTree: node('resources', 'threadnote://resources', true),
          tree: {
            ...node('memories', 'threadnote://user/test/memories', true),
            children: [node('first.md', firstUri), node('second.md', secondUri)],
          },
        });
      if (path === '/api/memory') {
        const uri = url.searchParams.get('uri');
        const content = uri === firstUri ? firstContent : 'Second handoff';
        const selected = node(uri === firstUri ? 'first.md' : 'second.md', uri ?? '');
        return json({content, node: selected, record: {content, body: content, metadata: selected.metadata, uri}});
      }
      if (path === '/api/shares') return json({shares: []});
      if (path === '/api/graphs') return json({repositories: [], builds: [], diagnostics: [], views: []});
      if (path === '/api/graphs/diagnostics')
        return new Response(JSON.stringify({error: 'Diagnostics unavailable in this fixture'}), {status: 503});
      if (path === '/api/graphs/status') return json({builds: [], catalogRevision: 'test'});
      return json({});
    }) as typeof fetch;
    try {
      await act(async () => {
        await import('../../src/manager/ui.js');
      });
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await flush();
        if (!document.querySelector<HTMLButtonElement>('.primary-nav button:nth-child(4)')?.disabled) break;
      }
      expect(
        document.querySelector<HTMLButtonElement>('.primary-nav button:nth-child(4)')?.disabled,
        root.textContent ?? '',
      ).toBe(false);
      await clickButton('Library');
      await flush();
      await clickButton('New');
      await editTextarea('Unsaved new memory');
      online = false;
      await refresh();
      expect(root.textContent).toContain('Manager disconnected');
      online = true;
      await refresh();
      expect(editor()?.value).toBe('Unsaved new memory');

      await selectMemory(firstUri);
      expect(editor()?.value).toBe('Original handoff');
      await editTextarea('Unsaved handoff edit');
      online = false;
      await refresh();
      firstContent = 'Changed on disk';
      online = true;
      await refresh();
      expect(root.textContent).toContain('Unsaved handoff edit');
      expect(root.textContent).toContain('Your unsaved draft is preserved');
      expect(root.textContent).toContain('Review the reloaded record');
      expect(actionButton('Save')?.disabled).toBe(true);

      await selectMemory(secondUri);
      expect(editor()?.value).toBe('Second handoff');
      expect(actionButton('Save')?.disabled).toBe(false);
      await clickButton('Forget');
      await clickButton('Forget memory');
      expect(editor()?.value).toBe('');
      await selectMemory(firstUri, false);
      expect(root.textContent).toContain('Your unsaved draft is preserved');
      expect(root.textContent).toContain('Unsaved handoff edit');
      await clickButton('Load reloaded record');
      await clickButton('Edit');
      await clickButton('Forget');
      await clickButton('Forget memory');
      expect(editor()?.value).toBe('');
    } finally {
      globalThis.fetch = originalFetch;
      document.body.replaceChildren();
    }
  });
});

function node(name: string, uri: string, isDir = false) {
  return {
    isDir,
    isShared: false,
    isSystem: false,
    metadata: {kind: 'handoff', sourceAgentClient: 'test', status: 'active', timestamp: '2026-09-14T00:00:00Z'},
    name,
    relativePath: name,
    uri,
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}});
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

async function clickButton(label: string): Promise<void> {
  const button = [...document.querySelectorAll('button')].find(
    candidate => candidate.textContent?.trim() === label || candidate.querySelector('strong')?.textContent === label,
  );
  expect(
    button,
    `${label}: ${[...document.querySelectorAll('button')].map(candidate => candidate.textContent?.trim()).join(' | ')}`,
  ).toBeDefined();
  await act(async () => button?.click());
  await flush();
}

async function refresh(): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>('[aria-label="Refresh manager"]');
  expect(button?.disabled).toBe(false);
  await act(async () => button?.click());
  await flush();
}

async function selectMemory(uri: string, edit = true): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>(`.tree-file[title="${uri}"]`);
  expect(button).not.toBeNull();
  await act(async () => button?.click());
  if (edit) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await flush();
      if (!actionButton('Edit')?.disabled) break;
    }
    await clickButton('Edit');
  } else {
    await flush();
  }
}

async function editTextarea(value: string): Promise<void> {
  const textarea = editor();
  expect(textarea).not.toBeNull();
  await act(async () => {
    if (textarea) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, value);
      textarea.dispatchEvent(new Event('input', {bubbles: true}));
    }
  });
}

function editor(): HTMLTextAreaElement | null {
  return document.querySelector('.editor-pane textarea');
}

function actionButton(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('.editor-pane .action-row button')].find(
    button => button.textContent?.trim() === label,
  );
}
