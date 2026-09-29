import type {
  CandidateCategory,
  CandidateComparison,
  CandidateRecommendation,
  CandidateReviewState,
} from '@threadnote/memory/candidate';
import type {ContextHealthReportV1} from '@threadnote/context/health';
import type {MemoryKind} from '@threadnote/memory/types';

export type ManagerRepositoryEvidenceUnavailableReasonV1 =
  'foreign-host' | 'manifest-unavailable' | 'project-not-configured' | 'repository-unavailable';

export type ManagerRepositoryEvidenceV1 =
  | {readonly state: 'available'}
  | {readonly reason: ManagerRepositoryEvidenceUnavailableReasonV1; readonly state: 'unavailable'};

export interface ManagerReviewCandidateV1 {
  readonly candidateId: string;
  readonly categories: readonly CandidateCategory[];
  readonly comparison: CandidateComparison;
  readonly confidence: number;
  readonly proposedText: string;
  readonly reason: string;
  readonly recommendation: CandidateRecommendation;
  readonly state: CandidateReviewState;
  readonly targetUri?: string;
}

export interface ManagerReviewInboxItemV1 {
  readonly candidates: readonly ManagerReviewCandidateV1[];
  readonly createdAt: string;
  readonly project: string;
  readonly reviewId: string;
  readonly revision: number;
  readonly task: string;
  readonly topic: string;
}

export interface ManagerReviewInboxResponseV1 {
  readonly items: readonly ManagerReviewInboxItemV1[];
  readonly pendingCount: number;
  readonly project: string;
  readonly version: 1;
}

export interface ManagerContextHealthCodePreviewV1 {
  readonly citationId: string;
  readonly excerpt?: string;
  readonly findingIds: readonly string[];
  readonly line?: number;
  readonly path: string;
  readonly targetLabel?: string;
}

export interface ManagerContextHealthRecordPreviewV1 {
  readonly code: readonly ManagerContextHealthCodePreviewV1[];
  readonly excerpt: string;
  readonly kind: MemoryKind;
  readonly title: string;
  readonly topic?: string;
  readonly uri: string;
}

export type ManagerContextHealthResponseV1 = ContextHealthReportV1 & {
  readonly recordPreviews: readonly ManagerContextHealthRecordPreviewV1[];
  readonly repositoryEvidence: ManagerRepositoryEvidenceV1;
};

export type ManagerCitationRepairJobStatusV1 = 'completed' | 'failed' | 'running';

export interface ManagerCitationRepairJobV1 {
  readonly createdAt: string;
  readonly error?: string;
  readonly finishedAt?: string;
  readonly id: string;
  readonly progress: {
    readonly batch: number;
    readonly failedCount: number;
    readonly initialCitationCount?: number;
    readonly message: string;
    readonly pagesScanned: number;
    readonly phase: 'applying' | 'completed' | 'failed' | 'rebuilding' | 'scanning' | 'starting';
    readonly repairableCount: number;
    readonly repairedCount: number;
    readonly unresolvedCount: number;
  };
  readonly project: string;
  readonly status: ManagerCitationRepairJobStatusV1;
  readonly warning?: string;
}

export interface ManagerCitationRepairJobResponseV1 {
  readonly job: ManagerCitationRepairJobV1 | null;
}
