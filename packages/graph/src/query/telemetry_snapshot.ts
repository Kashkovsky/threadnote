import {observationFromCodeGraphStatus} from '../query.js';
import type {CodeGraphSnapshot, CodeGraphStatus} from '../types.js';
export type CodeGraphSnapshotSelection = 'active' | 'borrowed' | 'none' | 'promoted';
type PublishedSnapshotCounts = Pick<CodeGraphSnapshot, 'edgeCount' | 'fileCount' | 'symbolCount'>;

export type CodeGraphQueryAnonymousTelemetrySnapshotSurface =
  | Readonly<{selection: 'none'}>
  | Readonly<{
      freshness: CodeGraphStatus['freshness'];
      selection: Exclude<CodeGraphSnapshotSelection, 'none'>;
      snapshot: PublishedSnapshotCounts;
    }>;

export function codeGraphQueryAnonymousTelemetrySnapshotSelection(
  before: CodeGraphStatus,
  after: CodeGraphStatus,
): CodeGraphSnapshotSelection {
  if (after.readySnapshot === undefined) return 'none';
  if (observationFromCodeGraphStatus(after)?.borrowedSnapshotId === after.readySnapshot.id) return 'borrowed';
  return before.readySnapshot?.id === after.readySnapshot.id ? 'active' : 'promoted';
}

export function codeGraphQueryAnonymousTelemetrySnapshotSurface(
  status: CodeGraphStatus,
  selection: CodeGraphSnapshotSelection,
): CodeGraphQueryAnonymousTelemetrySnapshotSurface {
  if (selection === 'none' || status.readySnapshot === undefined) return {selection: 'none'};
  return {
    freshness: status.freshness,
    selection,
    snapshot: status.readySnapshot,
  };
}
