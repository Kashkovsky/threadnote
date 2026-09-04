import type {Path} from 'effect';

export const GRAPH_SHARE_ENROLLMENT_RELATIVE_PATH = '.threadnote/graph-share.json';
export const GRAPH_SHARING_DIRECTORY = 'graph-sharing';
export const GRAPH_SHARING_CLIENT_STATE_FILE = 'client-state.json';
export const GRAPH_SHARING_TRUST_RECEIPTS_FILE = 'trust-receipts.json';
export const GRAPH_SHARING_PUBLISHER_KEY_FILE = 'publisher.ed25519.json';

export interface GraphSharingLayout {
  readonly attemptsRoot: string;
  readonly casRoot: string;
  readonly clientStateLockPath: string;
  readonly clientStatePath: string;
  readonly coordinatorStateLockPath: string;
  readonly coordinatorStatePath: string;
  readonly frontiersRoot: string;
  readonly keysRoot: string;
  readonly profilesRoot: string;
  readonly provenanceRoot: string;
  readonly publisherKeyPath: string;
  readonly quarantineRoot: string;
  readonly root: string;
  readonly trustReceiptsLockPath: string;
  readonly trustReceiptsPath: string;
  readonly workerRoot: string;
}

export function graphSharingLayout(path: Path.Path, threadnoteHome: string, casRoot?: string): GraphSharingLayout {
  const root = path.join(threadnoteHome, GRAPH_SHARING_DIRECTORY);
  const resolvedCas = casRoot ?? path.join(root, 'cas');
  return {
    attemptsRoot: path.join(root, 'attempts'),
    casRoot: resolvedCas,
    clientStateLockPath: path.join(root, `${GRAPH_SHARING_CLIENT_STATE_FILE}.lock`),
    clientStatePath: path.join(root, GRAPH_SHARING_CLIENT_STATE_FILE),
    coordinatorStateLockPath: path.join(root, 'coordinator-state.json.lock'),
    coordinatorStatePath: path.join(root, 'coordinator-state.json'),
    frontiersRoot: path.join(resolvedCas, 'frontiers'),
    keysRoot: path.join(root, 'keys'),
    profilesRoot: path.join(root, 'profiles'),
    provenanceRoot: path.join(root, 'provenance'),
    publisherKeyPath: path.join(root, 'keys', GRAPH_SHARING_PUBLISHER_KEY_FILE),
    quarantineRoot: path.join(root, 'quarantine'),
    root,
    trustReceiptsLockPath: path.join(root, `${GRAPH_SHARING_TRUST_RECEIPTS_FILE}.lock`),
    trustReceiptsPath: path.join(root, GRAPH_SHARING_TRUST_RECEIPTS_FILE),
    workerRoot: path.join(resolvedCas, 'worker'),
  };
}

export function graphShareEnrollmentPath(path: Path.Path, repoRoot: string): string {
  return path.join(repoRoot, GRAPH_SHARE_ENROLLMENT_RELATIVE_PATH);
}

export function graphSharingFrontierPointerPath(path: Path.Path, frontiersRoot: string, repositoryId: string): string {
  return path.join(frontiersRoot, repositoryId, 'latest.json');
}

export function graphSharingContributionQueuePath(path: Path.Path, root: string, repositoryId: string): string {
  return path.join(root, 'contribution', `${repositoryId}.json`);
}

export function graphSharingWorkerWorkPath(path: Path.Path, workerRoot: string, repositoryId: string): string {
  return path.join(workerRoot, repositoryId, 'work.json');
}

export function graphSharingProvenancePath(path: Path.Path, provenanceRoot: string, checkoutId: string): string {
  return path.join(provenanceRoot, `${checkoutId}.json`);
}

export function graphSharingAttemptPath(path: Path.Path, attemptsRoot: string, checkoutId: string): string {
  return path.join(attemptsRoot, `${checkoutId}.json`);
}

export function graphSharingCasBlobPath(path: Path.Path, casRoot: string, hex: string): string {
  return path.join(casRoot, 'sha256', hex);
}

export function graphSharingCoordinatorStatePath(path: Path.Path, root: string): string {
  return path.join(root, 'coordinator-state.json');
}

export function graphSharingTagPath(path: Path.Path, casRoot: string, name: string): string {
  return path.join(casRoot, 'tags', name);
}
