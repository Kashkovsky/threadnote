import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {makeFinalCliOutput} from '../../src/effect/cli_output.js';

const writeDelayedFinalOutput = makeFinalCliOutput(async output => {
  await Bun.sleep(500);
  const stdout = Bun.stdout.writer({highWaterMark: 64 * 1024});
  stdout.write(`${output}\n`);
  await stdout.flush();
  await stdout.end();
});

const value = 'x'.repeat(128 * 1024);
BunRuntime.runMain(writeDelayedFinalOutput(JSON.stringify({value})), {
  disableErrorReporting: true,
  teardown: () => process.exit(0),
});
