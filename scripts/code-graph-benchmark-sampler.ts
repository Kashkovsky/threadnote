import {mkdir, readdir, readFile, rename, stat, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';

export interface CodeGraphBenchmarkSamplerPhase {
  readonly cpuMilliseconds?: number;
  readonly databasePeakBytes: number;
  readonly rssPeakBytes?: number;
  readonly samples: number;
  readonly shmPeakBytes: number;
  readonly temporaryPeakBytes: number;
  readonly walPeakBytes: number;
}

export type CodeGraphBenchmarkSamplerProcessTelemetry =
  | {
      readonly availability: 'available';
      readonly parentIdentityValidation: 'linux-proc-starttime';
      readonly source: 'linux-proc';
    }
  | {
      readonly availability: 'unavailable';
      readonly parentIdentityValidation: 'process-liveness-only';
      readonly reason: 'parent-inspection-unavailable' | 'unsupported-platform';
      readonly source: 'none';
    };

export interface CodeGraphBenchmarkSamplerArtifact {
  readonly intervalMilliseconds: number;
  readonly phases: Readonly<Record<string, CodeGraphBenchmarkSamplerPhase>>;
  readonly platform: string;
  readonly processTelemetry: CodeGraphBenchmarkSamplerProcessTelemetry;
  readonly samples: number;
  readonly version: 2;
}

export interface CodeGraphBenchmarkSamplerCheckpoint {
  readonly sampler: CodeGraphBenchmarkSamplerArtifact;
  readonly state: 'aborted' | 'complete' | 'parent-exited' | 'running';
  readonly updatedAt: string;
  readonly version: 2;
}

export function parseCodeGraphBenchmarkSamplerArtifact(value: unknown): CodeGraphBenchmarkSamplerArtifact {
  if (typeof value !== 'object' || value === null) throw new Error('Benchmark sampler artifact must be an object.');
  const artifact = value as Partial<CodeGraphBenchmarkSamplerArtifact>;
  if (
    artifact.version !== 2 ||
    typeof artifact.intervalMilliseconds !== 'number' ||
    !Number.isSafeInteger(artifact.intervalMilliseconds) ||
    artifact.intervalMilliseconds < 10 ||
    typeof artifact.platform !== 'string' ||
    artifact.platform.length === 0 ||
    !Number.isSafeInteger(artifact.samples) ||
    Number(artifact.samples) < 1 ||
    typeof artifact.phases !== 'object' ||
    artifact.phases === null
  ) {
    throw new Error('Benchmark sampler artifact is invalid.');
  }
  const processTelemetry = parseSamplerProcessTelemetry(artifact.platform, artifact.processTelemetry);
  let phaseSamples = 0;
  for (const [phase, sample] of Object.entries(artifact.phases)) {
    if (!phase || !isSamplerPhase(sample, processTelemetry.availability)) {
      throw new Error(`Benchmark sampler phase ${phase || '<empty>'} is invalid.`);
    }
    phaseSamples += sample.samples;
    if (!Number.isSafeInteger(phaseSamples)) throw new Error('Benchmark sampler sample total is invalid.');
  }
  if (phaseSamples !== artifact.samples) throw new Error('Benchmark sampler phase samples do not match its total.');
  return artifact as CodeGraphBenchmarkSamplerArtifact;
}

export function parseCodeGraphBenchmarkSamplerCheckpoint(value: unknown): CodeGraphBenchmarkSamplerCheckpoint {
  if (typeof value !== 'object' || value === null) throw new Error('Benchmark sampler checkpoint must be an object.');
  const checkpoint = value as Partial<CodeGraphBenchmarkSamplerCheckpoint>;
  if (
    checkpoint.version !== 2 ||
    !['aborted', 'complete', 'parent-exited', 'running'].includes(checkpoint.state ?? '') ||
    typeof checkpoint.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(checkpoint.updatedAt))
  ) {
    throw new Error('Benchmark sampler checkpoint is invalid.');
  }
  parseCodeGraphBenchmarkSamplerArtifact(checkpoint.sampler);
  return checkpoint as CodeGraphBenchmarkSamplerCheckpoint;
}

function parseSamplerProcessTelemetry(platform: string, value: unknown): CodeGraphBenchmarkSamplerProcessTelemetry {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Benchmark sampler process telemetry must be an object.');
  }
  const telemetry = value as Partial<CodeGraphBenchmarkSamplerProcessTelemetry>;
  if (
    telemetry.availability === 'available' &&
    platform === 'linux' &&
    telemetry.parentIdentityValidation === 'linux-proc-starttime' &&
    telemetry.source === 'linux-proc'
  ) {
    return telemetry as CodeGraphBenchmarkSamplerProcessTelemetry;
  }
  const expectedReason = platform === 'linux' ? 'parent-inspection-unavailable' : 'unsupported-platform';
  if (
    telemetry.availability === 'unavailable' &&
    telemetry.parentIdentityValidation === 'process-liveness-only' &&
    telemetry.reason === expectedReason &&
    telemetry.source === 'none'
  ) {
    return telemetry as CodeGraphBenchmarkSamplerProcessTelemetry;
  }
  throw new Error('Benchmark sampler process telemetry does not match its platform.');
}

