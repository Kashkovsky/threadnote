import type {
  CodeGraphWorksetPrepareIndexActivityV1,
  CodeGraphWorksetPrepareMemberV1,
  CodeGraphWorksetPrepareProgressV1,
} from './workset.js';

/** Browser-safe canonical copy for CLI, JSON progress, and Manager job status. */
export function renderCodeGraphWorksetPrepareProgress(
  progress: Omit<CodeGraphWorksetPrepareProgressV1, 'message'> | CodeGraphWorksetPrepareProgressV1,
): string {
  const count = `${progress.completed}/${progress.total} members · ${formatWorksetPrepareElapsed(progress.elapsedMilliseconds)}`;
  switch (progress.phase) {
    case 'starting':
      return `Workset starting · ${progress.total} member${progress.total === 1 ? '' : 's'}.`;
    case 'waiting':
      return `Workset waiting · home-global publication lock · ${count}.`;
    case 'indexing': {
      const attempt =
        progress.attempt === undefined
          ? ''
          : ` · attempt ${progress.attempt}/${progress.maxAttempts ?? progress.attempt}`;
      const activity = renderCodeGraphWorksetIndexActivity(progress.activity);
      const terminal = progress.member === undefined ? '' : ` · ${renderPrepareMemberTerminal(progress.member)}`;
      return `Workset indexing · ${progress.project ?? 'member'}${attempt}${activity}${terminal} · ${count}.`;
    }
    case 'projecting': {
      const terminal = progress.member === undefined ? '' : ` · ${renderPrepareMemberTerminal(progress.member)}`;
      return `Workset projecting · ${progress.project ?? 'member'}${terminal} · ${count}.`;
    }
    case 'cataloging':
      return `Workset cataloging · staging an atomic routing catalog · ${count}.`;
    case 'bridging':
      return `Workset bridging · resolving cross-repository bridges · ${count}.`;
    case 'publishing':
      return `Workset publishing · atomic generation pointer · ${count}.`;
    case 'completed':
      return progress.resultState === 'ready'
        ? `Workset completed · published generation · ${count}.`
        : `Workset completed · no ready generation published · ${count}.`;
    case 'failed':
      return `Workset failed · previous generation preserved · ${count}.`;
  }
}

function formatWorksetPrepareElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s elapsed`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s elapsed`;
}

function renderCodeGraphWorksetIndexActivity(activity: CodeGraphWorksetPrepareIndexActivityV1 | undefined): string {
  if (activity === undefined) return '';
  const phase = activity.subphase === undefined ? activity.phase : `${activity.phase}/${activity.subphase}`;
  const measured =
    activity.completed === undefined || activity.total === undefined
      ? ''
      : ` ${activity.completed}/${activity.total}${activity.unit === undefined ? '' : ` ${activity.unit}`}`;
  const reason = activity.reason === undefined ? '' : ` (${activity.reason})`;
  return ` · ${phase}${measured}${reason}`;
}

function renderPrepareMemberTerminal(member: CodeGraphWorksetPrepareMemberV1): string {
  switch (member.state) {
    case 'ready':
      return `ready with ${member.symbolCount} routing symbols`;
    case 'failed':
      return `${member.reason}: ${member.detail.summary}`;
    case 'excluded':
    case 'missing':
      return `${member.state}: ${member.reason}`;
  }
}
