import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {Clock, Console, Effect, FileSystem, Option, Result} from 'effect';
import {inferProjectFromQuery, inferWorksetFromQuery, requireWorkset} from './manifest.js';
import type {ProjectManifest} from './types.js';
import {
  activePersonalMemoryUrisFromText,
  existingReferencedUris,
  formatReferencedContextPointers,
  recallHygieneNudges,
  referencedUrisFromRecords,
} from './memory_hygiene.js';
import {isInSharedNamespace, applyScrubber} from './share.js';
import {
  errorMessage,
  enrichRecallQueryWithWorkspaceContext,
  enrichRecallQueryWithWorkspaceProjectContext,
  exactRecallTerms,
  type RecallHit,
  recallScoreThreshold,
  resolveWorkspaceRepoName,
  trimTrailingSlash,
} from './utils.js';
import {
  EffectMcpServerAdapter,
  McpInput,
  type McpProgressUpdate,
  type McpToolProgress,
  withMcpProgressHeartbeat,
} from './effect/ai/mcp.js';
import {
  expandWeakRecallQueryEffect,
  limitRecallRewritesForConfidence,
  mergeRecallRewritesForConfidence,
  recallHybridMinimumScore,
  recallRewriteLimitForConfidence,
  selectExpandedRecallCandidatesEffect,
  shouldExpandRecall,
} from './effect/ai/recall.js';
import {resolveEffectAiConfiguration} from './effect/ai/consolidator.js';
import {enrichMemoryMetadataWithConfiguredLocalAi} from './effect/ai/enrichment.js';
import {sha256Hex} from './effect/digest.js';
import {withMemoryUriLocks} from './effect/memory_lock.js';
import {SystemInfo} from './effect/system.js';
import {syncSharedReposBeforeAgentRead} from './effect/share.js';
import {canonicalMemoryDocumentContent, isSharedMemoryUri, type MemoryMetadata} from './memory_document.js';
import {
  buildCandidateReview,
  candidateReviewWithAuditEvent,
  candidateReviewWithApplyStage,
  candidateReviewWithApplying,
  candidateReviewWithState,
  loadCandidateReview,
  readActiveProjectMemories,
  saveCandidateReview,
  type CandidateReview,
  type CandidateApplyOperation,
  type MemoryCandidate,
  type SessionCloseoutInput,
  validateSessionCloseoutInput,
  withCandidateReviewLock,
} from './candidate_memory.js';
import {recordRecallFeedback} from './recall/feedback.js';
import type {CursorCloudMemoryScope} from './cursor_cloud.js';
import {resourceIdIsWithin} from './storage/resource-id.js';
import {loadRecallExactMatches} from './recall/index.js';
import {RECALL_RANKER_VERSION} from './recall/rank.js';
import {syncObsidianSourcesBeforeRecall} from './obsidian_source.js';
import {withProductionPhaseTiming} from './effect/production_log.js';
import {
  buildRecallIndexSelectionCandidates,
  buildRecallSelectionCandidates,
  createRecallRerankerCache,
  loadRecallExpansionVocabulary,
  loadMcpRecallSemanticScoresResult,
  prepareRecallSections,
  recallSelectionAnchorIds,
  recallSelectionQueries,
  selectedRecallCandidateUris,
} from './recall/runtime.js';
import {
  McpServerOperationError,
  MAX_WORKSET_PASSES,
  type RecallProgressTiming,
  type RuntimeConfig,
  argumentError,
  exactMemoryScopes,
  normalizeOptionalMetadata,
  optionalResourceUri,
  optionalResourceUriList,
  projectMemoryScopeUris,
  requiredResourceUri,
  requiredResourceUriList,
  requiredText,
  uriSegment,
  withStaleVersionNotice,
  worksetScopeUris,
} from './mcp_server_common.js';
import {
  type WriteDurableMemoryParams,
  forgetResourceWithRetry,
  preparePersonalMemoryWrite,
  readMemoryRecordsByUri,
  removeResourceWithRetry,
  resourceExists,
  runNativeListTool,
  runNativeReadTool,
  textFromCallToolResult,
  writeDurableMemory,
  writeCursorCloudSharedMemory,
} from './mcp_server_memory.js';
export function registerCandidateMemoryTools(server: EffectMcpServerAdapter, config: RuntimeConfig): void {
  server.registerTool(
    'review_session_context',
    {
      annotations: {readOnlyHint: false, destructiveHint: false},
      description:
        'After routine durable and handoff writes, form up to three additional reviewable decision, invariant, preference, or handoff candidates. Compares active project/topic memories and persists only a pending review plus audit event; it never creates active memory.',
      inputSchema: {
        callerCwd: McpInput.string('Absolute caller workspace path, used to infer project when project is omitted'),
        decisions: McpInput.stringOrStrings('Decisions worth carrying into later agent sessions'),
        evidence: McpInput.stringOrStrings('Bounded evidence pointers such as files, commits, or session turn IDs'),
        handoff: McpInput.stringOrStrings('Current status, blockers, checks, and next steps'),
        invariants: McpInput.stringOrStrings('Stable constraints or contracts future work must preserve'),
        outcome: McpInput.string('Required concise task outcome'),
        preferences: McpInput.stringOrStrings('User preferences explicitly expressed during this session'),
        project: McpInput.string('Stable project/repo namespace; inferred from callerCwd when omitted'),
        sourceAgentClient: McpInput.string('Originating client, for example codex or claude'),
        sourceCommit: McpInput.string('Optional source commit'),
        sourceSessionId: McpInput.string('Optional source session/thread identifier'),
        task: McpInput.string('Required concise task description'),
        topic: McpInput.string('Stable memory topic; defaults to a slug derived from task'),
      },
    },
    ({
      callerCwd,
      decisions,
      evidence,
      handoff,
      invariants,
      outcome,
      preferences,
      project,
      sourceAgentClient,
      sourceCommit,
      sourceSessionId,
      task,
      topic,
    }) => {
      const checkedTask = requiredText(task, 'review_session_context', 'task', {
        task: 'Improve recall and memory formation',
      });
      if (!checkedTask.ok) {
        return checkedTask.error;
      }
      const checkedOutcome = requiredText(outcome, 'review_session_context', 'outcome', {
        outcome: 'Implemented candidate review workflow',
      });
      if (!checkedOutcome.ok) {
        return checkedOutcome.error;
      }
      return Effect.gen(function* () {
        const candidatePolicy = parseCandidatePolicy((yield* SystemInfo).environment().THREADNOTE_CANDIDATE_POLICY);
        if (candidatePolicy === 'off') {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Session memory suggestions are disabled by THREADNOTE_CANDIDATE_POLICY=off.',
              },
            ],
            structuredContent: {candidates: [], noAction: true},
          };
        }
        const inferredProject =
          normalizeOptionalMetadata(project) ??
          (callerCwd ? yield* resolveWorkspaceRepoName({cwd: callerCwd, includeProcessCwd: false}) : undefined);
        if (!inferredProject) {
          return argumentError(
            'review_session_context requires project or an absolute callerCwd from which the repo can be inferred.',
          );
        }
        const rawCloseout: SessionCloseoutInput = {
          decisions: candidatePolicy === 'handoff-only' ? [] : stringList(decisions),
          evidence: stringList(evidence),
          handoff: stringList(handoff),
          invariants: candidatePolicy === 'handoff-only' ? [] : stringList(invariants),
          outcome: checkedOutcome.value,
          preferences: candidatePolicy === 'handoff-only' ? [] : stringList(preferences),
          project: inferredProject,
          sourceAgentClient: sourceAgentClient?.trim() || 'mcp',
          sourceCommit: normalizeOptionalMetadata(sourceCommit),
          sourceSessionId: normalizeOptionalMetadata(sourceSessionId),
          task: checkedTask.value,
          topic: normalizeOptionalMetadata(topic) ?? uriSegment(checkedTask.value),
        };
        const closeoutSizeError = validateSessionCloseoutInput(rawCloseout);
        if (closeoutSizeError) {
          return argumentError(`Refusing session review: ${closeoutSizeError}`);
        }
        const closeout = scrubSessionCloseout(rawCloseout);
        if (!closeout.ok) {
          return argumentError(closeout.error);
        }
        if (sessionCloseoutHasCandidateMaterial(closeout.input) && !sessionCloseoutHasEvidence(closeout.input)) {
          return argumentError(
            'review_session_context requires at least one evidence pointer, sourceSessionId, or sourceCommit before proposing durable memory.',
          );
        }
        const existing = yield* readActiveProjectMemories(config, closeout.input.project);
        const now = new Date(yield* Clock.currentTimeMillis);
        const review = yield* buildCandidateReview(closeout.input, existing, now);
        yield* saveCandidateReview(config.agentContextHome, review);
        return candidateReviewResult(review);
      }).pipe(
        Effect.catch(error =>
          Effect.succeed({content: [{type: 'text' as const, text: errorMessage(error)}], isError: true}),
        ),
      );
    },
  );

  server.registerTool(
    'apply_memory_candidates',
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description:
        'Record an explicit user decision for one pending session-memory candidate. approve may create or replace active memory; reject and defer never write memory. Pass the review revision to prevent stale decisions.',
      inputSchema: {
        action: McpInput.literals(['approve', 'defer', 'reject'], 'Explicit user decision for this candidate'),
        approved: McpInput.boolean('Must be true for approve, confirming the user explicitly approved this write'),
        candidateId: McpInput.string('Candidate ID returned by review_session_context'),
        editedText: McpInput.string('Optional user-edited replacement for the proposed memory text'),
        operation: McpInput.literals(
          ['create', 'replace'],
          'Required for replace/manual-review candidates: explicitly create a new memory or replace the reviewed target',
        ),
        replaceUri: McpInput.string(
          'Required with operation=replace; must exactly match the target returned by review_session_context',
        ),
        reviewId: McpInput.string('Review ID returned by review_session_context'),
        revision: McpInput.integer('Review revision returned by review_session_context', {minimum: 1}),
      },
    },
    ({action, approved, candidateId, editedText, operation, replaceUri, reviewId, revision}) => {
      const checkedReviewId = requiredText(reviewId, 'apply_memory_candidates', 'reviewId', {
        reviewId: 'review-0123456789abcdef',
      });
      if (!checkedReviewId.ok) {
        return checkedReviewId.error;
      }
      const checkedCandidateId = requiredText(candidateId, 'apply_memory_candidates', 'candidateId', {
        candidateId: 'review-0123456789abcdef-1',
      });
      if (!checkedCandidateId.ok) {
        return checkedCandidateId.error;
      }
      const checkedReplaceUri = optionalResourceUri(replaceUri, 'apply_memory_candidates');
      if (!checkedReplaceUri.ok) {
        return checkedReplaceUri.error;
      }
      if (!action) {
        return argumentError('apply_memory_candidates requires action: approve, defer, or reject.');
      }
      if (revision === undefined) {
        return argumentError('apply_memory_candidates requires the current review revision.');
      }
      if (action === 'approve' && approved !== true) {
        return argumentError('approve requires approved=true after explicit user approval.');
      }
      return withCandidateReviewLock(
        config.agentContextHome,
        checkedReviewId.value,
        Effect.gen(function* () {
          const review = yield* loadCandidateReview(config.agentContextHome, checkedReviewId.value);
          const candidate = review.candidates.find(item => item.candidateId === checkedCandidateId.value);
          if (!candidate) {
            return argumentError(`Candidate ${checkedCandidateId.value} is not part of ${checkedReviewId.value}.`);
          }
          if (
            action === 'approve' &&
            candidate.state === 'applied' &&
            (review.revision === revision || review.revision === revision + 1)
          ) {
            const memoryMessage = candidate.applyTargetUri ? ` at ${candidate.applyTargetUri}` : '';
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Candidate ${candidate.candidateId} was already approved${memoryMessage}.`,
                },
              ],
              structuredContent: {
                action: candidate.applyTargetUri ? 'approve' : 'no_action',
                candidateId: candidate.candidateId,
                memoryUri: candidate.applyTargetUri,
                reviewId: review.reviewId,
                revision: review.revision,
              },
            };
          }
          if (review.revision !== revision) {
            return argumentError(
              `Candidate review revision changed: expected ${revision}, current ${review.revision}. Review it again before applying.`,
            );
          }
          if (candidate.state === 'applying' && candidate.applyTargetUri) {
            const [appliedRecord] = yield* readMemoryRecordsByUri(config, [candidate?.applyTargetUri as string]);
            if (appliedRecord?.metadata.candidateId === candidate.candidateId) {
              if (
                !candidate.applyContentHash ||
                (yield* sha256Hex(canonicalMemoryDocumentContent(appliedRecord.content))) !== candidate.applyContentHash
              ) {
                return yield* persistCandidateConflict(
                  config,
                  review,
                  candidate,
                  `Candidate ${candidate.candidateId} found mismatched content at ${candidate.applyTargetUri}. The partial apply is recorded as a conflict.`,
                );
              }
              const cleanup = yield* reconcileCandidateReplacementCleanup(config, candidate);
              if (cleanup === 'conflict') {
                return yield* persistCandidateConflict(
                  config,
                  review,
                  candidate,
                  `Candidate ${candidate.candidateId} was written at ${candidate.applyTargetUri}, but its reviewed replacement target changed before cleanup. The partial apply is recorded as a conflict; review both memories before continuing.`,
                );
              }
              if (cleanup === 'pending') {
                const pendingCleanup = candidateReviewWithApplyStage(review, candidate.candidateId, 'cleanup_pending');
                yield* saveCandidateReview(config.agentContextHome, pendingCleanup);
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: `Candidate ${candidate.candidateId} is stored at ${candidate.applyTargetUri}, but its reviewed replacement still exists. Retry this approval to finish cleanup.`,
                    },
                  ],
                  isError: true,
                  structuredContent: {
                    action: 'cleanup_pending',
                    candidateId: candidate.candidateId,
                    memoryUri: candidate.applyTargetUri,
                    reviewId: review.reviewId,
                    revision: review.revision,
                  },
                };
              }
              const withBeginAudit = candidateReviewWithAuditEvent(review, {
                action: 'begin_apply',
                at: appliedRecord.metadata.timestamp,
                candidateId: candidate.candidateId,
                memoryUri: candidate.applyTargetUri,
                reviewId: review.reviewId,
                revision: review.revision,
              });
              const recovered = candidateReviewWithState(withBeginAudit, candidate.candidateId, 'applied', {
                action: 'apply',
                at: appliedRecord.metadata.timestamp,
                memoryUri: candidate.applyTargetUri,
              });
              yield* saveCandidateReview(config.agentContextHome, recovered);
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Recovered approved candidate ${candidate.candidateId} at ${candidate.applyTargetUri}.`,
                  },
                ],
                structuredContent: {
                  action: 'approve',
                  candidateId: candidate.candidateId,
                  memoryUri: candidate.applyTargetUri,
                  reviewId: review.reviewId,
                  revision: recovered.revision,
                },
              };
            }
          }
          if (candidate.state === 'applied' || candidate.state === 'conflict' || candidate.state === 'rejected') {
            return argumentError(`Candidate ${candidate.candidateId} is already ${candidate.state}.`);
          }
          const at = new Date(yield* Clock.currentTimeMillis).toISOString();
          if (action === 'defer' || action === 'reject') {
            if (candidate.state === 'applying') {
              return argumentError(
                `Candidate ${candidate.candidateId} has an interrupted approval in progress. Retry approve to recover it before recording another decision.`,
              );
            }
            if (action === 'defer' && candidate.state === 'deferred') {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Candidate ${candidate.candidateId} is already deferred in review ${review.reviewId}.`,
                  },
                ],
                structuredContent: {
                  action,
                  candidateId: candidate.candidateId,
                  reviewId: review.reviewId,
                  revision: review.revision,
                },
              };
            }
            const updated = candidateReviewWithState(
              review,
              candidate.candidateId,
              action === 'defer' ? 'deferred' : 'rejected',
              {action, at},
            );
            yield* saveCandidateReview(config.agentContextHome, updated);
            return {
              content: [
                {
                  type: 'text' as const,
                  text:
                    action === 'defer'
                      ? `Deferred candidate ${candidate.candidateId}. It remains available in review ${review.reviewId}.`
                      : `Rejected candidate ${candidate.candidateId}. No memory was written.`,
                },
              ],
              structuredContent: {
                action,
                candidateId: candidate.candidateId,
                reviewId: review.reviewId,
                revision: updated.revision,
              },
            };
          }
          if (candidate.recommendation === 'no_action') {
            if (!(yield* reviewedCandidateTargetIsCurrent(config, candidate))) {
              return argumentError(
                `Duplicate candidate ${candidate.candidateId} is stale because its reviewed target changed or disappeared. Run review_session_context again.`,
              );
            }
            const updated = candidateReviewWithState(review, candidate.candidateId, 'applied', {
              action: 'apply',
              at,
            });
            yield* saveCandidateReview(config.agentContextHome, updated);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Confirmed no action for duplicate candidate ${candidate.candidateId}. No memory was written.`,
                },
              ],
              structuredContent: {
                action: 'no_action',
                candidateId: candidate.candidateId,
                reviewId: review.reviewId,
                revision: updated.revision,
              },
            };
          }
          const text = normalizeOptionalMetadata(editedText) ?? candidate.proposedText;
          const scrub = applyScrubber(text, {redact: true});
          if (scrub.blocker) {
            return argumentError(
              `Refusing to store candidate ${candidate.candidateId}: possible ${scrub.blocker}. Remove the sensitive value first.`,
            );
          }
          const reviewedTargetUri = candidate.targetUri;
          const effectiveOperation = operation ?? candidate.applyOperation;
          const effectiveReplaceUri = checkedReplaceUri.value ?? candidate.applyReplaceUri;
          const requiresExplicitOperation =
            candidate.recommendation === 'replace' || candidate.recommendation === 'manual_review';
          if (requiresExplicitOperation && effectiveOperation === undefined) {
            return argumentError(
              `Candidate ${candidate.candidateId} requires an explicit operation: create or replace.`,
            );
          }
          if (candidate.applyOperation && operation && operation !== candidate.applyOperation) {
            return argumentError(
              `Candidate ${candidate.candidateId} is recovering an approved ${candidate.applyOperation} operation; the retry cannot change it to ${operation}.`,
            );
          }
          if (
            candidate.applyReplaceUri &&
            checkedReplaceUri.value &&
            checkedReplaceUri.value !== candidate.applyReplaceUri
          ) {
            return argumentError(
              `Candidate ${candidate.candidateId} is recovering approved target ${candidate.applyReplaceUri}; the retry cannot change it.`,
            );
          }
          const reviewedTargetIsShared = reviewedTargetUri !== undefined && isSharedMemoryUri(reviewedTargetUri);
          if (
            effectiveOperation === 'create' &&
            !reviewedTargetIsShared &&
            (candidate.recommendation === 'replace' || candidate.comparison === 'contradiction')
          ) {
            return argumentError(
              `Candidate ${candidate.candidateId} has the same stable identity as active memory and cannot be created separately; choose operation=replace with its reviewed target.`,
            );
          }
          if (effectiveOperation === 'replace' && reviewedTargetUri === undefined) {
            return argumentError(`Candidate ${candidate.candidateId} has no reviewed replacement target.`);
          }
          if (
            effectiveOperation === 'replace' &&
            (effectiveReplaceUri === undefined || effectiveReplaceUri !== reviewedTargetUri)
          ) {
            return argumentError(
              `Candidate ${candidate.candidateId} requires replaceUri=${reviewedTargetUri} for the reviewed replacement.`,
            );
          }
          if (effectiveOperation !== 'replace' && effectiveReplaceUri !== undefined) {
            return argumentError(`Candidate ${candidate.candidateId} cannot use replaceUri without operation=replace.`);
          }
          const targetUri = effectiveOperation === 'replace' ? reviewedTargetUri : undefined;
          if (targetUri && isSharedMemoryUri(targetUri)) {
            return argumentError(
              `Candidate ${candidate.candidateId} targets shared memory. Choose operation=create to store the reviewed candidate personally without overwriting the shared source.`,
            );
          }
          if (targetUri) {
            if (!candidate.targetContentHash) {
              return argumentError(`Candidate ${candidate.candidateId} has no reviewed content hash for ${targetUri}.`);
            }
          }
          const approvedOperation: CandidateApplyOperation = effectiveOperation ?? 'create';
          const approvedAt = candidate.applyApprovedAt ?? at;
          const metadata = approvedCandidateMetadata(review, candidate, approvedAt);
          const writeParams: WriteDurableMemoryParams = {
            bodyText: scrub.cleaned,
            expectedReplaceContentHash: targetUri ? candidate.targetContentHash : undefined,
            metadata,
            operation: approvedOperation,
            replaceUri: targetUri,
          };
          const preparedWrite = yield* preparePersonalMemoryWrite(config, writeParams);
          const intendedMemoryUri = preparedWrite.memoryUri;
          const approvedContentHash = yield* sha256Hex(canonicalMemoryDocumentContent(preparedWrite.memory));
          if (candidate.applyContentHash && candidate.applyContentHash !== approvedContentHash) {
            return argumentError(
              `Candidate ${candidate.candidateId} retry does not match the previously approved content. Retry with the same editedText or start a new review.`,
            );
          }
          const applying =
            candidate.state === 'applying'
              ? review
              : candidateReviewWithApplying(
                  review,
                  candidate.candidateId,
                  {
                    contentHash: approvedContentHash,
                    operation: approvedOperation,
                    replaceUri: targetUri,
                    targetUri: intendedMemoryUri,
                  },
                  approvedAt,
                );
          if (candidate.state !== 'applying') {
            yield* saveCandidateReview(config.agentContextHome, applying);
          }
          const result = yield* writeDurableMemory(config, {
            ...writeParams,
            prepared: preparedWrite,
          });
          if (result.isError === true) {
            const resultText = textFromCallToolResult(result);
            if (resultText.includes('Candidate replacement is stale')) {
              return yield* persistCandidateConflict(
                config,
                applying,
                applying.candidates.find(item => item.candidateId === candidate?.candidateId) ?? candidate,
                `${resultText} The approval is recorded as a conflict; start a new review against the current target.`,
              );
            }
            const [possiblyWritten] = yield* readMemoryRecordsByUri(config, [intendedMemoryUri]);
            const destinationCanConflict = approvedOperation === 'create' || intendedMemoryUri !== targetUri;
            if (
              (destinationCanConflict &&
                possiblyWritten &&
                possiblyWritten.metadata.candidateId !== candidate.candidateId) ||
              resultText.includes('Create conflict')
            ) {
              return yield* persistCandidateConflict(
                config,
                applying,
                applying.candidates.find(item => item.candidateId === candidate?.candidateId) ?? candidate,
                `Candidate ${candidate.candidateId} could not be created because ${intendedMemoryUri} contains another memory. The apply is recorded as a conflict.`,
              );
            }
            return result;
          }
          if (replacementCleanupIsPending(result)) {
            const pendingCleanup = candidateReviewWithApplyStage(applying, candidate.candidateId, 'cleanup_pending');
            yield* saveCandidateReview(config.agentContextHome, pendingCleanup);
            return {
              ...result,
              isError: true,
              structuredContent: {
                action: 'cleanup_pending',
                candidateId: candidate.candidateId,
                memoryUri: intendedMemoryUri,
                reviewId: review.reviewId,
                revision: review.revision,
              },
            };
          }
          const memoryUri = storedMemoryUri(result) ?? intendedMemoryUri;
          const updated = candidateReviewWithState(applying, candidate.candidateId, 'applied', {
            action: 'apply',
            at,
            memoryUri,
          });
          yield* saveCandidateReview(config.agentContextHome, updated);
          return {
            ...result,
            structuredContent: {
              action: 'approve',
              candidateId: candidate.candidateId,
              memoryUri,
              reviewId: review.reviewId,
              revision: updated.revision,
            },
          };
        }),
      ).pipe(
        Effect.catch(error =>
          Effect.succeed({content: [{type: 'text' as const, text: errorMessage(error)}], isError: true}),
        ),
      );
    },
  );
}

