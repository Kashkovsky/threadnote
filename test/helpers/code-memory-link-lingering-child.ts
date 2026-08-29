import {spawn} from './node-child-process.js';
import {stat, writeFile} from './node-fs-promises.js';

const [mode, markerPath] = Bun.argv.slice(2);
if (!markerPath || (mode !== 'leader' && mode !== 'descendant')) {
  throw new Error('Lingering-child fixture requires a mode and marker path.');
}

if (mode === 'descendant') {
  process.on('SIGTERM', () => undefined);
  await writeFile(markerPath, `${process.pid}\n`, {flag: 'wx'});
  setInterval(() => undefined, 1_000);
} else {
  const child = spawn(process.execPath, [Bun.argv[1]!, 'descendant', markerPath], {stdio: 'ignore'});
  child.unref();
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      await stat(markerPath);
      break;
    } catch (cause) {
      if (!isMissing(cause) || Date.now() >= deadline) throw cause;
      await Bun.sleep(5);
    }
  }
  process.stdout.write(`${process.pid}\n`);
  process.exit(0);
}

function isMissing(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT';
}
