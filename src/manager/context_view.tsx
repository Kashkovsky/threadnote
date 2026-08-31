import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  CONTEXT_BRIEF_MAXIMUM_CODE_REFS,
  CONTEXT_BRIEF_MAXIMUM_ESTIMATED_TOKENS,
  CONTEXT_BRIEF_MINIMUM_ESTIMATED_TOKENS,
  parseContextBriefCodeRefs,
} from '../context_brief/types.js';
import type {
  ContextBriefFollowUpV1,
  ContextBriefMemoryEvidenceV1,
  ContextBriefMode,
  ContextBriefV1,
  ProjectedContextBriefV1,
} from '../context_brief/types.js';
import type {ManagerContextReadResponse, ManagerRecallResponse, ManagerRecallResult} from './context.js';
import {MANAGER_CONTEXT_RECALL_PAGE_SIZE_DEFAULT, projectManagerRecallPage} from './context_paging.js';
import {api, errorMessage} from './ui_support.js';
import type {ManagerWorksetPrepareJob} from './worksets.js';

type ContextWorkspaceView = 'brief' | 'recall';
type ContextScopeKind = 'repository' | 'workset';
const CONTEXT_WORKSET_RECOVERY_POLL_MILLISECONDS = 750;
const CONTEXT_WORKSET_RECOVERY_MAXIMUM_POLLS = 800;

interface BriefRunOverrides {
  readonly codeRefs?: readonly string[];
  readonly mode?: ContextBriefMode;
  readonly task?: string;
  readonly workset?: string;
}

interface BriefRequestSnapshot {
  readonly body: {
    readonly budgetTokens: number;
    readonly callerCwd?: string;
    readonly codeRefs: readonly string[];
    readonly mode: ContextBriefMode;
    readonly project?: string;
    readonly task: string;
    readonly workset?: string;
  };
  readonly scope:
    {readonly callerCwd: string; readonly kind: 'repository'} | {readonly kind: 'workset'; readonly workset: string};
}

