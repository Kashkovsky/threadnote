import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {makeFinalCliOutput} from '../../src/effect/cli_output.js';

const writeDelayedFinalOutput = makeFinalCliOutput(async () => {
  await Bun.sleep(500);
  await new Promise<void>((resolve, reject) => {
    process.stdout.write('', error => (error ? reject(error) : resolve()));
  });
});

const value = 'x'.repeat(128 * 1024);
BunRuntime.runMain(writeDelayedFinalOutput(JSON.stringify({value})), {
  disableErrorReporting: true,
  teardown: () => process.exit(0),
});