export function registerSearchTool(
  server: EffectMcpServerAdapter,
  config: RuntimeConfig,
  name: string,
  description: string,
  progressTiming: RecallProgressTiming,
  memoryScope?: CursorCloudMemoryScope,
): void {
  server.registerTool(
    name,
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description,
      inputSchema: {
        query: McpInput.string('Required search query, for example "unity-ui-ccc latest handoff"'),
        uri: McpInput.string('Optional threadnote:// subtree to search'),
        callerCwd: McpInput.string(
          'Optional absolute caller workspace path used to resolve this/current branch queries',
        ),
        project: McpInput.string('Optional stable project/repo namespace; inferred from callerCwd when omitted'),
        nodeLimit: McpInput.integer('Maximum result count', {minimum: 1, maximum: 100}),
        includeArchived: McpInput.boolean('Include archived memories in recall results'),
        threshold: McpInput.number(
          'Minimum relevance score 0-1 (default 0.5); lower it (toward 0) to broaden when a recall comes back empty',
          {minimum: 0, maximum: 1},
        ),
        workset: McpInput.string(
          'Optional named workset (a set of related repos from the seed manifest) to recall across as one working set',
        ),
      },
    },
    ({callerCwd, includeArchived, nodeLimit, project, query, threshold, uri, workset}, {progress}) => {
      const checkedQuery = requiredText(query, name, 'query', {query: 'unity-ui-ccc latest handoff'});
      if (!checkedQuery.ok) {
        return checkedQuery.error;
      }
      const checkedUri = optionalResourceUri(uri, name);
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      if (workset?.trim() && memoryScope) {
        return argumentError(`${name} does not allow worksets in the Cursor Cloud profile.`);
      }
      const scopedUri = checkedUri.value ?? memoryScope?.root;
      if (scopedUri && memoryScope && !resourceIdIsWithin(scopedUri, memoryScope.root)) {
        return argumentError(`${name} uri must stay within ${memoryScope.root}.`);
      }
      return runRecallTool(
        config,
        {
          callerCwd,
          project: project?.trim() || undefined,
          query: checkedQuery.value,
          pinnedUri: scopedUri,
          nodeLimit,
          includeArchived: includeArchived === true,
          threshold: threshold === undefined ? undefined : String(threshold),
          workset: workset?.trim() || undefined,
        },
        progress,
        progressTiming,
        memoryScope,
      ).pipe(
        Effect.flatMap(withStaleVersionNotice),
        Effect.catch(error =>
          Effect.succeed({content: [{type: 'text' as const, text: errorMessage(error)}], isError: true}),
        ),
      );
    },
  );
}

