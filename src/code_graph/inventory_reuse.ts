import {Effect, FileSystem, Path} from 'effect';
import {sha256HexSync} from '../crypto/sha256.js';
import {runCommandEffect} from '../effect/command.js';
import {readOptionalText} from './inventory_contained_file.js';
import {CodeGraphInventoryError} from './inventory_error.js';
import {
  CODE_GRAPH_INVENTORY_ADMISSION_POLICY_VERSION,
  CODE_GRAPH_INVENTORY_EXCLUSION_REASONS,
} from './inventory_policy.js';
import type {CodeGraphLanguagePackRegistryShape} from './languages/registry.js';
import type {CodeGraphWorkspace} from './languages/types.js';
import {
  CODE_GRAPH_INVENTORY_REUSE_RECEIPT_VERSION,
  type CodeGraphInventoryPolicyExclusionSummary,
  type CodeGraphInventoryReuseReceipt,
} from './store_models.js';
import {mergeCodeGraphWorkspaces} from './workspace.js';
import type {RepositoryIdentity} from './types.js';

/**
 * Bump when admission behavior changes without a corresponding language-pack
 * matcher or inventory policy revision. Persisted inventory reuse is denied
 * across different contract hashes.
 */
export const CODE_GRAPH_INVENTORY_REUSE_CONTRACT_VERSION = 1 as const;

export const readCodeGraphInventoryReuseEnvironment = Effect.fn('codeGraph.readInventoryReuseEnvironment')(function* (
  identity: RepositoryIdentity,
  fs: FileSystem.FileSystem,
  path: Path.Path,
) {
  const [gitInfoExcludeResult, globalExcludeResult] = yield* Effect.all(
    [
      runCommandEffect('git', ['-C', identity.repoRoot, 'rev-parse', '--git-path', 'info/exclude'], {
        allowFailure: true,
        maxOutputBytes: 16_384,
        timeoutMs: 0,
      }),
      runCommandEffect('git', ['-C', identity.repoRoot, 'config', '--path', '--get', 'core.excludesFile'], {
        allowFailure: true,
        maxOutputBytes: 16_384,
        timeoutMs: 0,
      }),
    ],
    {concurrency: 2},
  );
  if (gitInfoExcludeResult.exitCode !== 0 || gitInfoExcludeResult.stdout.trim().length === 0) {
    return yield* Effect.fail(new CodeGraphInventoryError('Git exclude policy path is unavailable.'));
  }
  if (globalExcludeResult.exitCode !== 0 && globalExcludeResult.exitCode !== 1) {
    return yield* Effect.fail(new CodeGraphInventoryError('Global Git exclude policy is unavailable.'));
  }
  const threadnoteIgnore = yield* readOptionalText(fs, path.join(identity.repoRoot, '.threadnoteignore'));
  const observedGitInfoExcludePath = gitInfoExcludeResult.stdout.trim();
  const gitInfoExcludePath = path.isAbsolute(observedGitInfoExcludePath)
    ? observedGitInfoExcludePath
    : path.resolve(identity.repoRoot, observedGitInfoExcludePath);
  const globalExcludePath = globalExcludeResult.stdout.trim();
  const [gitInfoExclude, globalExclude] = yield* Effect.all(
    [
      readOptionalText(fs, gitInfoExcludePath),
      globalExcludePath.length === 0
        ? Effect.succeed('')
        : readOptionalText(
            fs,
            path.isAbsolute(globalExcludePath) ? globalExcludePath : path.resolve(identity.repoRoot, globalExcludePath),
          ),
    ],
    {concurrency: 2},
  );
  return {
    fingerprint: sha256HexSync(
      [
        'code-graph-inventory-environment-v1',
        `threadnote:${sha256HexSync(threadnoteIgnore)}`,
        `git-info-exclude:${sha256HexSync(gitInfoExclude)}`,
        `global-exclude:${sha256HexSync(globalExclude)}`,
      ].join('\n'),
    ),
    threadnoteIgnore,
  } as const;
});

