export interface ManagerAuthorizationRequest {
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export function managerRequestIsAuthorized(request: ManagerAuthorizationRequest, token: string): boolean {
  return request.headers.authorization === `Bearer ${token}` || request.headers['x-threadnote-token'] === token;
}

export function managerLoopbackUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
}