interface RecallToolParams {
  readonly callerCwd: string | undefined;
  readonly includeArchived: boolean;
  readonly nodeLimit: number | undefined;
  readonly pinnedUri: string | undefined;
  readonly project: string | undefined;
  readonly query: string;
  readonly threshold: string | undefined;
  readonly workset: string | undefined;
}

const RECALL_MCP_PROGRESS = {
  lexicalRanking: {message: 'Ranking recall candidates.', phase: 'recall.lexical-ranking'},
  obsidianSync: {message: 'Refreshing Obsidian sources.', phase: 'recall.obsidian-sync'},
  semanticRetrieval: {message: 'Searching memory indexes.', phase: 'recall.semantic-retrieval'},
  sharedSync: {message: 'Refreshing shared memories.', phase: 'recall.shared-sync'},
  workspaceContext: {message: 'Resolving recall scope.', phase: 'recall.workspace-context'},
} as const satisfies Readonly<Record<string, McpProgressUpdate>>;

function runRecallTool(
  config: RuntimeConfig,
  params: RecallToolParams,
  progress: McpToolProgress,
  progressTiming: RecallProgressTiming,
  memoryScope?: CursorCloudMemoryScope,
) {
  return Effect.gen(function* () {
    const syncWarnings: string[] = [];
    const syncedTeams = yield* withMcpProgressHeartbeat(
      progress,
      RECALL_MCP_PROGRESS.sharedSync,
      withProductionPhaseTiming(
        'recall.shared-sync',
        progressTiming.sharedSyncDelayMilliseconds === 0
          ? syncSharedReposBeforeAgentRead(config, memoryScope?.team)
          : Effect.sleep(progressTiming.sharedSyncDelayMilliseconds).pipe(
              Effect.andThen(syncSharedReposBeforeAgentRead(config, memoryScope?.team)),
            ),
      ),
      progressTiming.heartbeatMilliseconds,
    ).pipe(
      Effect.map(syncResult => {
        syncWarnings.push(...syncResult.warnings);
        return syncResult.syncedTeams;
      }),
      Effect.catch(error => {
        syncWarnings.push(errorMessage(error));
        return Effect.succeed([] as readonly string[]);
      }),
    );
    const obsidianSyncWarnings: string[] = [];
    const syncedObsidianSources = memoryScope
      ? []
      : yield* withMcpProgressHeartbeat(
          progress,
          RECALL_MCP_PROGRESS.obsidianSync,
          withProductionPhaseTiming('recall.obsidian-sync', syncObsidianSourcesBeforeRecall(config)),
          progressTiming.heartbeatMilliseconds,
        ).pipe(
          Effect.map(syncResult => {
            obsidianSyncWarnings.push(...syncResult.warnings);
            return syncResult.syncedSources;
          }),
          Effect.catch(error => {
            obsidianSyncWarnings.push(`Obsidian source refresh failed: ${errorMessage(error)}`);
            return Effect.succeed([] as readonly string[]);
          }),
        );
    yield* progress.report(RECALL_MCP_PROGRESS.workspaceContext);
    const query = yield* enrichRecallQueryWithWorkspaceContext(params.query, {
      cwd: params.callerCwd,
      includeProcessCwd: false,
    });
    const projectQuery = yield* enrichRecallQueryWithWorkspaceProjectContext(params.query, {
      cwd: params.callerCwd,
      includeProcessCwd: false,
    });
    const explicitProjectName = params.pinnedUri ? undefined : params.project;
    const queryProject = params.pinnedUri
      ? undefined
      : yield* inferProjectFromQuery(config.manifestPath, explicitProjectName ?? params.query);
    const project =
      queryProject ??
      (params.pinnedUri || explicitProjectName
        ? undefined
        : yield* inferProjectFromQuery(config.manifestPath, projectQuery));
    const inferredProjectMemoryName = params.pinnedUri
      ? undefined
      : (project?.name ?? (yield* resolveWorkspaceRepoName({cwd: params.callerCwd, includeProcessCwd: false})));
    const recallProjectName = explicitProjectName ?? inferredProjectMemoryName;
    const threshold = params.threshold ?? (yield* recallScoreThreshold());
    const explicitWorkset = params.workset ? yield* requireWorkset(config.manifestPath, params.workset) : undefined;
    const passes: Array<readonly RecallHit[]> = [];
    const scopedRecallUris = new Set([params.pinnedUri].filter((uri): uri is string => uri !== undefined));
    for (const scope of projectMemoryScopeUris(config, recallProjectName, params.includeArchived)) {
      if (!scopedRecallUris.has(scope)) {
        scopedRecallUris.add(scope);
      }
    }
    const seededUri = project ? trimTrailingSlash(project.uri) : undefined;
    if (seededUri?.startsWith('threadnote://') && seededUri !== params.pinnedUri) {
      scopedRecallUris.add(seededUri);
    }

    const sections: string[] = [];
    const workset = params.pinnedUri
      ? undefined
      : explicitWorkset
        ? explicitWorkset
        : yield* inferWorksetFromQuery(config.manifestPath, projectQuery);
    if (workset && workset.projects.length > 0) {
      sections.push(`Workset scope: ${workset.name} (${workset.projects.map(member => member.name).join(', ')})`);
      const alreadyScoped = new Set(
        [params.pinnedUri, seededUri, ...scopedRecallUris].filter((uri): uri is string => uri !== undefined),
      );
      const worksetScopes = worksetScopeUris(config, workset)
        .filter(uri => !alreadyScoped.has(uri))
        .slice(0, MAX_WORKSET_PASSES);
      for (const scope of worksetScopes) {
        scopedRecallUris.add(scope);
      }
    }

    const exactMatches = yield* collectExactMemoryMatches(
      config,
      query,
      params.includeArchived,
      recallProjectName,
      project,
    );
    const environment = (yield* SystemInfo).environment();
    const effectAiResult = yield* resolveEffectAiConfiguration(config, environment).pipe(Effect.result);
    const effectAi = Result.isSuccess(effectAiResult) ? effectAiResult.success : undefined;
    if (Result.isFailure(effectAiResult)) {
      sections.push(
        `Local AI recall unavailable: ${errorMessage(effectAiResult.failure)}. Deterministic recall continued.`,
      );
    }
    let hybridMinimumScore = recallHybridMinimumScore(Number(threshold), params.threshold !== undefined);
    const expansionQueries: string[] = [];
    const recallLimit = params.nodeLimit ?? 12;
    const semanticRetrieval = yield* withMcpProgressHeartbeat(
      progress,
      RECALL_MCP_PROGRESS.semanticRetrieval,
      withProductionPhaseTiming(
        'recall.semantic-retrieval',
        loadMcpRecallSemanticScoresResult(config, query, recallLimit),
        result =>
          result.status === 'available'
            ? 'success'
            : result.status === 'unavailable'
              ? 'unavailable'
              : result.status === 'timed-out'
                ? 'timed-out'
                : 'failure',
      ),
      progressTiming.heartbeatMilliseconds,
    );
    let semanticResult = semanticRetrieval.result;
    const surfacedSemanticWarnings = new Set<string>();
    const appendSemanticWarning = (result: typeof semanticResult) => {
      if (Option.isNone(result.warning) || surfacedSemanticWarnings.has(result.warning.value)) return;
      surfacedSemanticWarnings.add(result.warning.value);
      sections.push(result.warning.value);
    };
    appendSemanticWarning(semanticResult);
    const rerankerCache = createRecallRerankerCache();
    const prepareSections = (candidateUris?: readonly string[]) =>
      withMcpProgressHeartbeat(
        progress,
        RECALL_MCP_PROGRESS.lexicalRanking,
        withProductionPhaseTiming(
          'recall.lexical-ranking',
          Effect.gen(function* () {
            const prepared = yield* prepareRecallSections(config, {
              allowExactRescue: params.threshold === undefined,
              allowedUriScopes: params.pinnedUri ? [params.pinnedUri] : undefined,
              candidateUris,
              exactMatches,
              feedbackQuery: params.query,
              includeInactive: params.includeArchived,
              limit: recallLimit,
              minimumScore: hybridMinimumScore,
              passes,
              preferredUriScopes: params.pinnedUri ? undefined : [...scopedRecallUris],
              project: recallProjectName,
              query,
              queryVariants: expansionQueries,
              readRecords: uris => readMemoryRecordsByUri(config, uris),
              rerankerCache,
              seedUris: [params.pinnedUri, seededUri].filter((uri): uri is string => uri !== undefined),
              semanticGenerationMismatchPolicy: 'fallback',
              semanticResult: Option.some(semanticResult),
            });
            semanticResult = prepared.semanticResult;
            appendSemanticWarning(semanticResult);
            return prepared;
          }),
        ),
        progressTiming.heartbeatMilliseconds,
      );
    let recallSections = yield* prepareSections();
    const shouldAttemptAiExpansion = shouldExpandRecall(recallSections.confidence);
    const indexSelectionCandidates = shouldAttemptAiExpansion
      ? buildRecallIndexSelectionCandidates(recallSections.expansionCandidates, recallProjectName, 24)
      : [];
    const indexSelectionIds =
      indexSelectionCandidates.length > 0
        ? yield* selectExpandedRecallCandidatesEffect(
            {candidates: indexSelectionCandidates, query: params.query},
            config,
            effectAi,
          )
        : undefined;
    const groundedExpansionQueries =
      indexSelectionIds && indexSelectionIds.length > 0
        ? limitRecallRewritesForConfidence(
            recallSections.confidence,
            recallSelectionQueries(
              indexSelectionCandidates,
              recallSections.expansionCandidates,
              indexSelectionIds,
              params.query,
              2,
            ),
          )
        : [];
    const needsFallbackExpansion =
      shouldExpandRecall(recallSections.confidence) &&
      groundedExpansionQueries.length < recallRewriteLimitForConfidence(recallSections.confidence);
    const expansionVocabulary =
      needsFallbackExpansion && shouldExpandRecall(recallSections.confidence)
        ? yield* loadRecallExpansionVocabulary(config, {
            allowedUriScopes: params.pinnedUri ? [params.pinnedUri] : [...scopedRecallUris],
            includeInactive: params.includeArchived,
            project: recallProjectName,
            rankedCandidates: recallSections.expansionCandidates,
          }).pipe(Effect.catch(() => Effect.succeed([])))
        : [];
    const fallbackExpansionQueries = needsFallbackExpansion
      ? yield* expandWeakRecallQueryEffect(
          {
            confidence: recallSections.confidence,
            project: recallProjectName,
            query: params.query,
            vocabulary: expansionVocabulary,
          },
          config,
          effectAi,
        )
      : [];
    const proposedExpansionQueries = mergeRecallRewritesForConfidence(
      recallSections.confidence,
      groundedExpansionQueries,
      fallbackExpansionQueries,
    );
    for (const expansionQuery of proposedExpansionQueries) {
      expansionQueries.push(expansionQuery);
      hybridMinimumScore = recallHybridMinimumScore(Number(threshold), params.threshold !== undefined);
      recallSections = yield* prepareSections();
    }
    if (expansionQueries.length > 0) {
      sections.push(`Recall query expansion: evaluated ${expansionQueries.length} model rewrite(s).`);
      const selectionCandidates = buildRecallSelectionCandidates(
        recallSections.ranked,
        recallSections.expansionCandidates,
        Math.max(params.nodeLimit ?? 12, 12) * 2,
      );
      const selectedIds = yield* selectExpandedRecallCandidatesEffect(
        {candidates: selectionCandidates, query: params.query},
        config,
        effectAi,
      );
      if (selectedIds !== undefined) {
        const selectedUris = selectedRecallCandidateUris(
          selectionCandidates,
          selectedIds,
          recallSelectionAnchorIds(selectionCandidates, recallSections.ranked),
        );
        recallSections = yield* prepareSections(selectedUris);
        sections.push(
          `Recall local AI post-filter: kept ${selectedUris.length} of ${selectionCandidates.length} candidate(s).`,
        );
      }
    }
    const {semanticSection, exactTail} = recallSections;
    if (semanticSection) {
      sections.push(semanticSection);
    }
    if (exactTail) {
      sections.push(exactTail);
    }
    const referencedContext = yield* referencedContextSection(config, semanticSection ?? '');
    if (referencedContext) {
      sections.push(referencedContext);
    }
    const hygieneHints = yield* recallHygieneHintsSection(config, semanticSection ?? '');
    if (hygieneHints) {
      sections.push(hygieneHints);
    }
    if (syncedTeams.length > 0) {
      sections.push(`Auto-synced shared memories: ${syncedTeams.join(', ')}`);
    }
    if (syncedObsidianSources.length > 0) {
      sections.push(`Auto-synced Obsidian sources: ${syncedObsidianSources.join(', ')}`);
    }
    for (const warning of syncWarnings) {
      sections.push(`Auto-sync warning: ${warning}`);
    }
    for (const warning of obsidianSyncWarnings) {
      sections.push(`Auto-sync warning: ${warning}`);
    }
    if (sections.length === 0) {
      return {
        content: [{type: 'text' as const, text: 'No recall results found.'}],
        ...(memoryScope
          ? {structuredContent: {memoryScope: cursorCloudMemoryScopeReceipt(memoryScope), results: []}}
          : {}),
      };
    }
    return {
      content: [{type: 'text' as const, text: sections.join('\n\n')}],
      structuredContent: {
        confidence: recallSections.confidence,
        ...(memoryScope ? {memoryScope: cursorCloudMemoryScopeReceipt(memoryScope)} : {}),
        queryExpansions: expansionQueries,
        rankerVersion: RECALL_RANKER_VERSION,
        results: recallSections.ranked.slice(0, params.nodeLimit ?? 12).map(hit => ({
          category: hit.category,
          finalScore: hit.finalScore,
          reasons: hit.rankReasons,
          signals: hit.rankSignals,
          uri: hit.uri,
          warnings: hit.rankWarnings,
        })),
      },
    };
  });
}

