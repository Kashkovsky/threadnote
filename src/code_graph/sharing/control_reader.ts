import {Clock, Console, Effect, Path, Schema, Semaphore} from 'effect';
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse';
import {fromPromiseInterruptible} from '../../effect/errors.js';
import {
  createRemoteAccessTokenVerifier,
  parseBearerAccessToken,
  type AccessTokenClaims,
} from '../../oauth/access_token.js';
import {
  parseGraphShareFrontierManifest,
  parseGraphShareFrontierPointer,
  parseGraphShareSignatureEnvelope,
  verifyGraphShareFrontier,
} from './artifacts.js';
import {decodeJsonBytes} from './atomic.js';
import {casBlobPath} from './cas.js';
import {
  graphControlGrantExpiry,
  makeGraphControlRateLimit,
  readGraphControlBytes,
  readGraphControlPolicy,
  type GraphControlPolicy,
  type GraphControlScope,
} from './control_authorization.js';
import {
  enrollGraphControlWorker,
  GraphControlEnrollmentError,
  readGraphWorkerEnrollmentRequest,
} from './control_enrollment.js';
import {GRAPH_SHARE_CONTROL_MAX_BODY_BYTES} from './control_protocol.js';
import {parseSha256Digest, sha256Digest} from './digest.js';
import {graphSharingFailure} from './errors.js';
import {graphSharingFrontierPointerPath, graphSharingLayout} from './layout.js';
import {graphShareFrontierDiscoveryTag} from './namespace.js';
import {
  assertProfileMatchesEnrollment,
  graphShareProfileDigest,
  type GraphShareEnrollmentV1,
  type GraphShareProfileV1,
} from './profile.js';

export interface GraphControlReaderOptions {
  readonly casRoot: string;
  readonly enrollment: GraphShareEnrollmentV1;
  readonly policyFile: string;
  readonly profile: GraphShareProfileV1;
  readonly threadnoteHome: string;
}

type Operation = 'discovery' | 'frontier' | 'status' | 'enroll' | 'unsupported';

export const validateGraphControlPolicy = Effect.fn('codeGraph.sharing.validateControlPolicy')(function* (
  options: GraphControlReaderOptions,
) {
  const scope = graphControlReaderScope(options);
  const policy = yield* readGraphControlPolicy(options.policyFile);
  if (
    policy.organization !== scope.organization ||
    policy.repositoryId !== scope.repositoryId ||
    policy.profileDigest !== scope.profileDigest
  ) {
    return yield* graphSharingFailure('Graph control policy does not match the enrolled profile.');
  }
  return policy;
});

export const makeGraphControlReader = Effect.fn('codeGraph.sharing.makeControlReader')(function* (
  options: GraphControlReaderOptions,
  verifyToken?: (token: string) => Promise<AccessTokenClaims>,
) {
  const scope = graphControlReaderScope(options);
  const initial = yield* validateGraphControlPolicy(options);
  const verify = verifyToken ?? createRemoteAccessTokenVerifier({...initial, jwksUrl: new URL(initial.jwksUrl)});
  const permits = yield* Semaphore.make(8);
  const globalAdmission = makeGraphControlRateLimit({maximumPrincipals: 1, requestsPerMinute: 1200});
  const principalAdmission = makeGraphControlRateLimit();
  const currentPolicy = readGraphControlPolicy(options.policyFile).pipe(
    Effect.filterOrFail(
      policy => sameAuthority(initial, policy),
      () => graphSharingFailure('Graph control authority changed; restart the listener.'),
    ),
  );

  const handleRequest = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (!globalAdmission('listener', now)) return reply(429, {error: 'rate-limited'});
    const request = yield* HttpServerRequest.HttpServerRequest;
    const pathname = request.url.split('?', 1)[0] ?? '';
    const operation: Operation =
      pathname === '/.well-known/threadnote-graph'
        ? 'discovery'
        : pathname === '/v1/status'
          ? 'status'
          : pathname === '/v1/enroll'
            ? 'enroll'
            : /^\/v1\/frontiers\/[0-9a-f]{40}$/u.test(pathname)
              ? 'frontier'
              : 'unsupported';
    let principalId: string | undefined;
    const handle = Effect.gen(function* () {
      if (operation === 'enroll' ? request.method !== 'POST' : request.method !== 'GET' && request.method !== 'HEAD')
        return reply(403, {error: 'operation-unavailable'});
      if (
        operation !== 'enroll' &&
        (request.headers['transfer-encoding'] || Number(request.headers['content-length'] ?? 0) !== 0)
      ) {
        return reply(400, {error: 'invalid-request'});
      }
      if (operation === 'unsupported') return reply(404, {error: 'not-found'});
      if (operation === 'discovery')
        return reply(200, {
          organization: scope.organization,
          protocolVersions: ['v1'],
          controlMode: 'authenticated-metadata',
        });
      const principal = yield* fromPromiseInterruptible(
        () => verify(parseBearerAccessToken(request.headers.authorization)),
        () => graphSharingFailure('Graph control authentication failed.'),
      ).pipe(Effect.option);
      if (principal._tag === 'None') return reply(401, {error: 'unauthorized'});
      principalId = sha256Digest(JSON.stringify([principal.value.issuer, principal.value.subject]));
      const authorized = Effect.gen(function* () {
        const policy = yield* currentPolicy;
        const at = (yield* Clock.currentTimeMillis) / 1000;
        return (
          principal.value.expiresAt > at &&
          request.headers['x-threadnote-repository-id'] === scope.repositoryId &&
          request.headers['x-threadnote-profile-digest'] === scope.profileDigest &&
          graphControlGrantExpiry(
            policy,
            scope,
            principal.value,
            operation === 'enroll' ? 'graph:contribute' : 'graph:read',
            at,
          ) !== undefined
        );
      });
      if (!(yield* authorized)) return reply(403, {error: 'forbidden'});
      if (!principalAdmission(principalId, yield* Clock.currentTimeMillis)) return reply(429, {error: 'rate-limited'});
      if (operation === 'enroll') {
        const declared = Number(request.headers['content-length'] ?? 0);
        if (!Number.isSafeInteger(declared) || declared < 0 || declared > GRAPH_SHARE_CONTROL_MAX_BODY_BYTES)
          return reply(413, {error: 'invalid-request'});
        if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
          return reply(400, {error: 'invalid-request'});
        const decoded = yield* readGraphWorkerEnrollmentRequest(request.stream).pipe(Effect.option);
        if (decoded._tag === 'None') return reply(400, {error: 'invalid-request'});
        const enrolled = yield* enrollGraphControlWorker({
          home: options.threadnoteHome,
          initialPolicy: initial,
          principal: principal.value,
          readCurrentPolicy: currentPolicy,
          request: decoded.value,
        }).pipe(
          Effect.map(result => reply(result.created ? 201 : 200, result.body)),
          Effect.catchIf(
            error => Schema.is(GraphControlEnrollmentError)(error),
            error => Effect.succeed(reply(error.code === 'forbidden' ? 403 : 429, {error: error.code})),
          ),
        );
        return enrolled;
      }
      const frontier = yield* readGraphControlFrontier(options);
      if (!(yield* authorized)) return reply(403, {error: 'forbidden'});
      if (operation === 'frontier') {
        const expected = graphShareFrontierDiscoveryTag(scope.repositoryId, frontier.manifest.branch).slice(
          'tn-frontier-'.length,
        );
        if (pathname !== `/v1/frontiers/${expected}`) return reply(404, {error: 'not-found'});
        return reply(200, {
          envelopeDigest: frontier.pointer.envelopeDigest,
          frontierDigest: frontier.pointer.manifestDigest,
          manifestDigest: frontier.pointer.manifestDigest,
        });
      }
      return reply(200, {
        generation: frontier.manifest.generation,
        organization: scope.organization,
        phase: 'published',
        profileDigest: scope.profileDigest,
        publishedFrontier: frontier.manifest.sourceCommit,
        receipts: [],
        repositoryId: scope.repositoryId,
      });
    }).pipe(
      Effect.timeout('10 seconds'),
      Effect.catchDefect(() => Effect.succeed(reply(503, {error: 'unavailable'}))),
      Effect.orElseSucceed(() => reply(503, {error: 'unavailable'})),
    );
    const response = yield* permits.withPermitsIfAvailable(1)(handle);
    const selected = response._tag === 'Some' ? response.value : reply(503, {error: 'busy'});
    yield* Console.log(
      JSON.stringify({
        event: 'graph-control-access',
        operation,
        ...(principalId === undefined ? {} : {principalId}),
        status: selected.status,
      }),
    );
    return selected;
  });
  return {handle: handleRequest};
});

