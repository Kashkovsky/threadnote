import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {removeMemoryUri} from '../../src/share.js';
import * as utils from '../../src/utils.js';
import type {CommandResult, ShareRuntime} from '../../src/types.js';

vi.mock('../../src/utils.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/utils.js')>();
  return {
    ...actual,
    runCommand: vi.fn(),
    sleep: vi.fn().mockResolvedValue(undefined),
  };
});

const runtime: ShareRuntime = {
  account: 'local',
  agentContextHome: '/tmp/.openviking',
  agentId: 'threadnote',
  user: 'denyskashkovskyi',
};

const ok = (stdout = ''): CommandResult => ({exitCode: 0, stdout, stderr: ''});
const fail = (stderr: string): CommandResult => ({exitCode: 1, stdout: '', stderr});

function commandSequence(...results: readonly CommandResult[]): void {
  const runCommand = vi.mocked(utils.runCommand);
  runCommand.mockReset();
  for (const result of results) {
    runCommand.mockResolvedValueOnce(result);
  }
}

describe('removeMemoryUri retry behavior', () => {
  beforeEach(() => {
    vi.mocked(utils.runCommand).mockReset();
    vi.mocked(utils.sleep).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns successfully on the first attempt when ov rm succeeds', async () => {
    commandSequence(ok('removed'));
    await removeMemoryUri(runtime, '/usr/local/bin/ov', 'viking://user/me/memories/durable/x.md', false, {
      quiet: true,
    });
    expect(vi.mocked(utils.runCommand)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(utils.sleep)).not.toHaveBeenCalled();
  });

  it('drains the ov queue and retries on "resource is busy" until success', async () => {
    commandSequence(
      fail('Error: API error: [INVALID_ARGUMENT] resource is busy'),
      ok(''), // ov wait drain
      fail('Error: API error: [INVALID_ARGUMENT] resource is busy'),
      ok(''), // ov wait drain
      ok('removed'),
    );
    await removeMemoryUri(runtime, '/ov', 'viking://user/me/memories/durable/x.md', false, {quiet: true});
    const runCommand = vi.mocked(utils.runCommand);
    expect(runCommand).toHaveBeenCalledTimes(5);
    expect(runCommand.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['rm']));
    expect(runCommand.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(['wait', '--timeout', '120']));
    expect(runCommand.mock.calls[3]?.[1]).toEqual(expect.arrayContaining(['wait', '--timeout', '120']));
    expect(vi.mocked(utils.sleep)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(utils.sleep)).toHaveBeenNthCalledWith(1, 2000);
    expect(vi.mocked(utils.sleep)).toHaveBeenNthCalledWith(2, 5000);
  });

  it('does not drain the queue for network-class transients, just sleeps', async () => {
    commandSequence(fail('connection refused'), ok('removed'));
    await removeMemoryUri(runtime, '/ov', 'viking://user/me/memories/durable/x.md', false, {quiet: true});
    const runCommand = vi.mocked(utils.runCommand);
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(runCommand.mock.calls.find(c => c[1]?.includes('wait'))).toBeUndefined();
    expect(vi.mocked(utils.sleep)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(utils.sleep)).toHaveBeenCalledWith(1000);
  });

  it('throws immediately on a non-transient failure', async () => {
    commandSequence(fail('Error: [NOT_FOUND] resource does not exist'));
    await expect(
      removeMemoryUri(runtime, '/ov', 'viking://user/me/memories/durable/x.md', false, {quiet: true}),
    ).rejects.toThrow(/NOT_FOUND/);
    expect(vi.mocked(utils.sleep)).not.toHaveBeenCalled();
  });

  it('gives up after the last attempt and throws with the underlying error', async () => {
    const busyResults = Array.from({length: 6}, () => fail('Error: API error: [INVALID_ARGUMENT] resource is busy'));
    // 6 ov rm attempts interleaved with 5 ov wait drains
    const sequence: CommandResult[] = [];
    for (let index = 0; index < 6; index += 1) {
      sequence.push(busyResults[index]);
      if (index < 5) {
        sequence.push(ok(''));
      }
    }
    commandSequence(...sequence);
    await expect(
      removeMemoryUri(runtime, '/ov', 'viking://user/me/memories/durable/x.md', false, {quiet: true}),
    ).rejects.toThrow(/resource is busy/);
    expect(vi.mocked(utils.sleep)).toHaveBeenCalledTimes(5);
  });

  it('is a no-op in dry-run mode', async () => {
    await removeMemoryUri(runtime, '/ov', 'viking://user/me/memories/durable/x.md', true);
    expect(vi.mocked(utils.runCommand)).not.toHaveBeenCalled();
  });
});
