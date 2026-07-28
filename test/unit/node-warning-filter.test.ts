import {execFile} from 'node:child_process';
import {createRequire} from 'node:module';
import {promisify} from 'node:util';
import {describe, expect, it} from 'vitest';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const filter = require('../../bin/node-warning-filter.cjs') as {
  readonly shouldSuppressNodeWarning: (warning: string | Error, type?: string | {readonly type?: string}) => boolean;
};

describe('Node warning filter', () => {
  it('matches only the node:sqlite experimental warning', () => {
    expect(filter.shouldSuppressNodeWarning('SQLite is an experimental feature', 'ExperimentalWarning')).toBe(true);
    expect(
      filter.shouldSuppressNodeWarning(new Error('SQLite is an experimental feature and might change at any time'), {
        type: 'ExperimentalWarning',
      }),
    ).toBe(true);
    expect(
      filter.shouldSuppressNodeWarning(
        Object.assign(new Error('SQLite is an experimental feature'), {name: 'ExperimentalWarning'}),
      ),
    ).toBe(true);
    expect(filter.shouldSuppressNodeWarning('SQLite is an experimental feature', 'Warning')).toBe(false);
    expect(filter.shouldSuppressNodeWarning('Another API is experimental', 'ExperimentalWarning')).toBe(false);
  });

  it('keeps unrelated process warnings visible', async () => {
    const script = [
      "require('./bin/node-warning-filter.cjs').suppressThreadnoteSQLiteExperimentalWarning();",
      "process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');",
      "process.emitWarning('keep-this-warning', 'ExperimentalWarning');",
    ].join('');
    const result = await execute(process.execPath, ['-e', script], {cwd: process.cwd()});

    expect(result.stderr).not.toContain('SQLite is an experimental feature');
    expect(result.stderr).toContain('keep-this-warning');
  });
});
