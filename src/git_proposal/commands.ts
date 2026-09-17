import {Console, Crypto, Effect, FileSystem, Option, Path} from 'effect';
import {resolveRepositoryIdentity} from '../code_graph/repository.js';
import {sha256HexSync} from '../crypto/sha256.js';
import {SystemInfo} from '../effect/system.js';
import {listCandidateReviews, withCandidateReviewLock, type CandidateReview} from '../memory/candidate.js';
import {
  memoryCodeCitationContentSharingBlocker,
  memoryCodeCitationSharingBlockerMessage,
} from '../memory/code_citation_policy.js';
import {hasDeferredCodeAnchorIntent} from '../memory/deferred_code_anchor.js';
import {canonicalMemoryDocumentContent, type MemoryRecord} from '../memory/document.js';
import {projectKnowledgeDeltaV1} from '../memory/knowledge_delta.js';
import {readMaintenanceMemoryRecords} from '../memory/maintenance_records.js';
import {MemoryOperationError} from '../memory/migrations.js';
import {assertSafeShareRelativePath, resolveTeam} from '../share/core.js';
import {gitFileContent} from '../share/git.js';
import {validatePortableSegment} from '../storage/resource-id.js';
import type {RuntimeConfig} from '../types.js';
import {
  buildKnowledgeDeltaGitProposalV1,
  type KnowledgeDeltaGitProposalBuildV1,
  type ReviewedSharedMemoryMutationV1,
} from './knowledge_delta.js';

const MAXIMUM_GIT_PROPOSAL_OUTPUT_BYTES = 256 * 1_024;

export interface KnowledgeDeltaGitProposalExportOptionsV1 {
  readonly approved?: boolean;
  readonly candidateIds: readonly string[];
  readonly output?: string;
  readonly reviewId: string;
  readonly revision: number;
  readonly team?: string;
}

export const buildReviewedKnowledgeDeltaGitProposal = Effect.fn('gitProposal.buildReviewed')(function* (
  config: RuntimeConfig,
  options: Omit<KnowledgeDeltaGitProposalExportOptionsV1, 'output'>,
) {
  if (options.approved !== true) {
    return yield* operationError('Git proposal export requires --approved after explicit shared-mutation review.');
  }
  const candidateIds = [...new Set(options.candidateIds.map(value => value.trim()).filter(Boolean))].sort();
  if (candidateIds.length === 0) return yield* operationError('Select at least one --candidate-id to share.');
  if (candidateIds.length > 3) return yield* operationError('A Git proposal can contain at most three candidates.');
  const reviewId = options.reviewId.trim();
  return yield* withCandidateReviewLock(
    config.agentContextHome,
    reviewId,
    Effect.gen(function* () {
      const reviews = yield* listCandidateReviews(config.agentContextHome);
      const review = reviews.find(item => item.reviewId === reviewId);
      if (!review) return yield* operationError(`Candidate review ${reviewId} was not found.`);
      if (review.revision !== options.revision) {
        return yield* operationError(
          `Candidate review revision changed: expected ${options.revision}, current ${review.revision}. Review it again before export.`,
        );
      }
      const delta = projectKnowledgeDeltaV1(review);
      const team = yield* resolveTeam(config, options.team);
      const repository = yield* resolveRepositoryIdentity(team.config.worktree).pipe(
        Effect.mapError(cause => operationError(`Could not resolve the shared Git repository: ${cause.message}`)),
      );
      if (repository.remoteIdentity === undefined) {
        return yield* operationError(
          'The configured shared Git worktree needs a portable remote repository identity before proposal export.',
        );
      }
      const baseCommit = repository.headCommit;
      if (/^0+$/u.test(baseCommit)) {
        return yield* operationError('The configured shared Git worktree has no readable HEAD commit.');
      }
      const records = yield* readMaintenanceMemoryRecords(config);
      const mutations = yield* Effect.forEach(candidateIds, candidateId =>
        reviewedMutation(config, review, candidateId, records, team.config.worktree, baseCommit),
      );
      return yield* Effect.try({
        try: () =>
          buildKnowledgeDeltaGitProposalV1({
            baseCommit,
            delta,
            mutations,
            project: review.project,
            target: {repositoryId: repository.repositoryId, team: team.name},
          }),
        catch: cause => operationError(cause instanceof Error ? cause.message : 'Could not build the Git proposal.'),
      });
    }),
  );
});

export const runKnowledgeDeltaGitProposalExport = Effect.fn('gitProposal.exportCommand')(function* (
  config: RuntimeConfig,
  options: KnowledgeDeltaGitProposalExportOptionsV1,
) {
  const built = yield* buildReviewedKnowledgeDeltaGitProposal(config, options);
  if (options.output === undefined) {
    yield* Console.log(built.artifact.trimEnd());
    return;
  }
  const system = yield* SystemInfo;
  const path = yield* Path.Path;
  const output = path.resolve(system.currentDirectory(), options.output);
  yield* writeProposalArtifact(output, built);
  yield* Console.log(`Wrote Knowledge Delta Git proposal: ${output}`);
});

