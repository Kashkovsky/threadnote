import {mkdir, readdir, readFile, readlink, realpath, rename, stat, writeFile} from 'fs/promises';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'path';

const MAX_DARWIN_LSOF_BYTES = 8 * 1024 * 1024;
const DARWIN_OPEN_FILE_SAMPLE_INTERVAL_MILLISECONDS = 1_000;
const MAX_OPEN_FILE_DESCRIPTORS = 65_536;
const MAX_OPEN_FILE_PROCESSES = 4_096;

export interface CodeGraphBenchmarkSamplerPhase {
  readonly cpuMilliseconds?: number;
  readonly databasePeakBytes: number;
  readonly ioReadBytes?: number;
  readonly ioWriteBytes?: number;
  readonly processPeakCount?: number;
  readonly processSampleAttempts?: number;
  readonly processSampleFailures?: number;
  readonly processSampleGapPeakMilliseconds?: number;
  readonly processSamples?: number;
  readonly rssPeakBytes?: number;
  readonly samples: number;
  readonly shmPeakBytes: number;
  readonly temporaryPeakBytes: number;
  readonly temporaryOpenAttempts?: number;
  readonly temporaryOpenFailures?: number;
  readonly temporaryLinkedPeakBytes?: number;
  readonly temporaryOpenPeakBytes?: number;
  readonly temporaryOpenSamples?: number;
  readonly walPeakBytes: number;
}

export type CodeGraphBenchmarkSamplerProcessTelemetry =
  | {
      readonly availability: 'available';
      readonly ioCounters?: 'linux-proc-read-write-bytes';
      readonly parentIdentityValidation: 'darwin-ps-lstart' | 'linux-proc-starttime';
      readonly sampleIntervalMilliseconds?: number;
      readonly scope?: 'recursive-process-tree';
      readonly source: 'darwin-ps' | 'linux-proc';
    }
  | {
      readonly availability: 'unavailable';
      readonly parentIdentityValidation: 'process-liveness-only';
      readonly reason: 'parent-inspection-unavailable' | 'unsupported-platform';
      readonly source: 'none';
    };

export type CodeGraphBenchmarkSamplerTemporaryTelemetry =
  | {
      readonly availability: 'available';
      readonly maximumOpenFileDescriptors: number;
      readonly maximumProcesses: number;
      readonly openFileSampleIntervalMilliseconds: number;
      readonly projectionByteLimit?: number;
      readonly scope: 'temporary-root-linked-plus-process-tree-open-files';
      readonly source: 'darwin-lsof' | 'linux-proc-fd';
    }
  | {
      readonly availability: 'unavailable';
      readonly reason: 'open-file-inspection-unavailable' | 'unsupported-platform';
      readonly scope: 'temporary-root-linked-files-only';
      readonly source: 'directory-walk';
    };

export interface CodeGraphBenchmarkSamplerArtifact {
  readonly intervalMilliseconds: number;
  readonly phases: Readonly<Record<string, CodeGraphBenchmarkSamplerPhase>>;
  readonly platform: string;
  readonly processTelemetry: CodeGraphBenchmarkSamplerProcessTelemetry;
  readonly samples: number;
  readonly temporaryTelemetry?: CodeGraphBenchmarkSamplerTemporaryTelemetry;
  readonly version: 2 | 3 | 4;
}

export interface CodeGraphBenchmarkSamplerCheckpoint {
  readonly sampler: CodeGraphBenchmarkSamplerArtifact;
  readonly state: 'aborted' | 'complete' | 'parent-exited' | 'running';
  readonly updatedAt: string;
  readonly version: 2 | 3 | 4;
}

