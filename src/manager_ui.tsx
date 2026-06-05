import React, {useEffect, useMemo, useState} from 'react';
import {createRoot} from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type PanelName = 'doctor' | 'memory' | 'shares' | 'tools';
type CheckStatus = 'fail' | 'ok' | 'warn';
type MemoryKind = 'durable' | 'handoff' | 'incident' | 'preference' | 'smoke';
type MemoryStatus = 'active' | 'archived' | 'superseded';
type AgentClient = 'claude' | 'codex' | 'copilot' | 'cursor';
type MemoryViewMode = 'edit' | 'preview';
type SelectId = 'agent' | 'kind' | 'status';

const SIDEBAR_WIDTH_KEY = 'threadnote.manager.sidebarWidth';
const SIDEBAR_WIDTH_DEFAULT = 340;
const SIDEBAR_WIDTH_MIN = 260;
const SIDEBAR_WIDTH_MAX = 560;

interface MemoryMetadata {
  readonly archivedFrom?: string;
  readonly kind: MemoryKind;
  readonly project?: string;
  readonly sourceAgentClient: string;
  readonly status: MemoryStatus;
  readonly supersedes?: string;
  readonly timestamp: string;
  readonly topic?: string;
}

interface TreeNode {
  readonly children?: readonly TreeNode[];
  readonly isDir: boolean;
  readonly isShared: boolean;
  readonly isSystem: boolean;
  readonly metadata?: MemoryMetadata;
  readonly modTime?: string;
  readonly name: string;
  readonly relativePath: string;
  readonly sharedTeam?: string;
  readonly size?: number;
  readonly uri: string;
}

interface MemoryResponse {
  readonly content: string;
  readonly node: TreeNode;
  readonly record?: {
    readonly body: string;
    readonly content: string;
    readonly metadata: MemoryMetadata;
    readonly uri: string;
  };
}

interface ReadResponse {
  readonly content: string;
  readonly localMemory?: MemoryResponse;
  readonly output: string;
}

interface AgentOption {
  readonly available: boolean;
  readonly command?: string;
  readonly id: AgentClient;
  readonly label: string;
}

interface StateResponse {
  readonly agents: readonly AgentOption[];
  readonly config: {
    readonly account: string;
    readonly agentContextHome: string;
    readonly user: string;
  };
  readonly latestVersion?: string;
  readonly openVikingLogPath: string;
  readonly version: string;
}

interface ShareSummary {
  readonly addedAt: string;
  readonly ahead?: number;
  readonly behind?: number;
  readonly default: boolean;
  readonly dirty?: boolean;
  readonly gitdir: string;
  readonly name: string;
  readonly remote: string;
  readonly status?: string;
  readonly warning?: string;
  readonly worktree: string;
}

interface DoctorCheck {
  readonly detail: string;
  readonly name: string;
  readonly status: CheckStatus;
}

interface ConsolidationJob {
  readonly agent: AgentClient;
  readonly draft?: string;
  readonly error?: string;
  readonly id: string;
  readonly sourceUris: readonly string[];
  readonly status: 'completed' | 'failed' | 'running';
}

interface TargetForm {
  kind: MemoryKind;
  project: string;
  status: MemoryStatus;
  team: string;
  topic: string;
}

interface DropdownOption {
  readonly disabled?: boolean;
  readonly label: string;
  readonly value: string;
}

const token = new URLSearchParams(window.location.search).get('token') ?? '';

function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(width)));
}

function loadSidebarWidth(): number {
  const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(stored) && stored > 0 ? clampSidebarWidth(stored) : SIDEBAR_WIDTH_DEFAULT;
}

