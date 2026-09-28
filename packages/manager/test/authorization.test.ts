import {describe, expect, it} from 'vitest';
import {managerLoopbackUrl, managerRequestIsAuthorized} from '../src/authorization.js';

describe('Manager authorization', () => {
  it('accepts the bearer and Manager header forms only for the exact token', () => {
    expect(managerRequestIsAuthorized({headers: {authorization: 'Bearer secret'}}, 'secret')).toBe(true);
    expect(managerRequestIsAuthorized({headers: {'x-threadnote-token': 'secret'}}, 'secret')).toBe(true);
    expect(managerRequestIsAuthorized({headers: {authorization: 'Bearer secret-extra'}}, 'secret')).toBe(false);
    expect(managerRequestIsAuthorized({headers: {}}, 'secret')).toBe(false);
  });

  it('round-trips reserved token characters through the loopback URL', () => {
    const token = 'a+b/c=d?e';
    const url = new URL(managerLoopbackUrl(43123, token));
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.port).toBe('43123');
    expect(url.searchParams.get('token')).toBe(token);
  });
});
