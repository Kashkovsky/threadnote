import {Console, Effect, Path} from 'effect';
import type {RuntimeConfig} from '../../types.js';
import {SystemInfo} from '../../effect/system.js';
import {CodeGraphWatcher} from '../watcher.js';
import {resolveCodeGraphScopeRoute} from '../scope/routing.js';

export const runCodeGraphWatch = Effect.fn('codeGraph.command.watch')(function* (
  config: RuntimeConfig,
  options: {readonly cwd?: string; readonly project?: string},
) {
  const system = yield* SystemInfo;
  const path = yield* Path.Path;
  const cwd = path.resolve(options.cwd?.trim() || system.currentDirectory());
  const route = yield* resolveCodeGraphScopeRoute(config.manifestPath, cwd, options.project);
  const watcher = yield* CodeGraphWatcher;
  yield* Console.log(`Watching code graph inputs in ${cwd}. Press Ctrl-C to stop.`);
  yield* watcher.watch({
    cwd,
    key: cwd,
    onRefreshed: (symbols, edges) => Console.log(`Code graph refreshed: ${symbols} symbol(s), ${edges} edge(s).`),
    ...(route.state === 'selected' ? {project: route.project} : {}),
    threadnoteHome: config.agentContextHome,
  });
});