function isSamplerPhase(
  value: unknown,
  processTelemetryAvailability: CodeGraphBenchmarkSamplerProcessTelemetry['availability'],
): value is CodeGraphBenchmarkSamplerPhase {
  if (typeof value !== 'object' || value === null) return false;
  const sample = value as Partial<CodeGraphBenchmarkSamplerPhase>;
  const byteCounts = [sample.databasePeakBytes, sample.shmPeakBytes, sample.temporaryPeakBytes, sample.walPeakBytes];
  const processTelemetryValid =
    processTelemetryAvailability === 'available'
      ? typeof sample.cpuMilliseconds === 'number' &&
        Number.isFinite(sample.cpuMilliseconds) &&
        sample.cpuMilliseconds >= 0 &&
        Number.isSafeInteger(sample.rssPeakBytes) &&
        Number(sample.rssPeakBytes) >= 0
      : sample.cpuMilliseconds === undefined && sample.rssPeakBytes === undefined;
  return (
    processTelemetryValid &&
    Number.isSafeInteger(sample.samples) &&
    Number(sample.samples) > 0 &&
    byteCounts.every(candidate => Number.isSafeInteger(candidate) && Number(candidate) >= 0)
  );
}

interface MutablePhase {
  cpuMilliseconds: number;
  databasePeakBytes: number;
  rssPeakBytes: number;
  samples: number;
  shmPeakBytes: number;
  temporaryPeakBytes: number;
  walPeakBytes: number;
}

interface SamplerOptions {
  readonly checkpointIntervalMilliseconds: number;
  readonly checkpointPath: string;
  readonly databasePath: string;
  readonly intervalMilliseconds: number;
  readonly outputPath: string;
  readonly phasePath: string;
  readonly processId: number;
  readonly readyPath: string;
  readonly stopPath: string;
  readonly temporaryRoot: string;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const clockTicksPerSecond = linuxClockTicksPerSecond();
  const initialProcessSample = await readProcessSample(options.processId, clockTicksPerSecond);
  const processTelemetry = samplerProcessTelemetryContract(process.platform, initialProcessSample?.startIdentity);
  const parentStartIdentity = initialProcessSample?.startIdentity;
  const phases = new Map<string, MutablePhase>();
  let previousProcessSample = processTelemetry.availability === 'available' ? initialProcessSample : undefined;
  let samples = 0;
  let lastCheckpointAt = 0;
  let readyPublished = false;
  let stopped: boolean;
  let stopState: CodeGraphBenchmarkSamplerCheckpoint['state'];
  do {
    const phase = (await readText(options.phasePath))?.trim() || 'unknown';
    const [databaseBytes, walBytes, shmBytes, temporaryBytes, processSample] = await Promise.all([
      fileBytes(options.databasePath),
      fileBytes(`${options.databasePath}-wal`),
      fileBytes(`${options.databasePath}-shm`),
      directoryBytes(options.temporaryRoot),
      readProcessSample(options.processId, clockTicksPerSecond),
    ]);
    const parentExists = processExists(options.processId);
    const parentExited = samplerParentExited(parentStartIdentity, processSample?.startIdentity, parentExists);
    const telemetrySample = processTelemetry.availability === 'available' && !parentExited ? processSample : undefined;
    const current = phases.get(phase) ?? {
      cpuMilliseconds: 0,
      databasePeakBytes: 0,
      rssPeakBytes: 0,
      samples: 0,
      shmPeakBytes: 0,
      temporaryPeakBytes: 0,
      walPeakBytes: 0,
    };
    current.databasePeakBytes = Math.max(current.databasePeakBytes, databaseBytes);
    current.walPeakBytes = Math.max(current.walPeakBytes, walBytes);
    current.shmPeakBytes = Math.max(current.shmPeakBytes, shmBytes);
    current.temporaryPeakBytes = Math.max(current.temporaryPeakBytes, temporaryBytes);
    current.rssPeakBytes = Math.max(current.rssPeakBytes, telemetrySample?.rssBytes ?? 0);
    if (telemetrySample) {
      current.cpuMilliseconds += Math.max(
        0,
        telemetrySample.cpuMilliseconds - (previousProcessSample?.cpuMilliseconds ?? telemetrySample.cpuMilliseconds),
      );
      previousProcessSample = telemetrySample;
    }
    current.samples += 1;
    samples += 1;
    phases.set(phase, current);
    const requestedStop = await readText(options.stopPath);
    stopped = requestedStop !== undefined || parentExited;
    stopState =
      requestedStop !== undefined ? parseStopState(requestedStop) : parentExited ? 'parent-exited' : 'running';
    const now = Date.now();
    if (stopped || samples === 1 || now - lastCheckpointAt >= options.checkpointIntervalMilliseconds) {
      await writeCheckpoint(
        options.checkpointPath,
        samplerArtifact(options.intervalMilliseconds, phases, processTelemetry, samples),
        stopState,
      );
      if (!readyPublished) {
        await atomicWriteFile(options.readyPath, '{"checkpointVersion":2,"version":1}\n');
        readyPublished = true;
      }
      lastCheckpointAt = now;
    }
    if (!stopped) await Bun.sleep(options.intervalMilliseconds);
  } while (!stopped);