function graphControlReaderScope(options: GraphControlReaderOptions): GraphControlScope {
  const profileDigest = graphShareProfileDigest(options.profile);
  assertProfileMatchesEnrollment(options.profile, options.enrollment, profileDigest);
  return {organization: options.profile.organization, profileDigest, repositoryId: options.profile.repositoryId};
}

function sameAuthority(left: GraphControlPolicy, right: GraphControlPolicy): boolean {
  return (
    left.audience === right.audience &&
    left.issuer === right.issuer &&
    left.jwksUrl === right.jwksUrl &&
    left.organization === right.organization &&
    left.repositoryId === right.repositoryId &&
    left.profileDigest === right.profileDigest
  );
}

export const readGraphControlFrontier = Effect.fn('codeGraph.sharing.readControlFrontier')(function* (
  options: GraphControlReaderOptions,
) {
  const scope = graphControlReaderScope(options);
  const path = yield* Path.Path;
  const layout = graphSharingLayout(path, options.threadnoteHome, options.casRoot);
  const pointerFile = graphSharingFrontierPointerPath(path, layout.frontiersRoot, scope.repositoryId);
  const pointer = parseGraphShareFrontierPointer(
    yield* decodeJsonBytes(yield* readGraphControlBytes(pointerFile, GRAPH_SHARE_CONTROL_MAX_BODY_BYTES)),
  );
  const readBlob = (digest: string) =>
    Effect.gen(function* () {
      const bytes = yield* readGraphControlBytes(
        yield* casBlobPath(options.casRoot, digest),
        GRAPH_SHARE_CONTROL_MAX_BODY_BYTES,
      );
      if (sha256Digest(bytes) !== digest) return yield* graphSharingFailure('Graph control artifact digest mismatch.');
      return yield* decodeJsonBytes(bytes);
    });
  const manifest = parseGraphShareFrontierManifest(yield* readBlob(pointer.manifestDigest));
  const envelope = parseGraphShareSignatureEnvelope(yield* readBlob(pointer.envelopeDigest));
  yield* verifyGraphShareFrontier(parseSha256Digest(options.enrollment.publisherKeyFingerprint), manifest, envelope);
  if (
    manifest.repositoryId !== scope.repositoryId ||
    manifest.profileDigest !== scope.profileDigest ||
    !options.profile.source.branches.includes(manifest.branch)
  ) {
    return yield* graphSharingFailure('Graph control frontier does not match the enrolled profile.');
  }
  return {manifest, pointer};
});

function reply(status: number, body: unknown) {
  return HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: {'cache-control': 'no-store', ...(status === 401 ? {'www-authenticate': 'Bearer'} : {})},
  });
}