const recallHygieneHintsSection = Effect.fn('mcpServer.recallHygieneHints')(function* (
  config: RuntimeConfig,
  recallText: string,
) {
  const uris = activePersonalMemoryUrisFromText(recallText, config.user);
  if (uris.length === 0) {
    return undefined;
  }
  const records = yield* readMemoryRecordsByUri(config, uris);
  const nudges = recallHygieneNudges(recallText, {records, user: config.user});
  return nudges.length > 0 ? ['Memory hygiene hints:', ...nudges.map(nudge => `- ${nudge}`)].join('\n') : undefined;
});

const MAX_REFERENCED_CONTEXT = 5;

/**
 * Resolves the one-way `references:` pointers carried by the personal memories
 * recall just surfaced and appends bounded URI-only pointers. The caller can
 * explicitly read a relevant pointer without recall inlining unrelated text.
 */
const referencedContextSection = Effect.fn('mcpServer.referencedContext')(function* (
  config: RuntimeConfig,
  recallText: string,
) {
  const surfacedUris = activePersonalMemoryUrisFromText(recallText, config.user);
  if (surfacedUris.length === 0) {
    return undefined;
  }
  const surfaced = yield* readMemoryRecordsByUri(config, surfacedUris);
  const referenced = referencedUrisFromRecords(surfaced, recallText);
  if (referenced.length === 0) {
    return undefined;
  }
  const candidates = referenced.slice(0, MAX_REFERENCED_CONTEXT);
  const existingRecords = yield* readMemoryRecordsByUri(config, candidates);
  return formatReferencedContextPointers(existingReferencedUris(candidates, existingRecords), MAX_REFERENCED_CONTEXT);
});

