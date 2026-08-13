import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, Layer, Runtime} from 'effect';
import {withCliOutputConsole} from './effect/cli_output.js';
import {
  CODE_GRAPH_COMPACTION_WORKER_ARGUMENT,
  CODE_GRAPH_DEEP_DIAGNOSTICS_WORKER_ARGUMENT,
  CODE_GRAPH_GIT_WORKTREE_REGISTRATION_WORKER_ARGUMENT,
  CODE_GRAPH_PARSER_WORKER_ARGUMENT,
  LOCAL_MODEL_WORKER_ARGUMENT,
} from './worker_protocol.js';

const executableName = process.execPath.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase();
const arguments_ = process.argv.slice(2);
const isLocalModelWorker = arguments_[0] === LOCAL_MODEL_WORKER_ARGUMENT;
const isCodeGraphParserWorker = arguments_[0] === CODE_GRAPH_PARSER_WORKER_ARGUMENT;
const isCodeGraphCompactionWorker = arguments_[0] === CODE_GRAPH_COMPACTION_WORKER_ARGUMENT;
const isCodeGraphDeepDiagnosticsWorker = arguments_[0] === CODE_GRAPH_DEEP_DIAGNOSTICS_WORKER_ARGUMENT;
const isGitWorktreeRegistrationWorker = arguments_[0] === CODE_GRAPH_GIT_WORKTREE_REGISTRATION_WORKER_ARGUMENT;
const isMcpBroker = arguments_[0] === 'mcp-broker';
const isRemoteMemoryOperator = arguments_[0] === 'remote-memory-operator';
const isMcpServer = executableName?.startsWith('threadnote-mcp-server') === true || arguments_[0] === 'mcp-server';
const runSignalTransparentMain = Runtime.makeRunMain(({fiber, teardown}) => {
  fiber.addObserver(exit => {
    teardown(exit, code => {
      if (code !== 0) process.exit(code);
    });
  });
});

if (isCodeGraphDeepDiagnosticsWorker || isCodeGraphCompactionWorker) {
  // SQLite's integrity_check is synchronous native work. This worker must keep
  // the OS default SIGTERM behavior so the lock-owning parent can always stop it.
  runSignalTransparentMain(
    isCodeGraphCompactionWorker
      ? await codeGraphAutomaticCompactionWorkerProgram()
      : await codeGraphDeepDiagnosticsWorkerProgram(),
    {disableErrorReporting: true},
  );
} else {
  const program: Effect.Effect<void, unknown, never> = isRemoteMemoryOperator
    ? await remoteMemoryOperatorProgram(arguments_.slice(1))
    : isLocalModelWorker
      ? await localModelWorkerProgram(arguments_)
      : isCodeGraphParserWorker
        ? await codeGraphParserWorkerProgram(arguments_)
        : isGitWorktreeRegistrationWorker
          ? await gitWorktreeRegistrationWorkerProgram()
          : await applicationProgram(arguments_, isMcpServer, isMcpBroker);

  BunRuntime.runMain(program, {
    disableErrorReporting:
      isLocalModelWorker ||
      isCodeGraphParserWorker ||
      isGitWorktreeRegistrationWorker ||
      (!isMcpServer && !isMcpBroker),
  });
}

async function remoteMemoryOperatorProgram(arguments_: readonly string[]) {
  const operator = await import('./remote_memory/operator_main.js');
  return operator.runRemoteMemoryOperator(arguments_).pipe(
    Effect.flatMap(code =>
      Effect.sync(() => {
        process.exitCode = code;
      }),
    ),
    Effect.provide(BunServices.layer),
  );
}

async function codeGraphDeepDiagnosticsWorkerProgram() {
  const [worker, system, processDiagnostics, processLease] = await Promise.all([
    import('./code_graph/deep_diagnostics.js'),
    import('./effect/system.js'),
    import('./process_diagnostics.js'),
    import('./standalone_process_lease.js'),
  ]);
  const processHome = normalizedProcessHome(arguments_, processDiagnostics.threadnoteHomeForProcess);
  return processHome.pipe(
    Effect.flatMap(home =>
      processLease.withStandaloneProcessLease(
        processDiagnostics.withSignalTransparentThreadnoteWorkerRegistration(
          home,
          'graph-diagnostics-worker',
          'deep-graph-diagnostics',
          worker.codeGraphDeepDiagnosticsWorkerProgram,
        ),
      ),
    ),
    Effect.provide(Layer.merge(system.SystemInfo.layer, BunServices.layer)),
  );
}

async function codeGraphAutomaticCompactionWorkerProgram() {
  const [worker, system, processDiagnostics, processLease] = await Promise.all([
    import('./code_graph/automatic_compaction.js'),
    import('./effect/system.js'),
    import('./process_diagnostics.js'),
    import('./standalone_process_lease.js'),
  ]);
  const processHome = normalizedProcessHome(arguments_, processDiagnostics.threadnoteHomeForProcess);
  return processHome.pipe(
    Effect.flatMap(home =>
      processLease.withStandaloneProcessLease(
        processDiagnostics.withSignalTransparentThreadnoteWorkerRegistration(
          home,
          'graph-compaction-worker',
          'compact-graph-storage',
          worker.codeGraphAutomaticCompactionWorkerProgram,
        ),
      ),
    ),
    Effect.provide(Layer.merge(system.SystemInfo.layer, BunServices.layer)),
  );
}

