import {readFile} from '../helpers/node-fs-promises.js';
import {join} from '../helpers/node-path.js';
import {describe, expect, it} from 'vitest';

describe('Context CI documentation', () => {
  it('ships a read-only, full-history GitHub example with the stable format and exit contract', async () => {
    const [workflow, guide] = await Promise.all([
      readFile(join(process.cwd(), '.github', 'examples', 'context-check.yml'), 'utf8'),
      readFile(join(process.cwd(), 'docs', 'context-ci.md'), 'utf8'),
    ]);

    expect(workflow).toContain('fetch-depth: 0');
    expect(workflow).toContain('--format sarif');
    expect(workflow).toContain('share init');
    expect(workflow).toContain('--read-only');
    expect(workflow).toContain("jq -e '.recordsScanned > 0'");
    expect(workflow).toContain('contents: read');
    expect(workflow).not.toMatch(/contents:\s*write/u);
    expect(workflow).not.toContain('git push');
    expect(guide).toMatch(/\|\s+`0`\s+\|/u);
    expect(guide).toMatch(/\|\s+`1`\s+\|/u);
    expect(guide).toMatch(/\|\s+`2`\s+\|/u);
    expect(guide).toContain('never as clean');
  });
});