export function ContextPanel(): React.ReactElement {
  const [view, setView] = useState<ContextWorkspaceView>('brief');
  const [scopeKind, setScopeKind] = useState<ContextScopeKind>('repository');
  const [callerCwd, setCallerCwd] = useState('');
  const [workset, setWorkset] = useState('');
  const [project, setProject] = useState('');
  const [task, setTask] = useState('');
  const [mode, setMode] = useState<ContextBriefMode>('brief');
  const [budgetTokens, setBudgetTokens] = useState(1_250);
  const [codeRefsText, setCodeRefsText] = useState('');
  const [brief, setBrief] = useState<ProjectedContextBriefV1>();
  const [briefRequestSnapshot, setBriefRequestSnapshot] = useState<BriefRequestSnapshot>();
  const [briefBusy, setBriefBusy] = useState(false);
  const [briefError, setBriefError] = useState('');
  const [graphRecoveryBusy, setGraphRecoveryBusy] = useState(false);
  const [graphRecoveryError, setGraphRecoveryError] = useState('');
  const [graphRecoveryNotice, setGraphRecoveryNotice] = useState('');
  const [recallQuery, setRecallQuery] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [recall, setRecall] = useState<ManagerRecallResponse>();
  const [recallPage, setRecallPage] = useState(0);
  const [recallBusy, setRecallBusy] = useState(false);
  const [recallError, setRecallError] = useState('');
  const [readResult, setReadResult] = useState<ManagerContextReadResponse>();
  const [readBusy, setReadBusy] = useState(false);
  const [readError, setReadError] = useState('');
  const briefRequest = useRef<AbortController>(undefined);
  const graphRecoveryRequest = useRef<AbortController>(undefined);
  const recallRequest = useRef<AbortController>(undefined);
  const readRequest = useRef<AbortController>(undefined);
  const codeRefs = useMemo(() => parseCodeRefs(codeRefsText), [codeRefsText]);
  const tooManyCodeRefs = codeRefs.length > CONTEXT_BRIEF_MAXIMUM_CODE_REFS;
  const codeRefsError = useMemo(() => {
    try {
      parseContextBriefCodeRefs(codeRefs);
      return '';
    } catch (cause) {
      return errorMessage(cause);
    }
  }, [codeRefs]);
  const invalidBudget =
    !Number.isSafeInteger(budgetTokens) ||
    budgetTokens < CONTEXT_BRIEF_MINIMUM_ESTIMATED_TOKENS ||
    budgetTokens > CONTEXT_BRIEF_MAXIMUM_ESTIMATED_TOKENS;

  useEffect(
    () => () => {
      briefRequest.current?.abort();
      graphRecoveryRequest.current?.abort();
      recallRequest.current?.abort();
      readRequest.current?.abort();
    },
    [],
  );

  async function runBrief(overrides: BriefRunOverrides = {}): Promise<void> {
    const nextTask = overrides.task ?? task;
    const nextMode = overrides.mode ?? mode;
    const nextCodeRefs = overrides.codeRefs ?? codeRefs;
    const nextWorkset = overrides.workset ?? workset;
    const nextScopeKind = overrides.workset === undefined ? scopeKind : 'workset';
    if (
      !nextTask.trim() ||
      invalidBudget ||
      parseCodeRefs(nextCodeRefs.join('\n')).length > CONTEXT_BRIEF_MAXIMUM_CODE_REFS ||
      (nextScopeKind === 'repository' ? !callerCwd.trim() : !nextWorkset.trim())
    )
      return;
    graphRecoveryRequest.current?.abort();
    graphRecoveryRequest.current = undefined;
    setGraphRecoveryBusy(false);
    setGraphRecoveryError('');
    setGraphRecoveryNotice('');
    if (overrides.task !== undefined) setTask(overrides.task);
    if (overrides.mode !== undefined) setMode(overrides.mode);
    if (overrides.codeRefs !== undefined) setCodeRefsText(overrides.codeRefs.join('\n'));
    if (overrides.workset !== undefined) {
      invalidateRecall();
      setScopeKind('workset');
      setWorkset(overrides.workset);
    }
    const snapshot: BriefRequestSnapshot = {
      body: {
        budgetTokens,
        codeRefs: nextCodeRefs,
        mode: nextMode,
        ...(project.trim() ? {project: project.trim()} : {}),
        task: nextTask.trim(),
        ...(nextScopeKind === 'repository' ? {callerCwd: callerCwd.trim()} : {workset: nextWorkset.trim()}),
      },
      scope:
        nextScopeKind === 'repository'
          ? {callerCwd: callerCwd.trim(), kind: 'repository'}
          : {kind: 'workset', workset: nextWorkset.trim()},
    };
    await executeBrief(snapshot);
  }

  async function executeBrief(snapshot: BriefRequestSnapshot): Promise<boolean> {
    briefRequest.current?.abort();
    const controller = new AbortController();
    briefRequest.current = controller;
    setBriefBusy(true);
    setBriefError('');
    try {
      const result = await api<ProjectedContextBriefV1>('/api/context/brief', snapshot.body, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return false;
      setBrief(result);
      setBriefRequestSnapshot(snapshot);
      return true;
    } catch (cause) {
      if (!controller.signal.aborted) setBriefError(errorMessage(cause));
      return false;
    } finally {
      if (!controller.signal.aborted) setBriefBusy(false);
    }
  }

  async function recoverGraph(scope: 'repository' | 'workset'): Promise<void> {
    const snapshot = briefRequestSnapshot;
    const currentScopeMatches =
      snapshot?.scope.kind === 'repository'
        ? scopeKind === 'repository' && snapshot.scope.callerCwd === callerCwd.trim()
        : snapshot?.scope.kind === 'workset'
          ? scopeKind === 'workset' && snapshot.scope.workset === workset.trim()
          : false;
    if (
      !snapshot ||
      snapshot.scope.kind !== scope ||
      !currentScopeMatches ||
      snapshot.body.task !== task.trim() ||
      snapshot.body.mode !== mode ||
      snapshot.body.budgetTokens !== budgetTokens ||
      (snapshot.body.project ?? '') !== project.trim() ||
      snapshot.body.codeRefs.join('\n') !== codeRefs.join('\n')
    ) {
      setGraphRecoveryError('The Context Brief inputs changed. Rerun the brief before preparing its graph scope.');
      return;
    }
    graphRecoveryRequest.current?.abort();
    const controller = new AbortController();
    graphRecoveryRequest.current = controller;
    setGraphRecoveryBusy(true);
    setGraphRecoveryError('');
    setGraphRecoveryNotice('');
    try {
      const recoveryOutput =
        snapshot.scope.kind === 'repository'
          ? (
              await api<{readonly output: string}>(
                '/api/graphs/action',
                {action: 'index-cwd', cwd: snapshot.scope.callerCwd},
                {signal: controller.signal},
              )
            ).output
          : await prepareWorksetForContext(snapshot.scope.workset, controller.signal);
      if (controller.signal.aborted) return;
      setGraphRecoveryNotice(`${recoveryOutput} Recompiling the Context Brief…`);
      const recompiled = await executeBrief(snapshot);
      if (!controller.signal.aborted) {
        setGraphRecoveryNotice(
          recompiled
            ? `${recoveryOutput} Context Brief recompiled with the refreshed graph.`
            : `${recoveryOutput} Graph recovery completed; retry the Context Brief compile.`,
        );
      }
    } catch (cause) {
      if (!controller.signal.aborted) setGraphRecoveryError(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) setGraphRecoveryBusy(false);
    }
  }

  async function runRecall(): Promise<void> {
    if (!recallQuery.trim()) return;
    recallRequest.current?.abort();
    const controller = new AbortController();
    recallRequest.current = controller;
    setRecallBusy(true);
    setRecallError('');
    try {
      const result = await api<ManagerRecallResponse>(
        '/api/context/recall',
        {
          includeArchived,
          ...(callerCwd.trim() && scopeKind === 'repository' ? {callerCwd: callerCwd.trim()} : {}),
          ...(project.trim() ? {project: project.trim()} : {}),
          query: recallQuery.trim(),
          ...(workset.trim() && scopeKind === 'workset' ? {workset: workset.trim()} : {}),
        },
        {signal: controller.signal},
      );
      if (!controller.signal.aborted) {
        setRecall(result);
        setRecallPage(0);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setRecallError(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) setRecallBusy(false);
    }
  }

  async function readContext(uri: string, page = 0): Promise<void> {
    readRequest.current?.abort();
    const controller = new AbortController();
    readRequest.current = controller;
    setReadBusy(true);
    setReadError('');
    if (page === 0 && readResult?.canonicalUri !== uri) setReadResult(undefined);
    try {
      const result = await api<ManagerContextReadResponse>(
        '/api/context/read',
        {page, uri},
        {signal: controller.signal},
      );
      if (!controller.signal.aborted) setReadResult(result);
    } catch (cause) {
      if (!controller.signal.aborted) setReadError(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) setReadBusy(false);
    }
  }

  function setScope(next: ContextScopeKind): void {
    briefRequest.current?.abort();
    invalidateRecall();
    setScopeKind(next);
    setBriefBusy(false);
    setBrief(undefined);
    setBriefError('');
  }

  function invalidateRecall(): void {
    recallRequest.current?.abort();
    recallRequest.current = undefined;
    setRecallBusy(false);
    setRecall(undefined);
    setRecallPage(0);
    setRecallError('');
  }

  function cancelBrief(): void {
    briefRequest.current?.abort();
    briefRequest.current = undefined;
    setBriefBusy(false);
  }

  return (
    <div className="context-workspace">
      <header className="workspace-header context-header">
        <div>
          <p className="eyebrow">Agent evidence workspace</p>
          <h2>Context Brief &amp; Recall</h2>
          <p>
            Compose bounded graph-and-memory context, or retrieve ranked memory pointers and read the canonical source.
            Repository and memory text is untrusted evidence and is never treated as an instruction here.
          </p>
        </div>
        <div aria-label="Context workspace view" className="segmented-control" role="tablist">
          {(['brief', 'recall'] as const).map(next => (
            <button
              aria-selected={view === next}
              className={view === next ? 'is-active' : undefined}
              disabled={graphRecoveryBusy}
              key={next}
              onClick={() => setView(next)}
              role="tab"
              type="button"
            >
              {next === 'brief' ? 'Context Brief' : 'Recall & read'}
            </button>
          ))}
        </div>
      </header>

      <section className="context-scope-card" aria-label="Context scope">
        <div className="context-scope-kind">
          <span>Scope</span>
          <div className="segmented-control">
            <button
              className={scopeKind === 'repository' ? 'is-active' : undefined}
              disabled={graphRecoveryBusy}
              onClick={() => setScope('repository')}
              type="button"
            >
              Repository
            </button>
            <button
              className={scopeKind === 'workset' ? 'is-active' : undefined}
              disabled={graphRecoveryBusy}
              onClick={() => setScope('workset')}
              type="button"
            >
              Workset
            </button>
          </div>
        </div>
        <label>
          {scopeKind === 'repository' ? 'Caller workspace' : 'Prepared Workset'}
          <input
            disabled={graphRecoveryBusy}
            onChange={event => {
              invalidateRecall();
              if (scopeKind === 'repository') setCallerCwd(event.target.value);
              else setWorkset(event.target.value);
            }}
            placeholder={scopeKind === 'repository' ? '/absolute/path/to/repository' : 'platform'}
            value={scopeKind === 'repository' ? callerCwd : workset}
          />
        </label>
        <label>
          Memory project
          <input
            disabled={graphRecoveryBusy}
            onChange={event => {
              invalidateRecall();
              setProject(event.target.value);
            }}
            placeholder="blank = inferred/all"
            value={project}
          />
        </label>
      </section>

      {view === 'brief' ? (
        <section aria-busy={briefBusy || graphRecoveryBusy} className="context-compose" role="tabpanel">
          <div className="context-compose-form">
            <label className="context-task-field">
              Engineering task
              <textarea
                disabled={graphRecoveryBusy}
                onChange={event => setTask(event.target.value)}
                placeholder="Explain the contract around this code and surface current decisions"
                rows={4}
                value={task}
              />
            </label>
            <label>
              Mode
              <select
                disabled={graphRecoveryBusy}
                onChange={event => setMode(event.target.value as ContextBriefMode)}
                value={mode}
              >
                {(['brief', 'locate', 'explain', 'trace', 'impact'] as const).map(value => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label>
              Budget
              <input
                disabled={graphRecoveryBusy}
                max={1_500}
                min={CONTEXT_BRIEF_MINIMUM_ESTIMATED_TOKENS}
                onChange={event => setBudgetTokens(Number(event.target.value))}
                type="number"
                value={budgetTokens}
              />
            </label>
            <label className="context-code-refs">
              Code anchors
              <span className={tooManyCodeRefs ? 'is-warning' : undefined}>
                {codeRefs.length}/{CONTEXT_BRIEF_MAXIMUM_CODE_REFS}
              </span>
              <textarea
                disabled={graphRecoveryBusy}
                onChange={event => setCodeRefsText(event.target.value)}
                placeholder={'src/manager/context.ts\ncgs_…'}
                rows={3}
                value={codeRefsText}
              />
              {codeRefsError ? <small role="alert">{codeRefsError}</small> : null}
            </label>
            <div className="context-form-actions">
              <button
                disabled={
                  briefBusy ||
                  graphRecoveryBusy ||
                  Boolean(codeRefsError) ||
                  invalidBudget ||
                  !task.trim() ||
                  (scopeKind === 'repository' ? !callerCwd.trim() : !workset.trim())
                }
                onClick={() => void runBrief()}
                type="button"
              >
                {briefBusy ? 'Compiling…' : brief ? 'Rerun Context Brief' : 'Compile Context Brief'}
              </button>
              {briefBusy ? (
                <button onClick={cancelBrief} type="button">
                  Cancel
                </button>
              ) : null}
            </div>
          </div>
          <ContextStatus
            error={briefError}
            loading={briefBusy}
            loadingText="Compiling bounded graph and memory evidence…"
          />
          <ContextStatus
            error={graphRecoveryError}
            loading={graphRecoveryBusy}
            loadingText="Preparing graph evidence and recompiling this Context Brief…"
          />
          {graphRecoveryNotice && !graphRecoveryBusy ? (
            <p aria-live="polite" className="context-status is-success" role="status">
              {graphRecoveryNotice}
            </p>
          ) : null}
          {brief ? (
            <ContextBriefResult
              brief={brief.structuredContent}
              onOpenMemory={uri => void readContext(uri)}
              onRecoverGraph={scope => void recoverGraph(scope)}
              recoveryBusy={graphRecoveryBusy}
              onRerun={overrides => void runBrief(overrides)}
            />
          ) : !briefBusy && !briefError ? (
            <ContextEmpty
              title="No brief compiled yet"
              text="Choose a repository or prepared Workset, describe the task, and optionally add exact file or graph anchors."
            />
          ) : null}
        </section>
      ) : (
        <section aria-busy={recallBusy} className="context-recall" role="tabpanel">
          <div className="context-recall-form">
            <label>
              Recall query
              <input
                onChange={event => {
                  invalidateRecall();
                  setRecallQuery(event.target.value);
                }}
                onKeyDown={event => {
                  if (event.key === 'Enter') void runRecall();
                }}
                placeholder="Context Brief Manager decisions and current handoff"
                value={recallQuery}
              />
            </label>
            <label className="context-check">
              <input
                checked={includeArchived}
                onChange={event => {
                  invalidateRecall();
                  setIncludeArchived(event.target.checked);
                }}
                type="checkbox"
              />
              Include inactive memory
            </label>
            <button disabled={recallBusy || !recallQuery.trim()} onClick={() => void runRecall()} type="button">
              {recallBusy ? 'Searching…' : 'Recall context'}
            </button>
          </div>
          <ContextStatus error={recallError} loading={recallBusy} loadingText="Ranking bounded memory pointers…" />
          {recall ? (
            <RecallResults
              onOpen={uri => void readContext(uri)}
              onPage={setRecallPage}
              page={recallPage}
              response={recall}
            />
          ) : !recallBusy && !recallError ? (
            <ContextEmpty
              title="Recall returns pointers, not evidence"
              text="Search by decision, contract, handoff, or implementation concept. Open a result to read its canonical source."
            />
          ) : null}
        </section>
      )}

      {readBusy || readResult || readError ? (
        <ContextReader
          busy={readBusy}
          error={readError}
          onClose={() => {
            readRequest.current?.abort();
            setReadBusy(false);
            setReadResult(undefined);
            setReadError('');
          }}
          onPage={(uri, page) => void readContext(uri, page)}
          result={readResult}
        />
      ) : null}
    </div>
  );
}

export function ContextBriefResult(props: {
  readonly brief: ContextBriefV1;
  readonly onOpenMemory: (uri: string) => void;
  readonly onRecoverGraph: (scope: 'repository' | 'workset') => void;
  readonly onRerun: (overrides: BriefRunOverrides) => void;
  readonly recoveryBusy: boolean;
}): React.ReactElement {
  const brief = props.brief;
  const anchors = brief.coverage.memory.codeAnchors;
  return (
    <div className="context-brief-result" aria-label="Context Brief result">
      <div className="context-metrics">
        <Metric
          label="Freshness"
          value={brief.scope.freshness}
          tone={brief.scope.freshness === 'fresh' ? 'ok' : 'warn'}
        />
        <Metric
          label="Repositories"
          value={`${brief.scope.readyRepositories}/${brief.scope.requestedRepositories} ready`}
          tone={brief.coverage.graph.complete ? 'ok' : 'warn'}
        />
        <Metric
          label="Memory"
          value={`${brief.durableDecisions.length} decisions · ${brief.activeHandoffs.length} handoffs · ${brief.coverage.memory.consideredCandidates} considered`}
        />
        <Metric
          label="Code anchors"
          value={
            anchors ? `${anchors.resolved}/${anchors.requested} resolved · ${anchors.matchedMemories} memories` : 'none'
          }
          tone={anchors && !anchors.complete ? 'warn' : 'ok'}
        />
        <Metric
          label="Output"
          value={`${brief.output.returnedItems} items${brief.output.truncated ? ` · ${brief.output.omittedItems} omitted` : ''}`}
          tone={brief.output.truncated ? 'warn' : 'ok'}
        />
      </div>

      {brief.coverage.gaps.length > 0 ? (
        <section className="context-notices" aria-label="Coverage gaps">
          <h3>Coverage gaps</h3>
          {brief.coverage.gaps.map(gap => (
            <p key={gap}>{gap}</p>
          ))}
        </section>
      ) : null}

      <div className="context-evidence-grid">
        <section className="context-evidence-column">
          <SectionHeading count={brief.graph.cards.length} title="Graph evidence" />
          {brief.graph.cards.length === 0 ? (
            <SmallEmpty text="No graph cards survived the bounded projection." />
          ) : null}
          {brief.graph.cards.map(card => (
            <GraphEvidenceCard card={card} key={card.id} onRerun={props.onRerun} />
          ))}
          {brief.graph.continuation ? (
            <div className="context-continuation">
              <strong>More graph evidence is available</strong>
              <span>
                {brief.graph.continuation.state === 'available'
                  ? `${brief.graph.continuation.remainingEstimate} estimated cards remain.`
                  : `${brief.graph.continuation.omittedCards} cards were omitted; narrow the task and rerun.`}
              </span>
              <button
                onClick={() =>
                  props.onRerun({
                    mode: 'locate',
                    task: `${brief.task.summary} Narrow to the most relevant implementation surface and its direct constraints.`,
                  })
                }
                type="button"
              >
                Narrow and rerun
              </button>
            </div>
          ) : null}
        </section>

        <section className="context-evidence-column">
          <SectionHeading count={brief.durableDecisions.length + brief.activeHandoffs.length} title="Memory evidence" />
          {[...brief.durableDecisions, ...brief.activeHandoffs].length === 0 ? (
            <SmallEmpty text="No active durable memory or handoff survived this brief." />
          ) : null}
          {brief.durableDecisions.map(memory => (
            <MemoryEvidenceCard key={memory.uri} memory={memory} onOpen={props.onOpenMemory} />
          ))}
          {brief.activeHandoffs.map(memory => (
            <MemoryEvidenceCard key={memory.uri} memory={memory} onOpen={props.onOpenMemory} />
          ))}
        </section>
      </div>

      {brief.graph.contracts.length > 0 ? (
        <section className="context-contracts">
          <SectionHeading count={brief.graph.contracts.length} title="Relationships" />
          <div>
            {brief.graph.contracts.map(contract => (
              <article key={contract.id}>
                <strong>{contract.relation}</strong>
                <code>{contract.sourceRef}</code>
                <span>→</span>
                <code>{contract.targetRef}</code>
                <small>
                  {contract.authority} · {contract.provenance} · {contract.evidence.path}:{contract.evidence.line}
                </small>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {brief.stalenessAndConflicts.length > 0 ? (
        <section className="context-notices is-warning">
          <h3>Staleness and conflicts</h3>
          {brief.stalenessAndConflicts.map(issue => (
            <article key={issue.id}>
              <strong>{issue.kind}</strong>
              <p>{issue.summary}</p>
              {issue.uris.map(uri => (
                <button key={uri} onClick={() => props.onOpenMemory(uri)} type="button">
                  Read affected memory
                </button>
              ))}
            </article>
          ))}
        </section>
      ) : null}

      {brief.recommendedFollowUps.length > 0 ? (
        <section className="context-followups">
          <SectionHeading count={brief.recommendedFollowUps.length} title="Recommended follow-ups" />
          {brief.recommendedFollowUps.map(followUp => (
            <FollowUpAction
              followUp={followUp}
              key={followUp.id}
              onOpenMemory={props.onOpenMemory}
              onRecoverGraph={props.onRecoverGraph}
              onRerun={props.onRerun}
              recoveryBusy={props.recoveryBusy}
            />
          ))}
        </section>
      ) : null}
    </div>
  );
}

function GraphEvidenceCard(props: {
  readonly card: ContextBriefV1['graph']['cards'][number];
  readonly onRerun: (overrides: BriefRunOverrides) => void;
}): React.ReactElement {
  const card = props.card;
  const codeRefs = contextBriefRerunCodeRefs(card.ref);
  return (
    <article className="context-graph-card">
      <header>
        <span>{card.symbol.kind}</span>
        <strong>{card.symbol.qualifiedName}</strong>
      </header>
      <code>
        {card.symbol.path}:{card.symbol.line}
      </code>
      <p>{card.reason}</p>
      <footer>
        <span>{card.repositoryKey}</span>
        <button
          onClick={() =>
            props.onRerun({
              ...(codeRefs === undefined ? {} : {codeRefs}),
              mode: 'explain',
              task:
                codeRefs === undefined
                  ? `Narrow the Workset to ${card.symbol.qualifiedName} and explain its current contract and related memory.`
                  : `Explain the current contract and related memory for ${card.symbol.qualifiedName}.`,
            })
          }
          type="button"
        >
          {codeRefs === undefined ? 'Narrow Workset and rerun' : 'Rerun from this ref'}
        </button>
      </footer>
    </article>
  );
}

function RecallResults(props: {
  readonly onOpen: (uri: string) => void;
  readonly onPage: (page: number) => void;
  readonly page: number;
  readonly response: ManagerRecallResponse;
}): React.ReactElement {
  const response = props.response;
  const page = projectManagerRecallPage(response.results, props.page, MANAGER_CONTEXT_RECALL_PAGE_SIZE_DEFAULT);
  return (
    <div className="context-recall-results" aria-label="Ranked recall results">
      <header>
        <div>
          <h3>
            {response.results.length === 0
              ? 'No ranked pointers'
              : `${response.resultSet.availableResults} ranked pointers`}
          </h3>
          <p>
            {response.confidence
              ? `${response.confidence.level.replaceAll('_', ' ')} confidence · ${response.confidence.reason}`
              : 'Open a pointer before using it as evidence.'}
          </p>
          {response.resultSet.truncated ? (
            <p>
              Showing the top {response.resultSet.availableResults} of {response.resultSet.totalRanked} ranked matches.
            </p>
          ) : null}
        </div>
        <span>
          Page {page.index + 1} of {page.pageCount} · {response.trust.replaceAll('-', ' ')}
        </span>
      </header>
      {response.results.length === 0 ? (
        <ContextEmpty
          title="No active match"
          text="Try a more specific contract, decision, component, or handoff term."
        />
      ) : (
        <div className="context-recall-list" role="list">
          {page.results.map(result => (
            <RecallResultCard key={`${result.rank}:${result.canonicalUri}`} onOpen={props.onOpen} result={result} />
          ))}
        </div>
      )}
      {response.queryExpansions.length > 0 ? (
        <div className="context-query-expansions">
          <strong>Evaluated query expansions</strong>
          {response.queryExpansions.map(expansion => (
            <span key={expansion}>{expansion}</span>
          ))}
        </div>
      ) : null}
      {response.warnings.length > 0 ? (
        <div className="context-notices is-warning" aria-label="Recall warnings">
          <h3>Recall may be incomplete</h3>
          {response.warnings.map(warning => (
            <p key={warning.code}>
              {warning.message} {warning.remediation}
            </p>
          ))}
        </div>
      ) : null}
      {page.hasPrevious || page.hasNext ? (
        <div className="context-page-actions">
          <button disabled={!page.hasPrevious} onClick={() => props.onPage(page.index - 1)} type="button">
            Previous
          </button>
          <button disabled={!page.hasNext} onClick={() => props.onPage(page.index + 1)} type="button">
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}

function RecallResultCard(props: {
  readonly onOpen: (uri: string) => void;
  readonly result: ManagerRecallResult;
}): React.ReactElement {
  const result = props.result;
  return (
    <article className="context-recall-card" role="listitem">
      <button onClick={() => props.onOpen(result.canonicalUri)} type="button">
        <span className="context-rank">#{result.rank}</span>
        <span className="context-recall-card-main">
          <strong>{result.metadata?.topic ?? result.canonicalUri.split('/').at(-1)}</strong>
          <small>
            {result.readState} · {result.category} · {result.metadata?.kind ?? result.contextType}
            {result.metadata?.project ? ` · ${result.metadata.project}` : ''}
            {result.confidence === undefined ? '' : ` · ${Math.round(result.confidence * 100)}%`}
          </small>
          <span>{result.snippet || result.reason}</span>
          {result.snippet && result.reason !== result.snippet ? (
            <span className="context-recall-reason">Why: {result.reason}</span>
          ) : null}
          <code>{result.canonicalUri}</code>
          {result.requestedUri !== result.canonicalUri ? <em>Relocated from the recalled URI</em> : null}
          {result.warnings.map(warning => (
            <em className="is-warning" key={warning}>
              {warning}
            </em>
          ))}
        </span>
        <span aria-hidden="true">→</span>
      </button>
    </article>
  );
}

function ContextReader(props: {
  readonly busy: boolean;
  readonly error: string;
  readonly onClose: () => void;
  readonly onPage: (uri: string, page: number) => void;
  readonly result?: ManagerContextReadResponse;
}): React.ReactElement {
  const result = props.result;
  return (
    <aside aria-label="Canonical context reader" className="context-reader">
      <header>
        <div>
          <p className="eyebrow">Canonical source</p>
          <h3>{result?.title ?? 'Reading context…'}</h3>
          <code>{result?.canonicalUri ?? ''}</code>
        </div>
        <button aria-label="Close context reader" onClick={props.onClose} type="button">
          Close
        </button>
      </header>
      {result && result.requestedUri !== result.canonicalUri ? (
        <p className="context-reader-relocation">Resolved the requested pointer to its canonical memory.</p>
      ) : null}
      {result?.metadata ? (
        <div className="context-reader-metadata">
          <span>{result.metadata.kind}</span>
          <span>{result.metadata.status}</span>
          {result.metadata.project ? <span>{result.metadata.project}</span> : null}
          {result.metadata.trust ? <span>{result.metadata.trust}</span> : null}
        </div>
      ) : null}
      {props.busy ? <ContextStatus loading loadingText="Reading canonical context…" error="" /> : null}
      {props.error ? <ContextStatus error={props.error} loading={false} loadingText="" /> : null}
      {result ? <pre>{result.content}</pre> : null}
      {result && result.page.total > 1 ? (
        <footer>
          <button
            disabled={result.page.previous === undefined || props.busy}
            onClick={() => props.onPage(result.requestedUri, result.page.previous!)}
            type="button"
          >
            Previous page
          </button>
          <span>
            Page {result.page.index + 1}/{result.page.total}
          </span>
          <button
            disabled={result.page.next === undefined || props.busy}
            onClick={() => props.onPage(result.requestedUri, result.page.next!)}
            type="button"
          >
            Next page
          </button>
        </footer>
      ) : null}
    </aside>
  );
}

function MemoryEvidenceCard(props: {
  readonly memory: ContextBriefMemoryEvidenceV1;
  readonly onOpen: (uri: string) => void;
}): React.ReactElement {
  const memory = props.memory;
  return (
    <article className="context-memory-card">
      <header>
        <span>{memory.kind}</span>
        <strong>{memory.topic ?? memory.uri.split('/').at(-1)}</strong>
        <em className={`is-${memory.freshness}`}>{memory.preciseStatus ?? memory.freshness}</em>
      </header>
      <p>{memory.excerpt}</p>
      <div className="context-memory-metadata">
        <span>{memory.freshnessBasis}</span>
        {memory.authority ? <span>{memory.authority}</span> : null}
        {memory.selectionBasis ? <span>selected by {memory.selectionBasis}</span> : null}
        {memory.citationSummary ? (
          <span>
            citations: {memory.citationSummary.exact} exact · {memory.citationSummary.relocated} relocated ·{' '}
            {memory.citationSummary.stale} stale · {memory.citationSummary.unknown} unknown
          </span>
        ) : null}
      </div>
      {memory.codeRelations && memory.codeRelations.length > 0 ? (
        <div className="context-memory-relations">
          {memory.codeRelations.map(relation => (
            <span key={`${relation.anchorOrdinal}:${relation.citationId}`}>
              {relation.kind} anchor {relation.anchorOrdinal + 1} · {relation.status}
            </span>
          ))}
        </div>
      ) : null}
      <footer>
        <code>{memory.uri}</code>
        <button onClick={() => props.onOpen(memory.uri)} type="button">
          Open memory
        </button>
      </footer>
    </article>
  );
}

function FollowUpAction(props: {
  readonly followUp: ContextBriefFollowUpV1;
  readonly onOpenMemory: (uri: string) => void;
  readonly onRecoverGraph: (scope: 'repository' | 'workset') => void;
  readonly onRerun: (overrides: BriefRunOverrides) => void;
  readonly recoveryBusy: boolean;
}): React.ReactElement {
  const followUp = props.followUp;
  if (followUp.operation === 'read-memory') {
    return (
      <button onClick={() => props.onOpenMemory(followUp.uri)} type="button">
        Read recommended memory
      </button>
    );
  }
  if (followUp.operation === 'inspect-node') {
    const codeRefs = contextBriefRerunCodeRefs(followUp.ref);
    return (
      <button
        onClick={() =>
          props.onRerun({
            ...(codeRefs === undefined ? {} : {codeRefs}),
            mode: 'explain',
            task:
              codeRefs === undefined
                ? 'Narrow the Workset to this repository-qualified graph result and explain its memory constraints.'
                : `Explain this graph node and the memory constraints that cite it: ${followUp.ref}`,
          })
        }
        type="button"
      >
        {codeRefs === undefined ? 'Narrow Workset and rerun' : 'Inspect node and rerun'}
      </button>
    );
  }
  if (followUp.operation === 'prepare-workset') {
    return (
      <button
        onClick={() =>
          props.onRerun({
            task: `Explain the current readiness and evidence gaps for Workset ${followUp.workset}.`,
            workset: followUp.workset,
          })
        }
        type="button"
      >
        Switch to {followUp.workset} scope and rerun
      </button>
    );
  }
  if (followUp.operation === 'graph-status') {
    return (
      <button disabled={props.recoveryBusy} onClick={() => props.onRecoverGraph(followUp.scope)} type="button">
        {props.recoveryBusy
          ? 'Preparing graph…'
          : followUp.scope === 'repository'
            ? 'Index graph and rerun'
            : 'Prepare Workset and rerun'}
      </button>
    );
  }
  return (
    <button
      onClick={() =>
        props.onRerun({mode: 'locate', task: 'Narrow the Workset query so its remaining evidence can be retrieved.'})
      }
      type="button"
    >
      Narrow before continuing Workset
    </button>
  );
}

async function prepareWorksetForContext(workset: string, signal: AbortSignal): Promise<string> {
  let job = (
    await api<{readonly job: ManagerWorksetPrepareJob}>('/api/worksets/prepare', {concurrency: 2, workset}, {signal})
  ).job;
  let polls = 0;
  while (job.status === 'running' || job.status === 'cancelling') {
    if (polls >= CONTEXT_WORKSET_RECOVERY_MAXIMUM_POLLS) {
      throw new Error('Workset preparation is still running. Monitor it in Worksets, then rerun this Context Brief.');
    }
    await contextRecoveryDelay(signal);
    job = (
      await api<{readonly job: ManagerWorksetPrepareJob}>(
        `/api/worksets/jobs/${encodeURIComponent(job.id)}`,
        undefined,
        {
          signal,
        },
      )
    ).job;
    polls += 1;
  }
  if (job.status !== 'completed' || job.result?.state !== 'ready') {
    throw new Error(job.error ?? `Workset preparation ended with status ${job.status}.`);
  }
  return `Workset ${job.workset} is ready.`;
}

function contextRecoveryDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Context graph recovery was cancelled.'));
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new Error('Context graph recovery was cancelled.'));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, CONTEXT_WORKSET_RECOVERY_POLL_MILLISECONDS);
    signal.addEventListener('abort', onAbort, {once: true});
  });
}

function Metric(props: {
  readonly label: string;
  readonly tone?: 'ok' | 'warn';
  readonly value: string;
}): React.ReactElement {
  return (
    <div className={props.tone ? `is-${props.tone}` : undefined}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function SectionHeading(props: {readonly count: number; readonly title: string}): React.ReactElement {
  return (
    <header className="context-section-heading">
      <h3>{props.title}</h3>
      <span>{props.count}</span>
    </header>
  );
}

function ContextStatus(props: {
  readonly error: string;
  readonly loading: boolean;
  readonly loadingText: string;
}): React.ReactElement | null {
  if (props.loading) {
    return (
      <p aria-live="polite" className="context-status" role="status">
        <span aria-hidden="true" className="spinner" /> {props.loadingText}
      </p>
    );
  }
  if (props.error) {
    return (
      <p aria-live="polite" className="context-status is-error" role="alert">
        {props.error}
      </p>
    );
  }
  return null;
}

function ContextEmpty(props: {readonly text: string; readonly title: string}): React.ReactElement {
  return (
    <div className="context-empty">
      <span aria-hidden="true">◎</span>
      <h3>{props.title}</h3>
      <p>{props.text}</p>
    </div>
  );
}

function SmallEmpty(props: {readonly text: string}): React.ReactElement {
  return <p className="context-small-empty">{props.text}</p>;
}

export function parseCodeRefs(value: string): readonly string[] {
  return [...new Set(value.split(/[\n,]/u).filter(item => item.length > 0))];
}

function contextBriefRerunCodeRefs(ref: string): readonly string[] | undefined {
  try {
    return parseContextBriefCodeRefs([ref]);
  } catch {
    return undefined;
  }
}
