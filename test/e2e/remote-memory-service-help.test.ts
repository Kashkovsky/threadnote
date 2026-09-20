import {execFile} from '../helpers/node-child-process.js';
import {promisify} from '../helpers/node-util.js';
import {describe, expect, it} from 'vitest';
import {join} from '../helpers/node-path.js';

const execute = promisify(execFile);
const root = process.cwd();
const sourceEntry = join(root, 'src', 'standalone.ts');

function serviceEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('THREADNOTE_REMOTE_')));
}

describe('remote memory service standalone entrypoint', () => {
  it.each(['--help', '-h'])('prints bounded help without loading service configuration (%s)', async argument => {
    const result = await execute(process.execPath, [sourceEntry, 'remote-memory-service', argument], {
      cwd: root,
      env: serviceEnvironment(),
      encoding: 'utf8',
      maxBuffer: 8 * 1024,
    });

    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      [
        'Threadnote remote memory service',
        '',
        'Usage: threadnote remote-memory-service',
        '',
        'Starts the remote memory HTTP service using THREADNOTE_REMOTE_* environment variables.',
        '',
      ].join('\n'),
    );
    expect(result.stdout.length).toBeLessThan(2048);
  });

  it('keeps normal startup on the service path when configuration is missing', async () => {
    const result = await execute(process.execPath, [sourceEntry, 'remote-memory-service'], {
      cwd: root,
      env: serviceEnvironment(),
      encoding: 'utf8',
      maxBuffer: 8 * 1024,
    }).catch(error => error as {code: number; stderr: string; stdout: string});

    expect(result).toMatchObject({
      code: 1,
      stderr: 'Remote memory service failed: RemoteMemoryError.\n',
      stdout: '',
    });
  });
});
