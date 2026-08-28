import {sha256HexSync} from '../../crypto/sha256.js';
import type {CodeGraphFileFacts} from '../types.js';
import {canonicalJson} from './canonical_json.js';

const CHECKPOINT_FILE_FACT_IDENTITY_DOMAIN = 'threadnote-code-graph-checkpoint-file-fact-v1\0';

/** Exact portable identity for one already-validated materialized file fact. */
export function codeGraphCheckpointFileFactCacheIdentity(facts: CodeGraphFileFacts): string {
  return `cgfd_${sha256HexSync(`${CHECKPOINT_FILE_FACT_IDENTITY_DOMAIN}${canonicalJson(facts)}`).slice(0, 40)}`;
}
