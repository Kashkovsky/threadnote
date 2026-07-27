import {Console, Effect, FileSystem, Path, Result} from 'effect';
import {hasManagedClaudeHooks, runHooksInstall} from './hooks.js';
import {localAiDoctorCheck} from './effect/local-ai.js';
import {SystemInfo} from './effect/system.js';
import {removeMcpConfigs, removeMcpSnippets, resolveMcpClients, runMcpInstall} from './mcp.js';
import {maybeRunPostUpdateAfterRepair} from './update.js';
import {loadRecallIndexData} from './recall/index.js';
import {readSeedManifest, uriSegment} from './manifest.js';
import {threadnoteStorageLayout, THREADNOTE_STORAGE_LAYOUT_VERSION} from './storage/layout.js';
import type {
  DoctorCheck,
  DoctorOptions,
  ForgetOptions,
  InstallOptions,
  RepairOptions,
  RuntimeConfig,
  StartOptions,
  UninstallOptions,
} from './types.js';
import {
  assertSafeThreadnoteHomeForErase,
  errorMessage,
  formatStatus,
  memoryFrontmatterField,
  memoryUriProjectSegment,
} from './utils.js';

const LAYOUT_RECEIPT = 'layout.json';

export const runDoctor = Effect.fn('lifecycle.doctor')(function* (config: RuntimeConfig, options: DoctorOptions) {
  const system = yield* SystemInfo;
  const checks = yield* collectDoctorChecks(config, options, system.platform);
  for (const check of checks) {
    yield* Console.log(`${formatStatus(check.status)} ${check.name}: ${check.detail}`);
  }
  const failureCount = checks.filter(check => check.status === 'fail').length;
  const warningCount = checks.filter(check => check.status === 'warn').length;
  yield* Console.log(`\nSummary: ${failureCount} failure(s), ${warningCount} warning(s)`);
  if (options.strict === true && failureCount > 0) {
    yield* Effect.sync(() => system.setExitCode(1));
  }
});

export const collectDoctorChecks = Effect.fn('lifecycle.collectDoctorChecks')(function* (
  config: RuntimeConfig,
  options: DoctorOptions = {},
  currentPlatform?: NodeJS.Platform,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const platform = currentPlatform ?? system.platform;
  const layout = threadnoteStorageLayout(path, config.agentContextHome, config.account, uriSegment(config.user));
  const checks: DoctorCheck[] = [
    {detail: options.dryRun ? 'dry run; no writes' : 'read-only checks', name: 'mode', status: 'ok'},
    {
      detail: platform,
      name: 'platform',
      status: ['darwin', 'linux', 'win32'].includes(platform) ? 'ok' : 'warn',
    },
    {
      detail: `v${system.nodeVersion}`,
      name: 'node',
      status: nodeMajorVersion(system.nodeVersion) >= 22 ? 'ok' : 'fail',
    },
    {
      detail: config.agentContextHome,
      name: 'Threadnote home',
      status: (yield* fs.exists(config.agentContextHome)) ? 'ok' : 'warn',
    },
    yield* layoutReceiptCheck(fs, path, config.agentContextHome),
    yield* manifestCheck(config.manifestPath),
    yield* localAiDoctorCheck(config),
    yield* recallIndexCheck(config),
    yield* memoryProjectConsistencyCheck(config),
  ];
  if (config.agentContextHome.endsWith('.openviking')) {
    checks.push({
      detail: 'THREADNOTE_HOME still targets a legacy .openviking directory; run `threadnote migrate`',
      name: 'legacy home override',
      status: 'fail',
    });
  }
  checks.push({
    detail: layout.canonicalRoot,
    name: 'canonical store',
    status: (yield* fs.exists(layout.canonicalRoot)) ? 'ok' : 'warn',
  });
  return checks;
});

