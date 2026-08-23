import {TestError} from '../helpers/test-error.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {TestClock} from 'effect/testing';
import {Effect, FileSystem, Fiber, Layer} from 'effect';
import {cachedCodeGraphFactBytes, CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM} from '../../src/code_graph/fact_budget.js';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '../../src/code_graph/languages/registry.js';
import {
  CODE_GRAPH_PARSER_RSS_BYTES_ENV,
  CODE_GRAPH_PARSER_SOURCE_BYTES_MAXIMUM,
  CODE_GRAPH_PARSER_WORKER_RESPONSE_BYTES_MAXIMUM,
  CODE_GRAPH_PARSER_WORKER_ARGUMENT,
  CodeGraphParserPool,
  budgetParserWorkerFacts,
  codeGraphParserPoolLayer,
  parserWorkerCapacity,
  parserWorkerResourceBudget,
  parserWorkerSourceByteBudget,
  parserWorkerSuccessResponseBytes,
  type ParserWorkerProcess,
  type ParserWorkerSpawner,
  type ParserWorkerSpawnOptions,
} from '../../src/code_graph/parser_worker.js';
import {TreeSitterRuntime} from '../../src/code_graph/tree_sitter/runtime.js';
import type {CodeGraphFileFacts, CodeGraphInventoryFile} from '../../src/code_graph/types.js';
import {SystemInfo, type SystemInfoShape} from '../../src/effect/system.js';

const encoder = new TextEncoder();

