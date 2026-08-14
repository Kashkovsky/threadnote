class ScriptError extends Error {}

class GrafanaHttpError extends ScriptError {
  constructor(readonly status: number) {
    super(`Grafana API request failed with HTTP ${status}.`);
  }
}

export const telemetryDashboardSourcePath = 'infra/telemetry-gateway/threadnote-anonymous-telemetry-dashboard.json';
export const telemetryDashboardProvisionedPath =
  'infra/telemetry-dashboard/git-sync/threadnote-telemetry/threadnote-telemetry.json';
export const telemetryDashboardFolderPath = 'infra/telemetry-dashboard/git-sync/threadnote-telemetry/_folder.json';
export const telemetryDashboardDatasourceUid = 'grafanacloud-traces';
export const telemetryDashboardFolderUid = 'threadnote-telemetry-private';
export const telemetryDashboardFolderTitle = 'Threadnote private telemetry';
export const telemetryDashboardUid = 'threadnote-telemetry';
export const telemetryDashboardQueryLengthLimit = 1024;
export const telemetryDashboardSourcePathInGitSync = 'threadnote-telemetry/threadnote-telemetry.json';
export const telemetryDashboardFolderSourcePathInGitSync = 'threadnote-telemetry';

type JsonPrimitive = boolean | null | number | string;
interface JsonArray extends ReadonlyArray<JsonValue> {
  readonly [index: number]: JsonValue;
}
interface JsonObject {
  readonly [key: string]: JsonValue;
}
export type JsonValue = JsonArray | JsonObject | JsonPrimitive;

export type ProvisionedDashboard = Readonly<{
  apiVersion: 'dashboard.grafana.app/v1';
  kind: 'Dashboard';
  metadata: Readonly<{name: typeof telemetryDashboardUid}>;
  spec: Readonly<Record<string, JsonValue>>;
}>;

export type ProvisionedFolder = Readonly<{
  apiVersion: 'folder.grafana.app/v1';
  kind: 'Folder';
  metadata: Readonly<{name: typeof telemetryDashboardFolderUid}>;
  spec: Readonly<{title: typeof telemetryDashboardFolderTitle}>;
}>;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const datasourcePlaceholder = '${DS_TEMPO}';
// Grafana's Git Sync parser removes these repository-authored fields before it
// writes a Dashboard resource. The stable UID remains metadata.name.
const serverOwnedDashboardKeys = new Set(['id', 'iteration', 'uid', 'version']);
const grafanaCloudNamespacePattern = /^stacks-[1-9][0-9]*$/u;
const dns1123LabelPattern = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/u;

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ScriptError(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function validateGrafanaCloudNamespace(value: string): string {
  if (value.length > 63 || !grafanaCloudNamespacePattern.test(value)) {
    throw new ScriptError('THREADNOTE_TELEMETRY_GRAFANA_NAMESPACE must use the stacks-<numeric-stack-id> format.');
  }
  return value;
}

export function validateGrafanaGitSyncManagerId(value: string): string {
  const labels = value.split('.');
  if (
    value.length === 0 ||
    value.length > 253 ||
    labels.some(label => label.length === 0 || label.length > 63 || !dns1123LabelPattern.test(label))
  ) {
    throw new ScriptError(
      'THREADNOTE_TELEMETRY_GRAFANA_GIT_SYNC_MANAGER_ID must be a valid lowercase repository resource name.',
    );
  }
  return value;
}

function cloneResolvingDatasource(value: unknown, path: string, replacements: {count: number}): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (value === datasourcePlaceholder) {
      replacements.count += 1;
      return telemetryDashboardDatasourceUid;
    }
    if (value.includes(datasourcePlaceholder)) {
      throw new ScriptError(`${path} embeds the Tempo data-source placeholder in an unsupported string.`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => cloneResolvingDatasource(item, `${path}[${index}]`, replacements));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneResolvingDatasource(item, `${path}.${key}`, replacements)]),
    );
  }
  throw new ScriptError(`${path} contains a value that JSON cannot represent.`);
}

function cloneJson(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => cloneJson(item, `${path}[${index}]`));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item, `${path}.${key}`)]));
  }
  throw new ScriptError(`${path} contains a value that JSON cannot represent.`);
}

function sortedJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortedJson(item)]),
    );
  }
  return value;
}

export function canonicalJson(value: JsonValue): string {
  return `${JSON.stringify(sortedJson(value), null, 2)}\n`;
}

