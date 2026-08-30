import {credentialScrubberBlocker} from '../share/scrubber.js';

const SAFE_PUBLIC_CONTROL_QUERY = /^[A-Za-z0-9_./:@+-]{1,512}$/;

export function privacySafeExternalControlQuery(query: string): string {
  const value = query.trim();
  if (
    !SAFE_PUBLIC_CONTROL_QUERY.test(value) ||
    credentialScrubberBlocker(value) !== undefined ||
    value.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith('\\\\')
  ) {
    throw new Error('External benchmark controls must use a privacy-safe public symbol or repository-relative path.');
  }
  return value;
}

export function privacySafeExternalControlPath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  if (
    normalized.length === 0 ||
    normalized.length > 1_024 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    credentialScrubberBlocker(normalized) !== undefined ||
    normalized.split('/').some(segment => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error('External benchmark control paths must be normalized repository-relative paths.');
  }
  return normalized;
}