export const runInstall = Effect.fn('lifecycle.install')(function* (config: RuntimeConfig, options: InstallOptions) {
  const dryRun = options.dryRun === true;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const layout = threadnoteStorageLayout(path, config.agentContextHome, config.account, uriSegment(config.user));
  const directories = [
    layout.home,
    layout.canonicalRoot,
    layout.cacheRoot,
    layout.indexesRoot,
    layout.locksRoot,
    layout.logsRoot,
    layout.migrationRoot,
    layout.modelsRoot,
    layout.resourcesRoot,
    layout.sharesRoot,
    layout.temporaryRoot,
    layout.userMemoriesRoot,
  ];
  if (dryRun) {
    for (const directory of directories) yield* Console.log(`Would ensure private directory: ${directory}`);
    yield* Console.log(`Would write storage layout v${THREADNOTE_STORAGE_LAYOUT_VERSION} receipt.`);
  } else {
    for (const directory of directories) {
      yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
    }
    yield* writeLayoutReceipt(fs, path, config.agentContextHome);
  }
  if (options.start !== false) {
    yield* Console.log('Threadnote 4 uses in-process storage and inference; no background server is required.');
  }
  if (options.printNextSteps !== false) {
    yield* Console.log(
      dryRun
        ? 'Dry run complete. Run without --dry-run to initialize the Threadnote home.'
        : 'Install complete. Next: `threadnote seed`, then `threadnote models list` for optional semantic recall.',
    );
  }
});

export const runRepair = Effect.fn('lifecycle.repair')(function* (config: RuntimeConfig, options: RepairOptions) {
  const dryRun = options.dryRun === true;
  yield* Console.log('Repairing the self-contained Threadnote home.');
  yield* runInstall(config, {dryRun, printNextSteps: false, start: false});
  if (!dryRun) {
    yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: false}).pipe(
      Effect.tap(index => Console.log(`Rebuilt lexical recall index for ${index.candidates.length} document(s).`)),
      Effect.catch(cause => Console.warn(`WARN lexical index repair failed: ${errorMessage(cause)}`)),
    );
  } else {
    yield* Console.log('Would validate and rebuild the derived lexical recall index.');
  }
  const mcpClients = yield* resolveMcpClients(options.mcp ?? 'available', 'repair');
  for (const client of mcpClients) {
    yield* runMcpInstall(config, client, {apply: !dryRun, name: 'threadnote'});
  }
  if (yield* hasManagedClaudeHooks()) {
    yield* runHooksInstall(config, 'claude', {apply: !dryRun, dryRun});
  }
  yield* runDoctor(config, {dryRun, strict: false});
  if (options.postUpdate !== false) {
    yield* maybeRunPostUpdateAfterRepair(config, {dryRun});
  }
});

export const runStart = Effect.fn('lifecycle.start')(function* (_config: RuntimeConfig, options: StartOptions) {
  yield* Console.log(
    options.dryRun
      ? 'Would verify the self-contained runtime; no daemon would be started.'
      : 'Threadnote is self-contained and starts on demand; no daemon is required.',
  );
});

export const runStop = Effect.fn('lifecycle.stop')(function* (_config: RuntimeConfig, options: ForgetOptions) {
  yield* Console.log(
    options.dryRun
      ? 'Would stop no services; Threadnote owns no daemon.'
      : 'No Threadnote daemon is running. Native resources exit with their CLI, MCP, or manager process.',
  );
});

export const runUninstall = Effect.fn('lifecycle.uninstall')(function* (
  config: RuntimeConfig,
  options: UninstallOptions,
) {
  const dryRun = options.dryRun === true;
  if (options.eraseMemories === true && options.preserveMemories === true) {
    return yield* Effect.fail(new Error('Use either --erase-memories or --preserve-memories, not both.'));
  }
  yield* removeMcpConfigs(options.mcp ?? 'available', dryRun);
  yield* removeMcpSnippets(config, dryRun);
  if (yield* hasManagedClaudeHooks()) {
    yield* runHooksInstall(config, 'claude', {apply: !dryRun, dryRun, remove: true});
  }
  if (options.eraseMemories === true) {
    yield* eraseThreadnoteHome(config.agentContextHome, dryRun);
  } else {
    yield* Console.log(`Preserving Threadnote home: ${config.agentContextHome}`);
  }
  yield* Console.log('Uninstall complete. Remove the npm package separately if desired.');
});

