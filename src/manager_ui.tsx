import React, {useEffect, useMemo, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {CodeGraphLocalDiagnosticsReport} from './code_graph/diagnostics.js';
import {ManagerAutocompleteInput, ManagerDialogProvider, useManagerDialogs} from './manager_dialog.js';
import {graphViewRemovalApprovalDialog, type ManagerGraphViewRemovalResponse} from './manager_graph_removal.js';
import {
  GraphWorkspace,
  graphBuildIsActive,
  graphCompletedBuildResultIdentity,
  graphMaintenanceStatusLabel,
  graphStatusPollDelay,
  graphStatusRequiresCatalogRefresh,
  type GraphAnalysis,
  type GraphAdministrationAction,
  type GraphCatalog,
  type GraphCatalogPage,
  type GraphNodeDetail,
  type GraphQueryVisualization,
  type GraphVisualization,
  type GraphViewPage,
} from './manager_graph.js';
import type {ManagerGraphVisualizationLimits} from './manager_graph_limits.js';

type PanelName = 'doctor' | 'graph' | 'memory' | 'shares' | 'tools';
type NavTreeTab = 'memories' | 'resources';
type CheckStatus = 'fail' | 'ok' | 'warn';
type MemoryKind = 'durable' | 'handoff' | 'incident' | 'preference' | 'smoke';
type MemoryStatus = 'active' | 'archived' | 'superseded';
type AgentClient = 'claude' | 'codex' | 'copilot' | 'cursor' | 'effect-ai';
type MemoryViewMode = 'edit' | 'preview';
type SelectId = 'agent' | 'kind' | 'status';

const SIDEBAR_WIDTH_KEY = 'threadnote.manager.sidebarWidth';
const SIDEBAR_WIDTH_DEFAULT = 300;
const SIDEBAR_WIDTH_MIN = 260;
const SIDEBAR_WIDTH_MAX = 440;

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

export interface TreeNode {
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

interface TreeResponse {
  readonly resourcesTree: TreeNode;
  readonly tree: TreeNode;
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

interface BulkItemResult {
  readonly error?: string;
  readonly ok: boolean;
  readonly output?: string;
  readonly uri: string;
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

const token = typeof window === 'undefined' ? '' : (new URLSearchParams(window.location.search).get('token') ?? '');
const EMPTY_SELECTED_URIS: ReadonlySet<string> = new Set();
const GRAPH_CATALOG_REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const GRAPH_DETAIL_REQUEST_TIMEOUT_MILLISECONDS = 30_000;

function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(width)));
}

function loadSidebarWidth(): number {
  const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(stored) && stored > 0 ? clampSidebarWidth(stored) : SIDEBAR_WIDTH_DEFAULT;
}

function App(): React.ReactElement {
  const dialogs = useManagerDialogs();
  const [panel, setPanel] = useState<PanelName>('graph');
  const [state, setState] = useState<StateResponse | undefined>();
  const [graphCatalog, setGraphCatalog] = useState<GraphCatalog | undefined>();
  const [graphCatalogError, setGraphCatalogError] = useState('');
  const graphCatalogRef = useRef<GraphCatalog | undefined>(undefined);
  const [graphDiagnostics, setGraphDiagnostics] = useState<CodeGraphLocalDiagnosticsReport | undefined>();
  const [graphAdministrationBusy, setGraphAdministrationBusy] = useState<string | undefined>();
  const [graphAdministrationOutput, setGraphAdministrationOutput] = useState('');
  const [tree, setTree] = useState<TreeNode | undefined>();
  const [resourceTree, setResourceTree] = useState<TreeNode | undefined>();
  const [shares, setShares] = useState<readonly ShareSummary[]>([]);
  const [doctor, setDoctor] = useState<readonly DoctorCheck[]>([]);
  const [doctorOutput, setDoctorOutput] = useState('');
  const [doctorAction, setDoctorAction] = useState<string | undefined>();
  const [selectedUri, setSelectedUri] = useState<string | undefined>();
  const [selectedUris, setSelectedUris] = useState<ReadonlySet<string>>(new Set());
  const [memory, setMemory] = useState<MemoryResponse | undefined>();
  const [content, setContent] = useState('');
  const [memoryViewMode, setMemoryViewMode] = useState<MemoryViewMode>('edit');
  const [openSelect, setOpenSelect] = useState<SelectId | undefined>();
  const [filter, setFilter] = useState('');
  const [showSystem, setShowSystem] = useState(false);
  const [navTreeTab, setNavTreeTab] = useState<NavTreeTab>('memories');
  const [toast, setToast] = useState('');
  const [output, setOutput] = useState('');
  const [recallQuery, setRecallQuery] = useState('');
  const [recallProject, setRecallProject] = useState('');
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
  const [bulkAction, setBulkAction] = useState<'archive' | 'forget' | 'publish' | undefined>();
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);

  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => {
    if (panel === 'doctor') {
      void loadDoctor(false);
    }
    if (panel === 'graph' && !graphDiagnostics) {
      void refreshGraphDiagnostics({analyze: false, deep: false}, false);
    }
  }, [panel]);

  useEffect(() => {
    if (panel !== 'graph') return;
    let cancelled = false;
    let timer: number | undefined;
    let observedActiveBuild = false;
    let observedActiveMaintenance = false;
    const acknowledgedCompletedResults = new Set<string>();
    const poll = async (): Promise<void> => {
      try {
        const status = await api<
          Pick<
            GraphCatalog,
            'builds' | 'catalogRevision' | 'lifecyclePending' | 'maintenance' | 'waiterCount' | 'waiters'
          >
        >('/api/graphs/status', undefined, {timeoutMilliseconds: GRAPH_CATALOG_REQUEST_TIMEOUT_MILLISECONDS});
        if (cancelled) return;
        const active = status.builds.some(graphBuildIsActive);
        const activeMaintenance = status.maintenance !== undefined;
        const refreshCatalog =
          !activeMaintenance &&
          ((observedActiveBuild && !active) ||
            (observedActiveMaintenance && !activeMaintenance) ||
            graphStatusRequiresCatalogRefresh(
              graphCatalogRef.current,
              status.builds,
              acknowledgedCompletedResults,
              status.catalogRevision,
            ));
        if (refreshCatalog) {
          const refreshed = await api<GraphCatalog>('/api/graphs', undefined, {
            timeoutMilliseconds: GRAPH_CATALOG_REQUEST_TIMEOUT_MILLISECONDS,
          });
          if (cancelled) return;
          graphCatalogRef.current = refreshed;
          setGraphCatalog(refreshed);
          setGraphCatalogError('');
          void refreshGraphDiagnostics({analyze: false, deep: false}, false, true);
          for (const build of status.builds) {
            const identity = graphCompletedBuildResultIdentity(build);
            if (identity) acknowledgedCompletedResults.add(identity);
          }
        } else if (graphCatalogRef.current) {
          const merged = {...graphCatalogRef.current, ...status};
          graphCatalogRef.current = merged;
          setGraphCatalog(merged);
        }
        observedActiveBuild = active;
        observedActiveMaintenance = activeMaintenance;
        timer = window.setTimeout(
          () => void poll(),
          graphStatusPollDelay(status.builds, status.maintenance, status.lifecyclePending),
        );
      } catch {
        if (!cancelled) timer = window.setTimeout(() => void poll(), 15_000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [panel]);

  useEffect(() => {
    setSelectedUris(current => pruneSelectedMemoryUris(current, tree, {filter, showSystem}));
  }, [filter, showSystem, tree]);

  useEffect(() => {
    if (!selectedUri) {
      setMemory(undefined);
      setContent('');
      setMemoryViewMode('edit');
      return;
    }
    const node = findNodeInTrees([tree, resourceTree], selectedUri);
    if (node?.isDir) {
      setMemory(undefined);
      setContent('');
      setMemoryViewMode('preview');
      setTarget({kind: 'durable', project: '', status: 'active', team: node.sharedTeam ?? '', topic: ''});
      return;
    }
    if (isResourceUri(selectedUri)) {
      void loadResource(selectedUri);
      return;
    }
    void loadMemory(selectedUri);
  }, [resourceTree, selectedUri, tree]);

  useEffect(() => {
    const firstAvailable =
      state?.agents.find(item => item.available && (item.id === 'codex' || item.id === 'claude')) ??
      state?.agents.find(item => item.available);
    if (firstAvailable) {
      setAgent(firstAvailable.id);
    }
  }, [state]);

  const selectedNode = useMemo(
    () => (selectedUri ? findNodeInTrees([tree, resourceTree], selectedUri) : undefined),
    [resourceTree, selectedUri, tree],
  );
  const visibleSelectedUris = useMemo(
    () =>
      navTreeTab === 'memories'
        ? pruneSelectedMemoryUris(selectedUris, tree, {filter, showSystem})
        : EMPTY_SELECTED_URIS,
    [filter, navTreeTab, selectedUris, showSystem, tree],
  );
  const selectedList = useMemo(() => [...visibleSelectedUris], [visibleSelectedUris]);
  const outputUris = useMemo(() => resourceUrisFromText(output), [output]);
  const projectOptions = useMemo(() => managerProjectOptions(tree), [tree]);
  const teamOptions = useMemo(
    () => uniqueSelectorValues(['default', ...shares.map(share => share.name), target.team]),
    [shares, target.team],
  );

  async function refreshAll(): Promise<void> {
    const graphRequest = api<GraphCatalog>('/api/graphs', undefined, {
      timeoutMilliseconds: GRAPH_CATALOG_REQUEST_TIMEOUT_MILLISECONDS,
    }).then(
      catalog => {
        graphCatalogRef.current = catalog;
        setGraphCatalog(catalog);
        setGraphCatalogError('');
      },
      cause => setGraphCatalogError(errorMessage(cause)),
    );
    const [nextState, nextTree, nextShares] = await Promise.all([
      api<StateResponse>('/api/state'),
      api<TreeResponse>('/api/tree'),
      api<{shares: readonly ShareSummary[]}>('/api/shares'),
    ]);
    setState(nextState);
    setTree(nextTree.tree);
    setResourceTree(nextTree.resourcesTree);
    setShares(nextShares.shares);
    await graphRequest;
    toastMessage('Refreshed');
  }

  async function refreshGraphCatalog(notify = true): Promise<void> {
    try {
      const next = await api<GraphCatalog>('/api/graphs', undefined, {
        timeoutMilliseconds: GRAPH_CATALOG_REQUEST_TIMEOUT_MILLISECONDS,
      });
      graphCatalogRef.current = next;
      setGraphCatalog(next);
      setGraphCatalogError('');
      if (notify) toastMessage('Graph indexes refreshed');
    } catch (cause) {
      const message = errorMessage(cause);
      setGraphCatalogError(message);
      toastMessage(message);
    }
  }

  async function refreshGraphDiagnostics(
    options: {readonly analyze: boolean; readonly deep: boolean},
    notify = true,
    background = false,
  ): Promise<void> {
    if (!background) {
      setGraphAdministrationBusy(
        options.deep ? 'Deep-checking graphs' : options.analyze ? 'Analyzing graphs' : 'Diagnosing graphs',
      );
    }
    try {
      const report = await api<CodeGraphLocalDiagnosticsReport>(
        `/api/graphs/diagnostics?analyze=${options.analyze}&deep=${options.deep}`,
      );
      setGraphDiagnostics(report);
      if (!background) setGraphAdministrationOutput('');
      if (notify) toastMessage('Graph diagnostics refreshed');
    } catch (cause) {
      if (background) return;
      const message = errorMessage(cause);
      setGraphAdministrationOutput(message);
      toastMessage(message);
    } finally {
      if (!background) setGraphAdministrationBusy(undefined);
    }
  }

  async function runGraphAdministration(action: GraphAdministrationAction): Promise<void> {
    const label = graphAdministrationActionLabel(action);
    setGraphAdministrationBusy(label);
    try {
      let result: {readonly output: string};
      if (action.action === 'remove-view' && action.dryRun !== true) {
        const preview = await api<ManagerGraphViewRemovalResponse>('/api/graphs/action', {
          ...action,
          dryRun: true,
        });
        const approvalDialog = graphViewRemovalApprovalDialog(preview);
        if (approvalDialog && !(await dialogs.confirm(approvalDialog))) {
          setGraphAdministrationOutput(preview.output);
          return;
        }
        result = approvalDialog
          ? await api<ManagerGraphViewRemovalResponse>('/api/graphs/action', {
              ...action,
              approvalDigest: preview.approvalDigest,
              confirm: true,
            })
          : preview;
      } else {
        result = await api<{readonly output: string}>('/api/graphs/action', {
          ...action,
          confirm: action.dryRun !== true,
        });
      }
      await Promise.all([refreshGraphCatalog(false), refreshGraphDiagnostics({analyze: false, deep: false}, false)]);
      setGraphAdministrationOutput(result.output);
      toastMessage(`${label} complete`);
    } catch (cause) {
      const message = errorMessage(cause);
      setGraphAdministrationOutput(message);
      toastMessage(message);
    } finally {
      setGraphAdministrationBusy(undefined);
    }
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

  async function loadResource(uri: string): Promise<void> {
    const result = await api<ReadResponse>('/api/read', {uri});
    setMemory(undefined);
    setContent(result.content || result.output);
    setOutput(result.output || result.content);
    setReadUri(uri);
    setMemoryViewMode(isMarkdownUri(uri) ? 'preview' : 'edit');
    setTarget({kind: 'durable', project: '', status: 'active', team: '', topic: ''});
  }

  async function readContext(uri: string): Promise<void> {
    const trimmed = uri.trim();
    if (!trimmed) {
      toastMessage('Provide a Threadnote URI');
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
        await reloadSelected(selectedUri);
      }
    } catch (err) {
      toastMessage(errorMessage(err));
    }
  }

  async function runDoctorAction(
    label: string,
    busyLabel: string,
    action: () => Promise<{readonly output?: string}>,
  ): Promise<void> {
    if (doctorAction) {
      return;
    }
    setDoctorAction(busyLabel);
    try {
      const result = await action();
      setDoctorOutput(result.output ?? '');
      toastMessage(label);
      await loadDoctorChecks();
    } catch (err) {
      toastMessage(errorMessage(err));
    } finally {
      setDoctorAction(undefined);
    }
  }

  async function refreshTreeOnly(): Promise<void> {
    const next = await api<TreeResponse>('/api/tree');
    setTree(next.tree);
    setResourceTree(next.resourcesTree);
  }

  async function reloadSelected(uri: string): Promise<void> {
    if (isResourceUri(uri)) {
      await loadResource(uri).catch(() => undefined);
    } else {
      await loadMemory(uri).catch(() => undefined);
    }
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
    if (!selectedUri) return;
    const confirmed = await dialogs.confirm({
      confirmLabel: 'Archive memory',
      detail: selectedUri,
      message: 'The memory stays available in the archive and can be restored later.',
      title: 'Archive this memory?',
    });
    if (!confirmed) return;
    await runAction('Archived memory', () => api('/api/memory/archive', {confirm: true, uri: selectedUri}));
  }

  async function forgetCurrent(): Promise<void> {
    if (!selectedUri) return;
    const confirmed = await dialogs.confirm({
      confirmLabel: 'Forget memory',
      detail: selectedUri,
      message: 'This permanently removes the memory from local context.',
      title: 'Forget this memory?',
      tone: 'danger',
    });
    if (!confirmed) return;
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
    const confirmed = await dialogs.confirm({
      confirmLabel: 'Remove folder',
      detail: selectedNode.uri,
      message: `This permanently removes ${fileCount} memory file${fileCount === 1 ? '' : 's'} from local context.`,
      title: 'Remove this folder?',
      tone: 'danger',
    });
    if (!confirmed) return;
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
    if (!selectedUri) return;
    const values = await dialogs.prompt({
      confirmLabel: 'Publish memory',
      detail: selectedUri,
      fields: [
        {
          id: 'team',
          initialValue: target.team || 'default',
          label: 'Team',
          options: teamOptions,
          required: true,
        },
      ],
      message: 'Publish this personal durable memory to a configured shared repository.',
      title: 'Publish memory',
    });
    if (!values) return;
    await runAction('Published memory', () =>
      api('/api/memory/publish', {confirm: true, team: values.team, uri: selectedUri}),
    );
  }

  async function unpublishCurrent(): Promise<void> {
    if (!selectedUri) return;
    const confirmed = await dialogs.confirm({
      confirmLabel: 'Unpublish memory',
      detail: selectedUri,
      message: 'Remove this memory from its shared repository projection.',
      title: 'Unpublish this memory?',
      tone: 'danger',
    });
    if (!confirmed) return;
    await runAction('Unpublished memory', () =>
      api('/api/memory/unpublish', {confirm: true, team: target.team, uri: selectedUri}),
    );
  }

  async function moveCurrent(): Promise<void> {
    if (!selectedUri) return;
    const values = await dialogs.prompt({
      confirmLabel: 'Move memory',
      detail: selectedUri,
      fields: [
        {
          allowCreate: true,
          id: 'project',
          initialValue: target.project,
          label: 'Project',
          options: projectOptions,
          required: true,
        },
        {id: 'topic', initialValue: target.topic, label: 'Topic', required: true},
        {
          description: 'Leave blank to move it to personal memory.',
          id: 'team',
          initialValue: target.team,
          label: 'Shared team',
          options: teamOptions,
        },
      ],
      message: 'Review the destination before moving this memory.',
      title: 'Move memory',
    });
    if (!values) return;
    await runAction('Moved memory', () =>
      api('/api/memory/move', {
        confirm: true,
        kind: target.kind,
        project: values.project,
        status: target.status,
        team: values.team,
        topic: values.topic,
        uri: selectedUri,
      }),
    );
  }

  async function bulk(action: 'archive' | 'forget' | 'publish'): Promise<void> {
    if (bulkAction || selectedList.length === 0) return;
    const title = `${bulkActionLabel(action)} ${selectedList.length} selected ${selectedList.length === 1 ? 'memory' : 'memories'}?`;
    const values = await dialogs.prompt({
      confirmLabel: bulkActionLabel(action),
      fields:
        action === 'publish'
          ? [{id: 'team', initialValue: 'default', label: 'Team', options: teamOptions, required: true}]
          : undefined,
      message:
        action === 'forget'
          ? 'This permanently removes every selected memory from local context.'
          : 'Only the currently selected memories will be changed.',
      title,
      tone: action === 'forget' ? 'danger' : 'default',
    });
    if (!values) return;
    const team = action === 'publish' ? values.team : undefined;
    const currentSelectedUri = selectedUri;
    setBulkAction(action);
    try {
      const result = await api<{readonly results: readonly BulkItemResult[]}>('/api/bulk', {
        action,
        confirm: true,
        team,
        uris: selectedList,
      });
      setOutput(formatBulkResults(action, result.results));
      const failedUris = result.results.filter(item => !item.ok).map(item => item.uri);
      setSelectedUris(new Set(failedUris));
      if (currentSelectedUri && selectedList.includes(currentSelectedUri)) {
        if (failedUris.includes(currentSelectedUri)) {
          await reloadSelected(currentSelectedUri);
        } else {
          setSelectedUri(undefined);
          setMemory(undefined);
          setContent('');
          setMemoryViewMode('edit');
        }
      } else if (currentSelectedUri) {
        await reloadSelected(currentSelectedUri);
      }
      await refreshTreeOnly();
      toastMessage(failedUris.length === 0 ? 'Bulk action complete' : 'Bulk action completed with failures');
    } catch (err) {
      toastMessage(errorMessage(err));
    } finally {
      setBulkAction(undefined);
    }
  }

  async function loadShares(): Promise<void> {
    const next = await api<{shares: readonly ShareSummary[]}>('/api/shares');
    setShares(next.shares);
    toastMessage('Shares refreshed');
  }

  async function loadDoctorChecks(showToast = false): Promise<void> {
    const next = await api<{checks: readonly DoctorCheck[]; shares: readonly ShareSummary[]}>('/api/doctor');
    setDoctor(next.checks);
    setShares(next.shares);
    if (showToast) {
      toastMessage('Doctor complete');
    }
  }

  async function loadDoctor(showToast = true): Promise<void> {
    if (doctorAction) {
      return;
    }
    setDoctorAction('Running doctor');
    try {
      await loadDoctorChecks(showToast);
    } catch (err) {
      toastMessage(errorMessage(err));
    } finally {
      setDoctorAction(undefined);
    }
  }

  async function draftConsolidation(): Promise<void> {
    if (draftingConsolidation || applyingConsolidation) {
      return;
    }
    const uris =
      selectedList.length > 0 ? selectedList : selectedUri && !isResourceUri(selectedUri) ? [selectedUri] : [];
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
    if (draftingConsolidation || applyingConsolidation || !jobId || !draft) return;
    const confirmed = await dialogs.confirm({
      confirmLabel: 'Apply consolidation',
      message: `Store the consolidated memory and archive ${consolidationSourceUris.length} personal source${consolidationSourceUris.length === 1 ? '' : 's'}.`,
      title: 'Apply this consolidation?',
    });
    if (!confirmed) return;
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
        await reloadSelected(currentSelectedUri);
      }
      await refreshTreeOnly();
      toastMessage('Applied consolidation');
    } catch (err) {
      toastMessage(errorMessage(err));
    } finally {
      setApplyingConsolidation(false);
    }
  }

  async function removeSelectedShare(): Promise<void> {
    if (!selectedShare) return;
    const confirmed = await dialogs.confirm({
      confirmLabel: 'Remove share',
      detail: selectedShare,
      message: keepShareFiles
        ? 'Disconnect this shared repository and keep its local files.'
        : 'Disconnect this shared repository and remove its managed local files.',
      title: 'Remove this share?',
      tone: 'danger',
    });
    if (!confirmed) return;
    await runAction('Removed share', () =>
      api('/api/shares/remove', {
        confirm: true,
        keepFiles: keepShareFiles,
        preserveLocal: preserveShare,
        team: selectedShare,
      }),
    );
    await loadShares();
  }

  async function repairThreadnote(): Promise<void> {
    const confirmed = await dialogs.confirm({
      confirmLabel: 'Run repair',
      message: 'Run Threadnote repair now and write the approved maintenance changes.',
      title: 'Repair Threadnote?',
    });
    if (!confirmed) return;
    await runDoctorAction('Repair complete', 'Running repair', () => api('/api/doctor/repair', {confirm: true}));
  }

  async function applyCompactPlan(): Promise<void> {
    const confirmed = await dialogs.confirm({
      confirmLabel: 'Apply compact plan',
      message: 'Apply the current memory compaction plan and write its changes.',
      title: 'Compact memories?',
    });
    if (!confirmed) return;
    await runAction('Compact applied', () =>
      api('/api/compact', {
        apply: true,
        confirm: true,
        project: compactProject,
        topic: compactTopic,
      }).then(result => result as {output: string}),
    );
  }

  async function importPack(): Promise<void> {
    const confirmed = await dialogs.confirm({
      confirmLabel: 'Import pack',
      detail: packPath || 'No path entered',
      message: 'Import memories and resources from this pack into local Threadnote storage.',
      title: 'Import this pack?',
    });
    if (!confirmed) return;
    await runAction('Import complete', () => api('/api/import-pack', {confirm: true, path: packPath}));
  }

  async function seedThreadnote(skills: boolean): Promise<void> {
    const confirmed = await dialogs.confirm({
      confirmLabel: skills ? 'Seed skills' : 'Seed resources',
      message: skills
        ? 'Write the configured Threadnote skills into their managed destinations.'
        : 'Write the configured Threadnote resources into local storage.',
      title: skills ? 'Run seed-skills?' : 'Run seed?',
    });
    if (!confirmed) return;
    await runAction(skills ? 'Seed skills complete' : 'Seed complete', () =>
      api('/api/seed', {confirm: true, ...(skills ? {skills: true} : {})}),
    );
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
  const selectedIsResource = selectedUri ? isResourceUri(selectedUri) : false;
  const selectedIsMarkdown = Boolean(selectedNode && isMarkdownNode(selectedNode));
  const markdownPreview = markdownBodyForPreview(content);
  const canMutate = Boolean(selectedUri && !selectedIsDir && !selectedIsResource);
  const canRemoveFolder = Boolean(
    selectedNode?.isDir && selectedNode.relativePath && !selectedNode.isShared && !selectedIsResource,
  );
  const consolidationBusy = draftingConsolidation || applyingConsolidation;
  const canDraftConsolidation = selectedList.length > 0 || !selectedIsResource;
  const doctorBusy = doctorAction !== undefined;
  const controlsBlocked = bulkAction !== undefined;
  const busyOverlayMessage = bulkAction
    ? `${actionProgressLabel(bulkAction)} ${selectedList.length} selected ${selectedList.length === 1 ? 'memory' : 'memories'}...`
    : '';
  const doctorBusyMessage = doctorAction ? `${doctorAction}...` : '';
  const metadataFieldsDisabled = Boolean(memory || selectedIsDir || selectedIsResource);
  const appStyle = {'--sidebar-width': `${sidebarWidth}px`} as React.CSSProperties;

  return (
    <div className="app" style={appStyle}>
      <aside className={`sidebar ${panel === 'memory' ? 'has-context' : ''}`}>
        <div className="brand">
          <div className="brand-title">
            <img alt="" className="brand-logo" src="/threadnote-logo.svg" />
            <div>
              <h1>Threadnote</h1>
              <p>{state ? `${state.config.user} · ${state.config.account}` : 'Loading manager'}</p>
            </div>
          </div>
        </div>
        <p className="sidebar-label">Workspace</p>
        <nav className="primary-nav" aria-label="Manager sections">
          {(['graph', 'memory', 'shares', 'doctor', 'tools'] as const).map(name => (
            <button
              aria-current={panel === name ? 'page' : undefined}
              className={panel === name ? 'is-active' : undefined}
              disabled={controlsBlocked}
              key={name}
              onClick={() => setPanel(name)}
              type="button"
            >
              <span aria-hidden="true" className="nav-icon">
                {panelIcon(name)}
              </span>
              <span>
                <strong>{tabTitle(name)}</strong>
                <small>{panelNavDescription(name)}</small>
              </span>
            </button>
          ))}
        </nav>

        {panel === 'memory' ? (
          <section className="sidebar-context" aria-label="Memory browser">
            <div className="sidebar-context-head">
              <p className="sidebar-label">Library</p>
              <button
                aria-label="Refresh memory library"
                className="icon-button"
                disabled={controlsBlocked}
                onClick={() => void refreshAll()}
                title="Refresh"
                type="button"
              >
                ↻
              </button>
            </div>
            <input
              disabled={controlsBlocked}
              value={filter}
              onChange={event => setFilter(event.target.value)}
              placeholder="Filter context"
              type="search"
            />
            <div className="nav-tree-tabs" aria-label="Navigation tree">
              <button
                className={navTreeTab === 'memories' ? 'is-active' : undefined}
                disabled={controlsBlocked}
                onClick={() => setNavTreeTab('memories')}
                type="button"
              >
                Memories
              </button>
              <button
                className={navTreeTab === 'resources' ? 'is-active' : undefined}
                disabled={controlsBlocked}
                onClick={() => setNavTreeTab('resources')}
                type="button"
              >
                Resources
              </button>
            </div>
            <label className="check-row">
              <input
                checked={showSystem}
                disabled={controlsBlocked}
                onChange={event => setShowSystem(event.target.checked)}
                type="checkbox"
              />
              <span>Show system files</span>
            </label>
            <nav className="tree" aria-label="Context tree">
              {navTreeTab === 'resources' ? (
                resourceTree ? (
                  <Tree
                    filter={filter}
                    node={resourceTree}
                    onSelect={selectTreeUri}
                    selectable={false}
                    selectedUri={selectedUri}
                    showSystem={showSystem}
                  />
                ) : (
                  <p className="tree-empty">No resources</p>
                )
              ) : tree ? (
                <Tree
                  filter={filter}
                  node={tree}
                  onSelect={selectTreeUri}
                  onToggleSelection={(node, checked) =>
                    setSelectedUris(current => {
                      const next = new Set(current);
                      for (const uri of selectableMemoryUris(node, {filter, showSystem})) {
                        if (checked) {
                          next.add(uri);
                        } else {
                          next.delete(uri);
                        }
                      }
                      return next;
                    })
                  }
                  selectedUri={selectedUri}
                  selectedUris={selectedUris}
                  selectionDisabled={bulkAction !== undefined}
                  showSystem={showSystem}
                />
              ) : (
                <p className="tree-empty">No memories</p>
              )}
            </nav>
          </section>
        ) : (
          <div className="sidebar-product-note">
            <span className="status-pulse" />
            <div>
              <strong>Local runtime</strong>
              <p>{state ? `v${state.version} · private by default` : 'Connecting…'}</p>
            </div>
          </div>
        )}
        {state?.latestVersion && state.latestVersion !== state.version ? (
          <div className="sidebar-update">
            <span>Update available</span>
            <strong>v{state.latestVersion}</strong>
          </div>
        ) : null}
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
          <div className="page-title">
            <span>{tabTitle(panel)}</span>
            <small>{panelDescription(panel)}</small>
          </div>
          {panel === 'memory' && selectedList.length > 0 ? (
            <div className="selection-bar">
              <span>{selectedList.length} selected</span>
              <button disabled={controlsBlocked} onClick={() => void bulk('archive')}>
                {bulkAction === 'archive' ? 'Archiving...' : 'Archive'}
              </button>
              <button disabled={controlsBlocked} onClick={() => void bulk('publish')}>
                {bulkAction === 'publish' ? 'Publishing...' : 'Publish'}
              </button>
              <button className="danger" disabled={controlsBlocked} onClick={() => void bulk('forget')}>
                {bulkAction === 'forget' ? 'Forgetting...' : 'Forget'}
              </button>
            </div>
          ) : (
            <button
              aria-label="Refresh manager"
              className="topbar-refresh"
              disabled={controlsBlocked}
              onClick={() => void refreshAll()}
              title="Refresh manager"
              type="button"
            >
              ↻
            </button>
          )}
        </header>

        {panel === 'graph' ? (
          <section className="panel graph-panel is-active">
            <GraphWorkspace
              administration={graphDiagnostics}
              administrationBusy={
                graphAdministrationBusy ??
                (graphCatalog?.maintenance
                  ? graphMaintenanceStatusLabel(graphCatalog.maintenance)
                  : graphCatalog?.lifecyclePending
                    ? 'Reconciling indexed views'
                    : undefined)
              }
              administrationOutput={graphAdministrationOutput}
              catalog={graphCatalog}
              catalogError={graphCatalogError}
              loadAnalysis={loadManagerGraphAnalysis}
              loadCatalogPage={loadManagerGraphCatalogPage}
              loadGraph={loadManagerGraph}
              loadNodeDetail={loadManagerGraphNodeDetail}
              loadQuery={loadManagerGraphQuery}
              loadViewsPage={loadManagerGraphViewsPage}
              onAdministrationAction={action => void runGraphAdministration(action)}
              onDiagnostics={options => void refreshGraphDiagnostics(options)}
              onRefresh={() => void refreshGraphCatalog(true)}
            />
          </section>
        ) : null}

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
                        disabled={!selectedIsMarkdown || selectedIsDir || controlsBlocked}
                        onClick={() => setMemoryViewMode('preview')}
                      >
                        Preview
                      </button>
                      <button
                        className={memoryViewMode === 'edit' ? 'is-active' : undefined}
                        disabled={selectedIsDir || selectedIsResource || controlsBlocked}
                        onClick={() => setMemoryViewMode('edit')}
                      >
                        Edit
                      </button>
                    </div>
                    <button disabled={controlsBlocked} onClick={() => void newMemory()}>
                      New
                    </button>
                    <button
                      disabled={selectedIsDir || selectedIsResource || controlsBlocked}
                      onClick={() => void (memory ? saveCurrent() : saveNew())}
                    >
                      Save
                    </button>
                    <button disabled={!canMutate || controlsBlocked} onClick={() => void archiveCurrent()}>
                      Archive
                    </button>
                    <button
                      disabled={!canMutate || selectedNode?.isShared === true || controlsBlocked}
                      onClick={() => void publishCurrent()}
                    >
                      Publish
                    </button>
                    <button
                      disabled={!canMutate || selectedNode?.isShared !== true || controlsBlocked}
                      onClick={() => void unpublishCurrent()}
                    >
                      Unpublish
                    </button>
                    <button disabled={!canMutate || controlsBlocked} onClick={() => void moveCurrent()}>
                      Move
                    </button>
                    <button
                      className="danger"
                      disabled={!canRemoveFolder || controlsBlocked}
                      onClick={() => void removeFolderCurrent()}
                      title={selectedNode?.isShared ? 'Use Sharing to remove shared folders' : undefined}
                    >
                      Remove Folder
                    </button>
                    <button
                      className="danger"
                      disabled={!canMutate || controlsBlocked}
                      onClick={() => void forgetCurrent()}
                    >
                      Forget
                    </button>
                  </div>
                </div>
                {memoryViewMode === 'preview' && selectedIsMarkdown && !selectedIsDir ? (
                  <MarkdownViewer markdown={markdownPreview} />
                ) : (
                  <textarea
                    disabled={selectedIsDir || selectedIsResource || controlsBlocked}
                    onChange={event => setContent(event.target.value)}
                    placeholder={
                      selectedIsDir ? 'Folder selected' : selectedIsResource ? 'Resource content' : 'Memory content'
                    }
                    spellCheck={false}
                    value={content}
                  />
                )}
              </section>

              <aside className="inspector">
                <h3>Metadata</h3>
                <TargetFields
                  disabled={metadataFieldsDisabled}
                  onChange={setTarget}
                  openSelect={openSelect}
                  projectOptions={projectOptions}
                  setOpenSelect={setOpenSelect}
                  target={target}
                />
                {metadataFieldsDisabled ? <p className="muted">Metadata is read-only for existing entries.</p> : null}
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
                  <button
                    disabled={consolidationBusy || controlsBlocked || !canDraftConsolidation}
                    onClick={() => void draftConsolidation()}
                  >
                    {draftingConsolidation ? 'Drafting...' : 'Draft'}
                  </button>
                </div>
                <textarea
                  aria-busy={consolidationBusy}
                  placeholder={draftingConsolidation ? 'Generating draft...' : 'Draft preview'}
                  readOnly={consolidationBusy || controlsBlocked}
                  value={draft}
                  onChange={event => setDraft(event.target.value)}
                  spellCheck={false}
                />
                <button
                  disabled={consolidationBusy || controlsBlocked || !jobId || !draft}
                  onClick={() => void applyConsolidation()}
                >
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
            removeShare={() => void removeSelectedShare()}
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
          <section aria-busy={doctorBusy} className="panel is-active health-panel">
            <div className="pane-head">
              <h2>Health and Doctor</h2>
              <div className="action-row">
                <button disabled={doctorBusy} onClick={() => void loadDoctor()}>
                  {doctorAction === 'Running doctor' ? 'Running...' : 'Run Doctor'}
                </button>
                <button
                  disabled={doctorBusy}
                  onClick={() =>
                    void runDoctorAction('Runtime ready', 'Checking runtime', () => api('/api/doctor/start', {}))
                  }
                >
                  Verify Runtime
                </button>
                <button
                  disabled={doctorBusy}
                  onClick={() =>
                    void runDoctorAction('Repair dry run complete', 'Running repair dry run', () =>
                      api('/api/doctor/repair-dry-run', {}),
                    )
                  }
                >
                  Repair Dry Run
                </button>
                <button disabled={doctorBusy} onClick={() => void repairThreadnote()}>
                  Repair
                </button>
              </div>
            </div>
            {doctorBusyMessage ? (
              <div aria-live="polite" className="loading-row" role="status">
                <span className="spinner" aria-hidden="true" />
                <span>{doctorBusyMessage}</span>
              </div>
            ) : null}
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
                  <ManagerAutocompleteInput
                    allowCreate={false}
                    onChange={setRecallProject}
                    options={projectOptions}
                    value={recallProject}
                    placeholder="project scope (blank = all)"
                  />
                  <button
                    onClick={() =>
                      void runAction('Recall complete', () =>
                        api('/api/recall', {
                          query: recallQuery,
                          ...(recallProject.trim() ? {project: recallProject.trim()} : {}),
                        }).then(result => result as {output: string}),
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
                    placeholder="threadnote://..."
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
                  <ManagerAutocompleteInput
                    allowCreate={false}
                    onChange={setCompactProject}
                    options={projectOptions}
                    value={compactProject}
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
                    <button onClick={() => void applyCompactPlan()}>Apply</button>
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
                    <button onClick={() => void importPack()}>Import</button>
                  </div>
                </section>
                <section className="form-section">
                  <h3>Seed</h3>
                  <div className="button-row">
                    <button onClick={() => void seedThreadnote(false)}>Seed</button>
                    <button onClick={() => void seedThreadnote(true)}>Seed Skills</button>
                  </div>
                </section>
              </aside>
            </div>
          </section>
        ) : null}
      </main>
      {busyOverlayMessage ? (
        <div aria-live="polite" className="busy-overlay" role="status">
          <div className="busy-panel">{busyOverlayMessage}</div>
        </div>
      ) : null}
      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}

function Tree(props: {
  readonly filter: string;
  readonly node: TreeNode;
  readonly onSelect: (uri: string) => void;
  readonly onToggleSelection?: (node: TreeNode, checked: boolean) => void;
  readonly selectable?: boolean;
  readonly selectedUri?: string;
  readonly selectedUris?: ReadonlySet<string>;
  readonly selectionDisabled?: boolean;
  readonly showSystem: boolean;
}): React.ReactElement | null {
  const selectable = props.selectable !== false;
  const selectedUris = props.selectedUris ?? EMPTY_SELECTED_URIS;
  if (!props.showSystem && props.node.isSystem) {
    return null;
  }
  if (props.filter && !nodeMatches(props.node, props.filter)) {
    return null;
  }
  if (props.node.isDir) {
    const selectableUris = selectable
      ? selectableMemoryUris(props.node, {filter: props.filter, showSystem: props.showSystem})
      : [];
    const selectedCount = selectableUris.filter(uri => selectedUris.has(uri)).length;
    const checked = selectableUris.length > 0 && selectedCount === selectableUris.length;
    const indeterminate = selectedCount > 0 && selectedCount < selectableUris.length;
    const summaryClass = treeItemClass(props.selectedUri === props.node.uri, !selectable);
    return (
      <details open={props.node.relativePath.split('/').length < 3}>
        <summary className={summaryClass} onClick={() => props.onSelect(props.node.uri)} title={props.node.uri}>
          {selectable ? (
            <TreeSelectionCheckbox
              checked={checked}
              disabled={props.selectionDisabled === true || selectableUris.length === 0}
              indeterminate={indeterminate}
              onChange={checked => props.onToggleSelection?.(props.node, checked)}
            />
          ) : null}
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
  const rowClass = treeItemClass(props.selectedUri === props.node.uri, !selectable, 'tree-row');
  return (
    <div className={rowClass}>
      {selectable ? (
        <input
          checked={selectedUris.has(props.node.uri)}
          disabled={props.selectionDisabled === true}
          onChange={event => props.onToggleSelection?.(props.node, event.target.checked)}
          type="checkbox"
        />
      ) : null}
      <button className="tree-file" onClick={() => props.onSelect(props.node.uri)} title={props.node.uri}>
        <span className="tree-name">{props.node.name}</span>
      </button>
    </div>
  );
}

function TreeSelectionCheckbox(props: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly indeterminate: boolean;
  readonly onChange: (checked: boolean) => void;
}): React.ReactElement {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = props.indeterminate;
    }
  }, [props.indeterminate]);
  return (
    <input
      checked={props.checked}
      disabled={props.disabled}
      onChange={event => props.onChange(event.target.checked)}
      onClick={event => event.stopPropagation()}
      ref={ref}
      type="checkbox"
    />
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
  readonly disabled: boolean;
  readonly onChange: (value: TargetForm) => void;
  readonly openSelect?: SelectId;
  readonly projectOptions: readonly string[];
  readonly setOpenSelect: (value: SelectId | undefined) => void;
  readonly target: TargetForm;
}): React.ReactElement {
  const set = (patch: Partial<TargetForm>) => props.onChange({...props.target, ...patch});
  return (
    <div className="target-fields">
      <DropdownSelect
        disabled={props.disabled}
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
        disabled={props.disabled}
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
      <ManagerAutocompleteInput
        allowCreate
        disabled={props.disabled}
        onChange={project => set({project})}
        options={props.projectOptions}
        placeholder="project"
        value={props.target.project}
      />
      <input
        disabled={props.disabled}
        value={props.target.topic}
        onChange={event => set({topic: event.target.value})}
        placeholder="topic"
      />
    </div>
  );
}

function DropdownSelect(props: {
  readonly disabled?: boolean;
  readonly id: SelectId;
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly openSelect?: SelectId;
  readonly options: readonly DropdownOption[];
  readonly setOpenSelect: (value: SelectId | undefined) => void;
  readonly value: string;
}): React.ReactElement {
  const isOpen = props.disabled !== true && props.openSelect === props.id;
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
        disabled={props.disabled === true}
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
  const teamOptions = useMemo(
    () => uniqueSelectorValues(['default', ...props.shares.map(share => share.name)]),
    [props.shares],
  );
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
          <ManagerAutocompleteInput
            allowCreate
            onChange={props.setShareTeam}
            options={teamOptions}
            placeholder="team name"
            value={props.shareTeam}
          />
          <input
            value={props.shareRemote}
            onChange={event => props.setShareRemote(event.target.value)}
            placeholder="git remote URL"
          />
          <button onClick={props.createShare}>Create</button>
          <h3>Selected Share</h3>
          <ManagerAutocompleteInput
            onChange={props.setSelectedShare}
            options={teamOptions}
            placeholder="team"
            value={props.selectedShare}
          />
          <ManagerAutocompleteInput
            allowCreate
            onChange={props.setRenameShareTo}
            options={teamOptions}
            placeholder="new team name"
            value={props.renameShareTo}
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

async function api<T>(
  path: string,
  body?: Record<string, unknown>,
  options: {readonly signal?: AbortSignal; readonly timeoutMilliseconds?: number} = {},
): Promise<T> {
  const controller = options.timeoutMilliseconds === undefined ? undefined : new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller?.abort(options.signal?.reason);
  if (controller && options.signal) {
    if (options.signal.aborted) abortFromCaller();
    else options.signal.addEventListener('abort', abortFromCaller, {once: true});
  }
  const timeout =
    controller && options.timeoutMilliseconds !== undefined
      ? window.setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, options.timeoutMilliseconds)
      : undefined;
  try {
    const response = await fetch(path, {
      body: body ? JSON.stringify(body) : undefined,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: body ? 'POST' : 'GET',
      signal: controller?.signal ?? options.signal,
    });
    const data = (await response.json()) as {readonly error?: string};
    if (!response.ok) {
      throw new Error(data.error ?? `HTTP ${response.status}`);
    }
    return data as T;
  } catch (cause) {
    if (timedOut) {
      throw new Error(`Manager request timed out after ${options.timeoutMilliseconds} ms. Retry the operation.`, {
        cause,
      });
    }
    throw cause;
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export function graphAdministrationActionLabel(action: GraphAdministrationAction): string {
  switch (action.action) {
    case 'compact':
      return action.dryRun ? 'Compaction preview' : 'Graph compaction';
    case 'index':
      return action.full ? 'Graph reindex' : 'Graph index';
    case 'purge':
      return action.dryRun ? 'Graph purge preview' : 'Graph purge';
    case 'purge-all':
      return action.dryRun ? 'All-graph purge preview' : 'All-graph purge';
    case 'purge-obsolete':
      return action.dryRun ? 'Obsolete-store preview' : 'Obsolete-store purge';
    case 'remove-view':
      return action.dryRun ? 'View removal preview' : 'View removal';
    case 'repair':
      return action.dryRun ? 'Graph repair preview' : action.deep ? 'Deep graph repair' : 'Graph repair';
  }
}

function loadManagerGraph(
  repositoryId: string,
  snapshotId: string,
  projectId: string,
  limits: ManagerGraphVisualizationLimits,
  signal: AbortSignal,
): Promise<GraphVisualization> {
  return api<GraphVisualization>(
    `/api/graph?repository=${encodeURIComponent(repositoryId)}&snapshot=${encodeURIComponent(snapshotId)}&project=${encodeURIComponent(projectId)}&nodeLimit=${limits.nodeLimit}&edgeLimit=${limits.edgeLimit}`,
    undefined,
    {signal, timeoutMilliseconds: GRAPH_DETAIL_REQUEST_TIMEOUT_MILLISECONDS},
  );
}

function loadManagerGraphCatalogPage(
  repositoryId: string,
  snapshotId: string,
  projectOffset: number,
  workspaceOffset: number,
  query: string,
  signal: AbortSignal,
): Promise<GraphCatalogPage> {
  return api<GraphCatalogPage>(
    `/api/graphs/page?repository=${encodeURIComponent(repositoryId)}&snapshot=${encodeURIComponent(snapshotId)}&offset=${projectOffset}&workspaceOffset=${workspaceOffset}${query ? `&query=${encodeURIComponent(query)}` : ''}`,
    undefined,
    {signal, timeoutMilliseconds: GRAPH_CATALOG_REQUEST_TIMEOUT_MILLISECONDS},
  );
}

function loadManagerGraphViewsPage(
  repositoryId: string,
  offset: number,
  query: string,
  signal: AbortSignal,
): Promise<GraphViewPage> {
  return api<GraphViewPage>(
    `/api/graphs/views?repository=${encodeURIComponent(repositoryId)}&offset=${offset}${query ? `&query=${encodeURIComponent(query)}` : ''}`,
    undefined,
    {signal, timeoutMilliseconds: GRAPH_CATALOG_REQUEST_TIMEOUT_MILLISECONDS},
  );
}

function loadManagerGraphAnalysis(
  repositoryId: string,
  snapshotId: string,
  signal: AbortSignal,
): Promise<GraphAnalysis> {
  return api<GraphAnalysis>(
    `/api/graph/analysis?repository=${encodeURIComponent(repositoryId)}&snapshot=${encodeURIComponent(snapshotId)}`,
    undefined,
    {signal, timeoutMilliseconds: GRAPH_DETAIL_REQUEST_TIMEOUT_MILLISECONDS},
  );
}

function loadManagerGraphNodeDetail(
  repositoryId: string,
  snapshotId: string,
  nodeId: string,
  signal: AbortSignal,
): Promise<GraphNodeDetail> {
  return api<GraphNodeDetail>(
    `/api/graph/node?repository=${encodeURIComponent(repositoryId)}&snapshot=${encodeURIComponent(snapshotId)}&node=${encodeURIComponent(nodeId)}`,
    undefined,
    {signal, timeoutMilliseconds: GRAPH_DETAIL_REQUEST_TIMEOUT_MILLISECONDS},
  );
}

function loadManagerGraphQuery(
  repositoryId: string,
  snapshotId: string,
  query: string,
  limits: ManagerGraphVisualizationLimits,
  signal: AbortSignal,
): Promise<GraphQueryVisualization> {
  return api<GraphQueryVisualization>(
    `/api/graph/query?repository=${encodeURIComponent(repositoryId)}&snapshot=${encodeURIComponent(snapshotId)}&query=${encodeURIComponent(query)}&nodeLimit=${limits.nodeLimit}&edgeLimit=${limits.edgeLimit}`,
    undefined,
    {signal, timeoutMilliseconds: GRAPH_DETAIL_REQUEST_TIMEOUT_MILLISECONDS},
  );
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

function findNodeInTrees(trees: readonly (TreeNode | undefined)[], uri: string): TreeNode | undefined {
  for (const tree of trees) {
    const node = tree ? findNode(tree, uri) : undefined;
    if (node) {
      return node;
    }
  }
  return undefined;
}

export function managerProjectOptions(tree: TreeNode | undefined): readonly string[] {
  const projects: string[] = [];
  const visit = (node: TreeNode): void => {
    if (node.metadata?.project) projects.push(node.metadata.project);
    for (const child of node.children ?? []) visit(child);
  };
  if (tree) visit(tree);
  return uniqueSelectorValues(projects);
}

function uniqueSelectorValues(values: readonly string[]): readonly string[] {
  const unique = new Map<string, string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const normalized = trimmed.toLocaleLowerCase();
    if (!unique.has(normalized)) unique.set(normalized, trimmed);
  }
  return [...unique.values()].sort((left, right) => left.localeCompare(right));
}

function treeItemClass(active: boolean, readOnly: boolean, base?: string): string | undefined {
  const classes = [base, active ? 'is-active' : undefined, readOnly ? 'is-readonly' : undefined].filter(
    (value): value is string => typeof value === 'string',
  );
  return classes.length > 0 ? classes.join(' ') : undefined;
}

function countFiles(node: TreeNode): number {
  if (!node.isDir) {
    return 1;
  }
  return (node.children ?? []).reduce((total, child) => total + countFiles(child), 0);
}

export function selectableMemoryUris(
  node: TreeNode,
  options: {readonly filter: string; readonly showSystem: boolean},
): readonly string[] {
  if (!options.showSystem && node.isSystem) {
    return [];
  }
  if (options.filter && !nodeMatches(node, options.filter)) {
    return [];
  }
  if (!node.isDir) {
    return [node.uri];
  }
  return (node.children ?? []).flatMap(child => selectableMemoryUris(child, options));
}

export function pruneSelectedMemoryUris(
  selectedUris: ReadonlySet<string>,
  tree: TreeNode | undefined,
  options: {readonly filter: string; readonly showSystem: boolean},
): ReadonlySet<string> {
  if (!tree || selectedUris.size === 0) {
    return selectedUris;
  }
  const selectableUris = new Set(selectableMemoryUris(tree, options));
  let changed = false;
  const next = new Set<string>();
  for (const uri of selectedUris) {
    if (selectableUris.has(uri)) {
      next.add(uri);
    } else {
      changed = true;
    }
  }
  return changed ? next : selectedUris;
}

function isMarkdownNode(node: TreeNode): boolean {
  return !node.isDir && isMarkdownUri(node.name);
}

function isMarkdownUri(uri: string): boolean {
  return uri.toLowerCase().endsWith('.md');
}

function isResourceUri(uri: string): boolean {
  return uri === 'threadnote://resources' || uri.startsWith('threadnote://resources/');
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

function resourceUrisFromText(text: string): readonly string[] {
  const matches = text.match(/threadnote:\/\/[^\s)"'<>`\]]+/g) ?? [];
  return [...new Set(matches.map(uri => uri.replace(/[.,;:]+$/, '')))];
}

function formatBulkResults(action: string, results: readonly BulkItemResult[]): string {
  const succeeded = results.filter(result => result.ok);
  const failed = results.filter(result => !result.ok);
  return [
    `Bulk ${action} complete: ${succeeded.length} succeeded, ${failed.length} failed.`,
    '',
    ...results.map(result => `${result.ok ? 'OK' : 'FAIL'} ${result.uri}${result.error ? ` (${result.error})` : ''}`),
  ].join('\n');
}

function bulkActionLabel(action: 'archive' | 'forget' | 'publish'): string {
  switch (action) {
    case 'archive':
      return 'Archive';
    case 'forget':
      return 'Forget';
    case 'publish':
      return 'Publish';
  }
}

function actionProgressLabel(action: 'archive' | 'forget' | 'publish'): string {
  switch (action) {
    case 'archive':
      return 'Archiving';
    case 'forget':
      return 'Forgetting';
    case 'publish':
      return 'Publishing';
  }
}

function tabTitle(name: PanelName): string {
  switch (name) {
    case 'doctor':
      return 'Health';
    case 'graph':
      return 'Graph';
    case 'memory':
      return 'Library';
    case 'shares':
      return 'Sharing';
    case 'tools':
      return 'Tools';
  }
}

function panelIcon(name: PanelName): string {
  switch (name) {
    case 'doctor':
      return '✓';
    case 'graph':
      return '◉';
    case 'memory':
      return '◇';
    case 'shares':
      return '⇄';
    case 'tools':
      return '··';
  }
}

function panelNavDescription(name: PanelName): string {
  switch (name) {
    case 'doctor':
      return 'Runtime diagnostics';
    case 'graph':
      return 'Explore architecture';
    case 'memory':
      return 'Memories and resources';
    case 'shares':
      return 'Team repositories';
    case 'tools':
      return 'Recall and maintenance';
  }
}

function panelDescription(name: PanelName): string {
  switch (name) {
    case 'doctor':
      return 'Diagnostics and runtime repair';
    case 'graph':
      return 'Repository architecture explorer';
    case 'memory':
      return 'Browse, edit, and consolidate context';
    case 'shares':
      return 'Manage synchronized team context';
    case 'tools':
      return 'Recall, compact, import, export, and seed';
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

if (typeof document !== 'undefined') {
  const root = document.getElementById('root');
  if (!root) {
    throw new Error('Missing #root');
  }
  createRoot(root).render(
    <ManagerDialogProvider>
      <App />
    </ManagerDialogProvider>,
  );
}