describe('code graph parser worker pool', () => {
  it.each([
    [8, 1],
    [16, 2],
    [32, 4],
    [64, 4],
  ])('selects %i GiB as %i automatic parser worker(s)', (memoryGiB, expected) => {
    expect(
      parserWorkerCapacity({
        effectiveMemoryBytes: memoryGiB * 1_024 * 1_024 * 1_024,
        environment: {},
        hardwareConcurrency: 16,
      }),
    ).toBe(expected);
  });

  it.prop(
    'keeps automatic parser capacity bounded and monotonic with effective memory',
    {
      hardwareConcurrency: FC.integer({max: 64, min: 1}),
      memoryGiB: FC.integer({max: 128, min: 1}),
    },
    ({hardwareConcurrency, memoryGiB}) => {
      const capacity = (effectiveMemoryGiB: number) =>
        parserWorkerCapacity({
          effectiveMemoryBytes: effectiveMemoryGiB * 1_024 * 1_024 * 1_024,
          environment: {},
          hardwareConcurrency,
        });
      expect(capacity(memoryGiB)).toBeGreaterThanOrEqual(1);
      expect(capacity(memoryGiB)).toBeLessThanOrEqual(4);
      expect(capacity(memoryGiB + 1)).toBeGreaterThanOrEqual(capacity(memoryGiB));
    },
    {fastCheck: {numRuns: 100}},
  );

  it.prop(
    'classifies parser allocation and RSS at inclusive resource boundaries',
    {
      allocationIncrease: FC.integer({max: 2_048, min: 0}),
      allocationMaximum: FC.integer({max: 2_048, min: 1}),
      beforePeak: FC.integer({max: 2_048, min: 0}),
      rssMaximum: FC.integer({max: 4_096, min: 1}),
      rssNow: FC.integer({max: 4_096, min: 0}),
    },
    ({allocationIncrease, allocationMaximum, beforePeak, rssMaximum, rssNow}) => {
      const afterPeak = beforePeak + allocationIncrease;
      const result = parserWorkerResourceBudget(
        {peakRssBytes: beforePeak, rssBytes: beforePeak},
        {peakRssBytes: afterPeak, rssBytes: rssNow},
        {maximumAllocationBytes: allocationMaximum, maximumRssBytes: rssMaximum},
      );
      const observedRss = Math.max(afterPeak, rssNow);
      expect(result).toEqual(
        observedRss > rssMaximum
          ? {code: 'rss-bytes', maximum: rssMaximum, observed: observedRss, unit: 'bytes'}
          : allocationIncrease > allocationMaximum
            ? {
                code: 'allocation-bytes',
                maximum: allocationMaximum,
                observed: allocationIncrease,
                unit: 'bytes',
              }
            : undefined,
      );
    },
    {fastCheck: {numRuns: 100}},
  );

  it('degrades emitted symbol and fact-byte exhaustion to one searchable module', () => {
    const file = inventoryFile('src/emission-budget.ts', 'export const emissionBudget = true;');
    const root = factsFor(file).symbols[0]!;
    const symbolHeavyFacts: CodeGraphFileFacts = {
      diagnostics: [],
      edges: [],
      path: file.path,
      symbols: [root, {...root, id: `${root.id}-child`, kind: 'variable', name: 'child'}],
    };
    const symbolHeavy = budgetParserWorkerFacts(file, symbolHeavyFacts, {maximumSymbols: 1});

    expect(symbolHeavy.degraded).toBe(true);
    expect(symbolHeavy.facts.symbols).toHaveLength(1);
    expect(symbolHeavy.facts.edges).toEqual([]);
    expect(symbolHeavy.facts.diagnostics[0]).toContain(
      '[code-graph-budget code=symbols status=exhausted observed-symbols=2 maximum-symbols=1]',
    );

    const maximumFactBytes = 2_048;
    const byteHeavyFacts: CodeGraphFileFacts = {
      diagnostics: [],
      edges: [],
      path: file.path,
      symbols: [{...root, documentation: 'x'.repeat(maximumFactBytes * 2)}],
    };
    const observedBytes = cachedCodeGraphFactBytes(byteHeavyFacts);
    const byteHeavy = budgetParserWorkerFacts(file, byteHeavyFacts, {maximumFactBytes});

    expect(byteHeavy.degraded).toBe(true);
    expect(byteHeavy.facts.symbols).toHaveLength(1);
    expect(byteHeavy.facts.edges).toEqual([]);
    expect(byteHeavy.facts.diagnostics[0]).toContain(
      `[code-graph-budget code=fact-bytes status=exhausted observed-bytes=${observedBytes} maximum-bytes=${maximumFactBytes}]`,
    );
    expect(cachedCodeGraphFactBytes(byteHeavy.facts)).toBeLessThanOrEqual(maximumFactBytes);
  });

  it.prop(
    'enforces an inclusive emitted-symbol boundary',
    {
      maximumSymbols: FC.integer({max: 16, min: 1}),
      symbolCount: FC.integer({max: 24, min: 1}),
    },
    ({maximumSymbols, symbolCount}) => {
      const file = inventoryFile('src/symbol-property.ts', 'export const symbolProperty = true;');
      const root = factsFor(file).symbols[0]!;
      const facts: CodeGraphFileFacts = {
        diagnostics: [],
        edges: [],
        path: file.path,
        symbols: Array.from({length: symbolCount}, (_, index) => ({
          ...root,
          id: `${root.id}-${index}`,
          kind: index === 0 ? 'module' : 'variable',
          name: `symbol-${index}`,
        })),
      };
      const result = budgetParserWorkerFacts(file, facts, {maximumSymbols});

      expect(result.degraded).toBe(symbolCount > maximumSymbols);
      expect(result.facts.symbols).toHaveLength(symbolCount > maximumSymbols ? 1 : symbolCount);
    },
    {fastCheck: {numRuns: 100}},
  );

  it.effect('honors explicit capacity without consulting hardware', () =>
    Effect.gen(function* () {
      const unavailableHardware = yield* systemWith({hardwareInfo: Effect.die('hardware must not be read')});
      yield* Effect.gen(function* () {
        const pool = yield* CodeGraphParserPool;
        expect(pool.capacity).toBe(8);
      }).pipe(
        provideTestLayer(parserLayer({capacity: 99}, Layer.succeed(SystemInfo, unavailableHardware))),
        Effect.scoped,
      );
    }),
  );

  it.effect('falls back to one worker when automatic hardware lookup fails', () =>
    Effect.gen(function* () {
      let hardwareLookups = 0;
      const unavailableHardware = yield* systemWith({
        environment: () => ({}),
        hardwareInfo: Effect.suspend(() => {
          hardwareLookups += 1;
          return Effect.fail(new TestError('hardware unavailable'));
        }),
      });
      yield* Effect.gen(function* () {
        const pool = yield* CodeGraphParserPool;
        expect(pool.capacity).toBe(1);
        expect(hardwareLookups).toBe(1);
      }).pipe(provideTestLayer(parserLayer({}, Layer.succeed(SystemInfo, unavailableHardware))), Effect.scoped);
    }),
  );

  it('honors the environment override and ignores invalid automatic hardware values', () => {
    expect(
      parserWorkerCapacity({
        environment: {},
        hardwareConcurrency: 1,
        override: 99,
      }),
    ).toBe(8);
    expect(
      parserWorkerCapacity({
        effectiveMemoryBytes: 1,
        environment: {THREADNOTE_CODE_GRAPH_PARSER_WORKERS: '7'},
        hardwareConcurrency: 1,
      }),
    ).toBe(7);
    expect(
      parserWorkerCapacity({
        environment: {},
        hardwareConcurrency: Number.NaN,
      }),
    ).toBe(1);
  });

  it.effect('degrades oversized source before acquiring or launching a parser worker', () => {
    const launches: ParserWorkerSpawnOptions[] = [];
    const spawn: ParserWorkerSpawner = options => {
      launches.push(options);
      return echoProcess();
    };
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-parser-worker-source-budget-'});
      const pool = yield* CodeGraphParserPool;
      const file = {...inventoryFile('src/oversized.ts', 'é'.repeat(9)), size: 1};
      const result = yield* pool.extract(file, home);

      expect(result.degraded).toBe(true);
      expect(result.parseMilliseconds).toBe(0);
      expect(result.facts.symbols).toHaveLength(1);
      expect(result.facts.symbols[0]).toMatchObject({kind: 'module', path: file.path});
      expect(result.facts.edges).toEqual([]);
      expect(result.facts.diagnostics).toEqual([
        expect.stringContaining(
          '[code-graph-budget code=source-bytes status=exhausted observed-bytes=18 maximum-bytes=16]',
        ),
      ]);
      expect(launches).toEqual([]);
    }).pipe(provideTestLayer(parserLayer({capacity: 1, maxSourceBytes: 16, spawnWorker: spawn})), Effect.scoped);
  });

  it.effect('admits source exactly at the byte boundary and leaves omitted content metadata-only', () => {
    const processes: ScriptedParserWorkerProcess[] = [];
    const spawn: ParserWorkerSpawner = () => {
      const process = echoProcess();
      processes.push(process);
      return process;
    };
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-parser-worker-source-boundary-'});
      const pool = yield* CodeGraphParserPool;
      const admitted = yield* pool.extract(inventoryFile('src/boundary.ts', 'é'.repeat(8)), home);

      expect(admitted.degraded).toBe(false);
      expect(processes).toHaveLength(1);
      expect(
        parserWorkerSourceByteBudget(
          {
            ...inventoryFile('src/omitted.ts', ''),
            content: undefined,
            contentOmittedReason: 'size-budget',
            size: CODE_GRAPH_PARSER_SOURCE_BYTES_MAXIMUM + 1,
          },
          16,
        ),
      ).toEqual({exceeded: false, maximumBytes: 16, observedBytes: 0});
    }).pipe(provideTestLayer(parserLayer({capacity: 1, maxSourceBytes: 16, spawnWorker: spawn})), Effect.scoped);
  });

  it.prop(
    'classifies source bytes from UTF-8 content and declared size without undercounting either',
    {
      content: FC.string({maxLength: 128}),
      declaredSize: FC.integer({max: 256, min: 0}),
      maximumBytes: FC.integer({max: 256, min: 1}),
    },
    ({content, declaredSize, maximumBytes}) => {
      const file = {...inventoryFile('src/property.ts', content), size: declaredSize};
      const observedBytes = Math.max(declaredSize, encoder.encode(content).byteLength);
      expect(parserWorkerSourceByteBudget(file, maximumBytes)).toEqual({
        exceeded: observedBytes > maximumBytes,
        maximumBytes,
        observedBytes,
      });
    },
    {fastCheck: {numRuns: 100}},
  );

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

      yield* pool.trimIdle;
      const restarted = yield* pool.extract(
        inventoryFile('src/restarted-worker.ts', 'export const restartedWorker = true;'),
        home,
      );
      expect(restarted.degraded).toBe(false);
      expect(restarted.facts.symbols.some(symbol => symbol.name === 'restartedWorker')).toBe(true);
    }).pipe(provideTestLayer(parserLayer({capacity: 1})), Effect.scoped),
  );

  it.effect('degrades and recycles a real worker that exceeds its RSS budget', () =>
    Effect.gen(function* () {
      const resourceLimitedSystem = yield* systemWith({
        environment: () => ({...process.env, [CODE_GRAPH_PARSER_RSS_BYTES_ENV]: '1'}),
      });
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-parser-worker-rss-'});
        const pool = yield* CodeGraphParserPool;
        const result = yield* pool.extract(inventoryFile('src/rss-worker.ts', 'export const rssWorker = true;'), home);

        expect(result.degraded).toBe(true);
        expect(result.facts.symbols).toHaveLength(1);
        expect(result.facts.diagnostics[0]).toContain(
          '[code-graph-budget code=rss-bytes status=exhausted observed-bytes=',
        );
        expect(result.facts.diagnostics[0]).toContain('maximum-bytes=1]');
      }).pipe(
        provideTestLayer(parserLayer({capacity: 1}, Layer.succeed(SystemInfo, resourceLimitedSystem))),
        Effect.scoped,
      );
    }),
  );

  it.effect('recycles a persistent slot after a worker reports resource degradation', () => {
    const processes: ScriptedParserWorkerProcess[] = [];
    const spawn: ParserWorkerSpawner = () => {
      const generation = processes.length;
      const worker = new ScriptedParserWorkerProcess(request => {
        worker.respond(request, factsFor(request.file), {
          degraded: generation === 0,
          recycle: generation === 0,
        });
      });
      processes.push(worker);
      return worker;
    };
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-parser-worker-resource-recycle-'});
      const pool = yield* CodeGraphParserPool;

      const degraded = yield* pool.extract(inventoryFile('src/resource-heavy.ts', 'export const heavy = true;'), home);
      const recovered = yield* pool.extract(
        inventoryFile('src/resource-recovered.ts', 'export const recovered = true;'),
        home,
      );

      expect(degraded.degraded).toBe(true);
      expect(recovered.degraded).toBe(false);
      expect(processes).toHaveLength(2);
      expect(processes[0]!.inputClosed).toBe(true);
    }).pipe(provideTestLayer(parserLayer({capacity: 1, spawnWorker: spawn})), Effect.scoped);
  });

  it.effect('degrades pathological emitted facts in the real worker before response serialization', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-parser-worker-budget-'});
      const content = `Pathological corpus\n===================\n\nprivate-corpus-sentinel ${'漢'.repeat(2_850_000)}`;
      const file = inventoryFile('docs/pathological.rst', content, 'document');
      const raw = yield* BUILTIN_LANGUAGE_PACK_REGISTRY.extractRawFile(file).pipe(
        provideTestLayer(TreeSitterRuntime.layer),
      );
      const worker = yield* CodeGraphParserPool;
      const result = yield* worker.extract(file, home);

      expect(cachedCodeGraphFactBytes(raw)).toBeGreaterThan(CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM);
      expect(result.degraded).toBe(true);
      expect(result.facts.symbols).toHaveLength(1);
      expect(result.facts.edges).toEqual([]);
      expect(result.facts.diagnostics[0]).toContain('code-graph-budget code=fact-bytes status=exhausted');
      expect(cachedCodeGraphFactBytes(result.facts)).toBeLessThanOrEqual(CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM);
      expect(parserWorkerSuccessResponseBytes(result.facts, 'x'.repeat(100))).toBeLessThanOrEqual(
        CODE_GRAPH_PARSER_WORKER_RESPONSE_BYTES_MAXIMUM,
      );
      expect(JSON.stringify(result.facts)).not.toContain('private-corpus-sentinel');
    }).pipe(provideTestLayer(parserLayer({capacity: 1})), Effect.scoped),
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
      }).pipe(provideTestLayer(baseLayer), Effect.scoped),
    {fastCheck: {numRuns: 30}},
  );

  for (const capacity of [2, 4, 6, 8]) {
    it.effect(`bounds simultaneous-worktree parsing to ${capacity} shared global slots`, () => {
      const tracker = {active: 0, maximum: 0};
      const spawn = echoSpawner({delayFor: () => 30, tracker});
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-parser-worker-capacity-'});
        const leftFiles = Array.from({length: capacity * 2}, (_, index) =>
          inventoryFile(`left/${index}.ts`, `export const left${index} = ${index};`),
        );
        const rightFiles = Array.from({length: capacity * 2}, (_, index) =>
          inventoryFile(`right/${index}.ts`, `export const right${index} = ${index};`),
        );

        const joined = Effect.all(
          [runPool(leftFiles, home, capacity, spawn), runPool(rightFiles, home, capacity, spawn)],
          {concurrency: 'unbounded'},
        );
        const joinedFiber = yield* Effect.forkScoped(joined);
        yield* advanceContentionClock();
        const [left, right] = yield* Fiber.join(joinedFiber);

        expect(left).toHaveLength(leftFiles.length);
        expect(right).toHaveLength(rightFiles.length);
        expect(tracker.maximum).toBe(capacity);
        expect(tracker.active).toBe(0);
      }).pipe(provideTestLayer(baseLayer), Effect.scoped);
    });
  }

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
      provideTestLayer(parserLayer({capacity: 1, requestTimeoutMilliseconds: 5_000, spawnWorker: spawn})),
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
      expect(result.facts.diagnostics.join('\n')).toContain(
        '[code-graph-budget code=elapsed status=exhausted observed-milliseconds=20 maximum-milliseconds=20]',
      );
    }).pipe(
      provideTestLayer(parserLayer({capacity: 1, requestTimeoutMilliseconds: 20, spawnWorker: spawn})),
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
    }).pipe(provideTestLayer(parserLayer({capacity: 1, spawnWorker: spawn})), Effect.scoped);
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
    }).pipe(provideTestLayer(parserLayer({capacity: 1, spawnWorker: spawn})), Effect.scoped);
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
    }).pipe(provideTestLayer(parserLayer({capacity: 1, spawnWorker: spawn})), Effect.scoped);
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
    }).pipe(
      provideTestLayer(parserLayer({capacity: 1, idleTimeoutMilliseconds: 15, spawnWorker: spawn})),
      Effect.scoped,
    );
  });

  it.effect('trims idle workers concurrently exactly once and lazily restarts their slots', () => {
    const processes: ScriptedParserWorkerProcess[] = [];
    const spawn: ParserWorkerSpawner = () => {
      const worker = echoProcess();
      processes.push(worker);
      return worker;
    };

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-parser-worker-trim-idle-'});
      const pool = yield* CodeGraphParserPool;

      yield* pool.extract(inventoryFile('src/before-trim.ts', 'export const beforeTrim = true;'), home);
      yield* Effect.all([pool.trimIdle, pool.trimIdle], {concurrency: 'unbounded'});
      expect(processes[0]!.closeInputCalls).toBe(1);
      expect(yield* Effect.promise(() => processes[0]!.exited)).toBe(0);

      const afterTrim = yield* pool.extract(inventoryFile('src/after-trim.ts', 'export const afterTrim = true;'), home);
      expect(afterTrim.degraded).toBe(false);
      expect(processes).toHaveLength(2);
    }).pipe(provideTestLayer(parserLayer({capacity: 1, spawnWorker: spawn})), Effect.scoped);
  });

  it.effect('does not terminate an active extraction when idle slots are trimmed', () => {
    const processes: ScriptedParserWorkerProcess[] = [];
    const spawn: ParserWorkerSpawner = () => {
      const worker = new ScriptedParserWorkerProcess(() => {});
      processes.push(worker);
      return worker;
    };

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-parser-worker-trim-active-'});
      const pool = yield* CodeGraphParserPool;
      const fiber = yield* Effect.forkScoped(
        pool.extract(inventoryFile('src/active.ts', 'export const active = true;'), home),
      );
      yield* waitUntil(() => processes[0]?.writes.length === 1);

      yield* pool.trimIdle;
      expect(processes[0]!.inputClosed).toBe(false);
      expect(processes[0]!.killed).toBe(false);

      const request = processes[0]!.writes[0]!;
      processes[0]!.respond(request, factsFor(request.file));
      expect((yield* Fiber.join(fiber)).degraded).toBe(false);
      yield* pool.trimIdle;
      expect(processes[0]!.closeInputCalls).toBe(1);
    }).pipe(
      provideTestLayer(parserLayer({capacity: 1, requestTimeoutMilliseconds: 5_000, spawnWorker: spawn})),
      Effect.scoped,
    );
  });

  it.effect('uses the packaged executable directly on Windows and preserves array-safe paths', () =>
    Effect.gen(function* () {
      const launches: ParserWorkerSpawnOptions[] = [];
      const spawn: ParserWorkerSpawner = options => {
        launches.push(options);
        return echoProcess();
      };
      const windowsSystem = yield* systemWith({
        executablePath: 'C:\\Program Files\\Threadnote\\threadnote.exe',
        platform: 'win32',
        processArguments: ['C:\\Program Files\\Threadnote\\threadnote.exe', 'graph', 'index'],
      });

      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-parser-worker-windows-'});
        const pool = yield* CodeGraphParserPool;
        const result = yield* pool.extract(inventoryFile('src/windows.ts', 'export const windows = true;'), home);

        expect(result.degraded).toBe(false);
        expect(launches).toHaveLength(1);
        expect(launches[0]!.executable).toBe('C:\\Program Files\\Threadnote\\threadnote.exe');
        expect(launches[0]!.arguments).toEqual([CODE_GRAPH_PARSER_WORKER_ARGUMENT]);
      }).pipe(
        provideTestLayer(parserLayer({capacity: 1, spawnWorker: spawn}, Layer.succeed(SystemInfo, windowsSystem))),
        Effect.scoped,
      );
    }),
  );
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
  }).pipe(provideTestLayer(parserLayer({capacity, spawnWorker})));
}

