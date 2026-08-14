import {readFileSync} from '../helpers/node-fs.js';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {JSON_SCHEMA, load} from 'js-yaml';
import {
  buildTempoQueryRequest,
  canonicalDashboardSpec,
  canonicalJson,
  collectTempoQueries,
  renderProvisionedDashboard,
  telemetryDashboardDatasourceUid,
  telemetryDashboardFolderPath,
  telemetryDashboardFolderSourcePathInGitSync,
  telemetryDashboardFolderTitle,
  telemetryDashboardFolderUid,
  telemetryDashboardProvisionedPath,
  telemetryDashboardQueryLengthLimit,
  telemetryDashboardSourcePath,
  telemetryDashboardSourcePathInGitSync,
  telemetryDashboardUid,
  validateGrafanaCloudNamespace,
  validateGrafanaGitSyncManagerId,
  verifyLiveDashboard,
  type JsonValue,
  type ProvisionedDashboard,
  type ProvisionedFolder,
} from '../../scripts/telemetry-dashboard.js';

const testGrafanaNamespace = 'stacks-123456';
const testGitSyncManagerId = 'repository-threadnote-telemetry';

type WorkflowJob = Readonly<{
  environment?: string | Readonly<{deployment: boolean; name: string}>;
  if?: string;
  needs?: string;
  permissions?: Readonly<Record<string, string>>;
  steps?: readonly Readonly<{
    env?: Readonly<Record<string, string>>;
    if?: string;
    name?: string;
    run?: string;
    uses?: string;
  }>[];
  'timeout-minutes'?: number;
}>;

