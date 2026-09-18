import type {
  CandidateComparison,
  CandidateRecommendation,
  CandidateReview,
  CandidateReviewState,
  MemoryCandidate,
  StructuredCloseoutV1,
} from './candidate.js';

export const KNOWLEDGE_DELTA_V1_MAX_ITEMS = 3;

const KNOWLEDGE_DELTA_V1_MAX_TEXT_CHARACTERS = 66_000;
const KNOWLEDGE_DELTA_V1_MAX_SOURCE_EVIDENCE = 34;

export type KnowledgeDeltaItemType =
  'context-repair-or-retirement' | 'decision-or-invariant' | 'handoff-state' | 'preference';

export interface KnowledgeDeltaEditedPreviewV1 {
  readonly bodyText: string;
  readonly candidateId: string;
  readonly revision: number;
}

export interface KnowledgeDeltaMutationPreviewV1 {
  readonly bodyText: string;
  readonly expectedTargetContentHash?: string;
  readonly operation: 'create' | 'no_action' | 'replace' | 'requires_explicit_operation';
  readonly replaceUri?: string;
  readonly truncated: boolean;
}

export interface KnowledgeDeltaItemV1 {
  readonly candidateId: string;
  readonly comparison: CandidateComparison;
  readonly comparisonReason: string;
  readonly confidence: number;
  readonly mutationPreview: KnowledgeDeltaMutationPreviewV1;
  readonly proposedDestination: {
    readonly kind: MemoryCandidate['kind'];
    readonly project: string;
    readonly targetUri?: string;
    readonly topic: string;
  };
  readonly recommendation: CandidateRecommendation;
  readonly sourceEvidence: readonly string[];
  readonly state: CandidateReviewState;
  readonly truncated: boolean;
  readonly type: KnowledgeDeltaItemType;
}

export interface KnowledgeDeltaV1 {
  readonly items: readonly KnowledgeDeltaItemV1[];
  readonly noAction: boolean;
  readonly reviewId: string;
  readonly revision: number;
  readonly structuredCloseout?: StructuredCloseoutV1;
  readonly type: 'knowledge-delta';
  readonly version: 1;
}

export function projectKnowledgeDeltaV1(
  review: CandidateReview,
  editedPreview?: KnowledgeDeltaEditedPreviewV1,
): KnowledgeDeltaV1 {
  if (editedPreview !== undefined) {
    if (editedPreview.revision !== review.revision) {
      throw new Error(
        `Candidate review revision changed: expected ${editedPreview.revision}, current ${review.revision}.`,
      );
    }
    if (!review.candidates.some(candidate => candidate.candidateId === editedPreview.candidateId)) {
      throw new Error(`Candidate ${editedPreview.candidateId} is not part of ${review.reviewId}.`);
    }
  }
  const items = [...review.candidates]
    .sort((left, right) => left.candidateId.localeCompare(right.candidateId))
    .slice(0, KNOWLEDGE_DELTA_V1_MAX_ITEMS)
    .map(candidate =>
      projectKnowledgeDeltaItemV1(
        candidate,
        editedPreview?.candidateId === candidate.candidateId ? editedPreview.bodyText : undefined,
      ),
    );
  return {
    items,
    noAction: items.every(item => item.recommendation === 'no_action'),
    reviewId: review.reviewId,
    revision: review.revision,
    ...(review.structuredCloseout ? {structuredCloseout: projectStructuredCloseout(review.structuredCloseout)} : {}),
    type: 'knowledge-delta',
    version: 1,
  };
}

function projectStructuredCloseout(value: StructuredCloseoutV1): StructuredCloseoutV1 {
  return {
    type: 'structured-closeout',
    version: 1,
    rationale: boundedText(value.rationale).text,
    constraints: value.constraints.slice(0, 32).map(item => boundedText(item).text),
    verificationPerformed: value.verificationPerformed.slice(0, 32).map(item => boundedText(item).text),
    knowledgeInvalidated: value.knowledgeInvalidated.slice(0, 32).map(item => boundedText(item).text),
    unresolvedRisks: value.unresolvedRisks.slice(0, 32).map(item => boundedText(item).text),
  };
}

function projectKnowledgeDeltaItemV1(candidate: MemoryCandidate, previewBodyText?: string): KnowledgeDeltaItemV1 {
  const candidateId = boundedText(candidate.candidateId);
  const bodyText = boundedText(previewBodyText ?? candidate.applyBodyText ?? candidate.proposedText);
  const comparisonReason = boundedText(candidate.reason);
  const project = boundedText(candidate.project);
  const targetContentHash = candidate.targetContentHash ? boundedText(candidate.targetContentHash) : undefined;
  const targetUri = candidate.targetUri ? boundedText(candidate.targetUri) : undefined;
  const topic = boundedText(candidate.topic);
  const sourceEvidence = candidate.evidence.slice(0, KNOWLEDGE_DELTA_V1_MAX_SOURCE_EVIDENCE).map(boundedText);
  return {
    candidateId: candidateId.text,
    comparison: candidate.comparison,
    comparisonReason: comparisonReason.text,
    confidence: candidate.confidence,
    mutationPreview: {
      bodyText: bodyText.text,
      ...(targetContentHash ? {expectedTargetContentHash: targetContentHash.text} : {}),
      operation: mutationOperation(candidate),
      ...(targetUri ? {replaceUri: targetUri.text} : {}),
      truncated: bodyText.truncated || (targetContentHash?.truncated ?? false) || (targetUri?.truncated ?? false),
    },
    proposedDestination: {
      kind: candidate.kind,
      project: project.text,
      ...(targetUri ? {targetUri: targetUri.text} : {}),
      topic: topic.text,
    },
    recommendation: candidate.recommendation,
    sourceEvidence: sourceEvidence.map(evidence => evidence.text),
    state: candidate.state,
    truncated:
      candidateId.truncated ||
      comparisonReason.truncated ||
      project.truncated ||
      (targetContentHash?.truncated ?? false) ||
      (targetUri?.truncated ?? false) ||
      topic.truncated ||
      bodyText.truncated ||
      candidate.evidence.length > KNOWLEDGE_DELTA_V1_MAX_SOURCE_EVIDENCE ||
      sourceEvidence.some(evidence => evidence.truncated),
    type: knowledgeDeltaItemType(candidate),
  };
}

function knowledgeDeltaItemType(candidate: MemoryCandidate): KnowledgeDeltaItemType {
  if (candidate.comparison !== 'new' || candidate.recommendation === 'no_action') {
    return 'context-repair-or-retirement';
  }
  if (candidate.categories.includes('handoff')) {
    return 'handoff-state';
  }
  if (candidate.categories.includes('decision') || candidate.categories.includes('invariant')) {
    return 'decision-or-invariant';
  }
  return 'preference';
}

function mutationOperation(candidate: MemoryCandidate): KnowledgeDeltaMutationPreviewV1['operation'] {
  switch (candidate.recommendation) {
    case 'create':
      return 'create';
    case 'no_action':
      return 'no_action';
    case 'replace':
      return 'replace';
    case 'manual_review':
      return 'requires_explicit_operation';
  }
}

function boundedText(text: string): {readonly text: string; readonly truncated: boolean} {
  return text.length <= KNOWLEDGE_DELTA_V1_MAX_TEXT_CHARACTERS
    ? {text, truncated: false}
    : {text: text.slice(0, KNOWLEDGE_DELTA_V1_MAX_TEXT_CHARACTERS), truncated: true};
}
