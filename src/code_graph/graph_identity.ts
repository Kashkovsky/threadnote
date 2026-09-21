import {sha256HexSync} from '../crypto/sha256.js';
import {codeGraphInventorySha256Hex} from './inventory/identity.js';
import {compareCodeUnits} from './ordering.js';
import {codeGraphScopeIdentitySuffix, type CodeGraphScopeIdentity} from './scope/identity.js';
import {CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION} from './store/build/core.js';
import type {CodeGraphLanguagePackProvenance} from './store/models.js';
import {CODE_GRAPH_EXTRACTOR_SET_VERSION} from './types.js';

export interface CodeGraphContentIdentityFile {
  readonly contentHash: string;
  readonly language?: string;
  readonly mode?: string;
  readonly path: string;
}

export interface CodeGraphContentIdentityAccumulator {
  readonly digest: () => string;
  readonly update: (file: CodeGraphContentIdentityFile) => void;
}

export function codeGraphExtractorSetIdentityFromPackProvenance(
  provenance: readonly CodeGraphLanguagePackProvenance[],
): string {
  return codeGraphExtractorSetIdentityFromIdentities(
    [...new Set(provenance.map(pack => pack.cacheIdentity))],
    [...new Set(provenance.map(pack => pack.derivationIdentity))],
  );
}

export function codeGraphExtractorSetIdentityFromIdentities(
  cacheIdentities: readonly string[],
  derivationIdentities: readonly string[],
): string {
  const activeParsers = [...cacheIdentities].sort(compareCodeUnits).join('\n');
  const activeDerivations = [...derivationIdentities].sort(compareCodeUnits).join('\n');
  return sha256HexSync(
    `${CODE_GRAPH_EXTRACTOR_SET_VERSION}\nactive-parser-packs:\n${activeParsers}\nactive-derivations:\n${activeDerivations}\nignore-policy:3\nresolution-context-policy:semantic-workspace-v1`,
  );
}

export function codeGraphContentIdentity(
  extractorSet: string,
  files: readonly CodeGraphContentIdentityFile[],
  scope?: CodeGraphScopeIdentity,
): string {
  return `cgc_${codeGraphInventorySha256Hex(graphContentPrefix(extractorSet, scope), files, graphContentLine).slice(0, 40)}`;
}

/** Hashes an already strict UTF-16-code-unit-ordered inventory without retaining it in memory. */
export function createCodeGraphContentIdentityAccumulator(
  extractorSet: string,
  scope?: CodeGraphScopeIdentity,
): CodeGraphContentIdentityAccumulator {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(graphContentPrefix(extractorSet, scope));
  let completed: string | undefined;
  let previousPath: string | undefined;
  let rows = 0;
  return {
    digest: () => {
      if (completed === undefined) completed = `cgc_${hasher.digest('hex').slice(0, 40)}`;
      return completed;
    },
    update: file => {
      if (completed !== undefined) throw new Error('Code graph content identity is already complete.');
      if (file.path.includes('\0') || (previousPath !== undefined && compareCodeUnits(previousPath, file.path) >= 0)) {
        throw new Error('Code graph content identity input is not in strict canonical order.');
      }
      if (rows > 0) hasher.update('\n');
      hasher.update(graphContentLine(file));
      previousPath = file.path;
      rows += 1;
    },
  };
}

function graphContentPrefix(extractorSet: string, scope: CodeGraphScopeIdentity | undefined): string {
  return `graph-content-v1\nlexical-storage:${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}\n${extractorSet}\n${codeGraphScopeIdentitySuffix(scope)}`;
}

function graphContentLine(file: CodeGraphContentIdentityFile): string {
  return `${file.path}\0${file.contentHash}\0${file.language ?? ''}\0${file.mode ?? ''}`;
}
