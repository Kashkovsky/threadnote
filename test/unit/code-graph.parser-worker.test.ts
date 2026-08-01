import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {TestClock} from 'effect/testing';
import {Effect, FileSystem, Fiber, Layer} from 'effect';
import {
  CODE_GRAPH_PARSER_WORKER_ARGUMENT,
  CodeGraphParserPool,
  codeGraphParserPoolLayer,
  type ParserWorkerProcess,
  type ParserWorkerSpawner,
  type ParserWorkerSpawnOptions,
} from '../../src/code_graph/parser_worker.js';
import type {CodeGraphFileFacts, CodeGraphInventoryFile} from '../../src/code_graph/types.js';
import {SystemInfo, type SystemInfoShape} from '../../src/effect/system.js';

const encoder = new TextEncoder();

describe('code graph parser worker pool', () => {
  it.effect('launches the real source worker and extracts TypeScript outside the caller process', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-parser-worker-real-'});
      const pool = yield* CodeGraphParserPool;
      const result = yield* pool.extract(
        inventoryFile('src/real-worker.ts', 'export function realWorker(value: number): number { return value + 1; }'),
        home,
      );

      expect(result.degraded).toBe(false);
      expect(result.parseMilliseconds).toBeGreaterThanOrEqual(0);
      expect(result.facts.path).toBe('src/real-worker.ts');
      expect(result.facts.symbols.some(symbol => symbol.name === 'realWorker')).toBe(true);
    }).pipe(Effect.provide(parserLayer({capacity: 1})), Effect.scoped),
  );

  it.effect.prop(
    'returns the same ordered facts with one worker and a parallel pool',
    {
      names: FC.uniqueArray(FC.stringMatching(/^[a-z]{1,8}$/), {maxLength: 16, minLength: 1}),
    },
    ({names}) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-parser-worker-determinism-'});
        const files = names.map((name, index) =>
          inventoryFile(`src/${index}-${name}.ts`, `export const ${name || 'value'}${index} = ${index};`),
        );
        const serial = yield* runPool(files, home, 1, echoSpawner({delayFor: file => file.path.length % 3}));
        const parallel = yield* runPool(
          files,
          home,
          4,
          echoSpawner({delayFor: file => Math.abs(17 - file.path.length) % 3}),
        );

        expect(serial.map(result => result.facts)).toEqual(parallel.map(result => result.facts));
        expect(serial.every(result => !result.degraded)).toBe(true);
        expect(parallel.every(result => !result.degraded)).toBe(true);
      }).pipe(Effect.provide(baseLayer), Effect.scoped),
    {fastCheck: {numRuns: 30}},
  );

  it.effect('bounds concurrent parsing across independent pool layers sharing one Threadnote home', () => {
    const tracker = {active: 0, maximum: 0};
    const spawn = echoSpawner({delayFor: () => 30, tracker});
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-parser-worker-capacity-'});
      const leftFiles = Array.from({length: 5}, (_, index) =>
        inventoryFile(`left/${index}.ts`, `export const left${index} = ${index};`),
      );
      const rightFiles = Array.from({length: 5}, (_, index) =>
        inventoryFile(`right/${index}.ts`, `export const right${index} = ${index};`),
      );

      const joined = Effect.all([runPool(leftFiles, home, 2, spawn), runPool(rightFiles, home, 2, spawn)], {
        concurrency: 'unbounded',
      });
      const joinedFiber = yield* Effect.forkScoped(joined);
      yield* advanceContentionClock();
      const [left, right] = yield* Fiber.join(joinedFiber);

      expect(left).toHaveLength(leftFiles.length);
      expect(right).toHaveLength(rightFiles.length);
      expect(tracker.maximum).toBe(2);
      expect(tracker.active).toBe(0);
    }).pipe(Effect.provide(baseLayer), Effect.scoped);
  });

  it.effect('interrupts a hung worker, returns its slot, and does not retry the interrupted request', () => {
    const processes: ScriptedParserWorkerProcess[] = [];
    const spawn: ParserWorkerSpawner = () => {
      const generation = processes.length;
      const worker = new ScriptedParserWorkerProcess(request => {
        if (generation === 0) return;
        worker.respond(request, factsFor(request.file));
      });
      processes.push(worker);
      return worker;
    };

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-parser-worker-cancel-'});
      const pool = yield* CodeGraphParserPool;
      const fiber = yield* Effect.forkScoped(
        pool.extract(inventoryFile('src/hung.ts', 'export const hung = true;'), home),
      );
      yield* waitUntil(() => processes[0]?.writes.length === 1);
      yield* Fiber.interrupt(fiber);

      expect(processes).toHaveLength(1);
      expect(processes[0]!.killed).toBe(true);

      const recovered = yield* pool.extract(inventoryFile('src/recovered.ts', 'export const recovered = true;'), home);
      expect(recovered.degraded).toBe(false);
      expect(processes).toHaveLength(2);
    }).pipe(
      Effect.provide(parserLayer({capacity: 1, requestTimeoutMilliseconds: 5_000, spawnWorker: spawn})),
      Effect.scoped,
    );
  });

  it.effect('applies the request deadline to a write that never settles and retries exactly once', () => {
    const processes: ScriptedParserWorkerProcess[] = [];
    const spawn: ParserWorkerSpawner = () => {
      const worker = new ScriptedParserWorkerProcess(
        () => {},
        () => new Promise<void>(() => {}),
      );
      processes.push(worker);
      return worker;
    };

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-parser-worker-write-timeout-'});
      const pool = yield* CodeGraphParserPool;
      const result = yield* pool.extract(inventoryFile('src/write-hang.ts', 'export const writeHang = true;'), home);

      expect(result.degraded).toBe(true);
      expect(processes).toHaveLength(2);
      expect(processes.every(process => process.killed)).toBe(true);
      expect(result.facts.diagnostics.join('\n')).toContain('time budget');
    }).pipe(
      Effect.provide(parserLayer({capacity: 1, requestTimeoutMilliseconds: 20, spawnWorker: spawn})),
      Effect.scoped,
    );
  });

  it.effect('retries a malformed worker once and retries degraded files on a later request', () => {
    const processes: ScriptedParserWorkerProcess[] = [];
    const spawn: ParserWorkerSpawner = () => {
      const generation = processes.length;
      const worker = new ScriptedParserWorkerProcess(request => {
        if (generation < 2) worker.stdoutFeed.push('{malformed}\n');
        else worker.respond(request, factsFor(request.file));
      });
      processes.push(worker);
      return worker;
    };

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-parser-worker-retry-'});
      const pool = yield* CodeGraphParserPool;
      const file = inventoryFile('src/retry.ts', 'export const retry = true;');

      const degraded = yield* pool.extract(file, home);
      const recovered = yield* pool.extract(file, home);

      expect(degraded.degraded).toBe(true);
      expect(recovered.degraded).toBe(false);
      expect(processes).toHaveLength(3);
    }).pipe(Effect.provide(parserLayer({capacity: 1, spawnWorker: spawn})), Effect.scoped);
  });

  it.effect('does not retry deterministic extraction failures or leak worker stderr into persisted facts', () => {
    const processes: ScriptedParserWorkerProcess[] = [];
    const spawn: ParserWorkerSpawner = () => {
      const worker = new ScriptedParserWorkerProcess(request => {
        worker.stderrFeed.push('SUPER_SECRET_SOURCE_TEXT\n');
        worker.respondFailure(request);
      });
      processes.push(worker);
      return worker;
    };

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-parser-worker-operation-'});
      const pool = yield* CodeGraphParserPool;
      const result = yield* pool.extract(
        inventoryFile('src/operation.ts', 'export const SUPER_SECRET_SOURCE_TEXT = true;'),
        home,
      );

      expect(result.degraded).toBe(true);
      expect(processes).toHaveLength(1);
      expect(JSON.stringify(result.facts)).not.toContain('SUPER_SECRET_SOURCE_TEXT');
      expect(result.facts.diagnostics.join('\n')).toContain('language extraction failed');
    }).pipe(Effect.provide(parserLayer({capacity: 1, spawnWorker: spawn})), Effect.scoped);
  });

  it.effect('propagates each selected home and restarts a persistent slot when the home changes', () => {
    const launches: ParserWorkerSpawnOptions[] = [];
    const spawn: ParserWorkerSpawner = options => {
      launches.push(options);
      return echoProcess();
    };

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const firstHome = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-parser-worker-home-a-'});
      const secondHome = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-parser-worker-home-b-'});
      const pool = yield* CodeGraphParserPool;

      yield* pool.extract(inventoryFile('src/first.ts', 'export const first = true;'), firstHome);
      yield* pool.extract(inventoryFile('src/second.ts', 'export const second = true;'), secondHome);

      expect(launches).toHaveLength(2);
      expect(launches.map(launch => launch.environment.THREADNOTE_HOME)).toEqual([firstHome, secondHome]);
      expect(launches.every(launch => launch.arguments.at(-1) === CODE_GRAPH_PARSER_WORKER_ARGUMENT)).toBe(true);
      expect(launches.every(launch => launch.environment.THREADNOTE_CODE_GRAPH_PARSER_WORKER === '1')).toBe(true);
    }).pipe(Effect.provide(parserLayer({capacity: 1, spawnWorker: spawn})), Effect.scoped);
  });

  it.effect('evicts idle workers so a long-lived MCP runtime releases parser memory', () => {
    const processes: ScriptedParserWorkerProcess[] = [];
    const spawn: ParserWorkerSpawner = () => {
      const worker = echoProcess();
      processes.push(worker);
      return worker;
    };

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-parser-worker-idle-'});
      const pool = yield* CodeGraphParserPool;

      yield* pool.extract(inventoryFile('src/before-idle.ts', 'export const beforeIdle = true;'), home);
      yield* Effect.promise(() => new Promise(resolve => setTimeout(resolve, 40)));
      expect(processes[0]!.inputClosed).toBe(true);

      const afterIdle = yield* pool.extract(inventoryFile('src/after-idle.ts', 'export const afterIdle = true;'), home);
      expect(afterIdle.degraded).toBe(false);
      expect(processes).toHaveLength(2);
    }).pipe(Effect.provide(parserLayer({capacity: 1, idleTimeoutMilliseconds: 15, spawnWorker: spawn})), Effect.scoped);
  });

  it.effect('uses the packaged executable directly on Windows and preserves array-safe paths', () => {
    const launches: ParserWorkerSpawnOptions[] = [];
    const spawn: ParserWorkerSpawner = options => {
      launches.push(options);
      return echoProcess();
    };
    const windowsSystem = systemWith({
      executablePath: 'C:\\Program Files\\Threadnote\\threadnote.exe',
      platform: 'win32',
      processArguments: ['C:\\Program Files\\Threadnote\\threadnote.exe', 'graph', 'index'],
    });

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-parser-worker-windows-'});
      const pool = yield* CodeGraphParserPool;
      const result = yield* pool.extract(inventoryFile('src/windows.ts', 'export const windows = true;'), home);

      expect(result.degraded).toBe(false);
      expect(launches).toHaveLength(1);
      expect(launches[0]!.executable).toBe('C:\\Program Files\\Threadnote\\threadnote.exe');
      expect(launches[0]!.arguments).toEqual([CODE_GRAPH_PARSER_WORKER_ARGUMENT]);
    }).pipe(
      Effect.provide(parserLayer({capacity: 1, spawnWorker: spawn}, Layer.succeed(SystemInfo, windowsSystem))),
      Effect.scoped,
    );
  });
});

