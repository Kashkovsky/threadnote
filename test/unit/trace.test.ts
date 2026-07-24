import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {distillTrace} from '../../src/trace.js';
import {runEffect} from '../helpers/effect-runtime.js';

describe('distillTrace', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tn-trace-'));
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  it('summarizes events, tools, and recent intents from a JSONL transcript', async () => {
    const path = join(dir, 't.jsonl');
    const lines = [
      JSON.stringify({type: 'user', message: {role: 'user', content: 'Add the workset feature'}}),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {type: 'text', text: 'ok'},
            {type: 'tool_use', name: 'Edit'},
          ],
        },
      }),
      JSON.stringify({type: 'assistant', message: {role: 'assistant', content: [{type: 'tool_use', name: 'Bash'}]}}),
      'not valid json',
      JSON.stringify({type: 'user', message: {role: 'user', content: [{type: 'text', text: 'now run the tests'}]}}),
    ].join('\n');
    await writeFile(path, lines, 'utf8');
    const summary = await runEffect(distillTrace(path));
    expect(summary).toContain('4 transcript events');
    expect(summary).toContain('tools used: Edit, Bash');
    expect(summary).toContain('recent intents:');
    expect(summary).toContain('Add the workset feature');
    expect(summary).toContain('now run the tests');
  });

  it('returns undefined for a missing transcript', async () => {
    expect(await runEffect(distillTrace(join(dir, 'missing.jsonl')))).toBeUndefined();
  });

  it('returns undefined when no line parses as an event', async () => {
    const path = join(dir, 'garbage.jsonl');
    await writeFile(path, 'garbage\nmore garbage\n', 'utf8');
    expect(await runEffect(distillTrace(path))).toBeUndefined();
  });

  it('summarizes large transcripts from the capped tail', async () => {
    const path = join(dir, 'large.jsonl');
    const prefix = `${JSON.stringify({type: 'user', message: {role: 'user', content: 'old intent'}})}\n${'x'.repeat(
      4 * 1024 * 1024,
    )}`;
    await writeFile(
      path,
      `${prefix}\n${JSON.stringify({type: 'user', message: {role: 'user', content: 'tail intent'}})}\n`,
      'utf8',
    );

    const summary = await runEffect(distillTrace(path));
    expect(summary).toContain('tail intent');
    expect(summary).not.toContain('old intent');
  });

  it('drops traces when untruncated intent text contains a credential', async () => {
    const path = join(dir, 'secret.jsonl');
    await writeFile(
      path,
      `${JSON.stringify({
        type: 'user',
        message: {role: 'user', content: `${'x'.repeat(155)} sk-abcdefghijklmnopqr1234`},
      })}\n`,
      'utf8',
    );

    expect(await runEffect(distillTrace(path))).toBeUndefined();
  });
});
