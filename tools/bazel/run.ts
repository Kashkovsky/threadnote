import {fileURLToPath} from 'node:url';
import {bazelPath} from './cli-tools.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const executable = await bazelPath(root);
const child = Bun.spawn([executable, ...process.argv.slice(2)], {
  cwd: root,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});
process.exitCode = await child.exited;