export const memoryProjectConsistencyCheck = Effect.fn('lifecycle.memoryProjectConsistencyCheck')(function* (
  config: RuntimeConfig,
) {
  const name = 'memory project consistency';
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const layout = threadnoteStorageLayout(path, config.agentContextHome, config.account, uriSegment(config.user));
  if (!(yield* fs.exists(layout.userMemoriesRoot))) {
    return {detail: 'no memories directory yet', name, status: 'ok' as const};
  }
  return yield* Effect.gen(function* () {
    const entries = yield* fs.readDirectory(layout.userMemoriesRoot, {recursive: true});
    const mismatches: string[] = [];
    let checked = 0;
    for (const entry of entries) {
      if (!entry.endsWith('.md') || entry.endsWith('.summary.md') || entry.endsWith('.overview.md')) continue;
      const uri = `viking://user/${uriSegment(config.user)}/memories/${entry.split(path.sep).join('/')}`;
      const pathProject = memoryUriProjectSegment(uri);
      if (!pathProject) continue;
      const content = yield* fs
        .readFileString(path.join(layout.userMemoriesRoot, entry))
        .pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (content === undefined) continue;
      checked += 1;
      const frontProject = memoryFrontmatterField(content, 'project');
      if (frontProject && uriSegment(frontProject) !== pathProject) {
        mismatches.push(`${uri} (frontmatter "${frontProject}" vs path "${pathProject}")`);
      }
    }
    if (mismatches.length === 0) {
      return {detail: `${checked} project-scoped memories consistent`, name, status: 'ok' as const};
    }
    const sample = mismatches.slice(0, 3).join('; ');
    const extra = Math.max(0, mismatches.length - 3);
    return {
      detail:
        `${mismatches.length} memory(ies) whose frontmatter project differs from their storage path: ` +
        `${sample}${extra > 0 ? `, +${extra} more` : ''}`,
      name,
      status: 'warn' as const,
    };
  }).pipe(Effect.catch(cause => Effect.succeed({detail: errorMessage(cause), name, status: 'warn' as const})));
});

function manifestCheck(manifestPath: string) {
  return readSeedManifest(manifestPath).pipe(
    Effect.as({detail: manifestPath, name: 'seed manifest', status: 'ok' as const}),
    Effect.catch(cause =>
      Effect.succeed({
        detail: errorMessage(cause),
        name: 'seed manifest',
        status: 'warn' as const,
      }),
    ),
  );
}

function recallIndexCheck(config: RuntimeConfig) {
  return loadRecallIndexData(config, {includeInactive: false}).pipe(
    Effect.map(index => ({
      detail: `${index.candidates.length} canonical document(s)`,
      name: 'lexical recall index',
      status: 'ok' as const,
    })),
    Effect.catch(cause =>
      Effect.succeed({
        detail: errorMessage(cause),
        name: 'lexical recall index',
        status: 'warn' as const,
      }),
    ),
  );
}

function layoutReceiptCheck(fs: FileSystem.FileSystem, path: Path.Path, home: string) {
  return Effect.gen(function* () {
    const receiptPath = path.join(home, LAYOUT_RECEIPT);
    if (!(yield* fs.exists(receiptPath))) {
      return {
        detail: 'missing; run `threadnote install`',
        name: 'storage layout',
        status: 'warn',
      } satisfies DoctorCheck;
    }
    const raw = yield* fs.readFileString(receiptPath);
    const parsed = Result.try(() => JSON.parse(raw) as unknown);
    return Result.isSuccess(parsed) &&
      typeof parsed.success === 'object' &&
      parsed.success !== null &&
      (parsed.success as {version?: unknown}).version === THREADNOTE_STORAGE_LAYOUT_VERSION
      ? ({
          detail: `version ${THREADNOTE_STORAGE_LAYOUT_VERSION}`,
          name: 'storage layout',
          status: 'ok',
        } satisfies DoctorCheck)
      : ({
          detail: 'invalid or unsupported receipt',
          name: 'storage layout',
          status: 'fail',
        } satisfies DoctorCheck);
  });
}

function writeLayoutReceipt(fs: FileSystem.FileSystem, path: Path.Path, home: string) {
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    const target = path.join(home, LAYOUT_RECEIPT);
    const temporary = path.join(home, `.${LAYOUT_RECEIPT}.${system.processId}.tmp`);
    yield* fs.writeFileString(
      temporary,
      `${JSON.stringify({createdBy: 'threadnote', version: THREADNOTE_STORAGE_LAYOUT_VERSION}, undefined, 2)}\n`,
      {mode: 0o600},
    );
    yield* fs.rename(temporary, target);
  });
}

function eraseThreadnoteHome(home: string, dryRun: boolean) {
  return Effect.gen(function* () {
    yield* assertSafeThreadnoteHomeForErase(home);
    if (dryRun) {
      yield* Console.log(`Would erase Threadnote home: ${home}`);
      return;
    }
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(home, {recursive: true});
    yield* Console.log(`Erased Threadnote home: ${home}`);
  });
}

function nodeMajorVersion(nodeVersion: string): number {
  return Number.parseInt(nodeVersion.split('.', 1)[0] ?? '0', 10);
}