function reviewedMutation(
  config: RuntimeConfig,
  review: CandidateReview,
  candidateId: string,
  records: readonly MemoryRecord[],
  worktree: string,
  baseCommit: string,
) {
  return Effect.gen(function* () {
    const candidate = review.candidates.find(item => item.candidateId === candidateId);
    if (!candidate) return yield* operationError(`Candidate ${candidateId} is not part of ${review.reviewId}.`);
    if (candidate.state !== 'applied' || !candidate.applyTargetUri) {
      return yield* operationError(`Candidate ${candidateId} must be applied before shared Git proposal export.`);
    }
    const sources = records.filter(record => record.uri === candidate.applyTargetUri);
    if (sources.length !== 1) {
      return yield* operationError(`Applied candidate source ${candidate.applyTargetUri} is not uniquely readable.`);
    }
    const source = sources[0];
    if (!source) return yield* operationError(`Applied candidate source ${candidate.applyTargetUri} is missing.`);
    if (!candidate.applyContentHash) {
      return yield* operationError(
        `Candidate ${candidateId} has no approved apply content hash. Apply it again before shared Git proposal export.`,
      );
    }
    const currentSourceContentHash = sha256HexSync(canonicalMemoryDocumentContent(source.content));
    if (currentSourceContentHash !== candidate.applyContentHash) {
      return yield* operationError(
        `Candidate ${candidateId} applied source changed after approval. Review and apply it again before shared Git proposal export.`,
      );
    }
    if (source.metadata.kind !== 'durable' || source.metadata.status !== 'active') {
      return yield* operationError(`Candidate ${candidateId} is not an active durable memory.`);
    }
    if (yield* hasDeferredCodeAnchorIntent(config, source.uri)) {
      return yield* operationError(
        `Candidate ${candidateId} code citations are still pending. Prepare the graph, run \`threadnote finalize-code-refs --uri ${source.uri}\`, and retry the export.`,
      );
    }
    const citationBlocker = memoryCodeCitationContentSharingBlocker(source.uri, source.content);
    if (citationBlocker) {
      return yield* operationError(
        `Candidate ${candidateId} cannot be shared: ${memoryCodeCitationSharingBlockerMessage(citationBlocker)}.`,
      );
    }
    const targetPath = yield* sharedTargetPath(review.project, source.metadata.topic);
    const targetContent = yield* gitFileContent(worktree, baseCommit, targetPath);
    const expectedTarget =
      targetContent === undefined
        ? ({state: 'absent'} as const)
        : ({content: targetContent, contentHash: sha256HexSync(targetContent), state: 'present'} as const);
    return {
      approval: {
        expectedSourceContentHash: currentSourceContentHash,
        reviewId: review.reviewId,
        revision: review.revision,
        share: true,
      },
      candidateId,
      expectedTarget,
      operation: targetContent === undefined ? 'create' : 'replace',
      sourceContent: source.content,
      sourceUri: source.uri,
    } satisfies ReviewedSharedMemoryMutationV1;
  });
}

function sharedTargetPath(projectInput: string, topicInput: string | undefined) {
  return Effect.try({
    try: () => {
      const project = validatePortableSegment(projectInput);
      const topic = validatePortableSegment(topicInput ?? '');
      return assertSafeShareRelativePath(`durable/projects/${project}/${topic}.md`);
    },
    catch: () => operationError('The reviewed project/topic is not a portable shared-memory path.'),
  });
}

const writeProposalArtifact = Effect.fn('gitProposal.writeArtifact')(function* (
  output: string,
  built: KnowledgeDeltaGitProposalBuildV1,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const bytes = new TextEncoder().encode(built.artifact).byteLength;
  if (bytes > MAXIMUM_GIT_PROPOSAL_OUTPUT_BYTES) return yield* operationError('Git proposal artifact is too large.');
  if (yield* fs.exists(output)) {
    if (Option.isSome(yield* fs.readLink(output).pipe(Effect.option))) {
      return yield* operationError('Refusing to overwrite a symbolic-link Git proposal output.');
    }
    const current = yield* fs.readFileString(output);
    if (current === built.artifact) return;
    return yield* operationError('Git proposal output already exists with different content.');
  }
  yield* fs.makeDirectory(path.dirname(output), {recursive: true});
  const crypto = yield* Crypto.Crypto;
  const temporary = `${output}.${yield* crypto.randomUUIDv4}.tmp`;
  yield* fs.writeFileString(temporary, built.artifact, {mode: 0o600});
  yield* fs.rename(temporary, output).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
});

function operationError(message: string) {
  return MemoryOperationError.make({message});
}
