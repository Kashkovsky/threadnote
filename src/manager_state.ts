import {Effect} from 'effect';
import {resolveEffectAiConfiguration} from './effect/ai/consolidator.js';
import {SystemInfo} from './effect/system.js';
import {resolveSelectedLocalModel} from './models/inference.js';
import type {RuntimeConfig} from './types.js';
import {currentPackageVersion, fetchLatestVersion, releaseSource} from './update.js';
import {selectUpdateChannel} from './update_channel.js';
import {findExecutable} from './utils.js';
import {compareVersions} from './version_compare.js';

export const detectConsolidationAgents = Effect.fn('manager.detectConsolidationAgents')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
) {
  const effectAi = yield* resolveEffectAiConfiguration(config, (yield* SystemInfo).environment());
  const nativeGeneration = yield* resolveSelectedLocalModel(config.agentContextHome, 'generation');
  const [codex, claude, cursor, copilot] = yield* Effect.all([
    findExecutable(['codex']),
    findExecutable(['claude']),
    findExecutable(['cursor-agent']),
    findExecutable(['copilot']),
  ]);
  return [
    {available: codex !== undefined, command: codex, id: 'codex', label: 'Codex'},
    {available: claude !== undefined, command: claude, id: 'claude', label: 'Claude'},
    {available: cursor !== undefined, command: cursor, id: 'cursor', label: 'Cursor'},
    {available: copilot !== undefined, command: copilot, id: 'copilot', label: 'Copilot'},
    {
      available: nativeGeneration !== undefined || effectAi !== undefined,
      command: nativeGeneration?.manifest.id ?? effectAi?.configuration.model,
      id: 'effect-ai',
      label: nativeGeneration ? 'Threadnote local AI' : 'Effect AI (explicit remote provider)',
    },
  ];
});

export function managerUpdateAvailable(currentVersion: string, latestVersion?: string): boolean {
  return latestVersion !== undefined && compareVersions(latestVersion, currentVersion) > 0;
}

export const readManagerRuntimeState = Effect.fn('manager.readRuntimeState')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
) {
  const system = yield* SystemInfo;
  const [agents, version] = yield* Effect.all([detectConsolidationAgents(config), currentPackageVersion()]);
  const latestVersion = yield* fetchLatestVersion(
    releaseSource(system.environment()),
    selectUpdateChannel(version),
  ).pipe(Effect.catch(() => Effect.succeed(undefined)));
  return {
    agents,
    latestVersion,
    updateAvailable: managerUpdateAvailable(version, latestVersion),
    version,
  };
});