type DashboardWorkflow = Readonly<{
  concurrency: Readonly<{'cancel-in-progress': boolean; group: string}>;
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

function readProvisionedDashboard(): ProvisionedDashboard {
  return JSON.parse(readFileSync(telemetryDashboardProvisionedPath, 'utf8')) as ProvisionedDashboard;
}

function readProvisionedFolder(): ProvisionedFolder {
  return JSON.parse(readFileSync(telemetryDashboardFolderPath, 'utf8')) as ProvisionedFolder;
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

function successfulQueryResponse(resource: ProvisionedDashboard): unknown {
  const request = buildTempoQueryRequest(resource) as Readonly<Record<string, JsonValue>>;
  const queries = request.queries as readonly Readonly<Record<string, JsonValue>>[];
  return {results: Object.fromEntries(queries.map(query => [query.refId, {frames: []}]))};
}

function storedDashboardSpec(resource: ProvisionedDashboard): Readonly<Record<string, JsonValue>> {
  return Object.fromEntries(Object.entries(resource.spec).filter(([key]) => !['id', 'uid', 'version'].includes(key)));
}

function liveGitSyncResource(
  resource: ProvisionedDashboard | ProvisionedFolder,
  options: Readonly<{
    folderUid?: string;
    managedBy?: string;
    managerId?: string;
    namespace?: string;
    sourcePath: string;
    spec?: Readonly<Record<string, JsonValue>>;
  }>,
): unknown {
  return {
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    metadata: {
      annotations: {
        'grafana.app/managedBy': options.managedBy ?? 'repo',
        'grafana.app/managerId': options.managerId ?? testGitSyncManagerId,
        'grafana.app/sourcePath': options.sourcePath,
        ...(options.folderUid === undefined ? {} : {'grafana.app/folder': options.folderUid}),
      },
      name: resource.metadata.name,
      namespace: options.namespace ?? testGrafanaNamespace,
    },
    spec: options.spec ?? resource.spec,
  };
}

describe('Grafana Git Sync dashboard provisioning', () => {
  it('keeps the canonical provisioned resource fresh and strips import/server state', () => {
    const source = readDashboardSource();
    const expected = renderProvisionedDashboard(source);
    const checkedIn = readProvisionedDashboard();

    expect(canonicalJson(checkedIn)).toBe(canonicalJson(expected));
    expect(checkedIn).toMatchObject({
      apiVersion: 'dashboard.grafana.app/v1',
      kind: 'Dashboard',
      metadata: {name: telemetryDashboardUid},
      spec: {uid: telemetryDashboardUid},
    });
    expect(checkedIn.spec).not.toHaveProperty('__inputs');
    expect(checkedIn.spec).not.toHaveProperty('__requires');
    expect(checkedIn.spec).not.toHaveProperty('id');
    expect(checkedIn.spec).not.toHaveProperty('iteration');
    expect(checkedIn.spec).not.toHaveProperty('version');
    expect(canonicalJson(checkedIn)).not.toContain('${DS_TEMPO}');

    const queries = collectTempoQueries(checkedIn);
    expect(queries.length).toBeGreaterThan(20);
    expect(new Set(queries.map(query => `${query.panelId}:${query.targetIndex}`)).size).toBe(queries.length);
    for (const {query, target} of queries) {
      expect(query.length).toBeLessThanOrEqual(telemetryDashboardQueryLengthLimit);
      expect(target.datasource).toEqual({type: 'tempo', uid: telemetryDashboardDatasourceUid});
    }
  });

  it.prop(
    'renders identically regardless of source object-key order',
    {choices: FC.array(FC.integer(), {maxLength: 80, minLength: 1})},
    ({choices}) => {
      const source = readDashboardSource();
      const permuted = permuteObjectKeys(source, choices);
      expect(canonicalJson(renderProvisionedDashboard(permuted))).toBe(
        canonicalJson(renderProvisionedDashboard(source)),
      );
    },
    {fastCheck: {numRuns: 40}},
  );

  it('normalizes live server fields and builds one bounded parser request for every Tempo target', () => {
    const resource = readProvisionedDashboard();
    const live = {...storedDashboardSpec(resource), id: 42, iteration: 1_723_000_000_000, version: 17};
    expect(canonicalDashboardSpec(live)).toBe(canonicalDashboardSpec(resource.spec));
    expect(
      canonicalDashboardSpec(
        JSON.parse(JSON.stringify(resource.spec).replaceAll(telemetryDashboardDatasourceUid, '${DS_TEMPO}')),
      ),
    ).not.toBe(canonicalDashboardSpec(resource.spec));

    const request = buildTempoQueryRequest(resource, 1_800_000_000_000) as Readonly<Record<string, JsonValue>>;
    const queries = request.queries as readonly Readonly<Record<string, JsonValue>>[];
    expect(request.from).toBe('1799999700000');
    expect(request.to).toBe('1800000000000');
    expect(queries).toHaveLength(collectTempoQueries(resource).length);
    expect(new Set(queries.map(query => query.refId)).size).toBe(queries.length);
    for (const query of queries) {
      expect(query.datasource).toEqual({type: 'tempo', uid: telemetryDashboardDatasourceUid});
      expect(query.limit).toBe(1);
      expect(query.maxDataPoints).toBe(1);
      expect(query.spanLimit).toBe(1);
    }
  });

  it('accepts only an explicit Grafana Cloud stack namespace and Kubernetes Repository resource name', () => {
    expect(validateGrafanaCloudNamespace(testGrafanaNamespace)).toBe(testGrafanaNamespace);
    expect(() => validateGrafanaCloudNamespace('default')).toThrow(/stacks-<numeric-stack-id>/u);
    expect(() => validateGrafanaCloudNamespace('stacks-private')).toThrow(/stacks-<numeric-stack-id>/u);
    expect(() => validateGrafanaCloudNamespace('stacks-0123')).toThrow(/stacks-<numeric-stack-id>/u);

    expect(validateGrafanaGitSyncManagerId(testGitSyncManagerId)).toBe(testGitSyncManagerId);
    expect(() => validateGrafanaGitSyncManagerId('Repository Threadnote')).toThrow(/repository resource name/u);
    expect(() => validateGrafanaGitSyncManagerId('repository/threadnote')).toThrow(/repository resource name/u);
  });

  it('requires exact repository ownership, manager, source paths, namespace, and folder provenance', async () => {
    const resource = readProvisionedDashboard();
    const folder = readProvisionedFolder();
    const mismatches: readonly Readonly<{
      dashboard?: Readonly<{folderUid?: string; managerId?: string; namespace?: string; sourcePath?: string}>;
      folder?: Readonly<{managerId?: string; namespace?: string; sourcePath?: string}>;
    }>[] = [
      {dashboard: {managerId: 'repository-other'}},
      {dashboard: {namespace: 'stacks-654321'}},
      {dashboard: {sourcePath: 'threadnote-telemetry/other.json'}},
      {dashboard: {folderUid: 'other-folder'}},
      {folder: {managerId: 'repository-other'}},
      {folder: {sourcePath: 'other-folder'}},
    ];

    for (const mismatch of mismatches) {
      let permissionsOrQueriesAttempted = false;
      const fetcher = async (input: string | URL | Request): Promise<Response> => {
        const url = String(input);
        if (url.includes('/apis/dashboard.grafana.app/')) {
          return Response.json(
            liveGitSyncResource(resource, {
              folderUid: telemetryDashboardFolderUid,
              sourcePath: telemetryDashboardSourcePathInGitSync,
              spec: storedDashboardSpec(resource),
              ...mismatch.dashboard,
            }),
          );
        }
        if (url.includes('/apis/folder.grafana.app/')) {
          return Response.json(
            liveGitSyncResource(folder, {
              sourcePath: telemetryDashboardFolderSourcePathInGitSync,
              ...mismatch.folder,
            }),
          );
        }
        permissionsOrQueriesAttempted = true;
        return Response.json([]);
      };

      await expect(
        verifyLiveDashboard({
          baseUrl: 'https://grafana.example.test',
          fetcher,
          folder,
          managerId: testGitSyncManagerId,
          namespace: testGrafanaNamespace,
          pollIntervalMs: 0,
          resource,
          syncTimeoutMs: 0,
          token: 'read-only-test-token',
        }),
      ).rejects.toThrow(/did not converge/u);
      expect(permissionsOrQueriesAttempted).toBe(false);
    }
  });

  it('does not expose private deployment identifiers when a Grafana transport request fails', async () => {
    const resource = readProvisionedDashboard();
    const folder = readProvisionedFolder();
    const privateNamespace = 'stacks-987654321';
    const privateManagerId = 'repository-private-deployment';
    const error = await verifyLiveDashboard({
      baseUrl: 'https://grafana.example.test',
      fetcher: async () => {
        throw new Error(`failed request for ${privateNamespace}/${privateManagerId}`);
      },
      folder,
      managerId: privateManagerId,
      namespace: privateNamespace,
      pollIntervalMs: 0,
      resource,
      syncTimeoutMs: 0,
      token: 'read-only-test-token',
    }).then(
      () => undefined,
      failure => failure,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Grafana API request failed before receiving a response.');
    expect((error as Error).message).not.toContain(privateNamespace);
    expect((error as Error).message).not.toContain(privateManagerId);
  });

  it('verifies synchronized dashboard state and all query results through read-only API calls', async () => {
    const resource = readProvisionedDashboard();
    const folder = readProvisionedFolder();
    const requests: {body?: string; method?: string; url: string}[] = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      requests.push({body: init?.body as string | undefined, method: init?.method, url});
      if (url.includes('/apis/dashboard.grafana.app/')) {
        return Response.json(
          liveGitSyncResource(resource, {
            folderUid: telemetryDashboardFolderUid,
            sourcePath: telemetryDashboardSourcePathInGitSync,
            spec: storedDashboardSpec(resource),
          }),
        );
      }
      if (url.includes('/apis/folder.grafana.app/')) {
        return Response.json(liveGitSyncResource(folder, {sourcePath: telemetryDashboardFolderSourcePathInGitSync}));
      }
      if (url.endsWith(`/api/folders/${telemetryDashboardFolderUid}/permissions`)) return Response.json([]);
      return Response.json(successfulQueryResponse(resource));
    };

    await verifyLiveDashboard({
      baseUrl: 'https://grafana.example.test',
      fetcher,
      folder,
      managerId: testGitSyncManagerId,
      namespace: testGrafanaNamespace,
      pollIntervalMs: 0,
      resource,
      syncTimeoutMs: 0,
      token: 'read-only-test-token',
    });

    expect(requests.map(request => request.url)).toEqual([
      `https://grafana.example.test/apis/dashboard.grafana.app/v1/namespaces/${testGrafanaNamespace}/dashboards/${telemetryDashboardUid}`,
      `https://grafana.example.test/apis/folder.grafana.app/v1/namespaces/${testGrafanaNamespace}/folders/${telemetryDashboardFolderUid}`,
      `https://grafana.example.test/api/folders/${telemetryDashboardFolderUid}/permissions`,
      'https://grafana.example.test/api/ds/query',
    ]);
    expect(requests[0]?.method).toBeUndefined();
    expect(requests[3]?.method).toBe('POST');
    expect(requests[3]?.body).not.toContain('${DS_TEMPO}');
  });

  it('retries a missing dashboard while the first Git Sync pull is converging', async () => {
    const resource = readProvisionedDashboard();
    const folder = readProvisionedFolder();
    let dashboardAttempts = 0;
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      if (String(input).includes('/apis/dashboard.grafana.app/')) {
        dashboardAttempts += 1;
        if (dashboardAttempts === 1) return new Response(null, {status: 404});
        return Response.json(
          liveGitSyncResource(resource, {
            folderUid: telemetryDashboardFolderUid,
            sourcePath: telemetryDashboardSourcePathInGitSync,
            spec: storedDashboardSpec(resource),
          }),
        );
      }
      if (String(input).includes('/apis/folder.grafana.app/')) {
        return Response.json(liveGitSyncResource(folder, {sourcePath: telemetryDashboardFolderSourcePathInGitSync}));
      }
      if (String(input).includes('/permissions')) return Response.json([]);
      return Response.json(successfulQueryResponse(resource));
    };

    await verifyLiveDashboard({
      baseUrl: 'https://grafana.example.test',
      fetcher,
      folder,
      managerId: testGitSyncManagerId,
      namespace: testGrafanaNamespace,
      pollIntervalMs: 0,
      resource,
      syncTimeoutMs: 1_000,
      token: 'read-only-test-token',
    });
    expect(dashboardAttempts).toBe(2);
  });

  it('does not accept a matching unmanaged dashboard as Git Sync convergence', async () => {
    const resource = readProvisionedDashboard();
    const folder = readProvisionedFolder();
    let queryAttempted = false;
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      if (String(input).includes('/apis/dashboard.grafana.app/')) {
        return Response.json(
          liveGitSyncResource(resource, {
            folderUid: telemetryDashboardFolderUid,
            managedBy: 'kubectl',
            sourcePath: telemetryDashboardSourcePathInGitSync,
            spec: storedDashboardSpec(resource),
          }),
        );
      }
      queryAttempted = true;
      return Response.json(successfulQueryResponse(resource));
    };

    await expect(
      verifyLiveDashboard({
        baseUrl: 'https://grafana.example.test',
        fetcher,
        folder,
        managerId: testGitSyncManagerId,
        namespace: testGrafanaNamespace,
        pollIntervalMs: 0,
        resource,
        syncTimeoutMs: 0,
        token: 'read-only-test-token',
      }),
    ).rejects.toThrow(/did not converge/u);
    expect(queryAttempted).toBe(false);
  });

  it('fails closed when Grafana omits even one parser result', async () => {
    const resource = readProvisionedDashboard();
    const folder = readProvisionedFolder();
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      if (String(input).includes('/apis/dashboard.grafana.app/')) {
        return Response.json(
          liveGitSyncResource(resource, {
            folderUid: telemetryDashboardFolderUid,
            sourcePath: telemetryDashboardSourcePathInGitSync,
            spec: storedDashboardSpec(resource),
          }),
        );
      }
      if (String(input).includes('/apis/folder.grafana.app/')) {
        return Response.json(liveGitSyncResource(folder, {sourcePath: telemetryDashboardFolderSourcePathInGitSync}));
      }
      if (String(input).includes('/permissions')) return Response.json([]);
      return Response.json({results: {}});
    };

    await expect(
      verifyLiveDashboard({
        baseUrl: 'https://grafana.example.test',
        fetcher,
        folder,
        managerId: testGitSyncManagerId,
        namespace: testGrafanaNamespace,
        pollIntervalMs: 0,
        resource,
        syncTimeoutMs: 0,
        token: 'read-only-test-token',
      }),
    ).rejects.toThrow(/rejected \d+ bounded dashboard query targets/u);
  });

  it('does not accept a stale Git Sync folder when the dashboard itself is current', async () => {
    const resource = readProvisionedDashboard();
    const folder = readProvisionedFolder();
    let permissionsOrQueriesAttempted = false;
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      if (String(input).includes('/apis/dashboard.grafana.app/')) {
        return Response.json(
          liveGitSyncResource(resource, {
            folderUid: telemetryDashboardFolderUid,
            sourcePath: telemetryDashboardSourcePathInGitSync,
            spec: storedDashboardSpec(resource),
          }),
        );
      }
      if (String(input).includes('/apis/folder.grafana.app/')) {
        return Response.json(
          liveGitSyncResource(folder, {
            sourcePath: telemetryDashboardFolderSourcePathInGitSync,
            spec: {title: 'Stale folder title'},
          }),
        );
      }
      permissionsOrQueriesAttempted = true;
      return Response.json([]);
    };

    await expect(
      verifyLiveDashboard({
        baseUrl: 'https://grafana.example.test',
        fetcher,
        folder,
        managerId: testGitSyncManagerId,
        namespace: testGrafanaNamespace,
        pollIntervalMs: 0,
        resource,
        syncTimeoutMs: 0,
        token: 'read-only-test-token',
      }),
    ).rejects.toThrow(/did not converge/u);
    expect(permissionsOrQueriesAttempted).toBe(false);
  });

  it('rejects the broad default Viewer and Editor grants on the private folder', async () => {
    const resource = readProvisionedDashboard();
    const folder = readProvisionedFolder();
    let queryAttempted = false;
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes('/apis/dashboard.grafana.app/')) {
        return Response.json(
          liveGitSyncResource(resource, {
            folderUid: telemetryDashboardFolderUid,
            sourcePath: telemetryDashboardSourcePathInGitSync,
            spec: storedDashboardSpec(resource),
          }),
        );
      }
      if (url.includes('/apis/folder.grafana.app/')) {
        return Response.json(liveGitSyncResource(folder, {sourcePath: telemetryDashboardFolderSourcePathInGitSync}));
      }
      if (url.includes('/permissions')) {
        return Response.json([{folderId: -1, permission: 1, role: 'Viewer'}]);
      }
      queryAttempted = true;
      return Response.json(successfulQueryResponse(resource));
    };

    await expect(
      verifyLiveDashboard({
        baseUrl: 'https://grafana.example.test',
        fetcher,
        folder,
        managerId: testGitSyncManagerId,
        namespace: testGrafanaNamespace,
        pollIntervalMs: 0,
        resource,
        syncTimeoutMs: 0,
        token: 'read-only-test-token',
      }),
    ).rejects.toThrow(/broad default Viewer or Editor access/u);
    expect(queryAttempted).toBe(false);
  });

  it('keeps validation secretless and live verification main-only, read-only, and configuration-gated', () => {
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
    expect(workflow.concurrency).toEqual({
      'cancel-in-progress': true,
      group: 'telemetry-dashboard-${{ github.ref }}',
    });

    const validation = workflow.jobs.validate!;
    const verification = workflow.jobs['verify-live']!;
    const validationText = JSON.stringify(validation);
    const verificationText = JSON.stringify(verification);
    expect(validation.environment).toBeUndefined();
    expect(validationText).not.toContain('secrets.');
    expect(validationText).not.toContain('verify-live');
    expect(validationText).toContain('bun install --frozen-lockfile');
    expect(verification.environment).toEqual({deployment: false, name: 'telemetry-dashboard-production'});
    expect(verification.needs).toBe('validate');
    expect(verification.if).toContain("github.event_name != 'pull_request'");
    expect(verification.if).toContain("github.ref == 'refs/heads/main'");
    expect(verification.if).toContain("THREADNOTE_TELEMETRY_GRAFANA_GIT_SYNC_ENABLED == 'true'");
    expect(verificationText).toContain('THREADNOTE_TELEMETRY_GRAFANA_READ_TOKEN');
    expect(verificationText).toContain('THREADNOTE_TELEMETRY_GRAFANA_NAMESPACE');
    expect(verificationText).toContain('THREADNOTE_TELEMETRY_GRAFANA_GIT_SYNC_MANAGER_ID');
    expect(verificationText).not.toContain('bun install');
    expect(verificationText).not.toMatch(/WRITE_TOKEN|dashboard.*write|gcx resources push/iu);
    expect(verificationText).toContain('bun scripts/telemetry-dashboard.ts verify-live');
    expect(
      `${validationText}\n${verificationText}`.match(/oven-sh\/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6/gu),
    ).toHaveLength(2);
  });

  it('pins a stable private folder identity for Git Sync permissions', () => {
    const folder = readProvisionedFolder();
    expect(folder).toEqual({
      apiVersion: 'folder.grafana.app/v1',
      kind: 'Folder',
      metadata: {name: 'threadnote-telemetry-private'},
      spec: {title: telemetryDashboardFolderTitle},
    });
  });
});