export function codeGraphInventoryReuseContract(
  languagePacks: CodeGraphLanguagePackRegistryShape,
  includeOpaqueCorpusAssets: boolean,
): string {
  const packs = languagePacks.packs
    .map(pack => ({
      files: pack.files
        .map(matcher => `${matcher.kind}:${matcher.value.toLowerCase()}:${matcher.language}:${matcher.role}`)
        .sort(),
      id: pack.id,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return sha256HexSync(
    JSON.stringify({
      admissionPolicy: CODE_GRAPH_INVENTORY_ADMISSION_POLICY_VERSION,
      contractVersion: CODE_GRAPH_INVENTORY_REUSE_CONTRACT_VERSION,
      includeOpaqueCorpusAssets,
      packs,
    }),
  );
}

export function encodeCodeGraphInventoryReuseReceipt(
  receipt: CodeGraphInventoryReuseReceipt | undefined,
): string | null {
  return receipt === undefined ? null : JSON.stringify(receipt);
}

export function decodeCodeGraphInventoryReuseReceipt(value: unknown): CodeGraphInventoryReuseReceipt | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_000_000) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return undefined;
    if (parsed.version !== CODE_GRAPH_INVENTORY_REUSE_RECEIPT_VERSION) return undefined;
    if (!isSha256(parsed.contract) || !isSha256(parsed.environmentFingerprint)) return undefined;
    if (typeof parsed.includeOpaqueCorpusAssets !== 'boolean') return undefined;
    if (!isNonNegativeSafeInteger(parsed.skipped)) return undefined;
    if (!isBoundedStringArray(parsed.diagnostics, 100, 2_000)) return undefined;
    if (!isPolicyExclusionSummary(parsed.policyExclusions)) return undefined;
    const workspaceInput = parsed.workspace;
    const workspace = normalizedWorkspace(workspaceInput);
    if (!isRecord(workspaceInput) || workspace === undefined || workspace.fingerprint !== workspaceInput.fingerprint) {
      return undefined;
    }
    return {
      contract: parsed.contract,
      diagnostics: parsed.diagnostics,
      environmentFingerprint: parsed.environmentFingerprint,
      includeOpaqueCorpusAssets: parsed.includeOpaqueCorpusAssets,
      policyExclusions: parsed.policyExclusions,
      skipped: parsed.skipped,
      version: CODE_GRAPH_INVENTORY_REUSE_RECEIPT_VERSION,
      workspace,
    };
  } catch {
    return undefined;
  }
}

function normalizedWorkspace(value: unknown): CodeGraphWorkspace | undefined {
  if (!isRecord(value) || !isSha256(value.fingerprint) || !Array.isArray(value.projects)) return undefined;
  if (!Array.isArray(value.diagnostics) || !Array.isArray(value.workspaces)) return undefined;
  try {
    return mergeCodeGraphWorkspaces([value as unknown as CodeGraphWorkspace]);
  } catch {
    return undefined;
  }
}

function isPolicyExclusionSummary(value: unknown): value is CodeGraphInventoryPolicyExclusionSummary {
  if (!isRecord(value)) return false;
  if (!isNonNegativeSafeInteger(value.bytes) || !isNonNegativeSafeInteger(value.files)) return false;
  if (
    value.policyVersion !== CODE_GRAPH_INVENTORY_ADMISSION_POLICY_VERSION ||
    !Array.isArray(value.reasons) ||
    value.reasons.length !== CODE_GRAPH_INVENTORY_EXCLUSION_REASONS.length
  ) {
    return false;
  }
  const reasons = new Set<string>();
  let bytes = 0;
  let files = 0;
  const valid = value.reasons.every(reason => {
    if (!isRecord(reason)) return false;
    const accepted =
      isNonNegativeSafeInteger(reason.bytes) &&
      isNonNegativeSafeInteger(reason.files) &&
      typeof reason.reason === 'string' &&
      CODE_GRAPH_INVENTORY_EXCLUSION_REASONS.includes(
        reason.reason as (typeof CODE_GRAPH_INVENTORY_EXCLUSION_REASONS)[number],
      ) &&
      !reasons.has(reason.reason);
    if (accepted) {
      reasons.add(reason.reason as string);
      bytes += reason.bytes as number;
      files += reason.files as number;
    }
    return accepted;
  });
  return valid && bytes === value.bytes && files === value.files;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedStringArray(value: unknown, maxItems: number, maxLength: number): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every(item => typeof item === 'string' && item.length <= maxLength)
  );
}