const baseLayer = Layer.mergeAll(BunServices.layer, SystemInfo.layer);

function parserLayer(
  options: Parameters<typeof codeGraphParserPoolLayer>[0],
  systemLayer: Layer.Layer<SystemInfo> = SystemInfo.layer,
) {
  const dependencies = Layer.mergeAll(BunServices.layer, systemLayer);
  return codeGraphParserPoolLayer(options).pipe(Layer.provideMerge(dependencies));
}

function inventoryFile(path: string, content: string, language = 'typescript'): CodeGraphInventoryFile {
  return {
    blobId: `blob-${path}`,
    content,
    contentHash: Bun.hash(content).toString(16),
    language,
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
  closeInputCalls = 0;
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
    this.closeInputCalls += 1;
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

  respond(
    request: WireRequest,
    facts: CodeGraphFileFacts,
    options: {readonly degraded?: boolean; readonly recycle?: boolean} = {},
  ): void {
    this.stdoutFeed.push(
      `${JSON.stringify({degraded: options.degraded ?? false, facts, id: request.id, ok: true, parseMilliseconds: 1, protocol: request.protocol, recycle: options.recycle ?? false})}\n`,
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

function systemWith(overrides: Partial<SystemInfoShape>) {
  return SystemInfo.pipe(
    provideTestLayer(SystemInfo.layer),
    Effect.map(current => SystemInfo.of({...current, ...overrides})),
  );
}
