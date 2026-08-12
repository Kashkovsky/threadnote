import React, {useEffect, useState} from 'react';
import {useManagerDialogs} from './manager_dialog.js';
import {api, errorMessage} from './manager_ui_support.js';
import type {
  ManageableThreadnoteProcessDiagnostic,
  ManageableThreadnoteProcessDiagnostics,
} from './process_diagnostics.js';

const PROCESS_POLL_MILLISECONDS = 2_000;

export function ProcessesPanel(): React.ReactElement {
  const dialogs = useManagerDialogs();
  const [diagnostics, setDiagnostics] = useState<ManageableThreadnoteProcessDiagnostics>();
  const [loadError, setLoadError] = useState('');
  const [operationError, setOperationError] = useState('');
  const [terminating, setTerminating] = useState<string>();

  const load = async (signal?: AbortSignal): Promise<void> => {
    try {
      const next = await api<ManageableThreadnoteProcessDiagnostics>('/api/processes', undefined, {signal});
      setDiagnostics(next);
      setLoadError('');
    } catch (cause) {
      if (!signal?.aborted) setLoadError(errorMessage(cause));
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      await load(controller.signal);
      if (!controller.signal.aborted) timer = window.setTimeout(() => void poll(), PROCESS_POLL_MILLISECONDS);
    };
    void poll();
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  const terminate = async (process: ManageableThreadnoteProcessDiagnostic): Promise<void> => {
    if (!process.terminable || process.processRef === undefined) return;
    const approved = await dialogs.confirm({
      confirmLabel: 'Terminate process',
      detail: `${processRoleLabel(process.role)} · PID ${process.processId}${process.currentOperation ? ` · ${process.currentOperation}` : ''}`,
      message: 'Threadnote will request a graceful stop and may force-stop this exact process instance if needed.',
      title: 'Terminate Threadnote process?',
      tone: 'danger',
    });
    if (!approved) return;
    setTerminating(process.processRef);
    setOperationError('');
    try {
      await api('/api/processes/terminate', {
        confirm: true,
        processId: process.processId,
        processRef: process.processRef,
      });
      await load();
    } catch (cause) {
      setOperationError(errorMessage(cause));
      await load();
    } finally {
      setTerminating(undefined);
    }
  };

  return (
    <div className="process-workspace">
      <header className="workspace-header process-header">
        <div>
          <p className="eyebrow">Runtime inventory</p>
          <h2>Threadnote processes</h2>
          <p>
            Registered processes and identity-verified legacy runtimes. Arguments, environment variables, and private
            registration data are never exposed.
          </p>
        </div>
        <button
          aria-label="Refresh process list"
          onClick={() => void load()}
          title="Refresh process list"
          type="button"
        >
          Refresh
        </button>
      </header>

      {loadError ? <p className="process-notice is-error">{loadError}</p> : null}
      {operationError ? (
        <p aria-live="polite" className="process-notice is-error">
          {operationError}
        </p>
      ) : null}
      {diagnostics?.truncated ? (
        <p className="process-notice">The bounded inventory is truncated. Refresh after other processes exit.</p>
      ) : null}

      <div className="process-list">
        {diagnostics === undefined ? (
          <p className="process-empty">Loading registered processes…</p>
        ) : diagnostics.processes.length === 0 ? (
          <p className="process-empty">No registered Threadnote processes are visible.</p>
        ) : (
          diagnostics.processes.map(process => (
            <article className="process-card" key={`${process.processId}:${process.startedAt}`}>
              <div className="process-card-main">
                <div className="process-card-title">
                  <strong>{processRoleLabel(process.role)}</strong>
                  {process.activityRole ? <em>{processRoleLabel(process.activityRole)} activity</em> : null}
                  <span>PID {process.processId}</span>
                </div>
                <p>{process.currentOperation ? operationLabel(process.currentOperation) : 'Idle'}</p>
                <dl>
                  <div>
                    <dt>Parent</dt>
                    <dd>{parentLabel(process)}</dd>
                  </div>
                  <div>
                    <dt>Running</dt>
                    <dd>{formatDuration(process.ageMilliseconds)}</dd>
                  </div>
                  <div>
                    <dt>Memory</dt>
                    <dd>{process.rssBytes === undefined ? 'Unavailable' : formatBytes(process.rssBytes)}</dd>
                  </div>
                  <div>
                    <dt>Version</dt>
                    <dd>{process.releaseVersion ? `v${process.releaseVersion}` : 'Current runtime'}</dd>
                  </div>
                </dl>
              </div>
              <button
                aria-label={`Terminate ${processRoleLabel(process.role)} process ${process.processId}`}
                className="icon-button danger process-terminate"
                disabled={!process.terminable || terminating !== undefined}
                onClick={() => void terminate(process)}
                title={terminationTitle(process)}
                type="button"
              >
                <svg aria-hidden="true" viewBox="0 0 20 20">
                  <rect height="9" rx="1" width="9" x="5.5" y="5.5" />
                </svg>
              </button>
            </article>
          ))
        )}
      </div>
    </div>
  );
}

function processRoleLabel(role: ManageableThreadnoteProcessDiagnostic['role']): string {
  switch (role) {
    case 'cli':
      return 'CLI';
    case 'graph-builder':
      return 'Graph builder';
    case 'graph-compaction-worker':
      return 'Graph compaction worker';
    case 'graph-diagnostics-worker':
      return 'Graph diagnostics worker';
    case 'graph-parser-worker':
      return 'Graph parser worker';
    case 'graph-waiter':
      return 'Graph waiter';
    case 'legacy':
      return 'Legacy runtime';
    case 'local-model-worker':
      return 'Local model worker';
    case 'manager':
      return 'Manager';
    case 'mcp':
      return 'MCP server';
  }
}

function operationLabel(operation: string): string {
  return operation
    .split('-')
    .filter(Boolean)
    .map((part, index) => (index === 0 ? `${part.slice(0, 1).toUpperCase()}${part.slice(1)}` : part))
    .join(' ');
}

function parentLabel(process: ManageableThreadnoteProcessDiagnostic): string {
  if (process.parentProcessId === 0) return 'Unavailable';
  return process.parentRole
    ? `${processRoleLabel(process.parentRole)} · PID ${process.parentProcessId}`
    : `PID ${process.parentProcessId}`;
}

function terminationTitle(process: ManageableThreadnoteProcessDiagnostic): string {
  if (process.terminable) return `Terminate ${processRoleLabel(process.role)}`;
  switch (process.terminationBlockedReason) {
    case 'current-manager':
      return 'The current Manager process is protected';
    case 'identity-unverified':
      return 'Process identity could not be verified';
    case 'legacy-process':
      return 'Restart the owning client to stop this legacy process safely';
    default:
      return 'This process cannot be terminated from Manager';
  }
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}
