import type {CandidateApplyOperation} from '@threadnote/memory/candidate';

export interface ApplyMemoryCandidateInput {
  readonly action?: 'approve' | 'defer' | 'reject';
  readonly allowDestructiveReplacement?: boolean;
  readonly allowMissingReplacementCreate?: boolean;
  readonly approved?: boolean;
  readonly candidateId?: string;
  readonly editedText?: string;
  readonly operation?: CandidateApplyOperation;
  readonly replaceUri?: string;
  readonly reviewId?: string;
  readonly revision?: number;
}
