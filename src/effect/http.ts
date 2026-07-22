import {NodeHttpClient} from '@effect/platform-node';
import {Context, Effect, Layer, Schema} from 'effect';
import * as HttpClient from 'effect/unstable/http/HttpClient';
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest';
import type {HttpClientResponse} from 'effect/unstable/http/HttpClientResponse';
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient';

export class HttpRequestFailed extends Schema.TaggedErrorClass<HttpRequestFailed>()('HttpRequestFailed', {
  cause: Schema.Defect(),
  message: Schema.String,
  method: Schema.String,
  url: Schema.String,
}) {}

export class HttpStatusError extends Schema.TaggedErrorClass<HttpStatusError>()('HttpStatusError', {
  message: Schema.String,
  method: Schema.String,
  status: Schema.Number,
  url: Schema.String,
}) {}

export type HttpError = HttpRequestFailed | HttpStatusError;

export interface HttpResponse<A> {
  readonly body: A;
  readonly status: number;
}

export interface HttpGetOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

const dynamicFetch: typeof globalThis.fetch = (...args) => globalThis.fetch(...args);

export class HttpService extends Context.Service<
  HttpService,
  {
    readonly getJson: (url: string | URL, options?: HttpGetOptions) => Effect.Effect<HttpResponse<unknown>, HttpError>;
    readonly getStatus: (url: string | URL, options?: HttpGetOptions) => Effect.Effect<number, HttpRequestFailed>;
    readonly getText: (url: string | URL, options?: HttpGetOptions) => Effect.Effect<HttpResponse<string>, HttpError>;
  }
>()('threadnote/effect/HttpService') {
  static readonly layer = Layer.effect(
    HttpService,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      return HttpService.of({
        getJson: (url, options) => execute(client, url, options, response => response.json),
        getStatus: (url, options) => executeStatus(client, url, options),
        getText: (url, options) => execute(client, url, options, response => response.text),
      });
    }),
  ).pipe(Layer.provide(NodeHttpClient.layerFetch));
}

const execute = <A>(
  client: HttpClient.HttpClient,
  url: string | URL,
  options: HttpGetOptions | undefined,
  readBody: (response: HttpClientResponse) => Effect.Effect<A, unknown>,
): Effect.Effect<HttpResponse<A>, HttpError> => {
  const urlText = String(url);
  let request = HttpClientRequest.get(url);
  if (options?.headers) {
    request = HttpClientRequest.setHeaders(request, options.headers);
  }
  const response = client.execute(request).pipe(
    Effect.provideService(FetchHttpClient.Fetch, dynamicFetch),
    Effect.mapError(
      cause =>
        new HttpRequestFailed({
          cause,
          message: `GET ${urlText} failed`,
          method: 'GET',
          url: urlText,
        }),
    ),
  );
  const completeResponse = Effect.gen(function* () {
    const current = yield* response;
    if (current.status < 200 || current.status >= 300) {
      return yield* new HttpStatusError({
        message: `GET ${urlText} returned HTTP ${current.status}`,
        method: 'GET',
        status: current.status,
        url: urlText,
      });
    }
    const body = yield* readBody(current).pipe(
      Effect.mapError(
        cause =>
          new HttpRequestFailed({
            cause,
            message: `GET ${urlText} response could not be decoded`,
            method: 'GET',
            url: urlText,
          }),
      ),
    );
    return {body, status: current.status};
  });
  return completeResponse.pipe(
    Effect.timeout(options?.timeoutMs ?? 3000),
    Effect.mapError(cause =>
      cause instanceof HttpRequestFailed || cause instanceof HttpStatusError
        ? cause
        : new HttpRequestFailed({
            cause,
            message: `GET ${urlText} failed`,
            method: 'GET',
            url: urlText,
          }),
    ),
  );
};

const executeStatus = (
  client: HttpClient.HttpClient,
  url: string | URL,
  options: HttpGetOptions | undefined,
): Effect.Effect<number, HttpRequestFailed> => {
  const urlText = String(url);
  let request = HttpClientRequest.get(url);
  if (options?.headers) {
    request = HttpClientRequest.setHeaders(request, options.headers);
  }
  return client.execute(request).pipe(
    Effect.provideService(FetchHttpClient.Fetch, dynamicFetch),
    Effect.timeout(options?.timeoutMs ?? 3000),
    Effect.map(response => response.status),
    Effect.mapError(
      cause =>
        new HttpRequestFailed({
          cause,
          message: `GET ${urlText} failed`,
          method: 'GET',
          url: urlText,
        }),
    ),
  );
};

export const getJsonEffect = Effect.fn('HttpService.getJson')(function* (url: string | URL, options?: HttpGetOptions) {
  const http = yield* HttpService;
  return yield* http.getJson(url, options);
});

export const getTextEffect = Effect.fn('HttpService.getText')(function* (url: string | URL, options?: HttpGetOptions) {
  const http = yield* HttpService;
  return yield* http.getText(url, options);
});

export const getStatusEffect = Effect.fn('HttpService.getStatus')(function* (
  url: string | URL,
  options?: HttpGetOptions,
) {
  const http = yield* HttpService;
  return yield* http.getStatus(url, options);
});