async function gitWorktreeRegistrationWorkerProgram() {
  const [worker, system] = await Promise.all([
    import('./code_graph/git_worktree_registration_worker.js'),
    import('./effect/system.js'),
  ]);
  return worker.gitWorktreeRegistrationWorkerProgram.pipe(
    Effect.provide(Layer.merge(system.SystemInfo.layer, BunServices.layer)),
  );
}

async function localModelWorkerProgram(arguments_: readonly string[]) {
  const [isolatedModel, model, systemModule, processDiagnostics, processLease] = await Promise.all([
    import('./effect/ai/isolated-local-model-runtime.js'),
    import('./effect/ai/local-model-runtime.js'),
    import('./effect/system.js'),
    import('./process_diagnostics.js'),
    import('./standalone_process_lease.js'),
  ]);
  const processHome = normalizedProcessHome(arguments_, processDiagnostics.threadnoteHomeForProcess);
  return processHome.pipe(
    Effect.flatMap(home =>
      processLease.withStandaloneProcessLease(
        processDiagnostics.withThreadnoteProcessRegistration(
          home,
          'local-model-worker',
          Effect.scoped(isolatedModel.localModelWorkerServer.pipe(Effect.provide(model.localModelRuntimeLayer()))),
          'model-stdio',
        ),
      ),
    ),
    Effect.provide(Layer.merge(systemModule.SystemInfo.layer, BunServices.layer)),
  );
}

async function codeGraphParserWorkerProgram(arguments_: readonly string[]) {
  const [parser, treeSitter, systemModule, processDiagnostics, processLease] = await Promise.all([
    import('./code_graph/parser_worker.js'),
    import('./code_graph/tree_sitter/runtime.js'),
    import('./effect/system.js'),
    import('./process_diagnostics.js'),
    import('./standalone_process_lease.js'),
  ]);
  const processHome = normalizedProcessHome(arguments_, processDiagnostics.threadnoteHomeForProcess);
  return processHome.pipe(
    Effect.flatMap(home =>
      processLease.withStandaloneProcessLease(
        processDiagnostics.withThreadnoteProcessRegistration(
          home,
          'graph-parser-worker',
          Effect.scoped(parser.codeGraphParserWorkerServer),
          'parser-stdio',
        ),
      ),
    ),
    Effect.provide(
      treeSitter.TreeSitterRuntime.layer.pipe(
        Layer.provideMerge(Layer.merge(systemModule.SystemInfo.layer, BunServices.layer)),
      ),
    ),
  );
}

async function applicationProgram(arguments_: readonly string[], isMcpServer: boolean, isMcpBroker: boolean) {
  const [runtime, processDiagnostics, processLease] = await Promise.all([
    import('./effect/runtime.js'),
    import('./process_diagnostics.js'),
    import('./standalone_process_lease.js'),
  ]);
  if (isMcpBroker) {
    const {mcpBrokerEffect} = await import('./effect/mcp_broker_process.js');
    const processHome = normalizedProcessHome(arguments_, processDiagnostics.threadnoteHomeForProcess);
    return processHome.pipe(
      Effect.flatMap(home =>
        processLease.withStandaloneProcessLease(
          processDiagnostics.withThreadnoteProcessRegistration(
            home,
            'mcp-broker',
            Effect.scoped(mcpBrokerEffect),
            'mcp-broker',
          ),
          {retirementPolicy: 'preserve-session'},
        ),
      ),
      Effect.provide(runtime.StandaloneBrokerLayer),
    );
  }
  if (isMcpServer) {
    const {mcpServerEffect} = await import('./mcp_server.js');
    const processHome = normalizedProcessHome(arguments_, processDiagnostics.threadnoteHomeForProcess);
    return processHome.pipe(
      Effect.flatMap(home =>
        processLease.withStandaloneProcessLease(
          processDiagnostics.withThreadnoteProcessRegistration(
            home,
            'mcp',
            Effect.scoped(mcpServerEffect),
            'mcp-server',
          ),
        ),
      ),
      Effect.provide(runtime.ApplicationLayer),
    );
  }

  const [{inspectCliInvocation}, {cliEffect}] = await Promise.all([
    import('./effect/cli.js'),
    import('./threadnote.js'),
  ]);
  const cliOperation = inspectCliInvocation(arguments_).operation;
  const processRole = cliOperation === 'manage' ? 'manager' : 'cli';
  const processOperation = cliOperation === 'manage' ? 'manager-ui' : cliOperation;
  const processHome = normalizedProcessHome(arguments_, processDiagnostics.threadnoteHomeForProcess);
  return processHome.pipe(
    Effect.flatMap(home =>
      processLease.withStandaloneProcessLease(
        processDiagnostics.withThreadnoteProcessRegistration(
          home,
          processRole,
          withCliOutputConsole(cliEffect(arguments_)),
          processOperation,
        ),
      ),
    ),
    Effect.provide(runtime.ApplicationLayer),
  );
}

function normalizedProcessHome(
  arguments_: readonly string[],
  resolveHome: typeof import('./process_diagnostics.js').threadnoteHomeForProcess,
) {
  return resolveHome(arguments_, process.env).pipe(
    Effect.tap(home =>
      Effect.sync(() => {
        // Normalize CLI-only --home into the environment inherited by the
        // crash-isolated model worker and by the direct MCP entrypoint. Runtime
        // diagnostics and model storage must remain in the same Threadnote home.
        process.env.THREADNOTE_HOME = home;
      }),
    ),
  );
}
