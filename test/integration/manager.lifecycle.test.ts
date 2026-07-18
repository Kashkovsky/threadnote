import {spawn, type ChildProcess} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

let child: ChildProcess | undefined;

afterEach(async () => {
  child?.kill('SIGKILL');
  child = undefined;
});

describe('Effect manager lifecycle', () => {
  it('serves the manager and closes its scoped server on SIGINT', async () => {
    const home = await mkdtemp(join(tmpdir(), 'threadnote-manager-lifecycle-'));
    try {
      child = spawn(
        process.execPath,
        ['--import', 'tsx', 'src/threadnote.ts', '--home', home, 'manage', '--ui-port', '0', '--no-open'],
        {cwd: process.cwd(), env: {...process.env, NO_COLOR: '1'}, stdio: ['ignore', 'pipe', 'pipe']},
      );
      const url = await managerUrl(child);
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('Threadnote');

      child.kill('SIGINT');
      const exit = await childExit(child);
      expect(exit.signal).toBeNull();
      expect(exit.code).toBe(130);
      child = undefined;

      await expect(fetch(url)).rejects.toThrow();
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });
});

async function managerUrl(process: ChildProcess): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Manager did not start:\n${output}`)), 10_000);
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
      reject(new Error(`Manager exited before startup (code=${code}, signal=${signal}):\n${output}`));
    });
  });
}

async function childExit(
  process: ChildProcess,
): Promise<{readonly code: number | null; readonly signal: NodeJS.Signals | null}> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Manager did not stop after SIGINT.')), 10_000);
    process.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({code, signal});
    });
  });
}
