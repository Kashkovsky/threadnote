import {existsSync} from 'node:fs';
import {userInfo} from 'node:os';
import {join} from 'node:path';
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

export interface RuntimeOptions {
  readonly home?: string;
  readonly host?: string;
  readonly manifest?: string;
  readonly port?: number;
}

export function getRuntimeConfig(options: RuntimeOptions = {}, manifestOverride?: string): RuntimeConfig {
  const threadnoteHome = expandPath(options.home ?? process.env.THREADNOTE_HOME ?? '~/.openviking');
  const manifestPath = expandPath(
    manifestOverride ?? options.manifest ?? process.env.THREADNOTE_MANIFEST ?? defaultManifestPath(threadnoteHome),
  );
  return {
    account: process.env.THREADNOTE_ACCOUNT ?? DEFAULT_ACCOUNT,
    agentContextHome: threadnoteHome,
    agentId: process.env.THREADNOTE_AGENT_ID ?? DEFAULT_AGENT_ID,
    host: options.host ?? process.env.THREADNOTE_HOST ?? DEFAULT_HOST,
    manifestPath,
    openVikingVersion: process.env.THREADNOTE_OPENVIKING_VERSION ?? DEFAULT_OPENVIKING_VERSION,
    port: options.port ?? parsePort(process.env.THREADNOTE_PORT ?? String(DEFAULT_PORT)),
    user: process.env.THREADNOTE_USER ?? userInfo().username,
  };
}

export function defaultManifestPath(agentContextHome: string): string {
  const userManifest = join(agentContextHome, USER_MANIFEST_NAME);
  return existsSync(userManifest) ? userManifest : builtInExampleManifestPath();
}

export function builtInExampleManifestPath(): string {
  return join(toolRoot(), 'config', 'seed-manifest.example.yaml');
}

export function openVikingHealthUrl(config: RuntimeConfig): string {
  return `http://${config.host}:${config.port}/health`;
}

export function openVikingLogPath(config: RuntimeConfig): string {
  return join(config.agentContextHome, 'logs', 'server.log');
}

export function openVikingServerArgs(config: RuntimeConfig): readonly string[] {
  return ['--config', join(config.agentContextHome, 'ov.conf'), '--host', config.host, '--port', String(config.port)];
}

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
  let rendered = template
    .replaceAll('{{THREADNOTE_HOME}}', config.agentContextHome)
    .replaceAll('{{OPENVIKING_ACCOUNT}}', config.account)
    .replaceAll('{{OPENVIKING_AGENT_ID}}', config.agentId)
    .replaceAll('{{OPENVIKING_HOST}}', config.host)
    .replaceAll('{{OPENVIKING_PORT}}', String(config.port))
    .replaceAll('{{OPENVIKING_USER}}', config.user);
  for (const [key, value] of Object.entries(extras)) {
    // Replacement is a literal string — use the function form to bypass
    // String.replaceAll's $-pattern interpretation, so absolute paths
    // containing characters like `$&` render correctly.
    rendered = rendered.replaceAll(`{{${key}}}`, () => value);
  }
  return rendered;
}