export function parseCodeGraphBenchmarkSamplerArtifact(value: unknown): CodeGraphBenchmarkSamplerArtifact {
  if (typeof value !== 'object' || value === null) throw new Error('Benchmark sampler artifact must be an object.');
  const artifact = value as Partial<CodeGraphBenchmarkSamplerArtifact>;
  if (
    (artifact.version !== 2 && artifact.version !== 3 && artifact.version !== 4) ||
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
  const processTelemetry = parseSamplerProcessTelemetry(artifact.platform, artifact.processTelemetry, artifact.version);
  const temporaryTelemetry = parseSamplerTemporaryTelemetry(
    artifact.platform,
    artifact.temporaryTelemetry,
    artifact.version,
  );
  let phaseSamples = 0;
  for (const [phase, sample] of Object.entries(artifact.phases)) {
    if (!phase || !isSamplerPhase(sample, processTelemetry, temporaryTelemetry, artifact.version)) {
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
    (checkpoint.version !== 2 && checkpoint.version !== 3 && checkpoint.version !== 4) ||
    !['aborted', 'complete', 'parent-exited', 'running'].includes(checkpoint.state ?? '') ||
    typeof checkpoint.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(checkpoint.updatedAt))
  ) {
    throw new Error('Benchmark sampler checkpoint is invalid.');
  }
  const sampler = parseCodeGraphBenchmarkSamplerArtifact(checkpoint.sampler);
  if (sampler.version !== checkpoint.version) throw new Error('Benchmark sampler checkpoint version is inconsistent.');
  return checkpoint as CodeGraphBenchmarkSamplerCheckpoint;
}

function parseSamplerProcessTelemetry(
  platform: string,
  value: unknown,
  version: CodeGraphBenchmarkSamplerArtifact['version'],
): CodeGraphBenchmarkSamplerProcessTelemetry {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Benchmark sampler process telemetry must be an object.');
  }
  const telemetry = value as Partial<CodeGraphBenchmarkSamplerProcessTelemetry>;
  if (telemetry.availability === 'available') {
    const legacyLinux =
      version === 2 &&
      platform === 'linux' &&
      telemetry.parentIdentityValidation === 'linux-proc-starttime' &&
      telemetry.source === 'linux-proc' &&
      telemetry.scope === undefined &&
      telemetry.sampleIntervalMilliseconds === undefined &&
      telemetry.ioCounters === undefined;
    const linuxTree =
      version >= 3 &&
      platform === 'linux' &&
      telemetry.parentIdentityValidation === 'linux-proc-starttime' &&
      telemetry.source === 'linux-proc' &&
      telemetry.scope === 'recursive-process-tree' &&
      telemetry.ioCounters === 'linux-proc-read-write-bytes';
    const darwinTree =
      version >= 3 &&
      platform === 'darwin' &&
      telemetry.parentIdentityValidation === 'darwin-ps-lstart' &&
      telemetry.source === 'darwin-ps' &&
      telemetry.scope === 'recursive-process-tree' &&
      telemetry.ioCounters === undefined;
    if (
      (legacyLinux || linuxTree || darwinTree) &&
      (version === 2 ||
        (Number.isSafeInteger(telemetry.sampleIntervalMilliseconds) &&
          Number(telemetry.sampleIntervalMilliseconds) >= 10))
    ) {
      return telemetry as CodeGraphBenchmarkSamplerProcessTelemetry;
    }
  }
  const expectedReason =
    platform === 'linux' || (version >= 3 && platform === 'darwin')
      ? 'parent-inspection-unavailable'
      : 'unsupported-platform';
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

function parseSamplerTemporaryTelemetry(
  platform: string,
  value: unknown,
  version: CodeGraphBenchmarkSamplerArtifact['version'],
): CodeGraphBenchmarkSamplerTemporaryTelemetry | undefined {
  if (version < 4) {
    if (value !== undefined) throw new Error('Legacy benchmark sampler temporary telemetry must be omitted.');
    return undefined;
  }
  if (typeof value !== 'object' || value === null) {
    throw new Error('Benchmark sampler temporary telemetry must be an object.');
  }
  const telemetry = value as Partial<CodeGraphBenchmarkSamplerTemporaryTelemetry>;
  if (
    telemetry.availability === 'available' &&
    telemetry.scope === 'temporary-root-linked-plus-process-tree-open-files' &&
    ((platform === 'linux' && telemetry.source === 'linux-proc-fd') ||
      (platform === 'darwin' && telemetry.source === 'darwin-lsof')) &&
    Number.isSafeInteger(telemetry.openFileSampleIntervalMilliseconds) &&
    Number(telemetry.openFileSampleIntervalMilliseconds) >= 10 &&
    Number.isSafeInteger(telemetry.maximumOpenFileDescriptors) &&
    Number(telemetry.maximumOpenFileDescriptors) >= 1 &&
    Number.isSafeInteger(telemetry.maximumProcesses) &&
    Number(telemetry.maximumProcesses) >= 1 &&
    (telemetry.source === 'darwin-lsof'
      ? Number.isSafeInteger(telemetry.projectionByteLimit) && Number(telemetry.projectionByteLimit) >= 1
      : telemetry.projectionByteLimit === undefined)
  ) {
    return telemetry as CodeGraphBenchmarkSamplerTemporaryTelemetry;
  }
  const expectedReason =
    platform === 'linux' || platform === 'darwin' ? 'open-file-inspection-unavailable' : 'unsupported-platform';
  if (
    telemetry.availability === 'unavailable' &&
    telemetry.reason === expectedReason &&
    telemetry.scope === 'temporary-root-linked-files-only' &&
    telemetry.source === 'directory-walk'
  ) {
    return telemetry as CodeGraphBenchmarkSamplerTemporaryTelemetry;
  }
  throw new Error('Benchmark sampler temporary telemetry does not match its platform.');
}

function isSamplerPhase(
  value: unknown,
  processTelemetry: CodeGraphBenchmarkSamplerProcessTelemetry,
  temporaryTelemetry: CodeGraphBenchmarkSamplerTemporaryTelemetry | undefined,
  version: CodeGraphBenchmarkSamplerArtifact['version'],
): value is CodeGraphBenchmarkSamplerPhase {
  if (typeof value !== 'object' || value === null) return false;
  const sample = value as Partial<CodeGraphBenchmarkSamplerPhase>;
  const byteCounts = [sample.databasePeakBytes, sample.shmPeakBytes, sample.temporaryPeakBytes, sample.walPeakBytes];
  const processTelemetryValid =
    processTelemetry.availability === 'available'
      ? typeof sample.cpuMilliseconds === 'number' &&
        Number.isFinite(sample.cpuMilliseconds) &&
        sample.cpuMilliseconds >= 0 &&
        Number.isSafeInteger(sample.rssPeakBytes) &&
        Number(sample.rssPeakBytes) >= 0 &&
        (version === 2 ||
          (Number.isSafeInteger(sample.processPeakCount) &&
            Number(sample.processPeakCount) >= 0 &&
            Number.isSafeInteger(sample.processSamples) &&
            Number(sample.processSamples) >= 0 &&
            (Number(sample.processSamples) === 0 || Number(sample.processPeakCount) >= 1) &&
            (processTelemetry.source === 'linux-proc'
              ? Number.isSafeInteger(sample.ioReadBytes) &&
                Number(sample.ioReadBytes) >= 0 &&
                Number.isSafeInteger(sample.ioWriteBytes) &&
                Number(sample.ioWriteBytes) >= 0
              : sample.ioReadBytes === undefined && sample.ioWriteBytes === undefined)))
      : sample.cpuMilliseconds === undefined &&
        sample.ioReadBytes === undefined &&
        sample.ioWriteBytes === undefined &&
        sample.processPeakCount === undefined &&
        sample.processSamples === undefined &&
        sample.rssPeakBytes === undefined;
  const temporaryTelemetryValid =
    version < 4
      ? sample.temporaryLinkedPeakBytes === undefined &&
        sample.temporaryOpenAttempts === undefined &&
        sample.temporaryOpenFailures === undefined &&
        sample.temporaryOpenPeakBytes === undefined &&
        sample.temporaryOpenSamples === undefined
      : Number.isSafeInteger(sample.temporaryLinkedPeakBytes) &&
        Number(sample.temporaryLinkedPeakBytes) >= 0 &&
        (temporaryTelemetry?.availability === 'available'
          ? Number.isSafeInteger(sample.temporaryOpenAttempts) &&
            Number(sample.temporaryOpenAttempts) >= 0 &&
            Number.isSafeInteger(sample.temporaryOpenFailures) &&
            Number(sample.temporaryOpenFailures) >= 0 &&
            Number.isSafeInteger(sample.temporaryOpenPeakBytes) &&
            Number(sample.temporaryOpenPeakBytes) >= 0 &&
            Number.isSafeInteger(sample.temporaryOpenSamples) &&
            Number(sample.temporaryOpenSamples) >= 0 &&
            Number(sample.temporaryOpenAttempts) ===
              Number(sample.temporaryOpenSamples) + Number(sample.temporaryOpenFailures) &&
            Number(sample.temporaryPeakBytes) >= Number(sample.temporaryLinkedPeakBytes) &&
            Number(sample.temporaryPeakBytes) >= Number(sample.temporaryOpenPeakBytes)
          : sample.temporaryOpenAttempts === undefined &&
            sample.temporaryOpenFailures === undefined &&
            sample.temporaryOpenPeakBytes === undefined &&
            sample.temporaryOpenSamples === undefined);
  const processSampleDiagnostics = [
    sample.processSampleAttempts,
    sample.processSampleFailures,
    sample.processSampleGapPeakMilliseconds,
  ];
  const processSampleDiagnosticsValid =
    processSampleDiagnostics.every(candidate => candidate === undefined) ||
    (processTelemetry.availability === 'available' &&
      processSampleDiagnostics.every(candidate => Number.isSafeInteger(candidate) && Number(candidate) >= 0) &&
      Number(sample.processSampleAttempts) === Number(sample.processSamples) + Number(sample.processSampleFailures));
  return (
    processTelemetryValid &&
    processSampleDiagnosticsValid &&
    temporaryTelemetryValid &&
    Number.isSafeInteger(sample.samples) &&
    Number(sample.samples) > 0 &&
    byteCounts.every(candidate => Number.isSafeInteger(candidate) && Number(candidate) >= 0)
  );
}

interface MutablePhase {
  cpuMilliseconds: number;
  databasePeakBytes: number;
  ioReadBytes: number;
  ioWriteBytes: number;
  processPeakCount: number;
  processSampleAttempts: number;
  processSampleFailures: number;
  processSampleGapPeakMilliseconds: number;
  processSamples: number;
  rssPeakBytes: number;
  samples: number;
  shmPeakBytes: number;
  temporaryLinkedPeakBytes: number;
  temporaryOpenAttempts: number;
  temporaryOpenFailures: number;
  temporaryOpenPeakBytes: number;
  temporaryOpenSamples: number;
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
  const canonicalTemporaryRoot = await canonicalDirectory(options.temporaryRoot);
  const clockTicksPerSecond = linuxClockTicksPerSecond();
  const processSampleIntervalMilliseconds = process.platform === 'darwin' ? 250 : options.intervalMilliseconds;
  const openFileSampleIntervalMilliseconds =
    process.platform === 'darwin' ? DARWIN_OPEN_FILE_SAMPLE_INTERVAL_MILLISECONDS : options.intervalMilliseconds;
  const initialProcessSample = await readProcessTreeSample(options.processId, clockTicksPerSecond);
  const processTelemetry = samplerProcessTelemetryContract(
    process.platform,
    initialProcessSample?.rootStartIdentity,
    processSampleIntervalMilliseconds,
  );
  const parentStartIdentity = initialProcessSample?.rootStartIdentity;
  const initialTemporaryOpenFiles = initialProcessSample
    ? await readOpenTemporaryFileSnapshot(initialProcessSample.processIds, canonicalTemporaryRoot)
    : undefined;
  const temporaryTelemetry = samplerTemporaryTelemetryContract(
    process.platform,
    initialTemporaryOpenFiles,
    openFileSampleIntervalMilliseconds,
  );
  const phases = new Map<string, MutablePhase>();
  let previousProcessSample = processTelemetry.availability === 'available' ? initialProcessSample : undefined;
  let pendingInitialProcessSample = previousProcessSample;
  let pendingInitialTemporaryOpenFiles =
    temporaryTelemetry.availability === 'available' ? initialTemporaryOpenFiles : undefined;
  let lastProcessSampleAt = Date.now();
  let lastSuccessfulProcessSampleAt = lastProcessSampleAt;
  let lastTemporaryOpenSampleAt = Date.now();
  let samples = 0;
  let lastCheckpointAt = 0;
  let readyPublished = false;
  let stopped: boolean;
  let stopState: CodeGraphBenchmarkSamplerCheckpoint['state'];
  do {
    const phase = (await readText(options.phasePath))?.trim() || 'unknown';
    const processSampleDue =
      pendingInitialProcessSample !== undefined ||
      Date.now() - lastProcessSampleAt >= processSampleIntervalMilliseconds;
    const temporaryOpenSampleDue =
      pendingInitialTemporaryOpenFiles !== undefined ||
      Date.now() - lastTemporaryOpenSampleAt >= openFileSampleIntervalMilliseconds;
    const [databaseBytes, walBytes, shmBytes, temporaryLinkedFiles, observedProcessSample] = await Promise.all([
      fileBytes(options.databasePath),
      fileBytes(`${options.databasePath}-wal`),
      fileBytes(`${options.databasePath}-shm`),
      directoryFileSnapshot(canonicalTemporaryRoot),
      processSampleDue
        ? pendingInitialProcessSample !== undefined
          ? Promise.resolve(pendingInitialProcessSample)
          : readProcessTreeSample(options.processId, clockTicksPerSecond)
        : Promise.resolve(undefined),
    ]);
    const processSample = processSampleDue ? observedProcessSample : undefined;
    if (processSampleDue) {
      pendingInitialProcessSample = undefined;
      lastProcessSampleAt = Date.now();
    }
    const processForOpenSample = processSample ?? previousProcessSample;
    const temporaryOpenFiles =
      temporaryTelemetry.availability === 'available' && temporaryOpenSampleDue
        ? pendingInitialTemporaryOpenFiles !== undefined
          ? pendingInitialTemporaryOpenFiles
          : processForOpenSample
            ? await readOpenTemporaryFileSnapshot(processForOpenSample.processIds, canonicalTemporaryRoot)
            : undefined
        : undefined;
    if (temporaryOpenSampleDue) {
      pendingInitialTemporaryOpenFiles = undefined;
      lastTemporaryOpenSampleAt = Date.now();
    }
    const temporaryBytes = mergeTemporaryFileSnapshots(temporaryLinkedFiles, temporaryOpenFiles).bytes;
    const parentExists = processExists(options.processId);
    const parentExited = samplerParentExited(parentStartIdentity, processSample?.rootStartIdentity, parentExists);
    const telemetrySample = processTelemetry.availability === 'available' && !parentExited ? processSample : undefined;
    const current = phases.get(phase) ?? {
      cpuMilliseconds: 0,
      databasePeakBytes: 0,
      ioReadBytes: 0,
      ioWriteBytes: 0,
      processPeakCount: 0,
      processSampleAttempts: 0,
      processSampleFailures: 0,
      processSampleGapPeakMilliseconds: 0,
      processSamples: 0,
      rssPeakBytes: 0,
      samples: 0,
      shmPeakBytes: 0,
      temporaryLinkedPeakBytes: 0,
      temporaryOpenAttempts: 0,
      temporaryOpenFailures: 0,
      temporaryOpenPeakBytes: 0,
      temporaryOpenSamples: 0,
      temporaryPeakBytes: 0,
      walPeakBytes: 0,
    };
    current.databasePeakBytes = Math.max(current.databasePeakBytes, databaseBytes);
    current.walPeakBytes = Math.max(current.walPeakBytes, walBytes);
    current.shmPeakBytes = Math.max(current.shmPeakBytes, shmBytes);
    current.temporaryLinkedPeakBytes = Math.max(current.temporaryLinkedPeakBytes, temporaryLinkedFiles.bytes);
    if (temporaryTelemetry.availability === 'available' && temporaryOpenSampleDue) {
      const inspection = observeTemporaryOpenInspection(current, temporaryOpenFiles);
      current.temporaryOpenAttempts = inspection.attempts;
      current.temporaryOpenFailures = inspection.failures;
      current.temporaryOpenPeakBytes = inspection.peakBytes;
      current.temporaryOpenSamples = inspection.samples;
    }
    current.temporaryPeakBytes = Math.max(current.temporaryPeakBytes, temporaryBytes);
    if (processTelemetry.availability === 'available' && processSampleDue) {
      const observedAt = Date.now();
      current.processSampleAttempts += 1;
      current.processSampleGapPeakMilliseconds = Math.max(
        current.processSampleGapPeakMilliseconds,
        observedAt - lastSuccessfulProcessSampleAt,
      );
      if (telemetrySample === undefined) current.processSampleFailures += 1;
      else lastSuccessfulProcessSampleAt = observedAt;
    }
    if (telemetrySample) {
      const delta = processTreeDelta(previousProcessSample, telemetrySample);
      current.cpuMilliseconds += delta.cpuMilliseconds;
      current.ioReadBytes = safeAdd(current.ioReadBytes, delta.ioReadBytes);
      current.ioWriteBytes = safeAdd(current.ioWriteBytes, delta.ioWriteBytes);
      current.processPeakCount = Math.max(current.processPeakCount, telemetrySample.processes.size);
      current.processSamples += 1;
      current.rssPeakBytes = Math.max(current.rssPeakBytes, telemetrySample.rssBytes);
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
        samplerArtifact(options.intervalMilliseconds, phases, processTelemetry, temporaryTelemetry, samples),
        stopState,
      );
      if (!readyPublished) {
        await atomicWriteFile(options.readyPath, '{"checkpointVersion":4,"version":1}\n');
        readyPublished = true;
      }
      lastCheckpointAt = now;
    }
    if (!stopped) await Bun.sleep(options.intervalMilliseconds);
  } while (!stopped);

  const artifact = samplerArtifact(options.intervalMilliseconds, phases, processTelemetry, temporaryTelemetry, samples);
  await atomicWriteFile(options.outputPath, `${JSON.stringify(artifact)}\n`);
}

