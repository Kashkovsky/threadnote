/** Local HTTP boundary for Effect tests that must talk to an in-process server. */
export function testHttpFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}
