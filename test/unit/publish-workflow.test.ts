import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

describe('publish workflow', () => {
  it('uses an npm major compatible with the configured Node runner', async () => {
    const workflow = await readFile(join(process.cwd(), '.github', 'workflows', 'publish.yml'), 'utf8');
    expect(workflow).toContain('npm install -g npm@11');
    expect(workflow).not.toContain('npm install -g npm@latest');
  });
});