  const artifact = samplerArtifact(options.intervalMilliseconds, phases, processTelemetry, samples);
  await atomicWriteFile(options.outputPath, `${JSON.stringify(artifact)}\n`);
}

function samplerArtifact(
  intervalMilliseconds: number,
  phases: ReadonlyMap<string, MutablePhase>,
  processTelemetry: CodeGraphBenchmarkSamplerProcessTelemetry,
  samples: number,
): CodeGraphBenchmarkSamplerArtifact {
  return {
    intervalMilliseconds,
    phases: Object.fromEntries(
      [...phases.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([phase, value]) => {
          const process =
            processTelemetry.availability === 'available'
              ? {cpuMilliseconds: value.cpuMilliseconds, rssPeakBytes: value.rssPeakBytes}
              : {};
          return [
            phase,
            {
              ...process,
              databasePeakBytes: value.databasePeakBytes,
              samples: value.samples,
              shmPeakBytes: value.shmPeakBytes,
              temporaryPeakBytes: value.temporaryPeakBytes,
              walPeakBytes: value.walPeakBytes,
            },
          ];
        }),
    ),
    platform: process.platform,
    processTelemetry,
    samples,
    version: 2,
  };
}

async function writeCheckpoint(
  checkpointPath: string,
  sampler: CodeGraphBenchmarkSamplerArtifact,
  state: CodeGraphBenchmarkSamplerCheckpoint['state'],
): Promise<void> {
  const checkpoint: CodeGraphBenchmarkSamplerCheckpoint = {
    sampler,
    state,
    updatedAt: new Date().toISOString(),
    version: 2,
  };
  await atomicWriteFile(checkpointPath, `${JSON.stringify(checkpoint)}\n`);
}

async function atomicWriteFile(outputPath: string, contents: string): Promise<void> {
  await mkdir(dirname(outputPath), {recursive: true, mode: 0o700});
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, contents, {encoding: 'utf8', mode: 0o600});
  await rename(temporaryPath, outputPath);
}

function parseStopState(value: string): 'aborted' | 'complete' {
  return value.trim() === 'complete' ? 'complete' : 'aborted';
}

async function readProcessSample(
  processId: number,
  clockTicksPerSecond: number,
): Promise<LinuxProcessSample | undefined> {
  if (process.platform !== 'linux') return undefined;
  try {
    const [statText, statusText] = await Promise.all([
      readFile(`/proc/${processId}/stat`, 'utf8'),
      readFile(`/proc/${processId}/status`, 'utf8'),
    ]);
    const stat = parseLinuxProcessStat(statText);
    const rssMatch = /^VmRSS:\s+(\d+)\s+kB$/m.exec(statusText);
    const rssKilobytes = Number(rssMatch?.[1]);
    if (!stat || !rssMatch || !Number.isSafeInteger(rssKilobytes) || rssKilobytes < 0) return undefined;
    return {
      cpuMilliseconds: ((stat.userTicks + stat.systemTicks) * 1_000) / clockTicksPerSecond,
      rssBytes: rssKilobytes * 1024,
      startIdentity: stat.startIdentity,
    };
  } catch {
    return undefined;
  }
}

interface LinuxProcessSample {
  readonly cpuMilliseconds: number;
  readonly rssBytes: number;
  readonly startIdentity: string;
}

