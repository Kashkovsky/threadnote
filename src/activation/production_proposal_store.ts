import {Effect, FileSystem, Path, Schema} from 'effect';
import {canonicalJson} from '../code_graph/checkpoint/canonical_json.js';
import {sha256HexSync} from '../crypto/sha256.js';
import {SystemInfo} from '../effect/system.js';
import type {RuntimeConfig} from '../types.js';
import {withActivationReceiptLock} from './lock.js';
import {activationStatePathsV1} from './store.js';

const MAX_PROPOSAL_EVIDENCE_BYTES = 16 * 1_024;

export interface ActivationProposalEvidenceV1 {
  readonly activationId: string;
  readonly approvedProjectionHash: string;
  readonly branchName: string;
  readonly candidateId: string;
  readonly finalContentHash: string;
  readonly operation: 'create' | 'replace';
  readonly proposalHash: string;
  readonly repositoryId: string;
  readonly reviewId: string;
  readonly reviewRevision: number;
  readonly revision: string;
  readonly sourceMemoryId: string;
  readonly targetMemoryId: string;
  readonly targetPreconditionHash: string;
  readonly team: string;
  readonly type: 'threadnote-activation-proposal-evidence';
  readonly version: 1;
}

export type ActivationProposalEvidenceInputV1 = Omit<ActivationProposalEvidenceV1, 'revision' | 'type' | 'version'>;

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const BoundedText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const EvidenceSchema = Schema.Struct({
  activationId: Sha256,
  approvedProjectionHash: Sha256,
  branchName: BoundedText,
  candidateId: BoundedText,
  finalContentHash: Sha256,
  operation: Schema.Literals(['create', 'replace']),
  proposalHash: Sha256,
  repositoryId: Sha256,
  reviewId: BoundedText,
  reviewRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  revision: Sha256,
  sourceMemoryId: BoundedText,
  targetMemoryId: BoundedText,
  targetPreconditionHash: Sha256,
  team: BoundedText,
  type: Schema.Literal('threadnote-activation-proposal-evidence'),
  version: Schema.Literal(1),
});

export const readActivationProposalEvidenceV1 = Effect.fn('activation.proposalStore.read')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  activationId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const target = yield* proposalEvidencePath(config, activationId);
  if (!(yield* fs.exists(target))) return undefined;
  const raw = yield* fs.readFileString(target);
  if (Buffer.byteLength(raw, 'utf8') > MAX_PROPOSAL_EVIDENCE_BYTES) {
    throw new Error('Activation proposal evidence is oversized.');
  }
  return parseEvidence(JSON.parse(raw) as unknown, activationId);
});

export const initializeActivationProposalEvidenceV1 = Effect.fn('activation.proposalStore.initialize')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  input: ActivationProposalEvidenceInputV1,
) {
  return yield* withActivationReceiptLock(
    config.agentContextHome,
    input.activationId,
    Effect.gen(function* () {
      const proposed = evidenceWithRevision(input);
      const existing = yield* readActivationProposalEvidenceV1(config, input.activationId);
      if (existing !== undefined) {
        if (canonicalJson(existing) !== canonicalJson(proposed)) {
          throw new Error('Activation proposal evidence changed after materialization.');
        }
        return existing;
      }
      yield* writeEvidence(config, proposed);
      return proposed;
    }),
  );
});

function parseEvidence(value: unknown, activationId: string): ActivationProposalEvidenceV1 {
  const evidence = Schema.decodeUnknownSync(EvidenceSchema, {errors: 'all', onExcessProperty: 'error'})(value);
  if (evidence.activationId !== activationId) {
    throw new Error('Activation proposal evidence target does not match its path.');
  }
  const {revision: _, ...body} = evidence;
  if (sha256HexSync(canonicalJson(body)) !== evidence.revision) {
    throw new Error('Activation proposal evidence hash is invalid.');
  }
  return evidence;
}

function evidenceWithRevision(input: ActivationProposalEvidenceInputV1): ActivationProposalEvidenceV1 {
  const body = {
    ...input,
    type: 'threadnote-activation-proposal-evidence' as const,
    version: 1 as const,
  };
  return parseEvidence({...body, revision: sha256HexSync(canonicalJson(body))}, input.activationId);
}

const proposalEvidencePath = Effect.fn('activation.proposalStore.path')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  activationId: string,
) {
  const paths = yield* activationStatePathsV1(config, activationId);
  const path = yield* Path.Path;
  return path.join(paths.root, 'proposal.json');
});

const writeEvidence = Effect.fn('activation.proposalStore.write')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  evidence: ActivationProposalEvidenceV1,
) {
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  const target = yield* proposalEvidencePath(config, evidence.activationId);
  const temporary = `${target}.${system.processId}.tmp`;
  yield* fs.writeFileString(temporary, `${JSON.stringify(evidence)}\n`, {flag: 'wx', mode: 0o600});
  yield* fs.rename(temporary, target).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
});
