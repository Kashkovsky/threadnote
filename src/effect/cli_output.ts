import {Context, Effect, Layer} from 'effect';

export interface CliOutputShape {
  readonly writeFinal: (output: string) => Effect.Effect<void, Error>;
}

export function makeFinalCliOutput(write: (output: string) => Promise<void>) {
  return Effect.fn('cliOutput.writeFinal')(function* (output: string) {
    yield* Effect.tryPromise({
      try: () => write(output),
      catch: cause => new Error('Failed to write complete Threadnote CLI output.', {cause}),
    });
  });
}

const writeBunStdout = async (output: string): Promise<void> => {
  const stdout = Bun.stdout.writer({highWaterMark: 64 * 1024});
  stdout.write(`${output}\n`);
  await stdout.flush();
  await stdout.end();
};

export class CliOutput extends Context.Service<CliOutput, CliOutputShape>()('threadnote/effect/CliOutput') {
  static readonly layer = Layer.succeed(
    CliOutput,
    CliOutput.of({
      writeFinal: makeFinalCliOutput(writeBunStdout),
    }),
  );
}

/** Best-effort barrier for ordinary small Console output at one-shot CLI exit. */
export const drainCliStdout = Effect.tryPromise({
  try: async () => {
    await Bun.write(Bun.stdout, '');
  },
  catch: cause => new Error('Failed to drain Threadnote CLI output.', {cause}),
});

export const writeFinalCliOutput = Effect.fn('cliOutput.writeFinalFromService')(function* (output: string) {
  const cliOutput = yield* CliOutput;
  yield* cliOutput.writeFinal(output);
});