const collectExactMemoryMatches = Effect.fn('mcp_server.collectExactMemoryMatches')(function* (
  config: RuntimeConfig,
  query: string,
  includeArchived: boolean,
  projectName: string | undefined,
  project: ProjectManifest | undefined,
) {
  const terms = exactRecallTerms(query);
  if (terms.length === 0) {
    return [];
  }
  const scopes = exactMemoryScopes(config, includeArchived, query, projectName, project);
  return yield* loadRecallExactMatches(config, {
    includeInactive: includeArchived,
    limitPerTerm: 25,
    terms,
    uriScopes: scopes,
  }).pipe(Effect.catch(() => Effect.succeed([])));
});

export function registerReadTool(
  server: EffectMcpServerAdapter,
  config: RuntimeConfig,
  name: string,
  description: string,
  memoryScope?: CursorCloudMemoryScope,
): void {
  server.registerTool(
    name,
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: `${description} Required: pass JSON arguments with uri, or native canonical-store uris. Canonical memory content is returned in full.`,
      inputSchema: {
        uri: McpInput.string('Required threadnote:// file URI'),
        uris: McpInput.stringOrStrings(
          'Native canonical-store MCP read input: a single threadnote:// URI or array of URIs',
        ),
      },
    },
    ({uri, uris}) => {
      const checkedUris = requiredResourceUriList(uris ?? uri, name, 'threadnote://user/you/memories/.abstract.md');
      if (!checkedUris.ok) {
        return checkedUris.error;
      }
      const outsideScope = memoryScope
        ? checkedUris.value.find(uri => !resourceIdIsWithin(uri, memoryScope.root))
        : undefined;
      if (outsideScope) {
        return argumentError(`${name} uri must stay within ${memoryScope!.root}.`);
      }
      return Effect.gen(function* () {
        const syncWarnings: string[] = [];
        const syncedTeams = yield* syncSharedReposBeforeAgentRead(config, memoryScope?.team).pipe(
          Effect.map(result => {
            syncWarnings.push(...result.warnings);
            return result.syncedTeams;
          }),
          Effect.catch(error => {
            syncWarnings.push(error instanceof Error ? error.message : String(error));
            return Effect.succeed([] as readonly string[]);
          }),
        );
        const result = yield* runNativeReadTool(config, checkedUris.value);
        const scopedResult = memoryScope
          ? {
              ...result,
              _meta: {
                ...result._meta,
                'threadnote.io/memory-scope': cursorCloudMemoryScopeReceipt(memoryScope),
              },
            }
          : result;
        if (result.isError === true || (syncedTeams.length === 0 && syncWarnings.length === 0)) {
          return scopedResult;
        }
        const syncMessages = [
          syncedTeams.length > 0 ? `Auto-synced shared memories: ${syncedTeams.join(', ')}` : undefined,
          ...syncWarnings.map(warning => `Auto-sync warning: ${warning}`),
        ].filter((part): part is string => part !== undefined);
        return {
          ...scopedResult,
          content: [...scopedResult.content, {type: 'text', text: syncMessages.join('\n')}],
        };
      });
    },
  );
}

