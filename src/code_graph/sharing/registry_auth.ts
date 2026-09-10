import {graphSharingFailure} from './errors.js';
import type {GraphShareRegistryTarget} from './registry_reference.js';

export type GraphShareRegistryChallenge =
  {readonly kind: 'basic'} | {readonly kind: 'bearer'; readonly realm: string; readonly service?: string};

export function parseGraphShareRegistryChallenge(
  value: string | undefined,
  target: GraphShareRegistryTarget,
  access: 'read' | 'write' = 'read',
): GraphShareRegistryChallenge {
  if (
    value === undefined ||
    value.length > 4096 ||
    [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw graphSharingFailure('Registry authentication is unsupported.');
  const head = /^(Basic|Bearer) +(.+)$/iu.exec(value);
  if (head === null) throw graphSharingFailure('Registry authentication is unsupported.');
  const fields = new Map<string, string>();
  let remaining = head[2];
  while (remaining.length > 0) {
    const field = /^([a-z_]+)="([^"\\]*)"(?:, *|$)/iu.exec(remaining);
    if (field === null || fields.has(field[1].toLowerCase())) {
      throw graphSharingFailure('Registry authentication challenge is invalid.');
    }
    fields.set(field[1].toLowerCase(), field[2]);
    remaining = remaining.slice(field[0].length);
  }
  if (head[1].toLowerCase() === 'basic') return {kind: 'basic'};
  const realm = fields.get('realm');
  if (realm === undefined) throw graphSharingFailure('Registry token realm is missing.');
  let url: URL;
  try {
    url = new URL(realm);
  } catch {
    throw graphSharingFailure('Registry token realm is invalid.');
  }
  if (
    url.origin !== target.origin ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !/^\/[A-Za-z0-9/_-]*$/u.test(url.pathname) ||
    realm !== `${url.origin}${url.pathname}`
  )
    throw graphSharingFailure('Registry token realm is outside the trusted origin.');
  const service = fields.get('service');
  if (service !== undefined && !/^[A-Za-z0-9._:-]{1,256}$/u.test(service)) {
    throw graphSharingFailure('Registry token service is invalid.');
  }
  const scope = fields.get('scope');
  if (scope !== undefined) {
    const prefix = `repository:${target.repository}:`;
    const actions = scope.slice(prefix.length).split(',');
    const allowed = access === 'write' ? ['pull', 'push'] : ['pull'];
    if (
      !scope.startsWith(prefix) ||
      new Set(actions).size !== actions.length ||
      actions.some(action => !allowed.includes(action))
    )
      throw graphSharingFailure('Registry authentication requested a different scope.');
  }
  return {kind: 'bearer', realm, ...(service === undefined ? {} : {service})};
}