function samplerArtifact(
  intervalMilliseconds: number,
  phases: ReadonlyMap<string, MutablePhase>,
  processTelemetry: CodeGraphBenchmarkSamplerProcessTelemetry,
  temporaryTelemetry: CodeGraphBenchmarkSamplerTemporaryTelemetry,
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
              ? {
                  cpuMilliseconds: value.cpuMilliseconds,
                  ...(processTelemetry.source === 'linux-proc'
                    ? {ioReadBytes: value.ioReadBytes, ioWriteBytes: value.ioWriteBytes}
                    : {}),
                  processPeakCount: value.processPeakCount,
                  processSampleAttempts: value.processSampleAttempts,
                  processSampleFailures: value.processSampleFailures,
                  processSampleGapPeakMilliseconds: value.processSampleGapPeakMilliseconds,
                  processSamples: value.processSamples,
                  rssPeakBytes: value.rssPeakBytes,
                }
              : {};
          const temporary =
            temporaryTelemetry.availability === 'available'
              ? {
                  temporaryLinkedPeakBytes: value.temporaryLinkedPeakBytes,
                  temporaryOpenAttempts: value.temporaryOpenAttempts,
                  temporaryOpenFailures: value.temporaryOpenFailures,
                  temporaryOpenPeakBytes: value.temporaryOpenPeakBytes,
                  temporaryOpenSamples: value.temporaryOpenSamples,
                }
              : {temporaryLinkedPeakBytes: value.temporaryLinkedPeakBytes};
          return [
            phase,
            {
              ...process,
              ...temporary,
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
    temporaryTelemetry,
    version: 4,
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
    version: sampler.version,
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

export interface BenchmarkProcessTreeEntry {
  readonly cpuMilliseconds: number;
  readonly ioReadBytes?: number;
  readonly ioWriteBytes?: number;
  readonly parentProcessId: number;
  readonly processId: number;
  readonly rssBytes: number;
  readonly startIdentity: string;
}

interface BenchmarkProcessCounters {
  readonly cpuMilliseconds: number;
  readonly ioReadBytes?: number;
  readonly ioWriteBytes?: number;
}

export interface BenchmarkProcessTreeSample {
  readonly processIds: readonly number[];
  readonly processes: ReadonlyMap<string, BenchmarkProcessCounters>;
  readonly rootStartIdentity: string;
  readonly rssBytes: number;
}

export interface BenchmarkProcessTreeDelta {
  readonly cpuMilliseconds: number;
  readonly ioReadBytes: number;
  readonly ioWriteBytes: number;
}

export function aggregateProcessTree(
  entries: readonly BenchmarkProcessTreeEntry[],
  rootProcessId: number,
  expectedRootStartIdentity?: string,
  excludedProcessId?: number,
): BenchmarkProcessTreeSample | undefined {
  const byProcessId = new Map<number, BenchmarkProcessTreeEntry>();
  for (const entry of entries) {
    if (
      !Number.isSafeInteger(entry.processId) ||
      entry.processId <= 0 ||
      !Number.isSafeInteger(entry.parentProcessId) ||
      entry.parentProcessId < 0 ||
      byProcessId.has(entry.processId) ||
      !entry.startIdentity ||
      !Number.isFinite(entry.cpuMilliseconds) ||
      entry.cpuMilliseconds < 0 ||
      !Number.isSafeInteger(entry.rssBytes) ||
      entry.rssBytes < 0 ||
      !optionalNonNegativeSafeInteger(entry.ioReadBytes) ||
      !optionalNonNegativeSafeInteger(entry.ioWriteBytes)
    ) {
      return undefined;
    }
    byProcessId.set(entry.processId, entry);
  }
  const root = byProcessId.get(rootProcessId);
  if (!root || (expectedRootStartIdentity !== undefined && root.startIdentity !== expectedRootStartIdentity)) {
    return undefined;
  }
  const children = new Map<number, number[]>();
  for (const entry of entries) {
    const siblings = children.get(entry.parentProcessId) ?? [];
    siblings.push(entry.processId);
    children.set(entry.parentProcessId, siblings);
  }
  const pending = [rootProcessId];
  const visited = new Set<number>();
  const processes = new Map<string, BenchmarkProcessCounters>();
  let rssBytes = 0;
  while (pending.length > 0) {
    const processId = pending.shift();
    if (processId === undefined || visited.has(processId)) continue;
    if (processId === excludedProcessId) continue;
    visited.add(processId);
    const entry = byProcessId.get(processId);
    if (!entry) continue;
    processes.set(`${entry.processId}:${entry.startIdentity}`, {
      cpuMilliseconds: entry.cpuMilliseconds,
      ioReadBytes: entry.ioReadBytes,
      ioWriteBytes: entry.ioWriteBytes,
    });
    rssBytes = safeAdd(rssBytes, entry.rssBytes);
    pending.push(...(children.get(processId) ?? []));
  }
  return {processIds: [...visited], processes, rootStartIdentity: root.startIdentity, rssBytes};
}

export function processTreeDelta(
  previous: BenchmarkProcessTreeSample | undefined,
  current: BenchmarkProcessTreeSample,
): BenchmarkProcessTreeDelta {
  let cpuMilliseconds = 0;
  let ioReadBytes = 0;
  let ioWriteBytes = 0;
  for (const [identity, counters] of current.processes) {
    const before = previous?.processes.get(identity);
    const beforeCpuMilliseconds = before?.cpuMilliseconds ?? (previous === undefined ? counters.cpuMilliseconds : 0);
    cpuMilliseconds = Math.min(
      Number.MAX_SAFE_INTEGER,
      cpuMilliseconds + Math.max(0, counters.cpuMilliseconds - beforeCpuMilliseconds),
    );
    if (counters.ioReadBytes !== undefined) {
      const beforeReadBytes = before?.ioReadBytes ?? (previous === undefined ? counters.ioReadBytes : 0);
      ioReadBytes = safeAdd(ioReadBytes, Math.max(0, counters.ioReadBytes - beforeReadBytes));
    }
    if (counters.ioWriteBytes !== undefined) {
      const beforeWriteBytes = before?.ioWriteBytes ?? (previous === undefined ? counters.ioWriteBytes : 0);
      ioWriteBytes = safeAdd(ioWriteBytes, Math.max(0, counters.ioWriteBytes - beforeWriteBytes));
    }
  }
  return {cpuMilliseconds, ioReadBytes, ioWriteBytes};
}

async function readProcessTreeSample(
  processId: number,
  clockTicksPerSecond: number,
): Promise<BenchmarkProcessTreeSample | undefined> {
  if (process.platform === 'linux') return readLinuxProcessTreeSample(processId, clockTicksPerSecond, process.pid);
  if (process.platform === 'darwin') return readDarwinProcessTreeSample(processId, process.pid);
  return undefined;
}

interface LinuxProcessEntryRead {
  readonly childProcessIds: readonly number[];
  readonly entry: BenchmarkProcessTreeEntry;
}

async function readLinuxProcessTreeSample(
  rootProcessId: number,
  clockTicksPerSecond: number,
  excludedProcessId: number,
): Promise<BenchmarkProcessTreeSample | undefined> {
  const pending: Array<{readonly expectedParent?: number; readonly processId: number}> = [{processId: rootProcessId}];
  const entries: BenchmarkProcessTreeEntry[] = [];
  const visited = new Set<number>();
  while (pending.length > 0) {
    const next = pending.shift();
    if (!next || visited.has(next.processId)) continue;
    visited.add(next.processId);
    const observed = await readLinuxProcessEntry(next.processId, clockTicksPerSecond);
    if (!observed || (next.expectedParent !== undefined && observed.entry.parentProcessId !== next.expectedParent)) {
      continue;
    }
    entries.push(observed.entry);
    pending.push(...observed.childProcessIds.map(processId => ({expectedParent: observed.entry.processId, processId})));
  }
  return aggregateProcessTree(entries, rootProcessId, undefined, excludedProcessId);
}

async function readLinuxProcessEntry(
  processId: number,
  clockTicksPerSecond: number,
): Promise<LinuxProcessEntryRead | undefined> {
  try {
    const firstStatText = await readFile(`/proc/${processId}/stat`, 'utf8');
    const firstStat = parseLinuxProcessStat(firstStatText);
    if (!firstStat) return undefined;
    const [statusText, ioText, childrenText, validatedStatText] = await Promise.all([
      readFile(`/proc/${processId}/status`, 'utf8'),
      readText(`/proc/${processId}/io`),
      readText(`/proc/${processId}/task/${processId}/children`),
      readFile(`/proc/${processId}/stat`, 'utf8'),
    ]);
    const validatedStat = parseLinuxProcessStat(validatedStatText);
    if (!validatedStat || validatedStat.startIdentity !== firstStat.startIdentity) return undefined;
    const rssMatch = /^VmRSS:\s+(\d+)\s+kB$/m.exec(statusText);
    const rssKilobytes = Number(rssMatch?.[1]);
    if (!rssMatch || !Number.isSafeInteger(rssKilobytes) || rssKilobytes < 0) return undefined;
    const io = ioText === undefined ? undefined : parseLinuxProcessIo(ioText);
    return {
      childProcessIds: parseLinuxChildProcessIds(childrenText ?? ''),
      entry: {
        cpuMilliseconds: ((validatedStat.userTicks + validatedStat.systemTicks) * 1_000) / clockTicksPerSecond,
        ioReadBytes: io?.readBytes,
        ioWriteBytes: io?.writeBytes,
        parentProcessId: validatedStat.parentProcessId,
        processId,
        rssBytes: rssKilobytes * 1024,
        startIdentity: validatedStat.startIdentity,
      },
    };
  } catch {
    return undefined;
  }
}

function parseLinuxChildProcessIds(text: string): readonly number[] {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter(candidate => Number.isSafeInteger(candidate) && candidate > 0);
}

export function parseLinuxProcessIo(
  ioText: string,
): {readonly readBytes: number; readonly writeBytes: number} | undefined {
  const readBytes = Number(/^read_bytes:\s+(\d+)$/m.exec(ioText)?.[1]);
  const writeBytes = Number(/^write_bytes:\s+(\d+)$/m.exec(ioText)?.[1]);
  if (!Number.isSafeInteger(readBytes) || readBytes < 0 || !Number.isSafeInteger(writeBytes) || writeBytes < 0) {
    return undefined;
  }
  return {readBytes, writeBytes};
}

async function readDarwinProcessTreeSample(
  rootProcessId: number,
  excludedProcessId: number,
): Promise<BenchmarkProcessTreeSample | undefined> {
  try {
    const result = Bun.spawnSync({
      cmd: ['/bin/ps', '-axo', 'pid=,ppid=,lstart=,time=,rss='],
      env: {LC_ALL: 'C'},
      stderr: 'ignore',
    });
    if (result.exitCode !== 0) return undefined;
    return aggregateProcessTree(
      parseDarwinProcessList(new TextDecoder().decode(result.stdout)),
      rootProcessId,
      undefined,
      excludedProcessId,
    );
  } catch {
    return undefined;
  }
}

export function parseDarwinProcessList(output: string): readonly BenchmarkProcessTreeEntry[] {
  return output
    .split(/\r?\n/)
    .map(parseDarwinProcessLine)
    .filter((entry): entry is BenchmarkProcessTreeEntry => entry !== undefined);
}

function parseDarwinProcessLine(line: string): BenchmarkProcessTreeEntry | undefined {
  const fields = line.trim().split(/\s+/);
  if (fields.length !== 9) return undefined;
  const processId = Number(fields[0]);
  const parentProcessId = Number(fields[1]);
  const cpuMilliseconds = parseProcessCpuTime(fields[7] ?? '');
  const rssKilobytes = Number(fields[8]);
  const startIdentity = fields.slice(2, 7).join(' ');
  if (
    !Number.isSafeInteger(processId) ||
    processId <= 0 ||
    !Number.isSafeInteger(parentProcessId) ||
    parentProcessId < 0 ||
    cpuMilliseconds === undefined ||
    !Number.isSafeInteger(rssKilobytes) ||
    rssKilobytes < 0 ||
    !/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(startIdentity)
  ) {
    return undefined;
  }
  return {cpuMilliseconds, parentProcessId, processId, rssBytes: rssKilobytes * 1024, startIdentity};
}

export function parseProcessCpuTime(value: string): number | undefined {
  const [dayText, clockText] = value.includes('-') ? value.split('-', 2) : [undefined, value];
  const parts = clockText?.split(':') ?? [];
  if (parts.length !== 2 && parts.length !== 3) return undefined;
  const days = dayText === undefined ? 0 : Number(dayText);
  const hours = parts.length === 3 ? Number(parts[0]) : 0;
  const minutes = Number(parts.at(-2));
  const seconds = Number(parts.at(-1));
  if (
    (dayText !== undefined && parts.length !== 3) ||
    !Number.isSafeInteger(days) ||
    days < 0 ||
    !Number.isSafeInteger(hours) ||
    hours < 0 ||
    !Number.isSafeInteger(minutes) ||
    minutes < 0 ||
    (parts.length === 3 && minutes >= 60) ||
    !Number.isFinite(seconds) ||
    seconds < 0 ||
    seconds >= 60
  ) {
    return undefined;
  }
  const milliseconds = Math.round((((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1_000);
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

export function parseLinuxProcessStat(statText: string):
  | {
      readonly parentProcessId: number;
      readonly startIdentity: string;
      readonly systemTicks: number;
      readonly userTicks: number;
    }
  | undefined {
  const closing = statText.lastIndexOf(')');
  if (closing < 0) return undefined;
  const fields = statText
    .slice(closing + 2)
    .trim()
    .split(/\s+/);
  const userTicksText = fields[11];
  const systemTicksText = fields[12];
  const startIdentity = fields[19];
  const parentProcessIdText = fields[1];
  if (
    parentProcessIdText === undefined ||
    !/^\d+$/.test(parentProcessIdText) ||
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
  const parentProcessId = Number(parentProcessIdText);
  if (
    !Number.isSafeInteger(parentProcessId) ||
    !Number.isSafeInteger(userTicks) ||
    !Number.isSafeInteger(systemTicks)
  ) {
    return undefined;
  }
  return {parentProcessId, startIdentity, systemTicks, userTicks};
}

export function samplerProcessTelemetryContract(
  platform: string,
  parentStartIdentity: string | undefined,
  sampleIntervalMilliseconds = 25,
): CodeGraphBenchmarkSamplerProcessTelemetry {
  if (platform === 'linux' && parentStartIdentity !== undefined) {
    return {
      availability: 'available',
      ioCounters: 'linux-proc-read-write-bytes',
      parentIdentityValidation: 'linux-proc-starttime',
      sampleIntervalMilliseconds,
      scope: 'recursive-process-tree',
      source: 'linux-proc',
    };
  }
  if (platform === 'darwin' && parentStartIdentity !== undefined) {
    return {
      availability: 'available',
      parentIdentityValidation: 'darwin-ps-lstart',
      sampleIntervalMilliseconds,
      scope: 'recursive-process-tree',
      source: 'darwin-ps',
    };
  }
  return {
    availability: 'unavailable',
    parentIdentityValidation: 'process-liveness-only',
    reason: platform === 'linux' || platform === 'darwin' ? 'parent-inspection-unavailable' : 'unsupported-platform',
    source: 'none',
  };
}

export interface BenchmarkTemporaryFileSnapshot {
  readonly bytes: number;
  readonly files: ReadonlyMap<string, number>;
}

export interface BenchmarkTemporaryOpenInspection {
  readonly attempts: number;
  readonly failures: number;
  readonly peakBytes: number;
  readonly samples: number;
}

/** Records every scheduled inspection so missing/capped observations cannot silently pass release evidence. */
export function observeTemporaryOpenInspection(
  previous: {
    readonly temporaryOpenAttempts: number;
    readonly temporaryOpenFailures: number;
    readonly temporaryOpenPeakBytes: number;
    readonly temporaryOpenSamples: number;
  },
  observed: BenchmarkTemporaryFileSnapshot | undefined,
): BenchmarkTemporaryOpenInspection {
  return {
    attempts: previous.temporaryOpenAttempts + 1,
    failures: previous.temporaryOpenFailures + (observed === undefined ? 1 : 0),
    peakBytes: Math.max(previous.temporaryOpenPeakBytes, observed?.bytes ?? 0),
    samples: previous.temporaryOpenSamples + (observed === undefined ? 0 : 1),
  };
}

export function samplerTemporaryTelemetryContract(
  platform: string,
  initialOpenFiles: BenchmarkTemporaryFileSnapshot | undefined,
  sampleIntervalMilliseconds = 25,
): CodeGraphBenchmarkSamplerTemporaryTelemetry {
  if ((platform === 'linux' || platform === 'darwin') && initialOpenFiles !== undefined) {
    return {
      availability: 'available',
      maximumOpenFileDescriptors: MAX_OPEN_FILE_DESCRIPTORS,
      maximumProcesses: MAX_OPEN_FILE_PROCESSES,
      openFileSampleIntervalMilliseconds: sampleIntervalMilliseconds,
      ...(platform === 'darwin' ? {projectionByteLimit: MAX_DARWIN_LSOF_BYTES} : {}),
      scope: 'temporary-root-linked-plus-process-tree-open-files',
      source: platform === 'linux' ? 'linux-proc-fd' : 'darwin-lsof',
    };
  }
  return {
    availability: 'unavailable',
    reason: platform === 'linux' || platform === 'darwin' ? 'open-file-inspection-unavailable' : 'unsupported-platform',
    scope: 'temporary-root-linked-files-only',
    source: 'directory-walk',
  };
}

export function mergeTemporaryFileSnapshots(
  linked: BenchmarkTemporaryFileSnapshot,
  open: BenchmarkTemporaryFileSnapshot | undefined,
): BenchmarkTemporaryFileSnapshot {
  if (open === undefined) return linked;
  const files = new Map(linked.files);
  for (const [identity, bytes] of open.files) files.set(identity, Math.max(files.get(identity) ?? 0, bytes));
  return temporaryFileSnapshot(files);
}

export function isOpenTemporaryFilePath(target: string, canonicalTemporaryRoot: string): boolean {
  const withoutDeletedMarker = target.endsWith(' (deleted)') ? target.slice(0, -' (deleted)'.length) : target;
  if (!isAbsolute(withoutDeletedMarker)) return false;
  const candidate = resolve(withoutDeletedMarker);
  const relativePath = relative(canonicalTemporaryRoot, candidate);
  const belongsToTemporaryRoot =
    relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
  return belongsToTemporaryRoot || /^etilqs_[a-z0-9]+$/i.test(basename(candidate));
}

export function parseDarwinOpenFileList(
  output: string,
  processIds: readonly number[],
  rootProcessId: number,
  canonicalTemporaryRoot: string,
): BenchmarkTemporaryFileSnapshot | undefined {
  const expectedProcessIds = new Set(processIds);
  const files = new Map<string, number>();
  let descriptorCount = 0;
  let currentProcessId: number | undefined;
  let observedRoot = false;
  let currentFile:
    | {
        device?: string;
        inode?: string;
        name?: string;
        size?: string;
        type?: string;
      }
    | undefined;
  const finishFile = () => {
    if (
      currentProcessId === undefined ||
      !expectedProcessIds.has(currentProcessId) ||
      currentFile?.type !== 'REG' ||
      currentFile.name === undefined ||
      !isOpenTemporaryFilePath(currentFile.name, canonicalTemporaryRoot)
    ) {
      currentFile = undefined;
      return;
    }
    const size = parseSafeByteCount(currentFile.size);
    const device = parseDarwinDevice(currentFile.device);
    const inode = currentFile.inode;
    if (size === undefined || device === undefined || inode === undefined || !/^\d+$/.test(inode)) {
      currentFile = undefined;
      return;
    }
    const identity = `${device}:${inode}`;
    files.set(identity, Math.max(files.get(identity) ?? 0, size));
    currentFile = undefined;
  };
  for (const rawField of output.split('\0')) {
    const field = rawField.replace(/^\n+/, '');
    if (!field) continue;
    const value = field.slice(1);
    switch (field[0]) {
      case 'p': {
        finishFile();
        const processId = Number(value);
        currentProcessId = Number.isSafeInteger(processId) && processId > 0 ? processId : undefined;
        if (currentProcessId === rootProcessId) observedRoot = true;
        break;
      }
      case 'f':
        finishFile();
        if (currentProcessId !== undefined && expectedProcessIds.has(currentProcessId)) {
          descriptorCount += 1;
          if (descriptorCount > MAX_OPEN_FILE_DESCRIPTORS) return undefined;
        }
        currentFile = {};
        break;
      case 't':
        if (currentFile) currentFile.type = value;
        break;
      case 'D':
        if (currentFile) currentFile.device = value;
        break;
      case 's':
        if (currentFile) currentFile.size = value;
        break;
      case 'i':
        if (currentFile) currentFile.inode = value;
        break;
      case 'n':
        if (currentFile) currentFile.name = value;
        break;
    }
  }
  finishFile();
  return observedRoot ? temporaryFileSnapshot(files) : undefined;
}

async function readOpenTemporaryFileSnapshot(
  processIds: readonly number[],
  canonicalTemporaryRoot: string,
): Promise<BenchmarkTemporaryFileSnapshot | undefined> {
  if (process.platform === 'linux') return readLinuxOpenTemporaryFiles(processIds, canonicalTemporaryRoot);
  if (process.platform === 'darwin') return readDarwinOpenTemporaryFiles(processIds, canonicalTemporaryRoot);
  return undefined;
}

async function readLinuxOpenTemporaryFiles(
  processIds: readonly number[],
  canonicalTemporaryRoot: string,
): Promise<BenchmarkTemporaryFileSnapshot | undefined> {
  const rootProcessId = processIds[0];
  if (rootProcessId === undefined || processIds.length > MAX_OPEN_FILE_PROCESSES) return undefined;
  const descriptors: Array<{readonly descriptorPath: string; readonly processId: number}> = [];
  for (const processId of [...new Set(processIds)]) {
    let names: readonly string[];
    try {
      names = await readdir(`/proc/${processId}/fd`);
    } catch {
      if (processId === rootProcessId) return undefined;
      continue;
    }
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      if (descriptors.length >= MAX_OPEN_FILE_DESCRIPTORS) return undefined;
      descriptors.push({descriptorPath: `/proc/${processId}/fd/${name}`, processId});
    }
  }
  const files = new Map<string, number>();
  for (let offset = 0; offset < descriptors.length; offset += 32) {
    const observed = await Promise.all(
      descriptors
        .slice(offset, offset + 32)
        .map(({descriptorPath}) => readLinuxOpenTemporaryFile(descriptorPath, canonicalTemporaryRoot)),
    );
    for (const file of observed) {
      if (file) files.set(file.identity, Math.max(files.get(file.identity) ?? 0, file.bytes));
    }
  }
  return temporaryFileSnapshot(files);
}

async function readLinuxOpenTemporaryFile(
  descriptorPath: string,
  canonicalTemporaryRoot: string,
): Promise<{readonly bytes: number; readonly identity: string} | undefined> {
  try {
    const [target, info] = await Promise.all([readlink(descriptorPath), stat(descriptorPath, {bigint: true})]);
    if (!info.isFile() || !isOpenTemporaryFilePath(target, canonicalTemporaryRoot)) return undefined;
    const bytes = safeBigIntByteCount(info.size);
    return bytes === undefined ? undefined : {bytes, identity: `${info.dev}:${info.ino}`};
  } catch {
    return undefined;
  }
}

async function readDarwinOpenTemporaryFiles(
  processIds: readonly number[],
  canonicalTemporaryRoot: string,
): Promise<BenchmarkTemporaryFileSnapshot | undefined> {
  const uniqueProcessIds = [...new Set(processIds)].filter(
    processId => Number.isSafeInteger(processId) && processId > 0,
  );
  const rootProcessId = uniqueProcessIds[0];
  if (rootProcessId === undefined || uniqueProcessIds.length > MAX_OPEN_FILE_PROCESSES) return undefined;
  try {
    const result = Bun.spawnSync({
      cmd: ['/usr/sbin/lsof', '-nP', '-a', '-p', uniqueProcessIds.join(','), '-d', '0-1048575', '-F0pftsiDn'],
      env: {LC_ALL: 'C'},
      maxBuffer: MAX_DARWIN_LSOF_BYTES,
      stderr: 'ignore',
    });
    if (
      (result.signalCode !== undefined && result.signalCode !== null) ||
      ![0, 1].includes(result.exitCode) ||
      result.stdout.byteLength >= MAX_DARWIN_LSOF_BYTES
    ) {
      return undefined;
    }
    return parseDarwinOpenFileList(
      new TextDecoder().decode(result.stdout),
      uniqueProcessIds,
      rootProcessId,
      canonicalTemporaryRoot,
    );
  } catch {
    return undefined;
  }
}

function parseDarwinDevice(value: string | undefined): string | undefined {
  if (value === undefined || !/^(?:0x[0-9a-f]+|\d+)$/i.test(value)) return undefined;
  try {
    return BigInt(value).toString();
  } catch {
    return undefined;
  }
}

function parseSafeByteCount(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  try {
    return safeBigIntByteCount(BigInt(value));
  } catch {
    return undefined;
  }
}

function safeBigIntByteCount(value: bigint): number | undefined {
  return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
}

function temporaryFileSnapshot(files: ReadonlyMap<string, number>): BenchmarkTemporaryFileSnapshot {
  let bytes = 0;
  for (const size of files.values()) bytes = safeAdd(bytes, size);
  return {bytes, files};
}

function optionalNonNegativeSafeInteger(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0);
}

function safeAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
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

async function canonicalDirectory(directory: string): Promise<string> {
  try {
    return await realpath(directory);
  } catch {
    return resolve(directory);
  }
}

async function directoryFileSnapshot(directory: string): Promise<BenchmarkTemporaryFileSnapshot> {
  const files = new Map<string, number>();
  await collectDirectoryFiles(directory, files);
  return temporaryFileSnapshot(files);
}

async function collectDirectoryFiles(directory: string, files: Map<string, number>): Promise<void> {
  try {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) {
        await collectDirectoryFiles(child, files);
      } else if (entry.isFile()) {
        const observed = await fileSnapshotEntry(child);
        if (observed) files.set(observed.identity, Math.max(files.get(observed.identity) ?? 0, observed.bytes));
      }
    }
  } catch {
    return;
  }
}

async function fileSnapshotEntry(
  file: string,
): Promise<{readonly bytes: number; readonly identity: string} | undefined> {
  try {
    const info = await stat(file, {bigint: true});
    if (!info.isFile()) return undefined;
    const bytes = safeBigIntByteCount(info.size);
    return bytes === undefined ? undefined : {bytes, identity: `${info.dev}:${info.ino}`};
  } catch {
    return undefined;
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
