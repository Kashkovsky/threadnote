import {sha256HexSync} from '../../crypto/sha256.js';
import type {RemoteRememberInputV1} from '../../memory_domain/contracts.js';
import {normalizeRemoteCitationSources} from '../../memory_domain/citation_sources.js';
import type {AuthorizedRemotePrincipal} from '../authorization.js';

export function requestFingerprint(principal: AuthorizedRemotePrincipal, input: RemoteRememberInputV1): string {
  // Attestation IDs are renewable authorization proofs, not mutation intent.
  // A retried operation must replay its original committed actor after renewal.
  return sha256HexSync(
    JSON.stringify({
      baseRevision: input.baseRevision ?? null,
      kind: input.kind,
      lifecycle: input.lifecycle ?? null,
      operationId: input.operationId,
      project: input.project,
      ...(input.relations === undefined ? {} : {relations: input.relations}),
      ...(input.citationSources === undefined
        ? {}
        : {citationSources: normalizeRemoteCitationSources(input.citationSources)}),
      ...(input.replaceUri === undefined ? {} : {replaceUri: input.replaceUri}),
      shareId: principal.shareId,
      text: input.text,
      topic: input.topic,
      version: input.version,
    }),
  );
}