export function validateProvisionedFolder(value: unknown): ProvisionedFolder {
  const folder = cloneJson(value, 'provisioned folder');
  const expected: ProvisionedFolder = {
    apiVersion: 'folder.grafana.app/v1',
    kind: 'Folder',
    metadata: {name: telemetryDashboardFolderUid},
    spec: {title: telemetryDashboardFolderTitle},
  };
  if (canonicalJson(folder) !== canonicalJson(expected)) {
    throw new ScriptError('Provisioned folder must retain its exact private Git Sync identity and title.');
  }
  return value as ProvisionedFolder;
}

function validateImportContract(source: Record<string, unknown>): void {
  if (source.uid !== telemetryDashboardUid) {
    throw new ScriptError(`Dashboard uid must remain ${telemetryDashboardUid}.`);
  }
  const inputs = source.__inputs;
  if (!Array.isArray(inputs) || inputs.length !== 1) {
    throw new ScriptError('Dashboard import source must declare exactly one Tempo input.');
  }
  const input = record(inputs[0], 'dashboard.__inputs[0]');
  if (input.name !== 'DS_TEMPO' || input.pluginId !== 'tempo' || input.type !== 'datasource') {
    throw new ScriptError('Dashboard import source must declare the DS_TEMPO Tempo data-source input.');
  }
}

export function renderProvisionedDashboard(source: unknown): ProvisionedDashboard {
  const sourceRecord = record(source, 'dashboard');
  validateImportContract(sourceRecord);
  const replacements = {count: 0};
  const resolved = record(cloneResolvingDatasource(sourceRecord, 'dashboard', replacements), 'dashboard');
  if (replacements.count === 0) throw new ScriptError('Dashboard import source does not use the DS_TEMPO placeholder.');
  delete resolved.__inputs;
  delete resolved.__requires;
  delete resolved.id;
  delete resolved.iteration;
  delete resolved.version;

  const provisioned: ProvisionedDashboard = {
    apiVersion: 'dashboard.grafana.app/v1',
    kind: 'Dashboard',
    metadata: {name: telemetryDashboardUid},
    spec: resolved as Readonly<Record<string, JsonValue>>,
  };
  validateProvisionedDashboard(provisioned);
  return provisioned;
}

type TempoQuery = Readonly<{
  panelId: number;
  query: string;
  target: Readonly<Record<string, JsonValue>>;
  targetIndex: number;
}>;

export function collectTempoQueries(resource: ProvisionedDashboard): readonly TempoQuery[] {
  const panels = resource.spec.panels;
  if (!Array.isArray(panels) || panels.length === 0) throw new ScriptError('Provisioned dashboard has no panels.');
  const queries: TempoQuery[] = [];
  for (const [panelIndex, panelValue] of panels.entries()) {
    const panel = record(panelValue, `dashboard.panels[${panelIndex}]`);
    if (!Number.isInteger(panel.id)) throw new ScriptError(`dashboard.panels[${panelIndex}].id must be an integer.`);
    const panelId = panel.id as number;
    const panelDatasource = record(panel.datasource, `dashboard.panels[${panelIndex}].datasource`);
    if (panelDatasource.type !== 'tempo' || panelDatasource.uid !== telemetryDashboardDatasourceUid) {
      throw new ScriptError(`Dashboard panel ${panelId} must use the production Tempo data source.`);
    }
    if (!Array.isArray(panel.targets) || panel.targets.length === 0) {
      throw new ScriptError(`Dashboard panel ${panelId} has no query targets.`);
    }
    for (const [targetIndex, targetValue] of panel.targets.entries()) {
      const target = record(targetValue, `dashboard.panels[${panelIndex}].targets[${targetIndex}]`);
      const datasource = record(
        target.datasource,
        `dashboard.panels[${panelIndex}].targets[${targetIndex}].datasource`,
      );
      if (datasource.type === '__expr__') continue;
      if (datasource.type !== 'tempo' || datasource.uid !== telemetryDashboardDatasourceUid) {
        throw new ScriptError(`Dashboard panel ${panelId} target ${targetIndex} uses an unexpected data source.`);
      }
      if (target.queryType !== 'traceql' || typeof target.query !== 'string' || target.query.length === 0) {
        throw new ScriptError(`Dashboard panel ${panelId} target ${targetIndex} must contain a TraceQL query.`);
      }
      if (target.query.length > telemetryDashboardQueryLengthLimit) {
        throw new ScriptError(
          `Dashboard panel ${panelId} target ${targetIndex} exceeds the ${telemetryDashboardQueryLengthLimit}-character Tempo query limit.`,
        );
      }
      queries.push({
        panelId,
        query: target.query,
        target: target as Readonly<Record<string, JsonValue>>,
        targetIndex,
      });
    }
  }
  if (queries.length === 0) throw new ScriptError('Provisioned dashboard has no Tempo queries.');
  return queries;
}