function runPool(
  files: readonly CodeGraphInventoryFile[],
  home: string,
  capacity: number,
  spawnWorker: ParserWorkerSpawner,
) {
  return Effect.gen(function* () {
    const pool = yield* CodeGraphParserPool;
    return yield* Effect.forEach(files, file => pool.extract(file, home), {concurrency: 'unbounded'});
  }).pipe(Effect.provide(parserLayer({capacity, spawnWorker})));
}

const baseLayer = Layer.mergeAll(BunServices.layer, SystemInfo.layer);

function parserLayer(
  options: Parameters<typeof codeGraphParserPoolLayer>[0],
  systemLayer: Layer.Layer<SystemInfo> = SystemInfo.layer,
) {
  const dependencies = Layer.mergeAll(BunServices.layer, systemLayer);
  return codeGraphParserPoolLayer(options).pipe(Layer.provideMerge(dependencies));
}

function inventoryFile(path: string, content: string): CodeGraphInventoryFile {
  return {
    blobId: `blob-${path}`,
    content,
    contentHash: Bun.hash(content).toString(16),
    language: 'typescript',
    mode: '100644',
    path,
    size: encoder.encode(content).byteLength,
    source: 'commit',
  };
}

function factsFor(file: CodeGraphInventoryFile): CodeGraphFileFacts {
  const name = file.path.split('/').at(-1) ?? file.path;
  return {
    diagnostics: [],
    edges: [],
    path: file.path,
    symbols: [
      {
        contentHash: file.contentHash,
        exported: true,
        id: `symbol-${file.contentHash}`,
        kind: 'module',
        language: file.language,
        name,
        path: file.path,
        qualifiedName: file.path,
        span: {column: 1, endColumn: 1, endLine: 1, line: 1},
      },
    ],
  };
}

