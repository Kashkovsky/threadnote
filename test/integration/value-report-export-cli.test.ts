import {execFile} from '../helpers/node-child-process.js';
import {mkdtemp, readFile, rm, stat} from '../helpers/node-fs-promises.js';
import {tmpdir} from '../helpers/node-os.js';
import {join} from '../helpers/node-path.js';
import {parseValueReportExportV1, VALUE_REPORT_EXPORT_SCHEMA} from '../../src/value_report/export.js';
import {afterEach, describe, expect, it} from 'vitest';
import {promisify} from 'node:util';

const execFilePromise = promisify(execFile);
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
});

describe('value report export CLI', () => {
  it('keeps report behavior and exposes preview/apply export beneath it', async () => {
    const home = await makeHome();
    const report = await runCli(['value', 'report', '--period', '1', '--json'], home);
    expect(JSON.parse(report.stdout)).toMatchObject({scope: 'local', type: 'value-report', version: 1});

    const preview = await runCli(['value', 'report', 'export', '--project', 'private-project', '--period', '1'], home);
    const bundle = parseValueReportExportV1(JSON.parse(preview.stdout));
    expect(bundle.schema).toBe(VALUE_REPORT_EXPORT_SCHEMA);
    expect(preview.stdout).not.toContain('private-project');
    await expect(stat(join(home, 'exports', 'value-reports'))).rejects.toThrow();

    const applied = await runCli(
      ['value', 'report', 'export', '--project', 'private-project', '--period', '1', '--apply'],
      home,
    );
    const outputPath = applied.stdout.trim().match(/^Exported redacted ValueReportExportV1 to (.+)\.$/u)?.[1];
    expect(outputPath).toBeDefined();
    expect(outputPath?.startsWith(join(home, 'exports', 'value-reports'))).toBe(true);
    const exported = await readFile(outputPath!, 'utf8');
    expect(parseValueReportExportV1(JSON.parse(exported))).toMatchObject({
      schema: VALUE_REPORT_EXPORT_SCHEMA,
      type: 'threadnote-value-report-export',
      version: 1,
    });
    expect(exported).not.toContain('private-project');
  });
});

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'threadnote-value-report-export-cli-'));
  homes.push(home);
  return home;
}

function runCli(args: readonly string[], home: string) {
  return execFilePromise(process.execPath, [join(process.cwd(), 'src', 'standalone.ts'), ...args], {
    env: {...process.env, NO_COLOR: '1', THREADNOTE_HOME: home, THREADNOTE_USER: 'local'},
  });
}
