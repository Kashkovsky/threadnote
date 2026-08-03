import {sha256HexSync} from '../../src/crypto/sha256.js';
import {
  createRecallEvaluationFixtureV2,
  serializeRecallEvaluationFixtureV2Identity,
} from '../../src/evaluation/recall-fixture.js';
import {
  createRecallRerankerDatasetV1,
  parseRecallRerankerDatasetDraftV1,
  parseRecallRerankerGroupJsonLinesV1,
  type RecallRerankerDatasetV1,
} from './recall-reranker-contract.js';

export function prepareReviewedRecallRerankerDatasetV1(
  draftValue: unknown,
  groupContent: string,
): RecallRerankerDatasetV1 {
  const draft = parseRecallRerankerDatasetDraftV1(draftValue);
  if (draft.purpose !== 'training_candidate') {
    throw new Error('Reviewed dataset preparation only accepts purpose training_candidate.');
  }
  if ((draft.reservedEvaluations?.length ?? 0) > 0) {
    throw new Error('The preparation helper manages reserved evaluations; remove them from the draft.');
  }
  if (draft.groupFile !== undefined && draft.groupFile !== 'groups.jsonl') {
    throw new Error('The preparation helper writes the reviewed groups to groups.jsonl.');
  }

  const fixture = createRecallEvaluationFixtureV2();
  const forbiddenTexts = [
    ...fixture.documents.map(document => document.text),
    ...fixture.queries.map(query => query.query),
  ];
  return createRecallRerankerDatasetV1(
    {
      ...draft,
      groupFile: 'groups.jsonl',
      reservedEvaluations: [
        {
          name: fixture.metadata.name,
          sha256: sha256HexSync(serializeRecallEvaluationFixtureV2Identity(fixture)),
        },
      ],
    },
    parseRecallRerankerGroupJsonLinesV1(groupContent),
    {forbiddenTexts},
  );
}
