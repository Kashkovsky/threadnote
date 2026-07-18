import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

let cachedVersion: string | undefined;
const moduleDirectory = dirname(fileURLToPath(import.meta.url));

/**
 * Returns the threadnote package version baked into this build. The bundled
 * ESM lives under `<install>/dist/`,
 * and the package's `files:` list ships `package.json` alongside `dist/`, so a
 * relative read from this module resolves the same metadata that npm sees.
 *
 * Returns `'unknown'` if the read fails (dev runs via tsx, or a damaged
 * install). Callers should treat `'unknown'` as a signal to skip whatever they
 * were about to do — there's no actionable comparison to make.
 */
export function getThreadnoteVersion(): string {
  if (cachedVersion !== undefined) {
    return cachedVersion;
  }
  try {
    const packageJsonPath = join(moduleDirectory, '..', 'package.json');
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {readonly version?: unknown};
    cachedVersion = typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}