function App(): React.ReactElement {
  const [panel, setPanel] = useState<PanelName>('memory');
  const [state, setState] = useState<StateResponse | undefined>();
  const [tree, setTree] = useState<TreeNode | undefined>();
  const [shares, setShares] = useState<readonly ShareSummary[]>([]);
  const [doctor, setDoctor] = useState<readonly DoctorCheck[]>([]);
  const [doctorOutput, setDoctorOutput] = useState('');
  const [selectedUri, setSelectedUri] = useState<string | undefined>();
  const [selectedUris, setSelectedUris] = useState<ReadonlySet<string>>(new Set());
  const [memory, setMemory] = useState<MemoryResponse | undefined>();
  const [content, setContent] = useState('');
  const [memoryViewMode, setMemoryViewMode] = useState<MemoryViewMode>('edit');
  const [openSelect, setOpenSelect] = useState<SelectId | undefined>();
  const [filter, setFilter] = useState('');
  const [showSystem, setShowSystem] = useState(false);
  const [toast, setToast] = useState('');
  const [output, setOutput] = useState('');
  const [recallQuery, setRecallQuery] = useState('');
  const [readUri, setReadUri] = useState('');
  const [compactProject, setCompactProject] = useState('');
  const [compactTopic, setCompactTopic] = useState('');
  const [packPath, setPackPath] = useState('');
  const [selectedShare, setSelectedShare] = useState('');
  const [shareTeam, setShareTeam] = useState('');
  const [shareRemote, setShareRemote] = useState('');
  const [renameShareTo, setRenameShareTo] = useState('');
  const [shareNewUrl, setShareNewUrl] = useState('');
  const [preserveShare, setPreserveShare] = useState(true);
  const [keepShareFiles, setKeepShareFiles] = useState(false);
  const [target, setTarget] = useState<TargetForm>({
    kind: 'durable',
    project: '',
    status: 'active',
    team: '',
    topic: '',
  });
  const [agent, setAgent] = useState<AgentClient>('codex');
  const [draft, setDraft] = useState('');
  const [jobId, setJobId] = useState<string | undefined>();
  const [draftingConsolidation, setDraftingConsolidation] = useState(false);
  const [applyingConsolidation, setApplyingConsolidation] = useState(false);
  const [consolidationSourceUris, setConsolidationSourceUris] = useState<readonly string[]>([]);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);

  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => {
    if (!selectedUri) {
      setMemory(undefined);
      setContent('');
      setMemoryViewMode('edit');
      return;
    }
    const node = tree ? findNode(tree, selectedUri) : undefined;
    if (node?.isDir) {
      setMemory(undefined);
      setContent('');
      setMemoryViewMode('preview');
      setTarget({kind: 'durable', project: '', status: 'active', team: node.sharedTeam ?? '', topic: ''});
      return;
    }
    void loadMemory(selectedUri);
  }, [selectedUri, tree]);

  useEffect(() => {
    const firstAvailable = state?.agents.find(item => item.available && (item.id === 'codex' || item.id === 'claude'));
    if (firstAvailable) {
      setAgent(firstAvailable.id);
    }
  }, [state]);

  const selectedNode = useMemo(
    () => (tree && selectedUri ? findNode(tree, selectedUri) : undefined),
    [tree, selectedUri],
  );
  const selectedList = useMemo(() => [...selectedUris], [selectedUris]);
  const outputUris = useMemo(() => vikingUrisFromText(output), [output]);

  async function refreshAll(): Promise<void> {
    const [nextState, nextTree, nextShares] = await Promise.all([
      api<StateResponse>('/api/state'),
      api<{tree: TreeNode}>('/api/tree'),
      api<{shares: readonly ShareSummary[]}>('/api/shares'),
    ]);
    setState(nextState);
    setTree(nextTree.tree);
    setShares(nextShares.shares);
    toastMessage('Refreshed');
  }

  async function loadMemory(uri: string): Promise<void> {
    const next = await api<MemoryResponse>(`/api/memory?uri=${encodeURIComponent(uri)}`);
    showMemory(next);
  }

  function showMemory(next: MemoryResponse): void {
    setMemory(next);
    setContent(next.content);
    setMemoryViewMode(isMarkdownNode(next.node) ? 'preview' : 'edit');
    setTarget({
      kind: next.record?.metadata.kind ?? 'durable',
      project: next.record?.metadata.project ?? '',
      status: next.record?.metadata.status ?? 'active',
      team: next.node.sharedTeam ?? '',
      topic: next.record?.metadata.topic ?? '',
    });
  }

  async function readContext(uri: string): Promise<void> {
    const trimmed = uri.trim();
    if (!trimmed) {
      toastMessage('Provide a viking URI');
      return;
    }
    try {
      const result = await api<ReadResponse>('/api/read', {uri: trimmed});
      setOutput(result.output || result.content);
      setReadUri(trimmed);
      if (result.localMemory) {
        setSelectedUri(result.localMemory.node.uri);
        showMemory(result.localMemory);
      }
      toastMessage('Read complete');
    } catch (err) {
      toastMessage(errorMessage(err));
    }
  }

  function toastMessage(message: string): void {
    setToast(message);
    window.setTimeout(() => setToast(current => (current === message ? '' : current)), 3000);
  }

  async function runAction(label: string, action: () => Promise<{readonly output?: string}>): Promise<void> {
    try {
      const result = await action();
      if (result.output) {
        setOutput(result.output);
      }
      toastMessage(label);
      await refreshTreeOnly();
      if (selectedUri) {
        await loadMemory(selectedUri).catch(() => undefined);
      }
    } catch (err) {
      toastMessage(errorMessage(err));
    }
  }

  async function runDoctorAction(label: string, action: () => Promise<{readonly output?: string}>): Promise<void> {
    try {
      const result = await action();
      setDoctorOutput(result.output ?? '');
      toastMessage(label);
      await loadDoctor();
    } catch (err) {
      toastMessage(errorMessage(err));
    }
  }

  async function refreshTreeOnly(): Promise<void> {
    const next = await api<{tree: TreeNode}>('/api/tree');
    setTree(next.tree);
  }

  async function saveCurrent(): Promise<void> {
    await runAction('Saved memory', () =>
      api('/api/memory/save', {
        kind: target.kind,
        project: target.project,
        replaceUri: memory?.node.uri,
        status: target.status,
        text: content,
        topic: target.topic,
      }),
    );
  }

  async function newMemory(): Promise<void> {
    setSelectedUri(undefined);
    setMemory(undefined);
    setContent('');
    setMemoryViewMode('edit');
    setTarget({kind: 'durable', project: '', status: 'active', team: '', topic: ''});
    toastMessage('New memory draft');
  }

  async function saveNew(): Promise<void> {
    await runAction('Stored memory', () =>
      api('/api/memory/save', {
        kind: target.kind,
        project: target.project,
        status: target.status,
        text: content,
        topic: target.topic,
      }),
    );
  }

  async function archiveCurrent(): Promise<void> {
    if (!selectedUri || !window.confirm(`Archive ${selectedUri}?`)) {
      return;
    }
    await runAction('Archived memory', () => api('/api/memory/archive', {confirm: true, uri: selectedUri}));
  }

  async function forgetCurrent(): Promise<void> {
    if (!selectedUri || !window.confirm(`Forget ${selectedUri}? This removes it from local context.`)) {
      return;
    }
    await runAction('Forgot memory', () => api('/api/memory/forget', {confirm: true, uri: selectedUri}));
    setSelectedUri(undefined);
  }

  async function removeFolderCurrent(): Promise<void> {
    if (!selectedNode?.isDir) {
      return;
    }
    if (!selectedNode.relativePath) {
      toastMessage('The root memories folder cannot be removed');
      return;
    }
    if (selectedNode.isShared) {
      toastMessage('Use Sharing to remove shared folders');
      return;
    }
    const fileCount = countFiles(selectedNode);
    if (
      !window.confirm(
        `Remove folder ${selectedNode.uri} and ${fileCount} file${fileCount === 1 ? '' : 's'}? This cannot be undone.`,
      )
    ) {
      return;
    }
    try {
      const result = await api<{readonly output?: string}>('/api/folder/remove', {
        confirm: true,
        uri: selectedNode.uri,
      });
      if (result.output) {
        setOutput(result.output);
      }
      setSelectedUri(undefined);
      setSelectedUris(new Set());
      setMemory(undefined);
      setContent('');
      await refreshTreeOnly();
      toastMessage('Removed folder');
    } catch (err) {
      toastMessage(errorMessage(err));
    }
  }

  async function publishCurrent(): Promise<void> {
    if (!selectedUri) {
      return;
    }
    const team = window.prompt('Team name', target.team || 'default') ?? '';
    if (!team) {
      return;
    }
    await runAction('Published memory', () => api('/api/memory/publish', {confirm: true, team, uri: selectedUri}));
  }

  async function unpublishCurrent(): Promise<void> {
    if (!selectedUri || !window.confirm(`Unpublish ${selectedUri}?`)) {
      return;
    }
    await runAction('Unpublished memory', () =>
      api('/api/memory/unpublish', {confirm: true, team: target.team, uri: selectedUri}),
    );
  }

  async function moveCurrent(): Promise<void> {
    if (!selectedUri) {
      return;
    }
    const project = window.prompt('Project', target.project) ?? '';
    const topic = window.prompt('Topic', target.topic) ?? '';
    const team = window.prompt('Team for shared target, or blank for personal', target.team) ?? '';
    if (!project || !topic || !window.confirm(`Move ${selectedUri}?`)) {
      return;
    }
    await runAction('Moved memory', () =>
      api('/api/memory/move', {
        confirm: true,
        kind: target.kind,
        project,
        status: target.status,
        team,
        topic,
        uri: selectedUri,
      }),
    );
  }

  async function bulk(action: 'archive' | 'forget' | 'publish'): Promise<void> {
    if (selectedList.length === 0 || !window.confirm(`${action} ${selectedList.length} selected memories?`)) {
      return;
    }
    const team = action === 'publish' ? (window.prompt('Team name', 'default') ?? '') : undefined;
    await runAction('Bulk action complete', () => api('/api/bulk', {action, confirm: true, team, uris: selectedList}));
  }

  async function loadShares(): Promise<void> {
    const next = await api<{shares: readonly ShareSummary[]}>('/api/shares');
    setShares(next.shares);
    toastMessage('Shares refreshed');
  }

  async function loadDoctor(): Promise<void> {
    const next = await api<{checks: readonly DoctorCheck[]; shares: readonly ShareSummary[]}>('/api/doctor');
    setDoctor(next.checks);
    setShares(next.shares);
    toastMessage('Doctor complete');
  }

  async function draftConsolidation(): Promise<void> {
    if (draftingConsolidation || applyingConsolidation) {
      return;
    }
    const uris = selectedList.length > 0 ? selectedList : selectedUri ? [selectedUri] : [];
    if (uris.length < 2) {
      toastMessage('Select at least two memories');
      return;
    }
    setDraftingConsolidation(true);
    setJobId(undefined);
    setDraft('');
    setConsolidationSourceUris(uris);
    try {
      const result = await api<{job: ConsolidationJob}>('/api/consolidations', {
        agent,
        kind: target.kind,
        project: target.project,
        status: target.status,
        topic: target.topic,
        uris,
      });
      if (result.job.status === 'completed') {
        setJobId(result.job.id);
        setDraft(result.job.draft ?? '');
        setConsolidationSourceUris(result.job.sourceUris);
        toastMessage('Draft ready');
      } else {
        setConsolidationSourceUris([]);
        setDraft(result.job.error ?? 'Draft failed');
        toastMessage('Draft failed');
      }
    } catch (err) {
      setConsolidationSourceUris([]);
      setDraft(errorMessage(err));
      toastMessage(errorMessage(err));
    } finally {
      setDraftingConsolidation(false);
    }
  }

  async function applyConsolidation(): Promise<void> {
    if (
      draftingConsolidation ||
      applyingConsolidation ||
      !jobId ||
      !draft ||
      !window.confirm('Apply this consolidation and archive personal sources?')
    ) {
      return;
    }
    const sourceUris = consolidationSourceUris;
    const currentSelectedUri = selectedUri;
    setApplyingConsolidation(true);
    try {
      const result = await api<{readonly output?: string}>(`/api/consolidations/${jobId}/apply`, {
        cleanup: 'archive',
        confirm: true,
        draft,
        kind: target.kind,
        project: target.project,
        status: target.status,
        topic: target.topic,
      });
      if (result.output) {
        setOutput(result.output);
      }
      setDraft('');
      setJobId(undefined);
      setConsolidationSourceUris([]);
      setSelectedUris(new Set());
      if (currentSelectedUri && sourceUris.includes(currentSelectedUri)) {
        setSelectedUri(undefined);
        setMemory(undefined);
        setContent('');
        setMemoryViewMode('edit');
      } else if (currentSelectedUri) {
        await loadMemory(currentSelectedUri).catch(() => undefined);
      }
      await refreshTreeOnly();
      toastMessage('Applied consolidation');
    } catch (err) {
      toastMessage(errorMessage(err));
    } finally {
      setApplyingConsolidation(false);
    }
  }

  function selectTreeUri(uri: string): void {
    setSelectedUri(uri);
    setPanel('memory');
  }

  function updateSidebarWidth(width: number): void {
    const next = clampSidebarWidth(width);
    setSidebarWidth(next);
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
  }

  function startSidebarResize(event: React.PointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const pointerId = event.pointerId;
    const handle = event.currentTarget;
    handle.setPointerCapture(pointerId);
    document.body.classList.add('is-resizing-sidebar');

    const onPointerMove = (moveEvent: PointerEvent) => {
      updateSidebarWidth(startWidth + moveEvent.clientX - startX);
    };
    const stopResize = () => {
      if (handle.hasPointerCapture(pointerId)) {
        handle.releasePointerCapture(pointerId);
      }
      document.body.classList.remove('is-resizing-sidebar');
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('pointercancel', stopResize);
  }

  function resizeSidebarWithKeyboard(event: React.KeyboardEvent<HTMLDivElement>): void {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      updateSidebarWidth(sidebarWidth - step);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      updateSidebarWidth(sidebarWidth + step);
    } else if (event.key === 'Home') {
      event.preventDefault();
      updateSidebarWidth(SIDEBAR_WIDTH_MIN);
    } else if (event.key === 'End') {
      event.preventDefault();
      updateSidebarWidth(SIDEBAR_WIDTH_MAX);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      updateSidebarWidth(SIDEBAR_WIDTH_DEFAULT);
    }
  }

  const selectedIsDir = selectedNode?.isDir === true;
  const selectedIsMarkdown = Boolean(selectedNode && isMarkdownNode(selectedNode));
  const markdownPreview = markdownBodyForPreview(content);
  const canMutate = Boolean(selectedUri && !selectedIsDir);
  const canRemoveFolder = Boolean(selectedNode?.isDir && selectedNode.relativePath && !selectedNode.isShared);
  const consolidationBusy = draftingConsolidation || applyingConsolidation;
  const appStyle = {'--sidebar-width': `${sidebarWidth}px`} as React.CSSProperties;

  return (
    <div className="app" style={appStyle}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-title">
            <img alt="" className="brand-logo" src="/threadnote-logo.svg" />
            <div>
              <h1>Threadnote</h1>
              <p>{state ? `${state.config.user} · ${state.config.account} · v${state.version}` : 'Loading manager'}</p>
            </div>
          </div>
          <button className="icon-button" onClick={() => void refreshAll()} title="Refresh" aria-label="Refresh">
            ↻
          </button>
        </div>
        <input
          value={filter}
          onChange={event => setFilter(event.target.value)}
          placeholder="Filter memories"
          type="search"
        />
        <label className="check-row">
          <input checked={showSystem} onChange={event => setShowSystem(event.target.checked)} type="checkbox" />
          <span>Show system files</span>
        </label>
        <nav className="tree" aria-label="Memory tree">
          {tree ? (
            <Tree
              filter={filter}
              node={tree}
              onSelect={selectTreeUri}
              onToggleSelection={(uri, checked) =>
                setSelectedUris(current => {
                  const next = new Set(current);
                  if (checked) {
                    next.add(uri);
                  } else {
                    next.delete(uri);
                  }
                  return next;
                })
              }
              selectedUri={selectedUri}
              selectedUris={selectedUris}
              showSystem={showSystem}
            />
          ) : null}
        </nav>
      </aside>
      <div
        aria-label="Resize navigation panel"
        aria-orientation="vertical"
        aria-valuemax={SIDEBAR_WIDTH_MAX}
        aria-valuemin={SIDEBAR_WIDTH_MIN}
        aria-valuenow={sidebarWidth}
        className="sidebar-resizer"
        onKeyDown={resizeSidebarWithKeyboard}
        onPointerDown={startSidebarResize}
        role="separator"
        tabIndex={0}
        title="Drag to resize navigation"
      />

      <main className="main">
        <header className="topbar">
          <div className="tabs">
            {(['memory', 'shares', 'doctor', 'tools'] as const).map(name => (
              <button className={`tab ${panel === name ? 'is-active' : ''}`} key={name} onClick={() => setPanel(name)}>
                {tabTitle(name)}
              </button>
            ))}
          </div>
          {selectedList.length > 0 ? (
            <div className="selection-bar">
              <span>{selectedList.length} selected</span>
              <button onClick={() => void bulk('archive')}>Archive</button>
              <button onClick={() => void bulk('publish')}>Publish</button>
              <button className="danger" onClick={() => void bulk('forget')}>
                Forget
              </button>
            </div>
          ) : null}
        </header>

        {panel === 'memory' ? (
          <section className="panel is-active">
            <div className="content-grid">
              <section className="editor-pane">
                <div className="pane-head">
                  <div>
                    <h2>{selectedNode?.name ?? 'New memory'}</h2>
                    <p className="uri-line">{selectedUri ?? 'No URI until saved'}</p>
                  </div>
                  <div className="action-row">
                    <div className="segmented-control" aria-label="Memory view mode">
                      <button
                        className={memoryViewMode === 'preview' ? 'is-active' : undefined}
                        disabled={!selectedIsMarkdown || selectedIsDir}
                        onClick={() => setMemoryViewMode('preview')}
                      >
                        Preview
                      </button>
                      <button
                        className={memoryViewMode === 'edit' ? 'is-active' : undefined}
                        disabled={selectedIsDir}
                        onClick={() => setMemoryViewMode('edit')}
                      >
                        Edit
                      </button>
                    </div>
                    <button onClick={() => void newMemory()}>New</button>
                    <button disabled={selectedIsDir} onClick={() => void (memory ? saveCurrent() : saveNew())}>
                      Save
                    </button>
                    <button disabled={!canMutate} onClick={() => void archiveCurrent()}>
                      Archive
                    </button>
                    <button
                      disabled={!canMutate || selectedNode?.isShared === true}
                      onClick={() => void publishCurrent()}
                    >
                      Publish
                    </button>
                    <button
                      disabled={!canMutate || selectedNode?.isShared !== true}
                      onClick={() => void unpublishCurrent()}
                    >
                      Unpublish
                    </button>
                    <button disabled={!canMutate} onClick={() => void moveCurrent()}>
                      Move
                    </button>
                    <button
                      className="danger"
                      disabled={!canRemoveFolder}
                      onClick={() => void removeFolderCurrent()}
                      title={selectedNode?.isShared ? 'Use Sharing to remove shared folders' : undefined}
                    >
                      Remove Folder
                    </button>
                    <button className="danger" disabled={!canMutate} onClick={() => void forgetCurrent()}>
                      Forget
                    </button>
                  </div>
                </div>
                {memoryViewMode === 'preview' && selectedIsMarkdown && !selectedIsDir ? (
                  <MarkdownViewer markdown={markdownPreview} />
                ) : (
                  <textarea
                    disabled={selectedIsDir}
                    onChange={event => setContent(event.target.value)}
                    placeholder={selectedIsDir ? 'Folder selected' : 'Memory content'}
                    spellCheck={false}
                    value={content}
                  />
                )}
              </section>

              <aside className="inspector">
                <h3>Metadata</h3>
                <TargetFields
                  onChange={setTarget}
                  openSelect={openSelect}
                  setOpenSelect={setOpenSelect}
                  target={target}
                />
                <Metadata metadata={memory?.record?.metadata} node={memory?.node ?? selectedNode} />
                <h3>Consolidate</h3>
                <div className="field-row select-row">
                  <DropdownSelect
                    id="agent"
                    label="Agent"
                    onChange={value => setAgent(value as AgentClient)}
                    openSelect={openSelect}
                    options={(state?.agents ?? []).map(item => ({
                      disabled: !item.available || (item.id !== 'codex' && item.id !== 'claude'),
                      label: `${item.label}${item.available ? '' : ' unavailable'}`,
                      value: item.id,
                    }))}
                    setOpenSelect={setOpenSelect}
                    value={agent}
                  />
                  <button disabled={consolidationBusy} onClick={() => void draftConsolidation()}>
                    {draftingConsolidation ? 'Drafting...' : 'Draft'}
                  </button>
                </div>
                <textarea
                  aria-busy={consolidationBusy}
                  placeholder={draftingConsolidation ? 'Generating draft...' : 'Draft preview'}
                  readOnly={consolidationBusy}
                  value={draft}
                  onChange={event => setDraft(event.target.value)}
                  spellCheck={false}
                />
                <button disabled={consolidationBusy || !jobId || !draft} onClick={() => void applyConsolidation()}>
                  {applyingConsolidation ? 'Applying...' : 'Apply draft'}
                </button>
              </aside>
            </div>
          </section>
        ) : null}

        {panel === 'shares' ? (
          <SharesPanel
            createShare={() =>
              runAction('Created share', () =>
                api('/api/shares/init', {confirm: true, remoteUrl: shareRemote, team: shareTeam}),
              ).then(loadShares)
            }
            keepShareFiles={keepShareFiles}
            loadShares={loadShares}
            preserveShare={preserveShare}
            removeShare={() =>
              window.confirm(`Remove share ${selectedShare}?`)
                ? runAction('Removed share', () =>
                    api('/api/shares/remove', {
                      confirm: true,
                      keepFiles: keepShareFiles,
                      preserveLocal: preserveShare,
                      team: selectedShare,
                    }),
                  ).then(loadShares)
                : undefined
            }
            renameShare={() =>
              runAction('Renamed share', () =>
                api('/api/shares/rename', {confirm: true, team: selectedShare, to: renameShareTo}),
              ).then(loadShares)
            }
            renameShareTo={renameShareTo}
            selectedShare={selectedShare}
            setKeepShareFiles={setKeepShareFiles}
            setPreserveShare={setPreserveShare}
            setRenameShareTo={setRenameShareTo}
            setSelectedShare={setSelectedShare}
            setShareNewUrl={setShareNewUrl}
            setShareRemote={setShareRemote}
            setShareTeam={setShareTeam}
            shareNewUrl={shareNewUrl}
            shareRemote={shareRemote}
            shares={shares}
            shareTeam={shareTeam}
            setShareUrl={() =>
              runAction('Updated share URL', () =>
                api('/api/shares/set-url', {confirm: true, remoteUrl: shareNewUrl, team: selectedShare}),
              ).then(loadShares)
            }
            syncShare={() =>
              runAction('Synced share', () => api('/api/shares/sync', {team: selectedShare})).then(loadShares)
            }
          />
        ) : null}

        {panel === 'doctor' ? (
          <section className="panel is-active">
            <div className="pane-head">
              <h2>Health and Doctor</h2>
              <div className="action-row">
                <button onClick={() => void loadDoctor()}>Run Doctor</button>
                <button onClick={() => void runDoctorAction('Started OpenViking', () => api('/api/doctor/start', {}))}>
                  Start OpenViking
                </button>
                <button
                  onClick={() =>
                    void runDoctorAction('Repair dry run complete', () => api('/api/doctor/repair-dry-run', {}))
                  }
                >
                  Repair Dry Run
                </button>
                <button
                  onClick={() =>
                    window.confirm('Run Threadnote repair and write changes?')
                      ? void runDoctorAction('Repair complete', () => api('/api/doctor/repair', {confirm: true}))
                      : undefined
                  }
                >
                  Repair
                </button>
              </div>
            </div>
            {doctorOutput ? <pre className="output doctor-output">{doctorOutput}</pre> : null}
            <div className="checks">
              {doctor.map(check => (
                <div className="check-item" key={check.name}>
                  <span className={`badge ${check.status}`}>{check.status.toUpperCase()}</span>
                  <strong>{check.name}</strong>
                  <p>{check.detail}</p>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {panel === 'tools' ? (
          <section className="panel is-active">
            <div className="split">
              <section>
                <h2>Recall</h2>
                <div className="field-row">
                  <input
                    value={recallQuery}
                    onChange={event => setRecallQuery(event.target.value)}
                    placeholder="Search memories and seeded resources"
                  />
                  <button
                    onClick={() =>
                      void runAction('Recall complete', () =>
                        api('/api/recall', {query: recallQuery}).then(result => result as {output: string}),
                      )
                    }
                  >
                    Search
                  </button>
                </div>
                <h3>Read URI</h3>
                <div className="field-row">
                  <input
                    value={readUri}
                    onChange={event => setReadUri(event.target.value)}
                    placeholder="viking://..."
                  />
                  <button disabled={!readUri.trim()} onClick={() => void readContext(readUri)}>
                    Read
                  </button>
                </div>
                {outputUris.length > 0 ? (
                  <div className="uri-list">
                    <h3>URIs in Output</h3>
                    {outputUris.map(uri => (
                      <button className="uri-button" key={uri} onClick={() => void readContext(uri)} title={uri}>
                        {uri}
                      </button>
                    ))}
                  </div>
                ) : null}
                <pre className="output">{output}</pre>
              </section>
              <aside className="form-pane">
                <section className="form-section">
                  <h3>Hygiene</h3>
                  <input
                    value={compactProject}
                    onChange={event => setCompactProject(event.target.value)}
                    placeholder="project"
                  />
                  <input
                    value={compactTopic}
                    onChange={event => setCompactTopic(event.target.value)}
                    placeholder="topic"
                  />
                  <div className="button-row">
                    <button
                      onClick={() =>
                        void runAction('Compact dry run complete', () =>
                          api('/api/compact', {project: compactProject, topic: compactTopic}).then(
                            result => result as {output: string},
                          ),
                        )
                      }
                    >
                      Dry Run
                    </button>
                    <button
                      onClick={() =>
                        window.confirm('Apply compact plan?')
                          ? void runAction('Compact applied', () =>
                              api('/api/compact', {
                                apply: true,
                                confirm: true,
                                project: compactProject,
                                topic: compactTopic,
                              }).then(result => result as {output: string}),
                            )
                          : undefined
                      }
                    >
                      Apply
                    </button>
                  </div>
                </section>
                <section className="form-section">
                  <h3>Import / Export</h3>
                  <input
                    value={packPath}
                    onChange={event => setPackPath(event.target.value)}
                    placeholder=".ovpack path"
                  />
                  <div className="button-row">
                    <button
                      onClick={() => void runAction('Export complete', () => api('/api/export-pack', {path: packPath}))}
                    >
                      Export
                    </button>
                    <button
                      onClick={() =>
                        window.confirm(`Import ${packPath}?`)
                          ? void runAction('Import complete', () =>
                              api('/api/import-pack', {confirm: true, path: packPath}),
                            )
                          : undefined
                      }
                    >
                      Import
                    </button>
                  </div>
                </section>
                <section className="form-section">
                  <h3>Seed</h3>
                  <div className="button-row">
                    <button
                      onClick={() =>
                        void runAction('Seed dry run complete', () => api('/api/seed', {confirm: true, dryRun: true}))
                      }
                    >
                      Seed Dry Run
                    </button>
                    <button
                      onClick={() =>
                        void runAction('Seed skills dry run complete', () =>
                          api('/api/seed', {confirm: true, dryRun: true, skills: true}),
                        )
                      }
                    >
                      Seed Skills Dry Run
                    </button>
                  </div>
                </section>
              </aside>
            </div>
          </section>
        ) : null}
      </main>
      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}

function Tree(props: {
  readonly filter: string;
  readonly node: TreeNode;
  readonly onSelect: (uri: string) => void;
  readonly onToggleSelection: (uri: string, checked: boolean) => void;
  readonly selectedUri?: string;
  readonly selectedUris: ReadonlySet<string>;
  readonly showSystem: boolean;
}): React.ReactElement | null {
  if (!props.showSystem && props.node.isSystem) {
    return null;
  }
  if (props.filter && !nodeMatches(props.node, props.filter)) {
    return null;
  }
  if (props.node.isDir) {
    return (
      <details open={props.node.relativePath.split('/').length < 3}>
        <summary
          className={props.selectedUri === props.node.uri ? 'is-active' : undefined}
          onClick={() => props.onSelect(props.node.uri)}
          title={props.node.uri}
        >
          <span aria-hidden="true" className="tree-caret" />
          <span className="tree-name">{props.node.name}</span>
        </summary>
        <div className="tree-children">
          {(props.node.children ?? []).map(child => (
            <Tree {...props} key={child.uri} node={child} />
          ))}
        </div>
      </details>
    );
  }
  return (
    <div className={`tree-row ${props.selectedUri === props.node.uri ? 'is-active' : ''}`}>
      <input
        checked={props.selectedUris.has(props.node.uri)}
        onChange={event => props.onToggleSelection(props.node.uri, event.target.checked)}
        type="checkbox"
      />
      <button className="tree-file" onClick={() => props.onSelect(props.node.uri)} title={props.node.uri}>
        <span className="tree-name">{props.node.name}</span>
      </button>
    </div>
  );
}

function Metadata(props: {readonly metadata?: MemoryMetadata; readonly node?: TreeNode}): React.ReactElement {
  const rows: Array<[string, string | undefined]> = [
    ['kind', props.metadata?.kind],
    ['status', props.metadata?.status],
    ['project', props.metadata?.project],
    ['topic', props.metadata?.topic],
    ['source', props.metadata?.sourceAgentClient],
    ['timestamp', props.metadata?.timestamp],
    ['team', props.node?.sharedTeam],
    ['size', props.node?.size === undefined ? undefined : `${props.node.size} bytes`],
  ].filter((row): row is [string, string] => typeof row[1] === 'string' && row[1].length > 0);
  return (
    <dl>
      {rows.map(([label, value]) => (
        <React.Fragment key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

function MarkdownViewer(props: {readonly markdown: string}): React.ReactElement {
  return (
    <article className="markdown-viewer">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{props.markdown || '_No content_'}</ReactMarkdown>
    </article>
  );
}

function TargetFields(props: {
  readonly onChange: (value: TargetForm) => void;
  readonly openSelect?: SelectId;
  readonly setOpenSelect: (value: SelectId | undefined) => void;
  readonly target: TargetForm;
}): React.ReactElement {
  const set = (patch: Partial<TargetForm>) => props.onChange({...props.target, ...patch});
  return (
    <div className="target-fields">
      <DropdownSelect
        id="kind"
        label="Kind"
        onChange={value => set({kind: value as MemoryKind})}
        openSelect={props.openSelect}
        options={(['durable', 'handoff', 'incident', 'preference', 'smoke'] as const).map(kind => ({
          label: kind,
          value: kind,
        }))}
        setOpenSelect={props.setOpenSelect}
        value={props.target.kind}
      />
      <DropdownSelect
        id="status"
        label="Status"
        onChange={value => set({status: value as MemoryStatus})}
        openSelect={props.openSelect}
        options={(['active', 'archived', 'superseded'] as const).map(status => ({
          label: status,
          value: status,
        }))}
        setOpenSelect={props.setOpenSelect}
        value={props.target.status}
      />
      <input
        value={props.target.project}
        onChange={event => set({project: event.target.value})}
        placeholder="project"
      />
      <input value={props.target.topic} onChange={event => set({topic: event.target.value})} placeholder="topic" />
    </div>
  );
}

function DropdownSelect(props: {
  readonly id: SelectId;
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly openSelect?: SelectId;
  readonly options: readonly DropdownOption[];
  readonly setOpenSelect: (value: SelectId | undefined) => void;
  readonly value: string;
}): React.ReactElement {
  const isOpen = props.openSelect === props.id;
  const selected = props.options.find(option => option.value === props.value);
  return (
    <div
      className="select-field"
      onBlur={event => {
        const relatedTarget = event.relatedTarget;
        if (!(relatedTarget instanceof Node) || !event.currentTarget.contains(relatedTarget)) {
          props.setOpenSelect(undefined);
        }
      }}
    >
      <button
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        className="select-button"
        onClick={() => props.setOpenSelect(isOpen ? undefined : props.id)}
        type="button"
      >
        <span>{selected?.label ?? props.value}</span>
        <span aria-hidden="true" className="select-chevron" />
      </button>
      {isOpen ? (
        <div aria-label={props.label} className="select-menu" role="listbox">
          {props.options.map(option => (
            <button
              aria-selected={option.value === props.value}
              className={`select-option ${option.value === props.value ? 'is-selected' : ''}`}
              disabled={option.disabled === true}
              key={option.value}
              onClick={() => {
                props.onChange(option.value);
                props.setOpenSelect(undefined);
              }}
              role="option"
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SharesPanel(props: {
  readonly createShare: () => void;
  readonly keepShareFiles: boolean;
  readonly loadShares: () => void;
  readonly preserveShare: boolean;
  readonly removeShare: () => void;
  readonly renameShare: () => void;
  readonly renameShareTo: string;
  readonly selectedShare: string;
  readonly setKeepShareFiles: (value: boolean) => void;
  readonly setPreserveShare: (value: boolean) => void;
  readonly setRenameShareTo: (value: string) => void;
  readonly setSelectedShare: (value: string) => void;
  readonly setShareNewUrl: (value: string) => void;
  readonly setShareRemote: (value: string) => void;
  readonly setShareTeam: (value: string) => void;
  readonly setShareUrl: () => void;
  readonly shareNewUrl: string;
  readonly shareRemote: string;
  readonly shares: readonly ShareSummary[];
  readonly shareTeam: string;
  readonly syncShare: () => void;
}): React.ReactElement {
  return (
    <section className="panel is-active">
      <div className="split">
        <section>
          <div className="pane-head">
            <h2>Team Shares</h2>
            <button onClick={props.loadShares}>Refresh</button>
          </div>
          <div className="list">
            {props.shares.map(share => (
              <button
                className={`list-item ${props.selectedShare === share.name ? 'is-selected' : ''}`}
                key={share.name}
                onClick={() => props.setSelectedShare(share.name)}
              >
                <strong>
                  {share.name}
                  {share.default ? ' · default' : ''}
                </strong>
                <span className={`badge ${share.dirty ? 'warn' : 'ok'}`}>{share.dirty ? 'dirty' : 'clean'}</span>
                {share.behind ? <span className="badge warn">behind {share.behind}</span> : null}
                {share.ahead ? <span className="badge warn">ahead {share.ahead}</span> : null}
                <p>{share.remote}</p>
                <p className="muted">{share.worktree}</p>
                {share.warning ? <p className="danger-text">{share.warning}</p> : null}
              </button>
            ))}
          </div>
        </section>
        <aside className="form-pane">
          <h3>Create Share</h3>
          <input
            value={props.shareTeam}
            onChange={event => props.setShareTeam(event.target.value)}
            placeholder="team name"
          />
          <input
            value={props.shareRemote}
            onChange={event => props.setShareRemote(event.target.value)}
            placeholder="git remote URL"
          />
          <button onClick={props.createShare}>Create</button>
          <h3>Selected Share</h3>
          <input
            value={props.selectedShare}
            onChange={event => props.setSelectedShare(event.target.value)}
            placeholder="team"
          />
          <input
            value={props.renameShareTo}
            onChange={event => props.setRenameShareTo(event.target.value)}
            placeholder="new team name"
          />
          <button onClick={props.renameShare}>Rename</button>
          <input
            value={props.shareNewUrl}
            onChange={event => props.setShareNewUrl(event.target.value)}
            placeholder="new git remote URL"
          />
          <button onClick={props.setShareUrl}>Set URL</button>
          <label className="check-row">
            <input
              checked={props.preserveShare}
              onChange={event => props.setPreserveShare(event.target.checked)}
              type="checkbox"
            />
            <span>Preserve local copies</span>
          </label>
          <label className="check-row">
            <input
              checked={props.keepShareFiles}
              onChange={event => props.setKeepShareFiles(event.target.checked)}
              type="checkbox"
            />
            <span>Keep files</span>
          </label>
          <button onClick={props.syncShare}>Sync</button>
          <button className="danger" onClick={props.removeShare}>
            Remove
          </button>
        </aside>
      </div>
    </section>
  );
}

async function api<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(path, {
    body: body ? JSON.stringify(body) : undefined,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    method: body ? 'POST' : 'GET',
  });
  const data = (await response.json()) as {readonly error?: string};
  if (!response.ok) {
    throw new Error(data.error ?? `HTTP ${response.status}`);
  }
  return data as T;
}

function findNode(node: TreeNode, uri: string): TreeNode | undefined {
  if (node.uri === uri) {
    return node;
  }
  for (const child of node.children ?? []) {
    const found = findNode(child, uri);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function countFiles(node: TreeNode): number {
  if (!node.isDir) {
    return 1;
  }
  return (node.children ?? []).reduce((total, child) => total + countFiles(child), 0);
}

function isMarkdownNode(node: TreeNode): boolean {
  return !node.isDir && node.name.toLowerCase().endsWith('.md');
}

function markdownBodyForPreview(content: string): string {
  if (!content.startsWith('MEMORY\n') && !content.startsWith('HANDOFF\n')) {
    return content;
  }
  const separatorIndex = content.indexOf('\n\n');
  return separatorIndex === -1 ? '' : content.slice(separatorIndex + 2).trimStart();
}

function nodeMatches(node: TreeNode, filter: string): boolean {
  const needle = filter.toLowerCase();
  if (node.name.toLowerCase().includes(needle) || node.uri.toLowerCase().includes(needle)) {
    return true;
  }
  return (node.children ?? []).some(child => nodeMatches(child, filter));
}

function vikingUrisFromText(text: string): readonly string[] {
  const matches = text.match(/viking:\/\/[^\s)"'<>`\]]+/g) ?? [];
  return [...new Set(matches.map(uri => uri.replace(/[.,;:]+$/, '')))];
}

function tabTitle(name: PanelName): string {
  switch (name) {
    case 'doctor':
      return 'Health';
    case 'memory':
      return 'Memory';
    case 'shares':
      return 'Sharing';
    case 'tools':
      return 'Tools';
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing #root');
}
createRoot(root).render(<App />);
