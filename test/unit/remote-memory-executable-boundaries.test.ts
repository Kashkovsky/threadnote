import {readFile} from '../helpers/node-fs-promises.js';
import {it as effectIt} from '@effect/vitest';
import {Cause, Effect, Exit} from 'effect';
import {describe, expect, it} from 'vitest';
import {TestClock} from 'effect/testing';
import {fromPromiseInterruptibleAwaiting} from '../../src/effect/errors.js';

const repoRoot = new URL('../..', import.meta.url).pathname;
const awaitedCancellationFixture = `
  import * as BunRuntime from '@effect/platform-bun/BunRuntime';
  import {Effect} from 'effect';
  import {fromPromiseInterruptibleAwaiting} from './src/effect/errors.ts';
  const program = Effect.acquireUseRelease(
    Effect.void,
    () => fromPromiseInterruptibleAwaiting(
      signal => new Promise(resolve => {
        const drain = () => setTimeout(() => {
          process.stderr.write('drain-complete\\n');
          resolve();
        }, 100);
        signal.addEventListener('abort', drain, {once: true});
        process.stdout.write('ready\\n');
        if (signal.aborted) drain();
      }),
      cause => cause,
    ),
    () => Effect.sync(() => process.stderr.write('release-complete\\n')),
  );
  BunRuntime.runMain(program, {disableErrorReporting: true});
`;

describe('remote memory executable boundaries', () => {
  effectIt.effect('turns a throwing rejection mapper into a prompt defect', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const mapperDefect = new Error('mapper defect');
        const exit = yield* Effect.exit(
          fromPromiseInterruptibleAwaiting(
            () => Promise.reject(new Error('operation failed')),
            () => {
              throw mapperDefect;
            },
          ).pipe(Effect.timeout('1 second')),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toBe(mapperDefect);
      }),
    ),
  );

  it('awaits delayed operation drain before releasing after SIGTERM', async () => {
    const standalone = await readFile(new URL('../../src/standalone.ts', import.meta.url), 'utf8');
    const operator = await readFile(new URL('../../src/remote_memory/operator_main.ts', import.meta.url), 'utf8');
    expect(standalone).toContain('fromPromiseInterruptibleAwaiting(');
    expect(standalone).toContain('service.runRemoteMemoryService(process.env');
    expect(operator).toContain('fromPromiseInterruptibleAwaiting(evaluate, cause => cause)');
    const child = Bun.spawn({
      cmd: [process.execPath, '--eval', awaitedCancellationFixture],
      cwd: repoRoot,
      env: process.env,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const stderr = new Response(child.stderr).text();
    try {
      await waitForOutput(child.stdout, 'ready');
      child.kill('SIGTERM');
      expect(await child.exited).not.toBe(0);
      expect(await stderr).toMatch(/drain-complete\nrelease-complete\n$/u);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });

  it.each([
    {
      environment: {},
      expected: '{"error":"missing_access_token","status":"failed","version":1}\n',
    },
    {
      environment: {
        THREADNOTE_CANARY_ACCESS_TOKEN: 'test',
        THREADNOTE_CANARY_ENDPOINT: 'not a URL',
        THREADNOTE_CANARY_SHARE_ID: 'canary',
      },
      expected: '{"error":"invalid_endpoint","status":"failed","version":1}\n',
    },
  ])('reports invalid canary configuration as exact privacy-safe JSON', async ({environment, expected}) => {
    const cleanEnvironment = {...process.env};
    delete cleanEnvironment.THREADNOTE_CANARY_ENDPOINT;
    delete cleanEnvironment.THREADNOTE_CANARY_SHARE_ID;
    delete cleanEnvironment.THREADNOTE_CANARY_ACCESS_TOKEN;
    const child = Bun.spawn({
      cmd: [process.execPath, 'scripts/remote-memory-canary.ts'],
      cwd: repoRoot,
      env: {...cleanEnvironment, ...environment},
      stderr: 'pipe',
      stdout: 'pipe',
    });

    expect(await child.exited).toBe(1);
    expect(await new Response(child.stdout).text()).toBe('');
    expect(await new Response(child.stderr).text()).toBe(expected);
  });

  it('interrupts an in-flight canary request on SIGTERM instead of waiting for its request timeout', async () => {
    let receiveRequest: (() => void) | undefined;
    let finishRequest: (() => void) | undefined;
    const requested = new Promise<void>(resolve => {
      receiveRequest = resolve;
    });
    const finished = new Promise<void>(resolve => {
      finishRequest = resolve;
    });
    const server = Bun.serve({
      fetch: async () => {
        receiveRequest?.();
        await finished;
        return Response.json({});
      },
      hostname: '127.0.0.1',
      port: 0,
    });
    const child = Bun.spawn({
      cmd: [process.execPath, 'scripts/remote-memory-canary.ts'],
      cwd: repoRoot,
      env: {
        ...process.env,
        THREADNOTE_CANARY_ACCESS_TOKEN: 'test',
        THREADNOTE_CANARY_ENDPOINT: `http://127.0.0.1:${server.port}/mcp`,
        THREADNOTE_CANARY_SHARE_ID: 'canary',
      },
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    try {
      await Promise.race([
        requested,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Canary did not begin its request.')), 5_000),
        ),
      ]);
      child.kill('SIGTERM');
      await expect(
        Promise.race([
          child.exited,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Canary did not stop after SIGTERM.')), 2_000),
          ),
        ]),
      ).resolves.not.toBe(0);
      await output;
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      finishRequest?.();
      await server.stop(true);
    }
  });
});

async function waitForOutput(stream: ReadableStream<Uint8Array>, expected: string): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = '';
  try {
    while (!output.includes(expected)) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Child did not emit ${expected}.`)), 5_000),
        ),
      ]);
      if (chunk.done) throw new Error(`Child exited before emitting ${expected}.`);
      output += decoder.decode(chunk.value, {stream: true});
    }
  } finally {
    await reader.cancel();
  }
}