export function parseLinuxProcessStat(
  statText: string,
): {readonly startIdentity: string; readonly systemTicks: number; readonly userTicks: number} | undefined {
  const closing = statText.lastIndexOf(')');
  if (closing < 0) return undefined;
  const fields = statText
    .slice(closing + 2)
    .trim()
    .split(/\s+/);
  const userTicksText = fields[11];
  const systemTicksText = fields[12];
  const startIdentity = fields[19];
  if (
    userTicksText === undefined ||
    !/^\d+$/.test(userTicksText) ||
    systemTicksText === undefined ||
    !/^\d+$/.test(systemTicksText) ||
    startIdentity === undefined ||
    !/^\d+$/.test(startIdentity)
  ) {
    return undefined;
  }
  const userTicks = Number(userTicksText);
  const systemTicks = Number(systemTicksText);
  if (!Number.isSafeInteger(userTicks) || !Number.isSafeInteger(systemTicks)) return undefined;
  return {startIdentity, systemTicks, userTicks};
}

export function samplerProcessTelemetryContract(
  platform: string,
  parentStartIdentity: string | undefined,
): CodeGraphBenchmarkSamplerProcessTelemetry {
  if (platform === 'linux' && parentStartIdentity !== undefined) {
    return {
      availability: 'available',
      parentIdentityValidation: 'linux-proc-starttime',
      source: 'linux-proc',
    };
  }
  return {
    availability: 'unavailable',
    parentIdentityValidation: 'process-liveness-only',
    reason: platform === 'linux' ? 'parent-inspection-unavailable' : 'unsupported-platform',
    source: 'none',
  };
}

export function samplerParentExited(
  expectedStartIdentity: string | undefined,
  observedStartIdentity: string | undefined,
  processExistsNow: boolean,
): boolean {
  return (
    !processExistsNow ||
    (expectedStartIdentity !== undefined &&
      observedStartIdentity !== undefined &&
      observedStartIdentity !== expectedStartIdentity)
  );
}

function linuxClockTicksPerSecond(): number {
  if (process.platform !== 'linux') return 100;
  try {
    const result = Bun.spawnSync({cmd: ['getconf', 'CLK_TCK'], stderr: 'ignore'});
    const value = Number(new TextDecoder().decode(result.stdout).trim());
    return Number.isFinite(value) && value > 0 ? value : 100;
  } catch {
    return 100;
  }
}

async function directoryBytes(directory: string): Promise<number> {
  try {
    let bytes = 0;
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) bytes += await directoryBytes(child);
      else if (entry.isFile()) bytes += await fileBytes(child);
    }
    return bytes;
  } catch {
    return 0;
  }
}

async function fileBytes(file: string): Promise<number> {
  try {
    const info = await stat(file);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}

function processExists(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (cause: unknown) {
    return !(
      typeof cause === 'object' &&
      cause !== null &&
      'code' in cause &&
      (cause as {readonly code?: unknown}).code === 'ESRCH'
    );
  }
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

function parseArguments(args: readonly string[]): SamplerOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith('--') || value === undefined) throw new Error(`Invalid benchmark sampler argument ${flag}.`);
    values.set(flag, value);
  }
  const required = (flag: string) => {
    const value = values.get(flag);
    if (!value) throw new Error(`Missing benchmark sampler argument ${flag}.`);
    return value;
  };
  const processId = Number(required('--pid'));
  const intervalMilliseconds = Number(required('--interval-ms'));
  const checkpointIntervalMilliseconds = Number(required('--checkpoint-ms'));
  if (!Number.isSafeInteger(processId) || processId <= 0) throw new Error('Sampler PID must be positive.');
  if (!Number.isSafeInteger(intervalMilliseconds) || intervalMilliseconds < 10) {
    throw new Error('Sampler interval must be at least 10 milliseconds.');
  }
  if (!Number.isSafeInteger(checkpointIntervalMilliseconds) || checkpointIntervalMilliseconds < intervalMilliseconds) {
    throw new Error('Sampler checkpoint interval must be at least the sampling interval.');
  }
  const outputPath = required('--output');
  const checkpointPath = required('--checkpoint-output');
  const readyPath = required('--ready');
  if (dirname(outputPath) === outputPath) throw new Error('Sampler output path must have a parent directory.');
  if (dirname(checkpointPath) === checkpointPath) {
    throw new Error('Sampler checkpoint path must have a parent directory.');
  }
  if (dirname(readyPath) === readyPath) throw new Error('Sampler ready path must have a parent directory.');
  if (new Set([checkpointPath, outputPath, readyPath]).size !== 3) {
    throw new Error('Sampler checkpoint, output, and ready paths must be distinct.');
  }
  return {
    checkpointIntervalMilliseconds,
    checkpointPath,
    databasePath: required('--database'),
    intervalMilliseconds,
    outputPath,
    phasePath: required('--phase'),
    processId,
    readyPath,
    stopPath: required('--stop'),
    temporaryRoot: required('--temp-root'),
  };
}

if (import.meta.main) await main();
