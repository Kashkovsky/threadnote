export const CODE_GRAPH_BUILD_STATUS_SCHEMA_VERSION = 1 as const;

export const CODE_GRAPH_BUILD_HASH_ID = /^[0-9a-f]{64}$/;
export const CODE_GRAPH_BUILD_ID = /^[0-9a-f-]{16,64}$/;
export const CODE_GRAPH_BUILD_COMMIT_ID = /^[0-9a-f]{7,64}$/;

export function isBuildStatusRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isBuildStatusHash(value: unknown): value is string {
  return typeof value === 'string' && CODE_GRAPH_BUILD_HASH_ID.test(value);
}

export function isBuildStatusText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\p{Cc}]/u.test(value);
}

export function isBuildStatusTimestamp(value: unknown): value is string {
  return isBuildStatusText(value, 64) && Number.isFinite(Date.parse(value));
}