export function validateProvisionedDashboard(resource: ProvisionedDashboard): void {
  if (
    resource.apiVersion !== 'dashboard.grafana.app/v1' ||
    resource.kind !== 'Dashboard' ||
    resource.metadata.name !== telemetryDashboardUid ||
    resource.spec.uid !== telemetryDashboardUid
  ) {
    throw new ScriptError('Provisioned dashboard CRD identity is invalid.');
  }
  const rendered = canonicalJson(resource);
  if (rendered.includes(datasourcePlaceholder)) {
    throw new ScriptError('Provisioned dashboard still contains an unresolved Tempo data-source placeholder.');
  }
  for (const key of ['__inputs', '__requires', 'id', 'iteration', 'version']) {
    if (Object.hasOwn(resource.spec, key))
      throw new ScriptError(`Provisioned dashboard retains volatile field ${key}.`);
  }
  collectTempoQueries(resource);
}

export function canonicalDashboardSpec(value: unknown): string {
  const dashboard = record(value, 'live dashboard');
  const normalized: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(dashboard)) {
    if (serverOwnedDashboardKeys.has(key)) continue;
    normalized[key] = cloneJson(item, `live dashboard.${key}`);
  }
  return canonicalJson(normalized);
}

export function buildTempoQueryRequest(resource: ProvisionedDashboard, now = Date.now()): JsonValue {
  const queries = collectTempoQueries(resource).map(({panelId, target, targetIndex}) => ({
    ...target,
    datasource: {type: 'tempo', uid: telemetryDashboardDatasourceUid},
    intervalMs: 300_000,
    limit: 1,
    maxDataPoints: 1,
    refId: `P${panelId}T${targetIndex}`,
    spanLimit: 1,
  }));
  return {
    from: String(now - 5 * 60_000),
    queries,
    to: String(now),
  };
}

function grafanaUrl(baseUrl: string, path: string): URL {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new ScriptError('THREADNOTE_TELEMETRY_GRAFANA_URL must be an absolute HTTPS URL.');
  }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new ScriptError('THREADNOTE_TELEMETRY_GRAFANA_URL must be an uncredentialed HTTPS origin.');
  }
  return new URL(path, `${base.origin}/`);
}

async function fetchJson(fetcher: FetchLike, url: URL, token: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(init?.body === undefined ? {} : {'Content-Type': 'application/json'}),
      },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    // Do not let transport errors echo a private Grafana stack namespace or
    // repository manager identity from a request URL.
    throw new ScriptError('Grafana API request failed before receiving a response.');
  }
  if (!response.ok) throw new GrafanaHttpError(response.status);
  try {
    return await response.json();
  } catch {
    throw new ScriptError('Grafana API returned malformed JSON.');
  }
}

type ExpectedGitSyncResource = Readonly<{
  apiVersion: string;
  folderUid?: string;
  kind: string;
  managerId: string;
  name: string;
  namespace: string;
  sourcePath: string;
}>;

function gitSyncResource(
  value: unknown,
  expected: ExpectedGitSyncResource,
): Readonly<{
  matches: boolean;
  spec: Record<string, unknown>;
}> {
  const resource = record(value, 'Grafana resource response');
  const metadata = record(resource.metadata, 'Grafana resource response.metadata');
  const spec = record(resource.spec, 'Grafana resource response.spec');
  const annotations =
    metadata.annotations !== null && typeof metadata.annotations === 'object' && !Array.isArray(metadata.annotations)
      ? (metadata.annotations as Record<string, unknown>)
      : {};
  return {
    matches:
      resource.apiVersion === expected.apiVersion &&
      resource.kind === expected.kind &&
      metadata.name === expected.name &&
      metadata.namespace === expected.namespace &&
      annotations['grafana.app/managedBy'] === 'repo' &&
      annotations['grafana.app/managerId'] === expected.managerId &&
      annotations['grafana.app/sourcePath'] === expected.sourcePath &&
      (expected.folderUid === undefined || annotations['grafana.app/folder'] === expected.folderUid),
    spec,
  };
}

