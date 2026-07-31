import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {
  parseCodeGraphBenchmarkSamplerArtifact,
  parseCodeGraphBenchmarkSamplerCheckpoint,
  parseLinuxProcessStat,
  samplerParentExited,
  samplerProcessTelemetryContract,
} from '../../scripts/code-graph-benchmark-sampler.js';

const validArtifact = {
  intervalMilliseconds: 25,
  phases: {
    scanning: {
      cpuMilliseconds: 12.5,
      databasePeakBytes: 4_096,
      rssPeakBytes: 8_192,
      samples: 3,
      shmPeakBytes: 32_768,
      temporaryPeakBytes: 0,
      walPeakBytes: 16_384,
    },
  },
  platform: 'linux',
  processTelemetry: {
    availability: 'available',
    parentIdentityValidation: 'linux-proc-starttime',
    source: 'linux-proc',
  },
  samples: 3,
  version: 2,
} as const;

const unavailableArtifact = {
  ...validArtifact,
  phases: {
    scanning: {
      databasePeakBytes: 4_096,
      samples: 3,
      shmPeakBytes: 32_768,
      temporaryPeakBytes: 0,
      walPeakBytes: 16_384,
    },
  },
  platform: 'darwin',
  processTelemetry: {
    availability: 'unavailable',
    parentIdentityValidation: 'process-liveness-only',
    reason: 'unsupported-platform',
    source: 'none',
  },
} as const;

