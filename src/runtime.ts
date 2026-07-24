import {Effect, FileSystem, Path} from 'effect';
import {
  DEFAULT_ACCOUNT,
  DEFAULT_AGENT_ID,
  DEFAULT_HOST,
  DEFAULT_OPENVIKING_VERSION,
  DEFAULT_PORT,
  USER_MANIFEST_NAME,
} from './constants.js';
import type {RuntimeConfig} from './types.js';
import {expandPath, parsePort, toolRoot} from './utils.js';
import {SystemInfo} from './effect/system.js';

export interface RuntimeOptions {
  readonly home?: string;
  readonly host?: string;
  readonly manifest?: string;
  readonly port?: number;
}

export const getRuntimeConfig = Effect.fn('runtime.getRuntimeConfig')(function* (
  options: RuntimeOptions = {},
  manifestOverride?: string,
) {
  const system = yield* SystemInfo;
  const environment = system.environment();
  const threadnoteHome = yield* expandPath(options.home ?? environment.THREADNOTE_HOME ?? '~/.openviking');
  const configuredManifest = manifestOverride ?? options.manifest ?? environment.THREADNOTE_MANIFEST;
  const manifestPath = yield* expandPath(configuredManifest ?? (yield* defaultManifestPath(threadnoteHome)));
  return {
    account: environment.THREADNOTE_ACCOUNT ?? DEFAULT_ACCOUNT,
    agentContextHome: threadnoteHome,
    agentId: environment.THREADNOTE_AGENT_ID ?? DEFAULT_AGENT_ID,
    host: options.host ?? environment.THREADNOTE_HOST ?? DEFAULT_HOST,
    manifestPath,
    openVikingVersion: environment.THREADNOTE_OPENVIKING_VERSION ?? DEFAULT_OPENVIKING_VERSION,
    port: options.port ?? parsePort(environment.THREADNOTE_PORT ?? String(DEFAULT_PORT)),
    user: environment.THREADNOTE_USER ?? system.userName,
  };
});

export const defaultManifestPath = Effect.fn('runtime.defaultManifestPath')(function* (agentContextHome: string) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const userManifest = pathService.join(agentContextHome, USER_MANIFEST_NAME);
  return (yield* fs.exists(userManifest)) ? userManifest : yield* builtInExampleManifestPath();
});

export const builtInExampleManifestPath = Effect.fn('runtime.builtInExampleManifestPath')(function* () {
  const pathService = yield* Path.Path;
  return pathService.join(yield* toolRoot(), 'config', 'seed-manifest.example.yaml');
});

export function openVikingHealthUrl(config: RuntimeConfig): string {
  return `http://${config.host}:${config.port}/health`;
}

export const openVikingLogPath = Effect.fn('runtime.openVikingLogPath')(function* (config: RuntimeConfig) {
  const pathService = yield* Path.Path;
  return pathService.join(config.agentContextHome, 'logs', 'server.log');
});

export const openVikingServerArgs = Effect.fn('runtime.openVikingServerArgs')(function* (config: RuntimeConfig) {
  const pathService = yield* Path.Path;
  return [
    '--config',
    pathService.join(config.agentContextHome, 'ov.conf'),
    '--host',
    config.host,
    '--port',
    String(config.port),
  ];
});

export interface AgentIdentity {
  readonly account: string;
  readonly agentId: string;
  readonly user: string;
}

export function withIdentity(config: AgentIdentity, args: readonly string[]): readonly string[] {
  // OpenViking 0.4.x removed the `--agent-id` CLI flag (every subcommand rejects
  // it with "Unexpected argument"); identity is now just account + user, and the
  // legacy agent_id maps to a request-level peer shim that the CLI no longer
  // takes. Passing it broke every `ov` call (recall included) on 0.4.4.
  return [...args, '--account', config.account, '--user', config.user];
}

export function renderTemplate(
  template: string,
  config: RuntimeConfig,
  extras: Readonly<Record<string, string>> = {},
): string {
  return renderTemplateWith(config, extras, value => value, template);
}

export function renderJsonTemplate(
  template: string,
  config: RuntimeConfig,
  extras: Readonly<Record<string, string>> = {},
): string {
  return renderTemplateWith(config, extras, value => JSON.stringify(value).slice(1, -1), template);
}

function renderTemplateWith(
  config: RuntimeConfig,
  extras: Readonly<Record<string, string>>,
  encode: (value: string) => string,
  template: string,
): string {
  let rendered = template
    .replaceAll('{{THREADNOTE_HOME}}', () => encode(config.agentContextHome))
    .replaceAll('{{OPENVIKING_ACCOUNT}}', () => encode(config.account))
    .replaceAll('{{OPENVIKING_AGENT_ID}}', () => encode(config.agentId))
    .replaceAll('{{OPENVIKING_HOST}}', () => encode(config.host))
    .replaceAll('{{OPENVIKING_PORT}}', String(config.port))
    .replaceAll('{{OPENVIKING_USER}}', () => encode(config.user));
  for (const [key, value] of Object.entries(extras)) {
    // Replacement is a literal string — use the function form to bypass
    // String.replaceAll's $-pattern interpretation, so absolute paths
    // containing characters like `$&` render correctly.
    rendered = rendered.replaceAll(`{{${key}}}`, () => encode(value));
  }
  return rendered;
}