function validatePrivateFolderPermissions(value: unknown): void {
  if (!Array.isArray(value)) throw new ScriptError('Grafana folder permissions response must be an array.');
  let broadPermissionCount = 0;
  for (const [index, item] of value.entries()) {
    const permission = record(item, `Grafana folder permissions response[${index}]`);
    const role = typeof permission.role === 'string' ? permission.role.toLowerCase() : '';
    if (role === 'viewer' || role === 'editor' || permission.folderId === -1 || permission.dashboardId === -1) {
      broadPermissionCount += 1;
    }
  }
  if (broadPermissionCount > 0) {
    throw new ScriptError('Grafana provisioned folder still grants broad default Viewer or Editor access.');
  }
}

function queryErrors(value: unknown, expectedReferenceIds: readonly string[]): readonly string[] {
  const response = record(value, 'Grafana query response');
  const results = record(response.results, 'Grafana query response.results');
  const errors: string[] = [];
  for (const referenceId of expectedReferenceIds) {
    if (!Object.hasOwn(results, referenceId)) {
      errors.push(`${referenceId}:missing`);
      continue;
    }
    const result = record(results[referenceId], `Grafana query response.results.${referenceId}`);
    if (typeof result.error === 'string' && result.error.length > 0) errors.push(`${referenceId}:error`);
    const status = typeof result.status === 'string' || typeof result.status === 'number' ? Number(result.status) : 200;
    if (!Number.isFinite(status) || status >= 400) errors.push(`${referenceId}:status`);
    if (!Array.isArray(result.frames)) errors.push(`${referenceId}:frames`);
  }
  return errors;
}

export async function verifyLiveDashboard(options: {
  readonly baseUrl: string;
  readonly fetcher?: FetchLike;
  readonly folder: ProvisionedFolder;
  readonly managerId: string;
  readonly namespace: string;
  readonly pollIntervalMs?: number;
  readonly resource: ProvisionedDashboard;
  readonly syncTimeoutMs?: number;
  readonly token: string;
}): Promise<void> {
  if (options.token.trim().length === 0) {
    throw new ScriptError('THREADNOTE_TELEMETRY_GRAFANA_READ_TOKEN is required when Git Sync verification is enabled.');
  }
  const namespace = validateGrafanaCloudNamespace(options.namespace);
  const managerId = validateGrafanaGitSyncManagerId(options.managerId);
  const fetcher = options.fetcher ?? fetch;
  const pollIntervalMs = options.pollIntervalMs ?? 10_000;
  const syncTimeoutMs = options.syncTimeoutMs ?? 5 * 60_000;
  const expected = canonicalDashboardSpec(options.resource.spec);
  const dashboardUrl = grafanaUrl(
    options.baseUrl,
    `/apis/dashboard.grafana.app/v1/namespaces/${namespace}/dashboards/${telemetryDashboardUid}`,
  );
  const folderUrl = grafanaUrl(
    options.baseUrl,
    `/apis/folder.grafana.app/v1/namespaces/${namespace}/folders/${telemetryDashboardFolderUid}`,
  );
  const deadline = Date.now() + syncTimeoutMs;
  let synchronized = false;
  do {
    try {
      const liveDashboard = gitSyncResource(await fetchJson(fetcher, dashboardUrl, options.token), {
        apiVersion: options.resource.apiVersion,
        folderUid: telemetryDashboardFolderUid,
        kind: options.resource.kind,
        managerId,
        name: telemetryDashboardUid,
        namespace,
        sourcePath: telemetryDashboardSourcePathInGitSync,
      });
      if (liveDashboard.matches && canonicalDashboardSpec(liveDashboard.spec) === expected) {
        const liveFolder = gitSyncResource(await fetchJson(fetcher, folderUrl, options.token), {
          apiVersion: options.folder.apiVersion,
          kind: options.folder.kind,
          managerId,
          name: telemetryDashboardFolderUid,
          namespace,
          sourcePath: telemetryDashboardFolderSourcePathInGitSync,
        });
        if (
          liveFolder.matches &&
          canonicalDashboardSpec(liveFolder.spec) === canonicalDashboardSpec(options.folder.spec)
        ) {
          synchronized = true;
          break;
        }
      }
    } catch (error) {
      if (!(error instanceof GrafanaHttpError) || error.status !== 404) throw error;
    }
    if (Date.now() < deadline) await Bun.sleep(pollIntervalMs);
  } while (Date.now() < deadline);
  if (!synchronized) {
    throw new ScriptError('Grafana Git Sync did not converge to the canonical dashboard before the timeout.');
  }

  const permissionsUrl = grafanaUrl(options.baseUrl, `/api/folders/${telemetryDashboardFolderUid}/permissions`);
  validatePrivateFolderPermissions(await fetchJson(fetcher, permissionsUrl, options.token));

  const request = buildTempoQueryRequest(options.resource);
  const queryUrl = grafanaUrl(options.baseUrl, '/api/ds/query');
  const response = await fetchJson(fetcher, queryUrl, options.token, {
    body: JSON.stringify(request),
    method: 'POST',
  });
  const requestRecord = record(request, 'Grafana query request');
  const queries = requestRecord.queries as readonly Readonly<Record<string, JsonValue>>[];
  const referenceIds = queries.map(query => query.refId as string);
  const errors = queryErrors(response, referenceIds);
  if (errors.length > 0) {
    throw new ScriptError(`Grafana rejected ${errors.length} bounded dashboard query targets.`);
  }
}

