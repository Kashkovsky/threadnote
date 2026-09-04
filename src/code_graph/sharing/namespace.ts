import type {Path} from 'effect';
import {sha256HexSync} from '../../crypto/sha256.js';
import type {GraphShareActionKey} from './action.js';

export const GRAPH_SHARE_CAS_CANONICAL = 'cas://local';
export const GRAPH_SHARE_CAS_WORKER = 'cas://local/worker';

export function graphShareFrontierDiscoveryTag(repositoryId: string, branchRef: string): string {
  return `tn-frontier-${sha256HexSync(`${repositoryId}${branchRef}`).slice(0, 40)}`;
}

export function graphShareActionDiscoveryTag(actionKey: GraphShareActionKey): string {
  return `tn-action-${actionKey}`;
}

export function graphShareWorkDiscoveryTag(batchId: string): string {
  return `tn-work-${batchId.slice(0, 40)}`;
}

export function graphShareWorkerCasRoot(path: Path.Path, casRoot: string): string {
  return path.join(casRoot, 'worker');
}

export function graphShareCanonicalCasRoot(path: Path.Path, casRoot: string): string {
  return casRoot;
}

export function isGraphShareWorkerRegistry(value: string): boolean {
  return value === GRAPH_SHARE_CAS_WORKER || value.endsWith('/worker');
}

export function isGraphShareCanonicalRegistry(value: string): boolean {
  return value === GRAPH_SHARE_CAS_CANONICAL || value.endsWith('/canonical');
}
