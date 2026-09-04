import {Schema} from 'effect';
import React, {useEffect, useRef, useState} from 'react';
import {useManagerDialogs} from './dialog.js';
import {ManagerApiError, api, errorMessage} from './ui_support.js';
import type {
  ManagerManifestProject,
  ManagerManifestProjectMutationResult,
  ManagerWorksetCatalog,
  ManagerWorksetProjectSummary,
} from './worksets.js';

interface ProjectDraft {
  readonly mode: 'create' | 'edit';
  readonly name: string;
  readonly originalName?: string;
  readonly path: string;
  readonly seedText: string;
  readonly uri: string;
}

export interface ManifestProjectsPanelProps {
  readonly catalog?: ManagerWorksetCatalog;
  readonly catalogError: string;
  readonly onCatalog: (catalog: ManagerWorksetCatalog) => void;
  readonly onRefreshCatalog: () => Promise<void>;
  readonly onSwitchToWorksets: () => void;
}

export function ManifestProjectsPanel(props: ManifestProjectsPanelProps): React.ReactElement {
  const dialogs = useManagerDialogs();
  const [selectedName, setSelectedName] = useState('');
  const [selectedProject, setSelectedProject] = useState<ManagerManifestProject>();
  const [draft, setDraft] = useState<ProjectDraft>();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [detailError, setDetailError] = useState('');
  const detailRequestRef = useRef<AbortController | undefined>(undefined);
  const detailSequenceRef = useRef(0);

  useEffect(() => {
    const projects = props.catalog?.projects ?? [];
    setSelectedName(current =>
      projects.some(project => project.name.toLowerCase() === current.toLowerCase())
        ? current
        : (projects[0]?.name ?? ''),
    );
  }, [props.catalog?.projects]);

  useEffect(() => {
    setSelectedProject(undefined);
    setDetailError('');
    if (selectedName) void loadProject(selectedName);
  }, [selectedName, props.catalog?.revision]);

  useEffect(
    () => () => {
      detailSequenceRef.current += 1;
      detailRequestRef.current?.abort();
    },
    [],
  );

  async function loadProject(name: string): Promise<void> {
    detailRequestRef.current?.abort();
    const controller = new AbortController();
    detailRequestRef.current = controller;
    const sequence = detailSequenceRef.current + 1;
    detailSequenceRef.current = sequence;
    setLoading(true);
    try {
      const project = await api<ManagerManifestProject>(
        `/api/worksets/project?project=${encodeURIComponent(name)}`,
        undefined,
        {signal: controller.signal},
      );
      if (sequence !== detailSequenceRef.current || controller.signal.aborted) return;
      setSelectedProject(project);
      setDetailError('');
    } catch (cause) {
      if (sequence === detailSequenceRef.current && !controller.signal.aborted) {
        setDetailError(errorMessage(cause));
      }
    } finally {
      if (sequence === detailSequenceRef.current) setLoading(false);
    }
  }

  function openCreate(): void {
    setNotice('');
    setDraft({mode: 'create', name: '', path: '', seedText: '', uri: ''});
  }

  function openEdit(): void {
    if (!selectedProject) return;
    setNotice('');
    setDraft({
      mode: 'edit',
      name: selectedProject.name,
      originalName: selectedProject.name,
      path: selectedProject.path,
      seedText: selectedProject.seed.join('\n'),
      uri: selectedProject.uri,
    });
  }

  async function saveProject(): Promise<void> {
    if (!draft || !props.catalog) return;
    setBusy(true);
    setNotice('');
    try {
      const result = await api<ManagerManifestProjectMutationResult>('/api/worksets/projects', {
        expectedRevision: props.catalog.revision,
        name: draft.name,
        operation: draft.mode === 'create' ? 'create' : 'update',
        path: draft.path,
        seed: seedLines(draft.seedText),
        uri: draft.uri,
        ...(draft.originalName === undefined ? {} : {project: draft.originalName}),
      });
      props.onCatalog(result.catalog);
      const savedName =
        result.catalog.projects.find(project => project.name.toLowerCase() === draft.name.toLowerCase())?.name ??
        draft.name;
      setSelectedName(savedName);
      setSelectedProject(undefined);
      setDraft(undefined);
      setNotice(result.warnings.join(' ') || (result.changed ? 'Manifest project saved.' : 'No project change.'));
    } catch (cause) {
      if (Schema.is(ManagerApiError)(cause) && cause.code === 'revision-conflict') {
        setNotice('The manifest changed. Projects were refreshed; your draft is preserved for review and retry.');
        await props.onRefreshCatalog();
      } else {
        setNotice(errorMessage(cause));
      }
    } finally {
      setBusy(false);
    }
  }

  async function deleteProject(project: ManagerWorksetProjectSummary): Promise<void> {
    if (!props.catalog) return;
    const referenceLabel = `${project.worksetCount} ${project.worksetCount === 1 ? 'Workset' : 'Worksets'}`;
    const visibleWorksets = project.worksets.slice(0, 8);
    const omittedWorksets = project.worksets.length - visibleWorksets.length;
    const affectedWorksets =
      visibleWorksets.length === 0
        ? ''
        : `: ${visibleWorksets.join(', ')}${omittedWorksets > 0 ? `, +${omittedWorksets} more` : ''}`;
    const confirmed = await dialogs.confirm({
      cancelLabel: 'Keep project',
      confirmLabel: 'Confirm project deletion',
      detail: `${project.name} · referenced by ${referenceLabel}${affectedWorksets}`,
      message:
        'Referencing Worksets will keep this project name as an unresolved member. Resources and repository graphs are not deleted.',
      title: 'Delete manifest project?',
      tone: 'danger',
    });
    if (!confirmed) return;
    setBusy(true);
    setNotice('');
    try {
      const result = await api<ManagerManifestProjectMutationResult>('/api/worksets/projects', {
        confirm: true,
        expectedRevision: props.catalog.revision,
        operation: 'delete',
        project: project.name,
      });
      props.onCatalog(result.catalog);
      setSelectedName(result.catalog.projects[0]?.name ?? '');
      setSelectedProject(undefined);
      setNotice(result.warnings.join(' ') || 'Manifest project deleted. Referencing Worksets are now unresolved.');
    } catch (cause) {
      setNotice(errorMessage(cause));
      await props.onRefreshCatalog();
    } finally {
      setBusy(false);
    }
  }

  const selectedSummary = props.catalog?.projects.find(
    project => project.name.toLowerCase() === selectedName.toLowerCase(),
  );
  const projectsReadOnly = props.catalog?.projectsReadOnly ?? true;

  return (
    <div
      aria-labelledby="manifest-management-tab-projects"
      className="worksets-workspace projects-workspace"
      id="manifest-management-panel-projects"
      role="tabpanel"
    >
      <aside
        aria-hidden={draft ? true : undefined}
        aria-label="Manifest projects"
        className="worksets-catalog"
        inert={draft ? true : undefined}
      >
        <div className="worksets-section-head">
          <div>
            <p className="eyebrow">Seed manifest</p>
            <h2>Projects</h2>
          </div>
          <button
            aria-label="Create project"
            disabled={!props.catalog || projectsReadOnly}
            onClick={openCreate}
            title="Create project"
            type="button"
          >
            +
          </button>
        </div>
        <ProjectEditabilityBoundary catalog={props.catalog} />
        {props.catalogError ? <p className="worksets-error">{props.catalogError}</p> : null}
        <div className="worksets-definition-list projects-list">
          {props.catalog?.projects.map(project => (
            <button
              aria-current={selectedName.toLowerCase() === project.name.toLowerCase() ? 'true' : undefined}
              className={selectedName.toLowerCase() === project.name.toLowerCase() ? 'is-selected' : undefined}
              key={project.name}
              onClick={() => setSelectedName(project.name)}
              type="button"
            >
              <strong>{project.name}</strong>
              <span>{managerManifestProjectLocation(project)}</span>
              <span>
                {project.worksetCount} {project.worksetCount === 1 ? 'Workset' : 'Worksets'}
              </span>
            </button>
          ))}
          {props.catalog && props.catalog.projects.length === 0 ? <p>No manifest projects yet.</p> : null}
        </div>
        <button className="quiet-button" onClick={() => void props.onRefreshCatalog()} type="button">
          Refresh projects
        </button>
      </aside>

      <section aria-hidden={draft ? true : undefined} className="worksets-main" inert={draft ? true : undefined}>
        {notice ? (
          <p className="worksets-notice" role="status">
            {notice}
          </p>
        ) : null}
        {selectedSummary ? (
          <>
            <header className="worksets-header">
              <div>
                <p className="eyebrow">Manifest repository</p>
                <h2>{selectedSummary.name}</h2>
                <p>{managerManifestProjectLocation(selectedSummary)}</p>
              </div>
              <div className="button-row">
                <button disabled={projectsReadOnly || !selectedProject || busy} onClick={openEdit} type="button">
                  Edit project
                </button>
                <button
                  className="danger"
                  disabled={projectsReadOnly || busy}
                  onClick={() => void deleteProject(selectedSummary)}
                  type="button"
                >
                  Delete project
                </button>
              </div>
            </header>
            {detailError ? (
              <p className="worksets-error" role="alert">
                {detailError}
              </p>
            ) : null}
            <section aria-label="Project manifest configuration" className="worksets-card project-detail-card">
              <div className="worksets-metrics">
                <Metric label="Worksets" value={String(selectedSummary.worksetCount)} />
                <Metric label="Branch" value={branchLabel(selectedSummary)} />
                <Metric label="Folder" value={selectedSummary.folder} />
                <Metric label="Seed patterns" value={String(selectedProject?.seed.length ?? 0)} />
              </div>
              {loading ? <p className="worksets-muted">Loading authoritative project fields…</p> : null}
              {selectedProject ? (
                <dl className="project-manifest-fields">
                  <div>
                    <dt>Configured path</dt>
                    <dd>{selectedProject.path}</dd>
                  </div>
                  <div>
                    <dt>Resource URI</dt>
                    <dd>{selectedProject.uri}</dd>
                  </div>
                  <div>
                    <dt>Seed patterns</dt>
                    <dd>{selectedProject.seed.length > 0 ? selectedProject.seed.join(', ') : 'No seed patterns'}</dd>
                  </div>
                </dl>
              ) : null}
            </section>
          </>
        ) : (
          <div className="worksets-empty">
            <h2>Add your first manifest project</h2>
            <p>
              A Workset needs at least one project. Add a repository path, resource URI, and optional seed patterns.
            </p>
            <button disabled={!props.catalog || projectsReadOnly} onClick={openCreate} type="button">
              Add first project
            </button>
            {props.catalog?.definitions.length ? (
              <button className="quiet-button" onClick={props.onSwitchToWorksets} type="button">
                View unresolved Worksets
              </button>
            ) : null}
          </div>
        )}
      </section>

      {draft && props.catalog ? (
        <ProjectEditor
          busy={busy}
          draft={draft}
          notice={notice}
          renameAllowed={!props.catalog.readOnly || (selectedSummary?.worksetCount ?? 0) === 0}
          onCancel={() => {
            setDraft(undefined);
            setNotice('');
          }}
          onChange={setDraft}
          onSave={() => void saveProject()}
        />
      ) : null}
    </div>
  );
}