export function registerListTool(
  server: EffectMcpServerAdapter,
  config: RuntimeConfig,
  name: string,
  description: string,
  memoryScope?: CursorCloudMemoryScope,
): void {
  server.registerTool(
    name,
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description,
      inputSchema: {
        uri: McpInput.string('Optional threadnote:// directory URI; defaults to threadnote://'),
        all: McpInput.boolean('Show hidden files like .abstract.md and .overview.md'),
        recursive: McpInput.boolean('List recursively'),
        simple: McpInput.boolean('Only return paths'),
        nodeLimit: McpInput.integer('Maximum node count', {minimum: 1, maximum: 1000}),
        node_limit: McpInput.integer('Maximum node count', {minimum: 1, maximum: 1000}),
      },
    },
    Effect.fn('mcp_server.callback')(function* ({all, nodeLimit, node_limit, recursive, simple, uri}) {
      const checkedUri = optionalResourceUri(uri, name);
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      const scopedUri = checkedUri.value ?? memoryScope?.root ?? 'threadnote://';
      if (memoryScope && !resourceIdIsWithin(scopedUri, memoryScope.root)) {
        return argumentError(`${name} uri must stay within ${memoryScope.root}.`);
      }
      yield* syncSharedReposBeforeAgentRead(config, memoryScope?.team).pipe(Effect.catch(() => Effect.void));
      const result = yield* runNativeListTool(config, {
        all,
        nodeLimit: nodeLimit ?? node_limit,
        recursive,
        simple,
        uri: scopedUri,
      });
      return memoryScope && result.structuredContent
        ? {
            ...result,
            structuredContent: {
              ...result.structuredContent,
              memoryScope: cursorCloudMemoryScopeReceipt(memoryScope),
            },
          }
        : result;
    }),
  );
}

function cursorCloudMemoryScopeReceipt(scope: CursorCloudMemoryScope) {
  return {mode: scope.mode, root: scope.root, team: scope.team, type: 'threadnote-memory-scope', version: 1} as const;
}

