import {TestError} from '../helpers/test-error.js';
import {spawn, type ChildProcess} from '../helpers/node-child-process.js';
import {mkdtemp, rm} from '../helpers/node-fs-promises.js';
import {createServer} from '../helpers/node-net.js';
import {networkInterfaces, tmpdir} from '../helpers/node-os.js';
import {join} from '../helpers/node-path.js';
import {afterEach, describe, expect, it} from 'vitest';

let child: ChildProcess | undefined;

afterEach(async () => {
  child?.kill('SIGKILL');
  child = undefined;
});

describe('Effect manager lifecycle', () => {
  it('serves authenticated APIs only on an ephemeral loopback port and closes on SIGINT', async () => {
    const home = await mkdtemp(join(tmpdir(), 'threadnote-manager-lifecycle-'));
    try {
      child = spawnManager(home, 0);
      const url = await managerUrl(child);
      const parsed = new URL(url);
      const token = parsed.searchParams.get('token');
      expect(parsed.hostname).toBe('127.0.0.1');
      expect(Number(parsed.port)).toBeGreaterThan(0);
      expect(token).not.toBeNull();

      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('Threadnote');

      const unauthorized = await fetch(`${parsed.origin}/api/graphs`);
      expect(unauthorized.status).toBe(401);
      expect(await unauthorized.json()).toEqual({error: 'Unauthorized'});

      const authorized = await fetch(`${parsed.origin}/api/graphs`, {
        headers: {authorization: `Bearer ${token}`},
      });
      expect(authorized.status).toBe(200);
      expect(await authorized.json()).toMatchObject({repositories: []});

      const nonLoopbackAddress = firstNonLoopbackIpv4Address();
      if (nonLoopbackAddress !== undefined) {
        await expect(
          fetch(`http://${nonLoopbackAddress}:${parsed.port}/api/graphs`, {
            headers: {authorization: `Bearer ${token}`},
            signal: AbortSignal.timeout(2_000),
          }),
        ).rejects.toThrow();
      }

      const exitPromise = childExit(child);
      child.kill('SIGINT');
      const exit = await exitPromise;
      expect(exit.signal).toBeNull();
      expect(exit.code).toBe(130);
      child = undefined;

      await expect(fetch(`${parsed.origin}/api/graphs`)).rejects.toThrow();
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('honors an explicitly requested loopback port', async () => {
    const home = await mkdtemp(join(tmpdir(), 'threadnote-manager-fixed-port-'));
    try {
      const requestedPort = await availableLoopbackPort();
      child = spawnManager(home, requestedPort);
      const url = new URL(await managerUrl(child));
      expect(url.hostname).toBe('127.0.0.1');
      expect(Number(url.port)).toBe(requestedPort);

      const exitPromise = childExit(child);
      child.kill('SIGINT');
      const exit = await exitPromise;
      expect(exit).toEqual({code: 130, signal: null});
      child = undefined;
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });
});

function spawnManager(home: string, uiPort: number): ChildProcess {
  return spawn(
    process.execPath,
    ['src/standalone.ts', '--home', home, 'manage', '--ui-port', String(uiPort), '--no-open'],
    {
      cwd: process.cwd(),
      env: {...process.env, NO_COLOR: '1'},
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

function firstNonLoopbackIpv4Address(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return undefined;
}

async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(TestError.make({message: 'Could not reserve a loopback TCP port.'}));
        return;
      }
      server.close(error => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function managerUrl(process: ChildProcess): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(TestError.make({message: `Manager did not start:\n${output}`})), 10_000);
    const consume = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      const match = /Threadnote manager: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(output);
      if (match?.[1]) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    };
    process.stdout?.on('data', consume);
    process.stderr?.on('data', consume);
    process.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(TestError.make({message: `Manager exited before startup (code=${code}, signal=${signal}):\n${output}`}));
    });
  });
}

async function childExit(
  process: ChildProcess,
): Promise<{readonly code: number | null; readonly signal: NodeJS.Signals | null}> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(TestError.make({message: 'Manager did not stop after SIGINT.'})), 10_000);
    process.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({code, signal});
    });
  });
}