function ProjectEditabilityBoundary(props: {readonly catalog?: ManagerWorksetCatalog}): React.ReactElement {
  const catalog = props.catalog;
  const text = catalog?.projectsReadOnly
    ? catalog.projectEditability.reason === 'manifest-symlink'
      ? 'This manifest is a symbolic link, so projects are read-only in Manager.'
      : 'Project YAML uses aliases, anchors, or shapes that Manager will preserve but cannot edit safely.'
    : 'Projects are edited atomically in the authoritative seed manifest.';
  return <p className="worksets-boundary">{text}</p>;
}

function ProjectEditor(props: {
  readonly busy: boolean;
  readonly draft: ProjectDraft;
  readonly notice: string;
  readonly renameAllowed: boolean;
  readonly onCancel: () => void;
  readonly onChange: (draft: ProjectDraft) => void;
  readonly onSave: () => void;
}): React.ReactElement {
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialogRef.current?.querySelector<HTMLElement>('input, button, textarea')?.focus();
    return () => previous?.focus();
  }, []);
  const update = (change: Partial<ProjectDraft>): void => props.onChange({...props.draft, ...change});
  const handleDialogKeyboard = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape' && !props.busy) {
      event.preventDefault();
      props.onCancel();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const controls = [
      ...dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea'),
    ];
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="worksets-editor-backdrop" role="presentation">
      <section
        aria-labelledby="manifest-project-editor-title"
        aria-modal="true"
        className="worksets-editor project-editor"
        onKeyDown={handleDialogKeyboard}
        ref={dialogRef}
        role="dialog"
      >
        <header>
          <div>
            <p className="eyebrow">Authoritative manifest</p>
            <h2 id="manifest-project-editor-title">
              {props.draft.mode === 'create' ? 'Create project' : 'Edit project'}
            </h2>
          </div>
          <button aria-label="Close project editor" disabled={props.busy} onClick={props.onCancel} type="button">
            ×
          </button>
        </header>
        <label>
          Project name
          <input
            autoFocus
            disabled={props.busy || (props.draft.mode === 'edit' && !props.renameAllowed)}
            onChange={event => update({name: event.target.value})}
            value={props.draft.name}
          />
          {props.draft.mode === 'edit' && !props.renameAllowed ? (
            <span className="worksets-muted">Rename is unavailable until referenced Workset YAML is editable.</span>
          ) : null}
        </label>
        <label>
          Repository path
          <input
            disabled={props.busy}
            onChange={event => update({path: event.target.value})}
            placeholder="~/src/my-project"
            value={props.draft.path}
          />
        </label>
        <label>
          Resource URI
          <input
            disabled={props.busy}
            onChange={event => update({uri: event.target.value})}
            placeholder="threadnote://resources/repos/my-project"
            value={props.draft.uri}
          />
        </label>
        <label>
          Seed patterns <span className="worksets-muted">One repository-relative path or glob per line</span>
          <textarea
            disabled={props.busy}
            onChange={event => update({seedText: event.target.value})}
            placeholder={'AGENTS.md\ndocs/**/*.md'}
            rows={5}
            value={props.draft.seedText}
          />
        </label>
        {props.notice ? (
          <p className="worksets-error" role="alert">
            {props.notice}
          </p>
        ) : null}
        <footer>
          <button disabled={props.busy} onClick={props.onCancel} type="button">
            Cancel
          </button>
          <button
            disabled={props.busy || !props.draft.name.trim() || !props.draft.path.trim() || !props.draft.uri.trim()}
            onClick={props.onSave}
            type="button"
          >
            {props.busy ? 'Saving…' : 'Save project'}
          </button>
        </footer>
      </section>
    </div>
  );
}

function Metric(props: {readonly label: string; readonly value: string}): React.ReactElement {
  return (
    <div>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function seedLines(value: string): readonly string[] {
  return value.split(/\r?\n/u).filter(line => line.length > 0);
}

function branchLabel(project: ManagerWorksetProjectSummary): string {
  return project.branchState === 'current' && project.branch
    ? project.branch
    : project.branchState === 'detached'
      ? 'Detached checkout'
      : project.branchState === 'not-observed'
        ? 'Observation deferred'
        : 'Unavailable';
}

export function managerManifestProjectLocation(project: ManagerWorksetProjectSummary): string {
  const observedBranch =
    project.branchState === 'current' && project.branch
      ? `observed branch ${project.branch}`
      : project.branchState === 'detached'
        ? 'observed detached checkout'
        : project.branchState === 'not-observed'
          ? 'branch observation deferred'
          : 'branch observation unavailable';
  return [observedBranch, project.folder, project.path]
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join(' · ');
}