describe('code graph benchmark sampler artifact', () => {
  it('accepts finite non-negative phase telemetry', () => {
    expect(parseCodeGraphBenchmarkSamplerArtifact(validArtifact)).toEqual(validArtifact);
  });

  it('omits process measurements when the platform cannot provide them', () => {
    const parsed = parseCodeGraphBenchmarkSamplerArtifact(unavailableArtifact);

    expect(parsed.processTelemetry).toEqual({
      availability: 'unavailable',
      parentIdentityValidation: 'process-liveness-only',
      reason: 'unsupported-platform',
      source: 'none',
    });
    expect(parsed.phases.scanning).not.toHaveProperty('cpuMilliseconds');
    expect(parsed.phases.scanning).not.toHaveProperty('rssPeakBytes');
  });

  it.each([
    {...validArtifact, intervalMilliseconds: 1},
    {...validArtifact, samples: 0},
    {...validArtifact, samples: 4},
    {...validArtifact, phases: {'': validArtifact.phases.scanning}},
    {
      ...validArtifact,
      phases: {scanning: {...validArtifact.phases.scanning, cpuMilliseconds: Number.NaN}},
    },
    {
      ...validArtifact,
      phases: {scanning: {...validArtifact.phases.scanning, databasePeakBytes: 0.5}},
    },
    {
      ...validArtifact,
      phases: {scanning: {...validArtifact.phases.scanning, samples: 1.5}},
    },
    {
      ...unavailableArtifact,
      phases: {
        scanning: {...unavailableArtifact.phases.scanning, cpuMilliseconds: 0, rssPeakBytes: 0},
      },
    },
    {
      ...validArtifact,
      platform: 'darwin',
    },
    {
      ...unavailableArtifact,
      platform: 'linux',
    },
  ])('rejects malformed telemetry %#', artifact => {
    expect(() => parseCodeGraphBenchmarkSamplerArtifact(artifact)).toThrow(/sampler/i);
  });

  it('exposes the platform-specific process telemetry contract', () => {
    expect(samplerProcessTelemetryContract('linux', '4096')).toEqual({
      availability: 'available',
      parentIdentityValidation: 'linux-proc-starttime',
      source: 'linux-proc',
    });
    expect(samplerProcessTelemetryContract('linux', undefined)).toEqual({
      availability: 'unavailable',
      parentIdentityValidation: 'process-liveness-only',
      reason: 'parent-inspection-unavailable',
      source: 'none',
    });
    for (const platform of ['darwin', 'win32']) {
      expect(samplerProcessTelemetryContract(platform, 'ignored')).toEqual({
        availability: 'unavailable',
        parentIdentityValidation: 'process-liveness-only',
        reason: 'unsupported-platform',
        source: 'none',
      });
    }
  });

  it('parses Linux start-time identity independently from process names containing parentheses', () => {
    const fields = Array.from({length: 20}, () => '0');
    fields[0] = 'S';
    fields[11] = '123';
    fields[12] = '45';
    fields[19] = '987654321';

    expect(parseLinuxProcessStat(`42 (worker ) name) ${fields.join(' ')}`)).toEqual({
      startIdentity: '987654321',
      systemTicks: 45,
      userTicks: 123,
    });
    expect(parseLinuxProcessStat('42 (truncated) S')).toBeUndefined();
  });

  it('treats a reused live PID as an exited parent', () => {
    expect(samplerParentExited('100', '100', true)).toBe(false);
    expect(samplerParentExited('100', undefined, true)).toBe(false);
    expect(samplerParentExited('100', '101', true)).toBe(true);
    expect(samplerParentExited('100', '100', false)).toBe(true);
  });

  it('writes its last observation and exits when the sampled parent is gone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-benchmark-sampler-'));
    try {
      const phase = join(root, 'phase');
      const output = join(root, 'output.json');
      const checkpoint = join(root, 'checkpoint.json');
      const ready = join(root, 'ready.json');
      await writeFile(phase, 'scanning');
      const sampler = Bun.spawn({
        cmd: [
          process.execPath,
          fileURLToPath(new URL('../../scripts/code-graph-benchmark-sampler.ts', import.meta.url)),
          '--pid',
          '2147483647',
          '--database',
          join(root, 'graph.sqlite'),
          '--temp-root',
          root,
          '--phase',
          phase,
          '--stop',
          join(root, 'stop'),
          '--output',
          output,
          '--checkpoint-output',
          checkpoint,
          '--ready',
          ready,
          '--interval-ms',
          '10',
          '--checkpoint-ms',
          '10',
        ],
        stderr: 'pipe',
        stdout: 'ignore',
      });
      expect(await sampler.exited).toBe(0);
      const artifact = parseCodeGraphBenchmarkSamplerArtifact(JSON.parse(await readFile(output, 'utf8')));
      expect(artifact).toMatchObject({
        phases: {scanning: {samples: 1}},
        processTelemetry: {
          availability: 'unavailable',
          parentIdentityValidation: 'process-liveness-only',
          reason: process.platform === 'linux' ? 'parent-inspection-unavailable' : 'unsupported-platform',
          source: 'none',
        },
        samples: 1,
        version: 2,
      });
      expect(artifact.phases.scanning).not.toHaveProperty('cpuMilliseconds');
      expect(artifact.phases.scanning).not.toHaveProperty('rssPeakBytes');
      expect(parseCodeGraphBenchmarkSamplerCheckpoint(JSON.parse(await readFile(checkpoint, 'utf8')))).toMatchObject({
        sampler: {samples: 1, version: 2},
        state: 'parent-exited',
        version: 2,
      });
      expect(JSON.parse(await readFile(ready, 'utf8'))).toEqual({checkpointVersion: 2, version: 1});
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  it('retains an uploadable checkpoint when a real sampled process crashes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-benchmark-sampler-crash-'));
    try {
      const phase = join(root, 'phase');
      const output = join(root, 'output.json');
      const checkpoint = join(root, 'artifacts', 'production-large.cold.sampler.json');
      const ready = join(root, 'ready.json');
      await writeFile(phase, 'scanning');
      const parent = Bun.spawn({
        cmd: [process.execPath, '-e', 'await Bun.sleep(500); process.exit(17)'],
        stderr: 'ignore',
        stdout: 'ignore',
      });
      const sampler = Bun.spawn({
        cmd: [
          process.execPath,
          fileURLToPath(new URL('../../scripts/code-graph-benchmark-sampler.ts', import.meta.url)),
          '--pid',
          String(parent.pid),
          '--database',
          join(root, 'graph.sqlite'),
          '--temp-root',
          root,
          '--phase',
          phase,
          '--stop',
          join(root, 'stop'),
          '--output',
          output,
          '--checkpoint-output',
          checkpoint,
          '--ready',
          ready,
          '--interval-ms',
          '10',
          '--checkpoint-ms',
          '20',
        ],
        stderr: 'pipe',
        stdout: 'ignore',
      });

      expect(JSON.parse(await waitForText(ready))).toEqual({checkpointVersion: 2, version: 1});
      expect(parseCodeGraphBenchmarkSamplerCheckpoint(JSON.parse(await readFile(checkpoint, 'utf8')))).toMatchObject({
        state: 'running',
        version: 2,
      });
      expect(await parent.exited).toBe(17);
      expect(await sampler.exited).toBe(0);
      expect(parseCodeGraphBenchmarkSamplerCheckpoint(JSON.parse(await readFile(checkpoint, 'utf8')))).toMatchObject({
        sampler: {phases: {scanning: expect.objectContaining({samples: expect.any(Number)})}},
        state: 'parent-exited',
        version: 2,
      });
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });
});

async function waitForText(file: string, timeoutMilliseconds = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMilliseconds;
  do {
    try {
      return await readFile(file, 'utf8');
    } catch {
      await Bun.sleep(5);
    }
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${file}.`);
}
