import {Clock, Effect, Redacted, Schema, Stream} from 'effect';
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient';
import * as HttpClient from 'effect/unstable/http/HttpClient';
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest';
import {
  GraphSharingError,
  graphSharingFailure,
  graphSharingHttpFailure,
  graphSharingUnavailable,
  graphShareRetryAfterMilliseconds,
} from './errors.js';
import {parseGraphShareRegistryChallenge, type GraphShareRegistryChallenge} from './registry_auth.js';
import {makeGraphShareRegistryCredentialLoader} from './registry_credentials.js';
import type {GraphShareRegistryTarget} from './registry_reference.js';

const TokenText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(16_384),
  Schema.isPattern(/^[\x21-\x7e]+$/u),
);
const TokenResponse = Schema.Struct({
  access_token: Schema.optionalKey(TokenText),
  expires_in: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  token: Schema.optionalKey(TokenText),
});

/** One reader owns one trusted origin, repository and selected credential provider. */
export const makeGraphShareRegistryHttp = Effect.fn('codeGraph.sharing.registryHttp')(function* (
  target: GraphShareRegistryTarget,
) {
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);
  const fetch = yield* FetchHttpClient.Fetch;
  const credentials = yield* makeGraphShareRegistryCredentialLoader(target);
  const request = (url: string, maximum: number, accept: string, authorization?: Redacted.Redacted<string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        let request = HttpClientRequest.get(url).pipe(HttpClientRequest.setHeader('accept', accept));
        if (authorization !== undefined)
          request = HttpClientRequest.setHeader(request, 'authorization', Redacted.value(authorization));
        const response = yield* client
          .execute(request)
          .pipe(
            Effect.provideService(FetchHttpClient.RequestInit, {redirect: 'manual', credentials: 'omit'}),
            Effect.provideService(FetchHttpClient.Fetch, fetch),
          );
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (response.status === 200) {
          const length = response.headers['content-length'];
          if (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > maximum)) {
            return yield* graphSharingFailure('Registry response exceeds its size limit.');
          }
          yield* Stream.runForEach(response.stream, chunk =>
            Effect.gen(function* () {
              size += chunk.byteLength;
              if (size > maximum) return yield* graphSharingFailure('Registry response exceeds its size limit.');
              chunks.push(chunk);
            }),
          );
        }
        return {bytes: Buffer.concat(chunks, size), headers: response.headers, status: response.status};
      }),
    ).pipe(
      Effect.timeout(60_000),
      Effect.mapError(error =>
        Schema.is(GraphSharingError)(error) ? error : graphSharingUnavailable('Registry request failed.'),
      ),
    );

  let challenge: GraphShareRegistryChallenge | undefined;
  let authorization: Redacted.Redacted<string> | undefined;
  let expiresAt = 0;
  const authorize = Effect.gen(function* () {
    if (challenge === undefined) return;
    const credential = yield* credentials();
    if (challenge.kind === 'basic') {
      if (credential === undefined)
        return yield* graphSharingFailure('Registry requires a configured credential helper.');
      authorization = credential.authorization;
      expiresAt = (yield* Clock.currentTimeMillis) + 300_000;
      return;
    }
    const url = new URL(challenge.realm);
    url.searchParams.set('scope', target.pullScope);
    if (challenge.service !== undefined) url.searchParams.set('service', challenge.service);
    const response = yield* request(url.href, 32_768, 'application/json', credential?.authorization);
    if (response.status !== 200) return yield* graphSharingHttpFailure(response.status);
    const token = yield* Schema.decodeEffect(Schema.fromJsonString(TokenResponse))(
      new TextDecoder().decode(response.bytes),
    ).pipe(Effect.mapError(() => graphSharingFailure('Registry token response is invalid.')));
    const value = token.token ?? token.access_token;
    if (
      value === undefined ||
      (token.token !== undefined && token.access_token !== undefined && token.token !== token.access_token)
    ) {
      return yield* graphSharingFailure('Registry token response is invalid.');
    }
    authorization = Redacted.make(`Bearer ${value}`);
    expiresAt = (yield* Clock.currentTimeMillis) + Math.min(token.expires_in ?? 60, 300) * 1000;
  });

  return (pathname: string, maximum: number, accept: string) =>
    Effect.gen(function* () {
      const prefix = `/v2/${target.repository}/`;
      if (
        !pathname.startsWith(prefix) ||
        !/^(?:manifests|blobs)\/[A-Za-z0-9_.:-]+$/u.test(pathname.slice(prefix.length))
      ) {
        return yield* graphSharingFailure('Registry read path is outside the trusted repository.');
      }
      if (challenge !== undefined && expiresAt <= (yield* Clock.currentTimeMillis)) yield* authorize;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = yield* request(target.origin + pathname, maximum, accept, authorization);
        if (response.status === 200) return response;
        if (response.status !== 401 || attempt === 2) {
          if (response.status === 404) return yield* graphSharingUnavailable('Registry artifact is missing.');
          return yield* graphSharingHttpFailure(
            response.status,
            graphShareRetryAfterMilliseconds(response.headers['retry-after'], yield* Clock.currentTimeMillis),
          );
        }
        const next = yield* Effect.try({
          try: () => parseGraphShareRegistryChallenge(response.headers['www-authenticate'], target),
          catch: () => graphSharingFailure('Registry authentication challenge is not trusted.'),
        });
        if (challenge !== undefined && JSON.stringify(next) !== JSON.stringify(challenge)) {
          return yield* graphSharingFailure('Registry authentication authority changed.');
        }
        challenge = next;
        yield* authorize;
      }
      return yield* graphSharingFailure('Registry authentication retry limit reached.');
    });
});