interface WireRequest {
  readonly file: CodeGraphInventoryFile;
  readonly id: string;
  readonly protocol: number;
}

class ScriptedParserWorkerProcess implements ParserWorkerProcess {
  readonly stderrFeed = new AsyncFeed<string | Uint8Array>();
  readonly stdoutFeed = new AsyncFeed<string | Uint8Array>();
  readonly stderr = this.stderrFeed;
  readonly stdout = this.stdoutFeed;
  readonly writes: WireRequest[] = [];
  readonly exited: Promise<number>;
  inputClosed = false;
  killed = false;
  private resolveExit = (_code: number) => {};

  constructor(
    private readonly onWrite: (request: WireRequest) => void,
    private readonly writeImplementation?: (line: string) => Promise<void> | void,
  ) {
    this.exited = new Promise(resolve => {
      this.resolveExit = resolve;
    });
  }

  closeInput(): void {
    this.inputClosed = true;
    this.stderrFeed.end();
    this.stdoutFeed.end();
    this.resolveExit(0);
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.stderrFeed.end();
    this.stdoutFeed.end();
    this.resolveExit(137);
  }

  respond(request: WireRequest, facts: CodeGraphFileFacts): void {
    this.stdoutFeed.push(
      `${JSON.stringify({facts, id: request.id, ok: true, parseMilliseconds: 1, protocol: request.protocol})}\n`,
    );
  }