export function registerStoreTool(
  server: EffectMcpServerAdapter,
  config: RuntimeConfig,
  name: string,
  description: string,
  memoryScope?: CursorCloudMemoryScope,
): void {
  server.registerTool(
    name,
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description: `${description} Never store secrets, credentials, customer data, or raw logs.`,
      inputSchema: {
        kind: McpInput.literals(
          ['durable', 'handoff', 'incident', 'preference', 'smoke'],
          'Memory lifecycle kind; durable facts and handoffs are most common',
        ),
        project: McpInput.string('Project/repo namespace, for example threadnote or mobile-native'),
        references: McpInput.stringOrStrings(
          'Optional threadnote:// URI(s) to record as one-way, read-only prior context for this memory. Recall surfaces a short excerpt of each. Stripped from shared copies on publish.',
        ),
        replaceUri: McpInput.string(
          'Optional threadnote:// memory URI to replace. Shared URIs are updated in place and pushed; personal URIs are forgotten after the replacement is safely stored.',
        ),
        text: McpInput.string('Required memory text to store'),
        sourceAgentClient: McpInput.string('Originating client, for example cursor, copilot, codex, or claude'),
        status: McpInput.literals(['active', 'archived', 'superseded'], 'Memory lifecycle status'),
        topic: McpInput.string('Stable topic; active project/topic memories update one file'),
      },
    },
    ({kind, project, references, replaceUri, sourceAgentClient, status, text, topic}) => {
      const checkedText = requiredText(text, name, 'text', {text: 'Durable engineering note...'});
      if (!checkedText.ok) {
        return checkedText.error;
      }
      const checkedReplaceUri = optionalResourceUri(replaceUri, name);
      if (!checkedReplaceUri.ok) {
        return checkedReplaceUri.error;
      }
      const checkedReferences = optionalResourceUriList(references, name);
      if (!checkedReferences.ok) {
        return checkedReferences.error;
      }
      const memoryKind = kind ?? 'durable';
      if (memoryScope && memoryKind !== 'durable' && memoryKind !== 'handoff') {
        return argumentError(
          `${name} supports durable shared memories and transient local handoffs in the Cursor Cloud profile.`,
        );
      }
      if (memoryScope) {
        const outsideReference = checkedReferences.value?.find(
          reference => !resourceIdIsWithin(reference, memoryScope.root),
        );
        if (outsideReference) {
          return argumentError(`${name} references must stay within ${memoryScope.root}.`);
        }
        if (
          memoryKind === 'durable' &&
          checkedReplaceUri.value &&
          !resourceIdIsWithin(checkedReplaceUri.value, memoryScope.root)
        ) {
          return argumentError(`${name} replaceUri must stay within ${memoryScope.root}.`);
        }
        const handoffRoot = `threadnote://user/${uriSegment(config.user)}/memories/handoffs`;
        if (
          memoryKind === 'handoff' &&
          checkedReplaceUri.value &&
          !resourceIdIsWithin(checkedReplaceUri.value, handoffRoot)
        ) {
          return argumentError(`${name} local handoff replaceUri must stay within ${handoffRoot}.`);
        }
      }
      const metadata: MemoryMetadata = {
        kind: memoryKind,
        project: normalizeOptionalMetadata(project),
        references: checkedReferences.value,
        sourceAgentClient: sourceAgentClient ?? 'mcp',
        status: status ?? 'active',
        timestamp: new Date().toISOString(),
        topic: normalizeOptionalMetadata(topic),
      };
      return Effect.gen(function* () {
        if (memoryScope && memoryKind === 'durable') {
          return yield* writeCursorCloudSharedMemory(config, memoryScope, {
            bodyText: checkedText.value,
            metadata,
            replaceUri: checkedReplaceUri.value,
          });
        }
        const enrichedMetadata =
          memoryScope || (checkedReplaceUri.value && isInSharedNamespace(config, checkedReplaceUri.value))
            ? metadata
            : yield* enrichMemoryMetadataWithConfiguredLocalAi(config, metadata, checkedText.value).pipe(
                Effect.catch(error =>
                  Console.log(
                    `Local AI memory enrichment skipped: ${error instanceof Error ? error.message : String(error)}`,
                  ).pipe(Effect.as(metadata)),
                ),
              );
        const result = yield* writeDurableMemory(config, {
          bodyText: checkedText.value,
          metadata: enrichedMetadata,
          replaceUri: checkedReplaceUri.value,
        });
        return memoryScope && memoryKind === 'handoff'
          ? {
              ...result,
              _meta: {
                ...result._meta,
                'threadnote.io/persistence': {
                  durability: 'cloud-workspace-local',
                  note: 'This handoff may not survive a new Cursor Cloud session.',
                  type: 'threadnote-cloud-persistence',
                  version: 1,
                },
              },
            }
          : result;
      }).pipe(Effect.flatMap(withStaleVersionNotice));
    },
  );
}

function stringList(value: string | readonly string[] | undefined): readonly string[] {
  return typeof value === 'string' ? [value] : (value ?? []);
}

function sessionCloseoutHasCandidateMaterial(input: SessionCloseoutInput): boolean {
  return [input.decisions, input.handoff, input.invariants, input.preferences].some(items => (items?.length ?? 0) > 0);
}

function sessionCloseoutHasEvidence(input: SessionCloseoutInput): boolean {
  return (input.evidence?.length ?? 0) > 0 || input.sourceSessionId !== undefined || input.sourceCommit !== undefined;
}

function parseCandidatePolicy(value: string | undefined): 'handoff-only' | 'off' | 'suggest' {
  const normalized = value?.trim() || 'suggest';
  if (normalized === 'suggest' || normalized === 'handoff-only' || normalized === 'off') {
    return normalized;
  }
  throw new McpServerOperationError(
    `Invalid THREADNOTE_CANDIDATE_POLICY=${normalized}. Expected suggest, handoff-only, or off.`,
  );
}

function scrubSessionCloseout(
  input: SessionCloseoutInput,
): {readonly input: SessionCloseoutInput; readonly ok: true} | {readonly error: string; readonly ok: false} {
  const scrubText = (value: string): {readonly blocker?: string; readonly cleaned: string} =>
    applyScrubber(value, {redact: true});
  const scalarValues = [
    ['task', input.task],
    ['outcome', input.outcome],
    ['project', input.project],
    ['topic', input.topic],
    ['sourceAgentClient', input.sourceAgentClient],
    ['sourceCommit', input.sourceCommit],
    ['sourceSessionId', input.sourceSessionId],
  ] as const;
  const scrubbedScalars = new Map<string, string | undefined>();
  for (const [key, value] of scalarValues) {
    if (value === undefined) {
      scrubbedScalars.set(key, undefined);
      continue;
    }
    const scrubbed = scrubText(value);
    if (scrubbed.blocker) {
      return {error: `Refusing session review: ${key} may contain ${scrubbed.blocker}.`, ok: false};
    }
    scrubbedScalars.set(key, scrubbed.cleaned);
  }
  const scrubList = (key: string, values: readonly string[] | undefined): readonly string[] | undefined => {
    if (!values) {
      return undefined;
    }
    const result: string[] = [];
    for (const value of values) {
      const scrubbed = scrubText(value);
      if (scrubbed.blocker) {
        throw new McpServerOperationError(`${key} may contain ${scrubbed.blocker}`);
      }
      result.push(scrubbed.cleaned);
    }
    return result;
  };
  try {
    return {
      input: {
        decisions: scrubList('decisions', input.decisions),
        evidence: scrubList('evidence', input.evidence),
        handoff: scrubList('handoff', input.handoff),
        invariants: scrubList('invariants', input.invariants),
        outcome: scrubbedScalars.get('outcome') as string,
        preferences: scrubList('preferences', input.preferences),
        project: scrubbedScalars.get('project') as string,
        sourceAgentClient: scrubbedScalars.get('sourceAgentClient') as string,
        sourceCommit: scrubbedScalars.get('sourceCommit'),
        sourceSessionId: scrubbedScalars.get('sourceSessionId'),
        task: scrubbedScalars.get('task') as string,
        topic: scrubbedScalars.get('topic') as string,
      },
      ok: true,
    };
  } catch (cause: unknown) {
    return {error: `Refusing session review: ${errorMessage(cause)}.`, ok: false};
  }
}

function candidateReviewResult(review: CandidateReview): CallToolResult {
  const actionable = review.candidates.filter(candidate => candidate.recommendation !== 'no_action');
  const lines =
    review.candidates.length === 0
      ? ['No additional memory candidates found in this task closeout. No candidate memory was written.']
      : actionable.length === 0
        ? ['No memory update is recommended; every candidate duplicates active memory.']
        : [
            `Review ${review.reviewId} · revision ${review.revision}`,
            'Present these additional recommendations in the current conversation. Do not write these additional candidates until the user decides:',
            ...review.candidates.map(
              (candidate, index) =>
                `${index + 1}. [${candidate.recommendation}] ${candidate.kind}/${candidate.topic} · ${candidate.reason}\n` +
                `   candidate: ${candidate.candidateId}` +
                (candidate.targetUri ? `\n   target: ${candidate.targetUri}` : '') +
                `\n${candidate.proposedText
                  .split('\n')
                  .map(line => `   ${line}`)
                  .join('\n')}`,
            ),
          ];
  return {
    content: [{type: 'text', text: lines.join('\n')}],
    structuredContent: {
      candidates: review.candidates,
      noAction: actionable.length === 0,
      reviewId: review.reviewId,
      revision: review.revision,
    },
  };
}

function approvedCandidateMetadata(
  review: CandidateReview,
  candidate: MemoryCandidate,
  approvedAt: string,
): MemoryMetadata {
  return {
    authority: 'user_approved',
    candidateId: candidate.candidateId,
    createdAt: approvedAt,
    evidence: candidate.evidence,
    kind: candidate.kind,
    lastReviewed: approvedAt,
    project: candidate.project,
    schemaVersion: 3,
    sourceAgentClient: review.sourceAgentClient,
    sourceCommit: review.sourceCommit,
    sourceObservedAt: review.createdAt,
    sourceSessionId: review.sourceSessionId,
    status: 'active',
    timestamp: approvedAt,
    topic: candidate.topic,
    trust: 'approved',
    updatedAt: approvedAt,
    visibility: 'personal',
  };
}

