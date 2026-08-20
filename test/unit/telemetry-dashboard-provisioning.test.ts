import {readFileSync} from '../helpers/node-fs.js';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {JSON_SCHEMA, load} from 'js-yaml';
import {
  assessDashboardThreeWay,
  buildTempoQueryRequest,
  canonicalDashboardSemantics,
  canonicalJson,
  collectTempoQueries,
  deployDashboard,
  formatDashboardArtifact,
  loadHistoricalArtifacts,
  renderDashboardArtifact,
  telemetryDashboardArtifactPath,
  telemetryDashboardDatasourceUid,
  telemetryDashboardFolderTitle,
  telemetryDashboardFolderUid,
  telemetryDashboardQueryLengthLimit,
  telemetryDashboardSourcePath,
  telemetryDashboardSyntheticCanaryExclusion,
  telemetryDashboardUid,
  telemetryDashboardUnexpectedFullBuildExpression,
  validateGrafanaCloudNamespace,
  validateDashboardArtifactBytes,
  validateReaderPermissions,
  validateWriterPermissions,
  verifyLiveDashboard,
  type DashboardArtifact,
  type JsonValue,
} from '../../scripts/telemetry-dashboard.js';

const testGrafanaNamespace = 'stacks-123456';
const testGrafanaUrl = 'https://threadnote-test.grafana.net';
const currentSha = 'a'.repeat(40);
const grafanaSharedWithMeFolderScope = 'folders:uid:sharedwithme';
const grafanaDefaultRefreshIntervals = ['5s', '10s', '30s', '1m', '5m', '15m', '30m', '1h', '2h', '1d'];

type WorkflowJob = Readonly<{
  environment?: string | Readonly<{deployment?: boolean; name: string}>;
  if?: string;
  needs?: string | readonly string[];
  outputs?: Readonly<Record<string, string>>;
  steps?: readonly Readonly<{
    env?: Readonly<Record<string, string>>;
    id?: string;
    if?: string;
    name?: string;
    run?: string;
    uses?: string;
    with?: Readonly<Record<string, unknown>>;
  }>[];
}>;

type DashboardWorkflow = Readonly<{
  concurrency: Readonly<{'cancel-in-progress': boolean; group: string; queue: string}>;
  jobs: Readonly<Record<string, WorkflowJob>>;
  on: Readonly<{
    pull_request: Readonly<{branches: readonly string[]; paths: readonly string[]}>;
    push: Readonly<{branches: readonly string[]; paths: readonly string[]}>;
    schedule: readonly Readonly<{cron: string}>[];
    workflow_dispatch: unknown;
  }>;
  permissions: Readonly<Record<string, string>>;
}>;

function readDashboardSource(): unknown {
  return JSON.parse(readFileSync(telemetryDashboardSourcePath, 'utf8'));
}

function readDashboardArtifact(): DashboardArtifact {
  return JSON.parse(readFileSync(telemetryDashboardArtifactPath, 'utf8')) as DashboardArtifact;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function evaluateUnexpectedFullBuildPercentage(numerator: number, denominator: number): number {
  return (numerator / (denominator + (denominator === 0 ? 1 : 0))) * 100;
}

function grafanaV42DashboardSpec(spec: Readonly<Record<string, JsonValue>>): Record<string, JsonValue> {
  const migrated = clone(spec) as Record<string, JsonValue>;
  migrated.schemaVersion = 42;
  migrated.preload = false;
  delete migrated.templating;
  migrated.timepicker = {refresh_intervals: grafanaDefaultRefreshIntervals};
  delete migrated.weekStart;
  const panels = migrated.panels as Record<string, JsonValue>[];
  for (const panel of panels) {
    panel.pluginVersion = '';
    if (typeof panel.id !== 'number') continue;
    const fieldConfig = panel.fieldConfig as Record<string, JsonValue>;
    const defaults = fieldConfig.defaults as Record<string, JsonValue>;
    if ((panel.id >= 1 && panel.id <= 12) || (panel.id >= 21 && panel.id <= 24)) delete defaults.mappings;
    if ((panel.id >= 1 && panel.id <= 11) || panel.id === 13 || (panel.id >= 21 && panel.id <= 24)) {
      delete fieldConfig.overrides;
    }
    if (panel.id >= 14 && panel.id <= 19) delete panel.fieldConfig;
    if (panel.id === 20) delete fieldConfig.defaults;
    if (panel.id === 13) panel.datasource = {type: 'mixed', uid: '-- Mixed --'};
  }
  return migrated;
}

function artifactWithTitle(resource: DashboardArtifact, title: string): DashboardArtifact {
  return {...resource, spec: {...resource.spec, title}};
}

function permuteObjectKeys(value: unknown, choices: readonly number[], offset = {value: 0}): unknown {
  if (Array.isArray(value)) return value.map(item => permuteObjectKeys(item, choices, offset));
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value);
  const choice = choices[offset.value % choices.length] ?? 0;
  offset.value += 1;
  const pivot = entries.length === 0 ? 0 : Math.abs(choice) % entries.length;
  const rotated = [...entries.slice(pivot), ...entries.slice(0, pivot)].reverse();
  return Object.fromEntries(rotated.map(([key, item]) => [key, permuteObjectKeys(item, choices, offset)]));
}

