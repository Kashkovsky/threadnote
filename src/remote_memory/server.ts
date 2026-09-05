import type {RemoteMemoryServiceConfig} from './config.js';
import {createRemoteMemoryHttpHandler} from './http_transport.js';
import type {LocalIdp} from './local_idp.js';
import type {RemoteMemoryServiceDependencies} from './service_types.js';

export interface RemoteMemoryServer {
  readonly hostname: string;
  readonly port: number;
  readonly stop: (closeActiveConnections?: boolean) => Promise<void>;
  readonly url: URL;
}

export interface StartRemoteMemoryServerOptions {
  readonly config: RemoteMemoryServiceConfig;
  readonly dependencies: RemoteMemoryServiceDependencies;
  readonly localIdp?: LocalIdp;
  readonly serve?: typeof Bun.serve;
}

export function startRemoteMemoryServer(options: StartRemoteMemoryServerOptions): RemoteMemoryServer {
  const fetch = createRemoteMemoryHttpHandler({
    config: options.config,
    dependencies: options.dependencies,
    ...(options.localIdp ? {localIdp: options.localIdp} : {}),
  });
  const server = (options.serve ?? Bun.serve)({
    fetch,
    hostname: options.config.host,
    maxRequestBodySize: options.config.maxBodyBytes,
    port: options.config.port,
  });
  const port = server.port ?? options.config.port;
  const hostname = server.hostname ?? options.config.host;
  let stopped = false;
  return {
    hostname,
    port,
    stop: async (closeActiveConnections = false) => {
      if (stopped) return;
      stopped = true;
      await server.stop(closeActiveConnections);
    },
    url: new URL(`http://${displayHost(hostname)}:${port}`),
  };
}

function displayHost(hostname: string): string {
  if (hostname === '0.0.0.0') return '127.0.0.1';
  if (hostname === '::') return '[::1]';
  return hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
}