function storedMemoryUri(result: CallToolResult): string | undefined {
  const structuredMemoryUri = result.structuredContent?.memoryUri;
  if (typeof structuredMemoryUri === 'string') {
    return structuredMemoryUri;
  }
  const text = textFromCallToolResult(result);
  return /Stored memory:\s+(threadnote:\/\/\S+)/.exec(text)?.[1];
}

function replacementCleanupIsPending(result: CallToolResult): boolean {
  return result.structuredContent?.replacementCleanupPending === true;
}

function reviewedCandidateTargetIsCurrent(config: RuntimeConfig, candidate: MemoryCandidate) {
  if (!candidate.targetUri || !candidate.targetContentHash) {
    return Effect.succeed(false);
  }
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* withMemoryUriLocks(
      fs,
      config.agentContextHome,
      [candidate.targetUri],
      Effect.gen(function* () {
        const [target] = yield* readMemoryRecordsByUri(config, [candidate.targetUri as string]);
        return (
          target !== undefined &&
          (yield* sha256Hex(canonicalMemoryDocumentContent(target.content))) === candidate.targetContentHash
        );
      }),
    );
  });
}

function persistCandidateConflict(
  config: RuntimeConfig,
  review: CandidateReview,
  candidate: MemoryCandidate,
  message: string,
) {
  return Effect.gen(function* () {
    const conflicted = candidateReviewWithState(
      candidateReviewWithApplyStage(review, candidate.candidateId, 'conflict'),
      candidate.candidateId,
      'conflict',
      {
        action: 'conflict',
        at: new Date(yield* Clock.currentTimeMillis).toISOString(),
        memoryUri: candidate.applyTargetUri,
      },
    );
    yield* saveCandidateReview(config.agentContextHome, conflicted);
    return argumentError(message);
  });
}

function reconcileCandidateReplacementCleanup(config: RuntimeConfig, candidate: MemoryCandidate) {
  if (
    candidate.applyOperation !== 'replace' ||
    !candidate.applyReplaceUri ||
    !candidate.applyTargetUri ||
    candidate.applyReplaceUri === candidate.applyTargetUri
  ) {
    return Effect.succeed('complete');
  }
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* withMemoryUriLocks(
      fs,
      config.agentContextHome,
      [candidate.applyReplaceUri, candidate.applyTargetUri],
      Effect.gen(function* () {
        const [currentTarget] = yield* readMemoryRecordsByUri(config, [candidate.applyReplaceUri as string]);
        if (!currentTarget) {
          return 'complete' as const;
        }
        if (
          !candidate.targetContentHash ||
          (yield* sha256Hex(canonicalMemoryDocumentContent(currentTarget.content))) !== candidate.targetContentHash
        ) {
          return 'conflict' as const;
        }
        const removed = yield* removeResourceWithRetry(
          'threadnote-native',
          config,
          candidate.applyReplaceUri as string,
        );
        if (!removed) {
          return 'pending' as const;
        }
        const stillExists = yield* resourceExists('threadnote-native', config, candidate.applyReplaceUri as string);
        return stillExists ? ('pending' as const) : ('complete' as const);
      }),
    );
  });
}

export function registerRecallFeedbackTool(server: EffectMcpServerAdapter, config: RuntimeConfig): void {
  server.registerTool(
    'recall_feedback',
    {
      annotations: {readOnlyHint: false, destructiveHint: false},
      description:
        'Record bounded local feedback for one recall result. Stores a query fingerprint, never the full query. Feedback cannot bypass topical relevance and decays over time.',
      inputSchema: {
        action: McpInput.literals(['dismiss', 'pin', 'useful', 'wrong']),
        project: McpInput.string('Optional project scope; pin is never global'),
        query: McpInput.string('The recall query; only its SHA-256 fingerprint is stored'),
        uri: McpInput.string('The threadnote:// result URI receiving feedback'),
      },
    },
    ({action, project, query, uri}) => {
      const checkedQuery = requiredText(query, 'recall_feedback', 'query', {query: 'threadnote recall quality'});
      if (!checkedQuery.ok) {
        return checkedQuery.error;
      }
      const checkedUri = requiredResourceUri(
        uri,
        'recall_feedback',
        'threadnote://user/example/memories/durable/projects/threadnote/recall.md',
      );
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      if (!action) {
        return argumentError('recall_feedback requires action: useful, wrong, pin, or dismiss.');
      }
      const normalizedProject = normalizeOptionalMetadata(project);
      if (action === 'pin' && normalizedProject === undefined) {
        return argumentError('recall_feedback requires project when action is pin; pins are never global.');
      }
      return Effect.gen(function* () {
        const timestamp = new Date(yield* Clock.currentTimeMillis).toISOString();
        const result = yield* recordRecallFeedback(config.agentContextHome, {
          action,
          project: normalizedProject,
          query: checkedQuery.value,
          timestamp,
          uri: checkedUri.value,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: result.recorded
                ? `Recorded ${action} feedback for ${checkedUri.value}.`
                : `Equivalent recent ${action} feedback already exists for ${checkedUri.value}; no duplicate was added.`,
            },
          ],
        };
      }).pipe(
        Effect.catch(error =>
          Effect.succeed({content: [{type: 'text' as const, text: errorMessage(error)}], isError: true}),
        ),
      );
    },
  );
}

export function registerArchiveTool(
  server: EffectMcpServerAdapter,
  config: RuntimeConfig,
  name: string,
  description: string,
): void {
  server.registerTool(
    name,
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description: `${description} The archive is written before the original URI is removed.`,
      inputSchema: {
        kind: McpInput.literals(['durable', 'handoff', 'incident', 'preference', 'smoke']),
        project: McpInput.string('Project/repo namespace for the archived copy'),
        topic: McpInput.string('Topic for the archived copy'),
        uri: McpInput.string('Required threadnote:// memory URI to archive'),
      },
    },
    ({kind, project, topic, uri}) => {
      const checkedUri = requiredResourceUri(
        uri,
        name,
        'threadnote://user/example/memories/handoffs/active/repo/topic.md',
      );
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      return Effect.gen(function* () {
        const [sourceRecord] = yield* readMemoryRecordsByUri(config, [checkedUri.value]);
        if (!sourceRecord) {
          return argumentError(`Could not resolve local memory content for ${checkedUri.value} before archiving.`);
        }
        const sourceContent = sourceRecord.content;
        const readResult = yield* runNativeReadTool(config, [checkedUri.value]);
        const original = textFromCallToolResult(readResult);
        if (!original) {
          return {
            content: [{type: 'text', text: `Could not read ${checkedUri.value} before archiving.`}],
            isError: true,
          };
        }
        const metadata: MemoryMetadata = {
          archivedFrom: checkedUri.value,
          kind: kind ?? 'handoff',
          project: normalizeOptionalMetadata(project),
          sourceAgentClient: 'mcp',
          status: 'archived',
          timestamp: new Date().toISOString(),
          topic: normalizeOptionalMetadata(topic),
        };
        const archiveResult = yield* writeDurableMemory(config, {
          bodyText: ['Archived original Threadnote memory.', '', original].join('\n'),
          expectedSourceContent: [{content: sourceContent, uri: checkedUri.value}],
          metadata,
        });
        if (archiveResult.isError === true) {
          return archiveResult;
        }
        const removedOriginal = yield* forgetResourceWithRetry(config, checkedUri.value, false, sourceContent);
        const [content] = archiveResult.content;
        const text = content?.type === 'text' ? content.text : 'Archived memory stored.';
        return {
          content: [
            {
              type: 'text',
              text: removedOriginal
                ? `${text}\nArchived original memory: ${checkedUri.value}`
                : `${text}\nArchive stored, but original memory is still processing. Retry later with forget: ${checkedUri.value}`,
            },
          ],
        };
      }).pipe(
        Effect.catch(error =>
          Effect.succeed({content: [{type: 'text' as const, text: errorMessage(error)}], isError: true}),
        ),
      );
    },
  );
}