  respondFailure(request: WireRequest): void {
    this.stdoutFeed.push(
      `${JSON.stringify({
        error: {summary: 'Language extraction failed.'},
        id: request.id,
        ok: false,
        protocol: request.protocol,
      })}\n`,
    );
  }

  write(line: string): Promise<void> | void {
    const request = JSON.parse(line) as WireRequest;
    this.writes.push(request);
    const written = this.writeImplementation?.(line);
    if (written instanceof Promise) return written;
    this.onWrite(request);
  }
}

class AsyncFeed<A> implements AsyncIterable<A> {
  private ended = false;
  private readonly queued: A[] = [];
  private readonly waiters: Array<(result: IteratorResult<A>) => void> = [];

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({done: true, value: undefined});
  }

  push(value: A): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({done: false, value});
    else this.queued.push(value);
  }

  [Symbol.asyncIterator](): AsyncIterator<A> {
    return {
      next: () => {
        const value = this.queued.shift();
        if (value !== undefined) return Promise.resolve({done: false, value});
        if (this.ended) return Promise.resolve({done: true, value: undefined});
        return new Promise(resolve => this.waiters.push(resolve));
      },
    };
  }
}

function echoProcess(options: {readonly delay?: number; readonly tracker?: ConcurrencyTracker} = {}) {
  const worker = new ScriptedParserWorkerProcess(request => {
    if (options.tracker) startTrackedRequest(options.tracker);
    setTimeout(() => {
      if (options.tracker) finishTrackedRequest(options.tracker);
      worker.respond(request, factsFor(request.file));
    }, options.delay ?? 0);
  });
  return worker;
}

interface ConcurrencyTracker {
  active: number;
  maximum: number;
}

function echoSpawner(options: {
  readonly delayFor: (file: CodeGraphInventoryFile) => number;
  readonly tracker?: ConcurrencyTracker;
}): ParserWorkerSpawner {
  return () => {
    const worker = new ScriptedParserWorkerProcess(request => {
      if (options.tracker) startTrackedRequest(options.tracker);
      setTimeout(() => {
        if (options.tracker) finishTrackedRequest(options.tracker);
        worker.respond(request, factsFor(request.file));
      }, options.delayFor(request.file));
    });
    return worker;
  };
}

function startTrackedRequest(tracker: ConcurrencyTracker): void {
  tracker.active += 1;
  tracker.maximum = Math.max(tracker.maximum, tracker.active);
}

function finishTrackedRequest(tracker: ConcurrencyTracker): void {
  tracker.active -= 1;
}

function waitUntil(predicate: () => boolean): Effect.Effect<void> {
  return Effect.promise(async () => {
    while (!predicate()) await new Promise(resolve => setTimeout(resolve, 1));
  });
}

function advanceContentionClock(): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (let index = 0; index < 20; index += 1) {
      yield* Effect.promise(() => new Promise(resolve => setTimeout(resolve, 20)));
      yield* TestClock.adjust(25);
    }
  });
}

function systemWith(overrides: Partial<SystemInfoShape>): SystemInfoShape {
  const current = Effect.runSync(SystemInfo.pipe(Effect.provide(SystemInfo.layer)));
  return SystemInfo.of({...current, ...overrides});
}
