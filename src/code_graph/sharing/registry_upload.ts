import {graphSharingFailure} from './errors.js';
import type {GraphShareRegistryTarget} from './registry_reference.js';

export function parseGraphShareRegistryUploadLocation(
  target: GraphShareRegistryTarget,
  value: string | undefined,
): string {
  const fail = () => graphSharingFailure('Registry upload location is invalid.');
  if (value === undefined || value.length > 8192) throw fail();
  const location = value.startsWith(target.origin + '/') ? value.slice(target.origin.length) : value;
  if (!location.startsWith('/') || location.startsWith('//') || location.endsWith('?')) throw fail();
  const pathname = location.split('?', 1)[0];
  const prefix = `/v2/${target.repository}/blobs/uploads/`;
  if (!pathname.startsWith(prefix) || !/^[A-Za-z0-9_-]{1,256}$/u.test(pathname.slice(prefix.length))) throw fail();
  let url: URL;
  try {
    url = new URL(location, target.origin);
  } catch {
    throw fail();
  }
  if (url.href !== target.origin + location || url.hash !== '') throw fail();
  const keys = new Set<string>();
  for (const key of url.searchParams.keys()) {
    const normalized = key.toLowerCase();
    if (
      !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u.test(key) ||
      keys.has(normalized) ||
      ['digest', 'mount', 'from'].includes(normalized)
    )
      throw fail();
    keys.add(normalized);
  }
  return location;
}