function successfulQueryResponse(resource: DashboardArtifact): unknown {
  const request = buildTempoQueryRequest(resource) as Readonly<Record<string, JsonValue>>;
  const queries = request.queries as readonly Readonly<Record<string, JsonValue>>[];
  return {results: Object.fromEntries(queries.map(query => [query.refId, {frames: []}]))};
}

function liveDashboard(
  resource: DashboardArtifact,
  options: Readonly<{
    annotations?: Readonly<Record<string, string>>;
    internalUid?: string;
    labels?: Readonly<Record<string, string>>;
    resourceVersion?: string;
    schemaVersion?: number;
    spec?: Readonly<Record<string, JsonValue>>;
  }> = {},
): unknown {
  return {
    access: {canEdit: true},
    apiVersion: 'dashboard.grafana.app/v1',
    kind: 'Dashboard',
    metadata: {
      annotations: {'grafana.app/folder': telemetryDashboardFolderUid, ...options.annotations},
      labels: options.labels ?? {},
      name: telemetryDashboardUid,
      namespace: testGrafanaNamespace,
      resourceVersion: options.resourceVersion ?? '101',
      uid: options.internalUid ?? 'immutable-dashboard-uid',
    },
    spec: {...(options.spec ?? resource.spec), schemaVersion: options.schemaVersion ?? 42},
  };
}

function liveFolder(
  options: Readonly<{
    annotations?: Readonly<Record<string, string>>;
    labels?: Readonly<Record<string, string>>;
    title?: string;
  }> = {},
): unknown {
  return {
    apiVersion: 'folder.grafana.app/v1',
    kind: 'Folder',
    metadata: {
      annotations: options.annotations ?? {},
      labels: options.labels ?? {},
      name: telemetryDashboardFolderUid,
      namespace: testGrafanaNamespace,
      resourceVersion: '51',
      uid: 'immutable-folder-uid',
    },
    spec: {title: options.title ?? telemetryDashboardFolderTitle},
  };
}

function writerPermissions(overrides: Readonly<Record<string, readonly string[]>> = {}): unknown {
  return {
    'dashboards:read': [`dashboards:uid:${telemetryDashboardUid}`],
    'dashboards:write': [`dashboards:uid:${telemetryDashboardUid}`],
    'folders.permissions:read': [`folders:uid:${telemetryDashboardFolderUid}`],
    'folders:read': [`folders:uid:${telemetryDashboardFolderUid}`, grafanaSharedWithMeFolderScope],
    ...overrides,
  };
}

function readerPermissions(overrides: Readonly<Record<string, readonly string[]>> = {}): unknown {
  return {
    'dashboards:read': [`dashboards:uid:${telemetryDashboardUid}`],
    'datasources:query': [`datasources:uid:${telemetryDashboardDatasourceUid}`],
    'datasources:read': [`datasources:uid:${telemetryDashboardDatasourceUid}`],
    'folders.permissions:read': [`folders:uid:${telemetryDashboardFolderUid}`],
    'folders:read': [`folders:uid:${telemetryDashboardFolderUid}`, grafanaSharedWithMeFolderScope],
    ...overrides,
  };
}

function deploymentFetcher(
  options: Readonly<{
    current: DashboardArtifact;
    live?: unknown;
    onPut?: (body: Record<string, unknown>) => void;
    permissions?: unknown;
    putResponse?: Response | 'transport-error';
    updated?: unknown;
  }>,
): {fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>; requests: string[]} {
  const requests: string[] = [];
  let dashboardReads = 0;
  return {
    requests,
    fetcher: async (input, init) => {
      const url = String(input);
      requests.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/api/access-control/user/permissions')) {
        return Response.json(options.permissions ?? writerPermissions());
      }
      if (url.includes('/apis/folder.grafana.app/')) return Response.json(liveFolder());
      if (url.endsWith(`/api/folders/${telemetryDashboardFolderUid}/permissions`)) return Response.json([]);
      if (url.includes('/apis/dashboard.grafana.app/')) {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          options.onPut?.(body);
          if (options.putResponse === 'transport-error') throw new Error('private transport failure');
          return options.putResponse ?? Response.json({}, {status: 200});
        }
        dashboardReads += 1;
        if (dashboardReads === 1) return Response.json(options.live ?? liveDashboard(options.current));
        return Response.json(
          options.updated ?? liveDashboard(options.current, {resourceVersion: '102', schemaVersion: 42}),
        );
      }
      throw new Error('unexpected test URL');
    },
  };
}

