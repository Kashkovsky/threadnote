export interface LinuxCgroupMemoryFile {
  readonly path: string;
  readonly version: 1 | 2;
}

interface LinuxCgroupMembership {
  readonly path: string;
  readonly version: 1 | 2;
}

interface LinuxCgroupMount {
  readonly mountPoint: string;
  readonly root: string;
  readonly version: 1 | 2;
}

const CGROUP_UNLIMITED_BYTES_MINIMUM = 9_223_372_036_854_771_712n;

/**
 * Resolves every visible memory-controller limit from the process's current
 * cgroup through the mounted hierarchy root. Parent limits matter when a child
 * reports `max`, and mount roots matter inside cgroup namespaces.
 */
export function linuxCgroupMemoryFiles(
  processCgroup: string,
  processMountInfo: string,
): readonly LinuxCgroupMemoryFile[] {
  const memberships = parseLinuxCgroupMemberships(processCgroup);
  const mounts = parseLinuxCgroupMounts(processMountInfo);
  const files: LinuxCgroupMemoryFile[] = [];
  for (const membership of memberships) {
    const mount = matchingLinuxCgroupMount(membership, mounts);
    if (mount === undefined) continue;
    const relative = membership.path === '/' ? '' : relativeToRoot(membership.path, mount.root);
    const filename = membership.version === 2 ? 'memory.max' : 'memory.limit_in_bytes';
    for (const ancestor of visibleAncestorPaths(relative)) {
      files.push({path: joinLinuxPath(mount.mountPoint, ancestor, filename), version: membership.version});
    }
  }
  return [...new Map(files.map(file => [`${file.version}:${file.path}`, file])).values()];
}

/** Parses a positive finite cgroup byte limit exactly. Unlimited and malformed values are absent. */
export function parseLinuxCgroupMemoryLimitBytes(value: string): bigint | undefined {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return undefined;
  try {
    const bytes = BigInt(normalized);
    return bytes > 0n && bytes < CGROUP_UNLIMITED_BYTES_MINIMUM ? bytes : undefined;
  } catch {
    return undefined;
  }
}

/** Physical RAM remains provenance; only a lower visible cgroup limit constrains capacity. */
export function effectiveLinuxMemoryBytes(
  physicalMemoryBytes: number,
  cgroupMemoryLimits: readonly (string | undefined)[],
): number {
  if (!Number.isSafeInteger(physicalMemoryBytes) || physicalMemoryBytes <= 0) return physicalMemoryBytes;
  const physical = BigInt(physicalMemoryBytes);
  let effective = physical;
  for (const value of cgroupMemoryLimits) {
    if (value === undefined) continue;
    const limit = parseLinuxCgroupMemoryLimitBytes(value);
    if (limit !== undefined && limit < effective) effective = limit;
  }
  return Number(effective);
}

function parseLinuxCgroupMemberships(input: string): readonly LinuxCgroupMembership[] {
  const memberships: LinuxCgroupMembership[] = [];
  for (const line of input.split(/\r?\n/)) {
    // The path may itself contain colons, so only the first two separators are structural.
    const match = /^(\d+):([^:]*):(.*)$/.exec(line.trim());
    if (!match) continue;
    const controllers = new Set((match[2] ?? '').split(',').filter(Boolean));
    const path = normalizeLinuxPath(match[3] ?? '/');
    if (path === undefined) continue;
    if (match[1] === '0' && controllers.size === 0) memberships.push({path, version: 2});
    if (controllers.has('memory')) memberships.push({path, version: 1});
  }
  return memberships;
}

function parseLinuxCgroupMounts(input: string): readonly LinuxCgroupMount[] {
  const mounts: LinuxCgroupMount[] = [];
  for (const line of input.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    const separator = fields.indexOf('-');
    if (separator < 6 || separator + 3 >= fields.length) continue;
    const filesystem = fields[separator + 1];
    const source = fields[separator + 2] ?? '';
    const superOptions = fields.slice(separator + 3).join(',');
    const version =
      filesystem === 'cgroup2'
        ? 2
        : filesystem === 'cgroup' && hasMemoryController(source, superOptions)
          ? 1
          : undefined;
    if (version === undefined) continue;
    const mountPoint = normalizeLinuxPath(decodeMountInfoPath(fields[4] ?? '/'));
    const root = normalizeLinuxPath(decodeMountInfoPath(fields[3] ?? '/'));
    if (mountPoint === undefined || root === undefined) continue;
    mounts.push({mountPoint, root, version});
  }
  return mounts;
}

function matchingLinuxCgroupMount(
  membership: LinuxCgroupMembership,
  mounts: readonly LinuxCgroupMount[],
): LinuxCgroupMount | undefined {
  return mounts
    .filter(
      candidate =>
        candidate.version === membership.version &&
        (membership.path === '/' || pathWithinRoot(membership.path, candidate.root)),
    )
    .sort((left, right) => right.root.length - left.root.length)[0];
}

function hasMemoryController(source: string, superOptions: string): boolean {
  return `${source},${superOptions}`.split(',').includes('memory');
}

function decodeMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function normalizeLinuxPath(value: string): string | undefined {
  if (!value.startsWith('/') || [...value].some(character => isControlCharacter(character))) return undefined;
  const segments: string[] = [];
  for (const segment of value.split('/')) {
    if (!segment) continue;
    if (segment === '.' || segment === '..') return undefined;
    segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

function isControlCharacter(value: string): boolean {
  const code = value.charCodeAt(0);
  return code <= 31 || code === 127;
}

function pathWithinRoot(path: string, root: string): boolean {
  return root === '/' || path === root || path.startsWith(`${root}/`);
}

function relativeToRoot(path: string, root: string): string {
  if (root === '/') return path.slice(1);
  return path === root ? '' : path.slice(root.length + 1);
}

function visibleAncestorPaths(relative: string): readonly string[] {
  if (!relative) return [''];
  const segments = relative.split('/');
  return Array.from({length: segments.length + 1}, (_, index) => segments.slice(0, segments.length - index).join('/'));
}

function joinLinuxPath(...parts: readonly string[]): string {
  return `/${parts
    .flatMap(part => part.split('/'))
    .filter(Boolean)
    .join('/')}`;
}