async function loadSource(repositoryRoot: string): Promise<unknown> {
  const source = Bun.file(`${repositoryRoot}/${telemetryDashboardSourcePath}`);
  if (!(await source.exists()))
    throw new ScriptError(`Dashboard source is missing at ${telemetryDashboardSourcePath}.`);
  try {
    return await source.json();
  } catch {
    throw new ScriptError(`Dashboard source at ${telemetryDashboardSourcePath} is not valid JSON.`);
  }
}

async function loadProvisionedFolder(repositoryRoot: string): Promise<ProvisionedFolder> {
  const folder = Bun.file(`${repositoryRoot}/${telemetryDashboardFolderPath}`);
  if (!(await folder.exists())) {
    throw new ScriptError(`Provisioned folder is missing at ${telemetryDashboardFolderPath}.`);
  }
  try {
    return validateProvisionedFolder(await folder.json());
  } catch (error) {
    if (error instanceof ScriptError) throw error;
    throw new ScriptError(`Provisioned folder at ${telemetryDashboardFolderPath} is not valid JSON.`);
  }
}

export async function renderTelemetryDashboard(repositoryRoot = process.cwd()): Promise<string> {
  return canonicalJson(renderProvisionedDashboard(await loadSource(repositoryRoot)));
}

async function formatProvisionedDashboard(rendered: string): Promise<string> {
  const {format} = await import('prettier');
  return format(rendered, {parser: 'json', printWidth: 120});
}

async function run(command: string | undefined): Promise<void> {
  const rendered = await renderTelemetryDashboard();
  const folder = await loadProvisionedFolder(process.cwd());
  if (command === 'render') {
    await Bun.write(telemetryDashboardProvisionedPath, await formatProvisionedDashboard(rendered));
    process.stdout.write(`Rendered ${telemetryDashboardProvisionedPath}\n`);
    return;
  }
  if (command === 'check') {
    const artifact = Bun.file(telemetryDashboardProvisionedPath);
    if (!(await artifact.exists()) || (await artifact.text()) !== (await formatProvisionedDashboard(rendered))) {
      throw new ScriptError(`Provisioned dashboard is stale; run bun scripts/telemetry-dashboard.ts render.`);
    }
    process.stdout.write(`Verified ${telemetryDashboardProvisionedPath}\n`);
    return;
  }
  if (command === 'verify-live') {
    const baseUrl = Bun.env.THREADNOTE_TELEMETRY_GRAFANA_URL?.trim() ?? '';
    const managerId = Bun.env.THREADNOTE_TELEMETRY_GRAFANA_GIT_SYNC_MANAGER_ID?.trim() ?? '';
    const namespace = Bun.env.THREADNOTE_TELEMETRY_GRAFANA_NAMESPACE?.trim() ?? '';
    const token = Bun.env.THREADNOTE_TELEMETRY_GRAFANA_READ_TOKEN?.trim() ?? '';
    await verifyLiveDashboard({
      baseUrl,
      folder,
      managerId,
      namespace,
      resource: JSON.parse(rendered) as ProvisionedDashboard,
      token,
    });
    process.stdout.write(
      `Verified synchronized Grafana dashboard ${telemetryDashboardUid} and its bounded Tempo queries.\n`,
    );
    return;
  }
  throw new ScriptError('Usage: bun scripts/telemetry-dashboard.ts <render|check|verify-live>');
}

if (import.meta.main) {
  run(Bun.argv[2]).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Telemetry dashboard operation failed.'}\n`);
    process.exitCode = 1;
  });
}