describe('direct Grafana dashboard provisioning', () => {
  it('keeps the canonical deployment artifact byte-exact, portable, and free of server state', async () => {
    const expected = renderDashboardArtifact(readDashboardSource());
    const checkedIn = readDashboardArtifact();
    const expectedBytes = await formatDashboardArtifact(canonicalJson(expected));

    expect(canonicalJson(checkedIn)).toBe(canonicalJson(expected));
    expect(readFileSync(telemetryDashboardArtifactPath, 'utf8')).toBe(expectedBytes);
    expect(() => validateDashboardArtifactBytes(expectedBytes, expectedBytes)).not.toThrow();
    expect(() => validateDashboardArtifactBytes(`${expectedBytes}\n`, expectedBytes)).toThrow(/artifact is stale/u);
    expect(checkedIn).toMatchObject({
      dashboardUid: telemetryDashboardUid,
      folderUid: telemetryDashboardFolderUid,
    });
    expect(checkedIn).not.toHaveProperty('apiVersion');
    expect(checkedIn).not.toHaveProperty('kind');
    expect(checkedIn).not.toHaveProperty('metadata');
    expect(telemetryDashboardArtifactPath).not.toMatch(/\.(?:json|ya?ml)$/u);
    for (const key of ['__inputs', '__requires', 'id', 'iteration', 'schemaVersion', 'uid', 'version']) {
      expect(checkedIn.spec).not.toHaveProperty(key);
    }
    expect(canonicalJson(checkedIn)).not.toContain('${DS_TEMPO}');

    const queries = collectTempoQueries(checkedIn);
    expect(queries.length).toBeGreaterThan(20);
    expect(new Set(queries.map(query => `${query.panelId}:${query.targetIndex}`)).size).toBe(queries.length);
    for (const {query, target} of queries) {
      expect(query.length).toBeLessThanOrEqual(telemetryDashboardQueryLengthLimit);
      expect(query).toContain(telemetryDashboardSyntheticCanaryExclusion);
      expect(target.datasource).toEqual({type: 'tempo', uid: telemetryDashboardDatasourceUid});
    }

    const queryRequest = buildTempoQueryRequest(checkedIn) as Readonly<Record<string, JsonValue>>;
    const verificationQueries = queryRequest.queries as readonly Readonly<Record<string, JsonValue>>[];
    const expressionQueries = verificationQueries.filter(query => {
      const datasource = query.datasource;
      return (
        datasource !== null &&
        typeof datasource === 'object' &&
        !Array.isArray(datasource) &&
        (datasource as Readonly<Record<string, JsonValue>>).type === '__expr__'
      );
    });
    expect(expressionQueries).toEqual([
      expect.objectContaining({
        datasource: {type: '__expr__', uid: '__expr__'},
        expression: '$P13T0 / ($P13T1 + ($P13T1 == 0)) * 100',
        refId: 'P13T2',
        type: 'math',
      }),
    ]);
    for (const refId of ['P13T0', 'P13T1']) {
      expect(verificationQueries).toContainEqual(
        expect.objectContaining({
          datasource: {type: 'tempo', uid: telemetryDashboardDatasourceUid},
          metricsQueryType: 'range',
          refId,
        }),
      );
    }
  });

  it('rejects an unguarded unexpected-full percentage expression', () => {
    const source = clone(readDashboardSource()) as Record<string, JsonValue>;
    const panel = (source.panels as Record<string, JsonValue>[]).find(candidate => candidate.id === 13)!;
    const expression = (panel.targets as Record<string, JsonValue>[])[2]!;
    expression.expression = '$A / $B * 100';

    expect(() => renderDashboardArtifact(source)).toThrow(/guarded executable A\/B percentage expression/u);
    expect(telemetryDashboardUnexpectedFullBuildExpression).toBe('$A / ($B + ($B == 0)) * 100');
    expect(evaluateUnexpectedFullBuildPercentage(0, 0)).toBe(0);
    expect(evaluateUnexpectedFullBuildPercentage(1, 2)).toBe(50);
  });

  it.prop(
    'keeps the guarded unexpected-full percentage finite for every subset count',
    {
      denominator: FC.integer({max: 1_000_000, min: 0}),
      numeratorSeed: FC.integer({max: 1_000_000, min: 0}),
    },
    ({denominator, numeratorSeed}) => {
      const numerator = denominator === 0 ? 0 : numeratorSeed % (denominator + 1);
      const percentage = evaluateUnexpectedFullBuildPercentage(numerator, denominator);
      expect(Number.isFinite(percentage)).toBe(true);
      expect(percentage).toBeGreaterThanOrEqual(0);
      expect(percentage).toBeLessThanOrEqual(100);
      expect(percentage).toBe(denominator === 0 ? 0 : (numerator / denominator) * 100);
    },
    {fastCheck: {numRuns: 100}},
  );

  it.prop(
    'renders identically regardless of source object-key order',
    {choices: FC.array(FC.integer(), {maxLength: 80, minLength: 1})},
    ({choices}) => {
      const source = readDashboardSource();
      expect(canonicalJson(renderDashboardArtifact(permuteObjectKeys(source, choices)))).toBe(
        canonicalJson(renderDashboardArtifact(source)),
      );
    },
    {fastCheck: {numRuns: 40}},
  );

  it('normalizes only proven Grafana migration noise', () => {
    const resource = readDashboardArtifact();
    const migrated = grafanaV42DashboardSpec(resource.spec);
    expect(canonicalDashboardSemantics(migrated)).toBe(canonicalDashboardSemantics(resource.spec));

    const queryDrift = clone(migrated);
    const firstPanel = (queryDrift.panels as Record<string, JsonValue>[])[0]!;
    const firstTarget = (firstPanel.targets as Record<string, JsonValue>[])[0]!;
    firstTarget.query = '{}';
    expect(canonicalDashboardSemantics(queryDrift)).not.toBe(canonicalDashboardSemantics(resource.spec));

    const unapprovedEmptyRemoval = clone(resource.spec);
    delete (unapprovedEmptyRemoval.panels as Record<string, JsonValue>[])[19]!.fieldConfig;
    expect(canonicalDashboardSemantics(unapprovedEmptyRemoval)).not.toBe(canonicalDashboardSemantics(resource.spec));

    const wrongRefreshIntervals = clone(migrated);
    wrongRefreshIntervals.timepicker = {refresh_intervals: ['17s']};
    expect(canonicalDashboardSemantics(wrongRefreshIntervals)).not.toBe(canonicalDashboardSemantics(resource.spec));

    const wrongMixedDatasource = clone(migrated);
    (wrongMixedDatasource.panels as Record<string, JsonValue>[])[12]!.datasource = {
      type: 'mixed',
      uid: 'other',
    };
    expect(canonicalDashboardSemantics(wrongMixedDatasource)).not.toBe(canonicalDashboardSemantics(resource.spec));

    const mismatchedTargetDatasources = clone(migrated);
    const expressionTargets = (mismatchedTargetDatasources.panels as Record<string, JsonValue>[])[12]!
      .targets as Record<string, JsonValue>[];
    expressionTargets[1]!.datasource = {type: 'tempo', uid: 'other'};
    expect(canonicalDashboardSemantics(mismatchedTargetDatasources)).not.toBe(
      canonicalDashboardSemantics(resource.spec),
    );
  });

  it.prop(
    'normalizes panel 13 from the exact shared Tempo target datasource across reviewed datasource migrations',
    {datasourceUid: FC.string({maxLength: 32, minLength: 1})},
    ({datasourceUid}) => {
      const historical = clone(readDashboardArtifact().spec);
      const panel = (historical.panels as Record<string, JsonValue>[])[12]!;
      panel.datasource = {type: 'tempo', uid: datasourceUid};
      const targets = panel.targets as Record<string, JsonValue>[];
      targets[0]!.datasource = {type: 'tempo', uid: datasourceUid};
      targets[1]!.datasource = {type: 'tempo', uid: datasourceUid};

      expect(canonicalDashboardSemantics(grafanaV42DashboardSpec(historical))).toBe(
        canonicalDashboardSemantics(historical),
      );
    },
    {fastCheck: {numRuns: 40}},
  );

  it.prop(
    'preserves arbitrary nonempty panel plugin versions as semantic drift',
    {pluginVersion: FC.string({maxLength: 32, minLength: 1})},
    ({pluginVersion}) => {
      const resource = readDashboardArtifact();
      const drift = clone(resource.spec) as Record<string, JsonValue>;
      (drift.panels as Record<string, JsonValue>[])[0]!.pluginVersion = pluginVersion;
      expect(canonicalDashboardSemantics(drift)).not.toBe(canonicalDashboardSemantics(resource.spec));
    },
    {fastCheck: {numRuns: 40}},
  );

  it.prop(
    'updates only from a trusted historical state and otherwise fails closed',
    {states: FC.uniqueArray(FC.string(), {maxLength: 3, minLength: 3})},
    ({states: [current, historical, drift]}) => {
      expect(assessDashboardThreeWay({current, historical: [historical], live: current})).toBe('noop');
      expect(assessDashboardThreeWay({current, historical: [historical], live: historical})).toBe('update');
      expect(() => assessDashboardThreeWay({current, historical: [historical], live: drift})).toThrow(/drifted/u);
    },
    {fastCheck: {numRuns: 100}},
  );

  it('preserves the live schema and exact resourceVersion in an update-only PUT, then re-reads exact state', async () => {
    const previous = readDashboardArtifact();
    const current = artifactWithTitle(previous, 'Updated telemetry title');
    let requestBody: Record<string, unknown> | undefined;
    const harness = deploymentFetcher({
      current,
      live: liveDashboard(previous, {
        labels: {'threadnote.dev/owner': 'telemetry'},
        resourceVersion: 'opaque-rv',
        schemaVersion: 43,
      }),
      onPut: body => {
        requestBody = body;
      },
      putResponse: new Response(null, {status: 200}),
      updated: liveDashboard(current, {
        resourceVersion: 'next-rv',
        schemaVersion: 43,
        spec: grafanaV42DashboardSpec(current.spec),
      }),
    });

    await expect(
      deployDashboard({
        baseUrl: testGrafanaUrl,
        current,
        currentSha,
        fetcher: harness.fetcher,
        historical: [previous],
        namespace: testGrafanaNamespace,
        token: 'narrow-writer-token',
      }),
    ).resolves.toBe('update');

    const metadata = requestBody?.metadata as Record<string, unknown>;
    const spec = requestBody?.spec as Record<string, unknown>;
    expect(metadata.name).toBe(telemetryDashboardUid);
    expect(metadata.resourceVersion).toBe('opaque-rv');
    expect(metadata.uid).toBe('immutable-dashboard-uid');
    expect(metadata.labels).toEqual({'threadnote.dev/owner': 'telemetry'});
    expect(spec.schemaVersion).toBe(43);
    expect(spec.title).toBe('Updated telemetry title');
    expect(requestBody).not.toHaveProperty('access');
    expect(harness.requests.filter(request => request.startsWith('PUT '))).toHaveLength(1);
    expect(harness.requests.at(-1)).toMatch(/^GET .*\/dashboards\/threadnote-telemetry$/u);
  });

  it('does not write when live already equals current', async () => {
    const current = readDashboardArtifact();
    const harness = deploymentFetcher({current});
    await expect(
      deployDashboard({
        baseUrl: testGrafanaUrl,
        current,
        currentSha,
        fetcher: harness.fetcher,
        historical: [artifactWithTitle(current, 'Previous title')],
        namespace: testGrafanaNamespace,
        token: 'narrow-writer-token',
      }),
    ).resolves.toBe('noop');
    expect(harness.requests.some(request => request.startsWith('PUT '))).toBe(false);
  });

  it('allows the first direct artifact commit to adopt only an already-current dashboard without history', async () => {
    const current = readDashboardArtifact();
    const harness = deploymentFetcher({current});
    await expect(
      deployDashboard({
        baseUrl: testGrafanaUrl,
        current,
        currentSha,
        fetcher: harness.fetcher,
        historical: [],
        namespace: testGrafanaNamespace,
        token: 'narrow-writer-token',
      }),
    ).resolves.toBe('noop');
    expect(harness.requests.some(request => request.startsWith('PUT '))).toBe(false);

    const drifted = deploymentFetcher({
      current,
      live: liveDashboard(artifactWithTitle(current, 'Untrusted old title')),
    });
    await expect(
      deployDashboard({
        baseUrl: testGrafanaUrl,
        current,
        currentSha,
        fetcher: drifted.fetcher,
        historical: [],
        namespace: testGrafanaNamespace,
        token: 'narrow-writer-token',
      }),
    ).rejects.toThrow(/trusted historical/u);
    expect(drifted.requests.some(request => request.startsWith('PUT '))).toBe(false);
  });

  it('skips source-history commits from before the direct artifact existed', async () => {
    const oldSourceCommit = 'b'.repeat(40);
    const artifacts = await loadHistoricalArtifacts('/unused-in-injected-test', currentSha, async args => {
      if (args[0] === 'log') return `${currentSha}\n${oldSourceCommit}`;
      if (args[0] === 'show' && String(args[1]).startsWith(oldSourceCommit)) return undefined;
      throw new Error('unexpected Git command');
    });
    expect(artifacts).toEqual([]);
  });

  it('loads reviewed historical artifacts without applying the current renderer contract', async () => {
    const historicalCommit = 'b'.repeat(40);
    const historical = clone(readDashboardArtifact());
    const firstPanel = (historical.spec.panels as Record<string, JsonValue>[])[0]!;
    const firstTarget = (firstPanel.targets as Record<string, JsonValue>[])[0]!;
    firstPanel.datasource = {type: 'tempo', uid: 'previous-traces-datasource'};
    firstTarget.datasource = {type: 'tempo', uid: 'previous-traces-datasource'};
    const expressionPanel = (historical.spec.panels as Record<string, JsonValue>[])[12]!;
    expressionPanel.datasource = {type: 'tempo', uid: 'previous-traces-datasource'};
    const expressionTargets = expressionPanel.targets as Record<string, JsonValue>[];
    expressionTargets[0]!.datasource = {type: 'tempo', uid: 'previous-traces-datasource'};
    expressionTargets[1]!.datasource = {type: 'tempo', uid: 'previous-traces-datasource'};
    const reader = async (args: readonly string[]): Promise<string | undefined> => {
      if (args[0] === 'log') {
        expect(args).toEqual([
          'log',
          '--first-parent',
          '--format=%H',
          '--max-count=65',
          currentSha,
          '--',
          telemetryDashboardArtifactPath,
        ]);
        return historicalCommit;
      }
      if (args[0] === 'show' && String(args[1]).endsWith(`:${telemetryDashboardArtifactPath}`)) {
        return JSON.stringify(historical);
      }
      throw new Error('historical loading must not re-run current source rendering');
    };

    const artifacts = await loadHistoricalArtifacts('/unused-in-injected-test', currentSha, reader);
    expect(artifacts).toEqual([historical]);
    const current = readDashboardArtifact();
    const harness = deploymentFetcher({
      current,
      live: liveDashboard(historical, {spec: grafanaV42DashboardSpec(historical.spec)}),
    });
    await expect(
      deployDashboard({
        baseUrl: testGrafanaUrl,
        current,
        currentSha,
        fetcher: harness.fetcher,
        historical: artifacts,
        namespace: testGrafanaNamespace,
        token: 'narrow-writer-token',
      }),
    ).resolves.toBe('update');

    const wrongIdentity = {...historical, dashboardUid: 'different-dashboard'};
    await expect(
      loadHistoricalArtifacts('/unused-in-injected-test', currentSha, async args => {
        if (args[0] === 'log') return historicalCommit;
        return JSON.stringify(wrongIdentity);
      }),
    ).rejects.toThrow(/exact dashboard and folder identity/u);
  });

  it.each([404, 409, 412, 500])('fails terminally on HTTP %i without retrying or falling back', async status => {
    const previous = readDashboardArtifact();
    const current = artifactWithTitle(previous, 'Updated title');
    const harness = deploymentFetcher({
      current,
      live: liveDashboard(previous),
      putResponse: new Response(null, {status}),
    });
    await expect(
      deployDashboard({
        baseUrl: testGrafanaUrl,
        current,
        currentSha,
        fetcher: harness.fetcher,
        historical: [previous],
        namespace: testGrafanaNamespace,
        token: 'narrow-writer-token',
      }),
    ).rejects.toThrow(`HTTP ${status}`);
    expect(harness.requests.filter(request => request.startsWith('PUT '))).toHaveLength(1);
  });

  it('classifies an ambiguous transport outcome by one re-read without retrying the write', async () => {
    const previous = readDashboardArtifact();
    const current = artifactWithTitle(previous, 'Updated title');
    const applied = deploymentFetcher({
      current,
      live: liveDashboard(previous),
      putResponse: 'transport-error',
      updated: liveDashboard(current, {resourceVersion: '102'}),
    });
    await expect(
      deployDashboard({
        baseUrl: testGrafanaUrl,
        current,
        currentSha,
        fetcher: applied.fetcher,
        historical: [previous],
        namespace: testGrafanaNamespace,
        token: 'narrow-writer-token',
      }),
    ).resolves.toBe('update');
    expect(applied.requests.filter(request => request.startsWith('PUT '))).toHaveLength(1);

    const unchanged = deploymentFetcher({
      current,
      live: liveDashboard(previous),
      putResponse: 'transport-error',
      updated: liveDashboard(previous),
    });
    await expect(
      deployDashboard({
        baseUrl: testGrafanaUrl,
        current,
        currentSha,
        fetcher: unchanged.fetcher,
        historical: [previous],
        namespace: testGrafanaNamespace,
        token: 'narrow-writer-token',
      }),
    ).rejects.toThrow(/indeterminate/u);
    expect(unchanged.requests.filter(request => request.startsWith('PUT '))).toHaveLength(1);
  });

  it('rejects drift, Git Sync provenance, stale folders, and broad ACLs before any PUT', async () => {
    const previous = readDashboardArtifact();
    const current = artifactWithTitle(previous, 'Current title');
    const managedMetadataKeys = [
      'grafana.app/managedBy',
      'grafana.app/managerAllowsEdits',
      'grafana.app/managerId',
      'grafana.app/managerSuspended',
      'grafana.app/repoHash',
      'grafana.app/repoName',
      'grafana.app/repoPath',
      'grafana.app/repoTimestamp',
      'grafana.app/sourceChecksum',
      'grafana.app/sourcePath',
      'grafana.app/sourceTimestamp',
    ] as const;
    const cases: readonly Readonly<{folder?: unknown; live?: unknown; permissions?: unknown}>[] = [
      {live: liveDashboard(artifactWithTitle(previous, 'Out-of-band title'))},
      ...managedMetadataKeys.map(key => ({live: liveDashboard(previous, {annotations: {[key]: 'reserved'}})})),
      {live: liveDashboard(previous, {labels: {'provisioning.grafana.app/repository': 'other-manager'}})},
      {live: liveDashboard(previous, {labels: {'grafana.app/managedBy': 'other-manager'}})},
      {folder: liveFolder({title: 'Wrong folder'})},
      {folder: liveFolder({annotations: {'grafana.app/folder': 'unexpected-parent'}})},
      {folder: liveFolder({annotations: {'grafana.app/repoPath': 'legacy/path'}})},
      {folder: liveFolder({labels: {'grafana.app/sourceTimestamp': 'legacy-timestamp'}})},
      {permissions: [{folderId: -1, role: 'Viewer'}]},
    ];
    for (const testCase of cases) {
      let putAttempted = false;
      const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (init?.method === 'PUT') putAttempted = true;
        if (url.endsWith('/api/access-control/user/permissions')) return Response.json(writerPermissions());
        if (url.includes('/apis/folder.grafana.app/')) return Response.json(testCase.folder ?? liveFolder());
        if (url.endsWith('/permissions')) return Response.json(testCase.permissions ?? []);
        return Response.json(testCase.live ?? liveDashboard(previous));
      };
      await expect(
        deployDashboard({
          baseUrl: testGrafanaUrl,
          current,
          currentSha,
          fetcher,
          historical: [previous],
          namespace: testGrafanaNamespace,
          token: 'narrow-writer-token',
        }),
      ).rejects.toThrow();
      expect(putAttempted).toBe(false);
    }
  });

  it('requires a writer token restricted to exact dashboard and folder read/update scopes', () => {
    expect(() => validateWriterPermissions(writerPermissions())).not.toThrow();
    expect(() => validateWriterPermissions(writerPermissions({'dashboards:create': ['folders:*']}))).toThrow(
      /forbidden/u,
    );
    expect(() => validateWriterPermissions(writerPermissions({'alert.rules:read': ['folders:uid:private']}))).toThrow(
      /forbidden/u,
    );
    expect(() => validateWriterPermissions(writerPermissions({'dashboards:write': ['dashboards:uid:other']}))).toThrow(
      /exact allowed targets/u,
    );
    expect(() => validateWriterPermissions({'dashboards:read': [`dashboards:uid:${telemetryDashboardUid}`]})).toThrow(
      /missing/u,
    );
    for (const scopes of [
      [`folders:uid:${telemetryDashboardFolderUid}`],
      [`folders:uid:${telemetryDashboardFolderUid}`, `folders:uid:${telemetryDashboardFolderUid}`],
      [`folders:uid:${telemetryDashboardFolderUid}`, grafanaSharedWithMeFolderScope, 'folders:uid:other'],
    ]) {
      expect(() => validateWriterPermissions(writerPermissions({'folders:read': scopes}))).toThrow(
        /exact allowed targets/u,
      );
    }
  });

  it.prop(
    'treats the exact Grafana folder-read scopes as an order-independent set',
    {actor: FC.constantFrom('reader' as const, 'writer' as const), reverse: FC.boolean()},
    ({actor, reverse}) => {
      const scopes = [`folders:uid:${telemetryDashboardFolderUid}`, grafanaSharedWithMeFolderScope];
      if (reverse) scopes.reverse();
      const permissions =
        actor === 'reader' ? readerPermissions({'folders:read': scopes}) : writerPermissions({'folders:read': scopes});
      const validate = actor === 'reader' ? validateReaderPermissions : validateWriterPermissions;
      expect(() => validate(permissions)).not.toThrow();
    },
    {fastCheck: {numRuns: 20}},
  );

  it('requires a reader token restricted to exact dashboard, folder, and datasource scopes', async () => {
    expect(() => validateReaderPermissions(readerPermissions())).not.toThrow();
    for (const permissions of [
      readerPermissions({'dashboards:write': [`dashboards:uid:${telemetryDashboardUid}`]}),
      readerPermissions({'alert.rules:read': ['folders:uid:private']}),
      readerPermissions({'datasources:query': ['datasources:uid:*']}),
      readerPermissions({'datasources:read': ['datasources:uid:other']}),
    ]) {
      let requests = 0;
      await expect(
        verifyLiveDashboard({
          baseUrl: testGrafanaUrl,
          fetcher: async input => {
            requests += 1;
            expect(String(input)).toBe(`${testGrafanaUrl}/api/access-control/user/permissions`);
            return Response.json(permissions);
          },
          namespace: testGrafanaNamespace,
          resource: readDashboardArtifact(),
          token: 'overprivileged-reader-token',
        }),
      ).rejects.toThrow();
      expect(requests).toBe(1);
    }
  });

  it('verifies exact live state, private ACLs, and every bounded Tempo query using only reads and query POST', async () => {
    const resource = readDashboardArtifact();
    const requests: {method?: string; url: string}[] = [];
    await verifyLiveDashboard({
      baseUrl: testGrafanaUrl,
      fetcher: async (input, init) => {
        const url = String(input);
        requests.push({method: init?.method, url});
        if (url.endsWith('/api/access-control/user/permissions')) return Response.json(readerPermissions());
        if (url.includes('/apis/dashboard.grafana.app/')) {
          return Response.json(liveDashboard(resource, {spec: grafanaV42DashboardSpec(resource.spec)}));
        }
        if (url.includes('/apis/folder.grafana.app/')) return Response.json(liveFolder());
        if (url.endsWith('/permissions')) return Response.json([]);
        return Response.json(successfulQueryResponse(resource));
      },
      namespace: testGrafanaNamespace,
      resource,
      token: 'read-only-token',
    });
    expect(requests.map(request => request.method ?? 'GET')).toEqual(['GET', 'GET', 'GET', 'GET', 'POST']);
    expect(requests.at(-1)?.url).toBe(`${testGrafanaUrl}/api/ds/query`);
  });

  it('fails closed when any bounded Tempo query result is absent', async () => {
    const resource = readDashboardArtifact();
    await expect(
      verifyLiveDashboard({
        baseUrl: testGrafanaUrl,
        fetcher: async input => {
          const url = String(input);
          if (url.endsWith('/api/access-control/user/permissions')) return Response.json(readerPermissions());
          if (url.includes('/apis/dashboard.grafana.app/')) return Response.json(liveDashboard(resource));
          if (url.includes('/apis/folder.grafana.app/')) return Response.json(liveFolder());
          if (url.endsWith('/permissions')) return Response.json([]);
          return Response.json({results: {}});
        },
        namespace: testGrafanaNamespace,
        resource,
        token: 'read-only-token',
      }),
    ).rejects.toThrow(/rejected \d+ bounded dashboard query targets/u);
  });

  it('accepts only an explicit Grafana Cloud stack namespace', () => {
    expect(validateGrafanaCloudNamespace(testGrafanaNamespace)).toBe(testGrafanaNamespace);
    expect(() => validateGrafanaCloudNamespace('default')).toThrow(/stacks-<numeric-stack-id>/u);
    expect(() => validateGrafanaCloudNamespace('stacks-private')).toThrow(/stacks-<numeric-stack-id>/u);
    expect(() => validateGrafanaCloudNamespace('stacks-0123')).toThrow(/stacks-<numeric-stack-id>/u);
  });

  it.each([
    'http://threadnote-test.grafana.net',
    'https://threadnote-test.grafana.net.evil.test',
    'https://threadnote-test.grafana.net/private-path',
    'https://user@threadnote-test.grafana.net',
    'https://threadnote-test.grafana.net:8443',
  ])('refuses to send a Grafana token to non-Cloud origin %s', async baseUrl => {
    let requested = false;
    await expect(
      verifyLiveDashboard({
        baseUrl,
        fetcher: async () => {
          requested = true;
          return Response.json({});
        },
        namespace: testGrafanaNamespace,
        resource: readDashboardArtifact(),
        token: 'private-token',
      }),
    ).rejects.toThrow(/Grafana Cloud HTTPS origin/u);
    expect(requested).toBe(false);
  });

  it('keeps PR validation secretless and isolates serialized push deployment from read-only daily verification', () => {
    const workflow = load(readFileSync('.github/workflows/telemetry-dashboard.yml', 'utf8'), {
      schema: JSON_SCHEMA,
    }) as DashboardWorkflow;
    const expectedPaths = [
      '.github/workflows/telemetry-dashboard.yml',
      'infra/telemetry-dashboard/**',
      telemetryDashboardSourcePath,
      'scripts/telemetry-dashboard.ts',
      'test/unit/telemetry-dashboard-provisioning.test.ts',
      'test/unit/telemetry-gateway-dashboard.test.ts',
    ];

    expect(workflow.permissions).toEqual({contents: 'read'});
    expect(workflow.on.push).toEqual({branches: ['main'], paths: expectedPaths});
    expect(workflow.on.pull_request).toEqual({branches: ['main'], paths: expectedPaths});
    expect(workflow.on.schedule).toEqual([{cron: '17 3 * * *'}]);
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
    expect(workflow.concurrency.queue).toBe('max');
    expect(workflow.concurrency.group).toContain("github.event_name != 'pull_request'");
    expect(workflow.concurrency.group).toContain("'production' || github.run_id");

    const validation = workflow.jobs.validate!;
    const deployment = workflow.jobs.deploy!;
    const verification = workflow.jobs['verify-live']!;
    const completion = workflow.jobs.complete!;
    const validationText = JSON.stringify(validation);
    const deploymentText = JSON.stringify(deployment);
    const verificationText = JSON.stringify(verification);

    expect(validation.environment).toBeUndefined();
    expect(validationText).not.toContain('secrets.');
    expect(validationText).toContain('bun install --frozen-lockfile');

    expect(deployment.environment).toEqual({name: 'telemetry-dashboard-production-deploy'});
    expect(deployment.if).toContain("github.event_name == 'push'");
    expect(deployment.if).toContain("github.ref == 'refs/heads/main'");
    expect(deployment.if).toContain("github.repository == 'Kashkovsky/threadnote'");
    expect(deployment.if).toContain("THREADNOTE_TELEMETRY_GRAFANA_DIRECT_ENABLED == 'true'");
    expect(deploymentText).toContain('THREADNOTE_TELEMETRY_GRAFANA_WRITE_TOKEN');
    expect(deploymentText).not.toContain('THREADNOTE_TELEMETRY_GRAFANA_READ_TOKEN');
    expect(deploymentText).toContain('secrets.THREADNOTE_TELEMETRY_GRAFANA_URL');
    expect(deploymentText).toContain('secrets.THREADNOTE_TELEMETRY_GRAFANA_NAMESPACE');
    expect(deploymentText).not.toContain('vars.THREADNOTE_TELEMETRY_GRAFANA_URL');
    expect(deploymentText).not.toContain('vars.THREADNOTE_TELEMETRY_GRAFANA_NAMESPACE');
    expect(deploymentText).not.toContain('bun install');
    expect(deploymentText).toContain('git merge-base --is-ancestor');
    expect(deploymentText).toContain('git diff --quiet --no-ext-diff --no-textconv');
    expect(deploymentText).toContain(telemetryDashboardArtifactPath);
    expect(deploymentText.match(/git fetch --no-tags origin/gu)).toHaveLength(2);
    expect(deploymentText).not.toContain('github.event.before');
    expect(deploymentText).toContain(
      'bun --config=/dev/null --no-env-file --no-install scripts/telemetry-dashboard.ts deploy',
    );

    expect(verification.environment).toEqual({deployment: false, name: 'telemetry-dashboard-production'});
    expect(verification.if).toContain("github.event_name != 'pull_request'");
    expect(verification.if).toContain("github.ref == 'refs/heads/main'");
    expect(verification.if).toContain("github.repository == 'Kashkovsky/threadnote'");
    expect(verificationText).toContain('THREADNOTE_TELEMETRY_GRAFANA_READ_TOKEN');
    expect(verificationText).not.toContain('THREADNOTE_TELEMETRY_GRAFANA_WRITE_TOKEN');
    expect(verificationText).toContain('secrets.THREADNOTE_TELEMETRY_GRAFANA_URL');
    expect(verificationText).toContain('secrets.THREADNOTE_TELEMETRY_GRAFANA_NAMESPACE');
    expect(verificationText).not.toContain('vars.THREADNOTE_TELEMETRY_GRAFANA_URL');
    expect(verificationText).not.toContain('vars.THREADNOTE_TELEMETRY_GRAFANA_NAMESPACE');
    expect(verificationText).not.toContain('bun install');
    expect(verificationText).toContain(
      'bun --config=/dev/null --no-env-file --no-install scripts/telemetry-dashboard.ts verify-live',
    );

    expect(completion.if).toBe('always()');
    expect(completion.needs).toEqual(['validate', 'deploy', 'verify-live']);
    expect(completion.steps?.at(-1)?.run).toContain("$EVENT_NAME\" != 'pull_request'");
    expect(
      `${validationText}\n${deploymentText}\n${verificationText}`.match(
        /oven-sh\/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6/gu,
      ),
    ).toHaveLength(3);

    const codeowners = readFileSync('.github/CODEOWNERS', 'utf8');
    expect(codeowners).toContain('/.github/CODEOWNERS @Kashkovsky');
    expect(codeowners).toContain('/.github/workflows/ @Kashkovsky');
    expect(codeowners).toContain('/infra/telemetry-dashboard/ @Kashkovsky');

    const actionlint = readFileSync('.github/actionlint.yml', 'utf8');
    expect(actionlint).toContain('.github/workflows/telemetry-dashboard.yml:');
    expect(actionlint).toContain('unexpected key "queue" for "concurrency" section');
  });
});
