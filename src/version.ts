import {readFileSync} from 'node:fs';
import {join} from 'node:path';

let cachedVersion: string | undefined;

/**
 * Returns the threadnote package version baked into this build. The bundled
 * CJS lives at `<install>/dist/threadnote.cjs` (or `<install>/dist/mcp_server.cjs`),
 * and the package's `files:` list ships `package.json` alongside `dist/`, so a
 * relative read from `__dirname` resolves the same metadata that npm sees.
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
    const packageJsonPath = join(__dirname, '..', 'package.json');
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {readonly version?: unknown};
    cachedVersion = typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}
