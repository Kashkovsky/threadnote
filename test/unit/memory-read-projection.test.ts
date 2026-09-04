import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  MEMORY_READ_MAXIMUM_CONTENT_BYTES,
  MemoryReadTooLargeError,
  memoryMarkdownOutline,
  memoryReadContentBytes,
  projectMemoryRead,
  selectMemoryMarkdownSection,
} from '../../src/memory/read_projection.js';

describe('complete memory read projection', () => {
  it('returns exact under-cap source bytes in one shot', () => {
    fc.assert(
      fc.property(fc.string({maxLength: 2_000}), text => {
        const resources = [{text, uri: 'threadnote://test/complete.md'}];
        const read = projectMemoryRead(resources);
        expect(read.structuredContent.complete).toBe(true);
        expect(read.structuredContent.content).toBe(text);
        expect(read.content).toBe(text);
        expect(read.structuredContent.contentBytes).toBe(memoryReadContentBytes(text));
        expect(read.structuredContent).not.toHaveProperty('budgetTokens');
        expect(read.structuredContent).not.toHaveProperty('cursor');
      }),
      {numRuns: 50},
    );
  });

  it('is deterministic for a stable source', () => {
    const resources = [{text: `${'🙂 bounded evidence\n'.repeat(50)}`, uri: 'threadnote://test/stable.md'}];
    expect(projectMemoryRead(resources)).toEqual(projectMemoryRead(resources));
  });

  it('refuses over-cap memories with an outline and no body prefix', () => {
    const body = `${'x'.repeat(MEMORY_READ_MAXIMUM_CONTENT_BYTES + 1)}`;
    const content = `# Ledger\n## Open\n${body}\n`;
    expect(() => projectMemoryRead([{text: content, uri: 'threadnote://test/huge.md'}])).toThrow(
      MemoryReadTooLargeError,
    );
    try {
      projectMemoryRead([{text: content, uri: 'threadnote://test/huge.md'}]);
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryReadTooLargeError);
      const failure = error as MemoryReadTooLargeError;
      expect(failure.message).toContain(`${MEMORY_READ_MAXIMUM_CONTENT_BYTES} bytes`);
      expect(failure.message).toContain('mode=outline');
      expect(failure.message).toContain('section=');
      expect(failure.message).toContain('## Open');
      expect(failure.outline).toContain('# Ledger');
      expect(failure.message.includes(body.slice(0, 80))).toBe(false);
    }
  });

  it('returns the complete memory at the exact byte cap', () => {
    const text = 'a'.repeat(MEMORY_READ_MAXIMUM_CONTENT_BYTES);
    const read = projectMemoryRead([{text, uri: 'threadnote://test/exact.md'}]);
    expect(read.structuredContent.complete).toBe(true);
    expect(read.structuredContent.contentBytes).toBe(MEMORY_READ_MAXIMUM_CONTENT_BYTES);
    expect(read.content).toBe(text);
  });

  it('refuses any over-cap payload without returning a successful prefix', () => {
    fc.assert(
      fc.property(fc.integer({max: 32, min: 1}), extra => {
        const text = 'x'.repeat(MEMORY_READ_MAXIMUM_CONTENT_BYTES + extra);
        expect(() => projectMemoryRead([{text, uri: 'threadnote://test/cap.md'}])).toThrow(MemoryReadTooLargeError);
      }),
      {numRuns: 10},
    );
  });

  it('mirrors a complete outline without paging', () => {
    const read = projectMemoryRead(
      [{text: '# Root\nintro\n## Details\nevidence\n', uri: 'threadnote://test/outline.md'}],
      {mode: 'outline'},
    );

    expect(read.structuredContent.complete).toBe(true);
    expect(read.content).toContain('## Details');
    expect(read.structuredContent.content).toBe(read.content);
    expect(read.structuredContent.mode).toBe('outline');
  });

  it('mirrors relocation guidance for content-only and structured-first clients', () => {
    const requestedUri = 'threadnote://user/test/memories/durable/projects/threadnote/old.md';
    const canonicalUri = 'threadnote://user/test/memories/shared/default/durable/projects/threadnote/current.md';
    const read = projectMemoryRead([
      {
        canonicalUri,
        requestedUri,
        text: 'Complete canonical evidence.',
        uri: canonicalUri,
      },
    ]);

    expect(read.structuredContent.complete).toBe(true);
    expect(read.content).toBe('Complete canonical evidence.');
    expect(read.receipt).toContain(`requested ${requestedUri}`);
    expect(read.receipt).toContain(`canonical ${canonicalUri}`);
    expect(read.structuredContent).toMatchObject({canonicalUri, content: read.content, requestedUri});
  });

  it('joins multiple under-cap URIs without a continuation cursor', () => {
    const read = projectMemoryRead([
      {text: 'first', uri: 'threadnote://test/one.md'},
      {text: 'second', uri: 'threadnote://test/two.md'},
    ]);
    expect(read.content).toBe('first\n\nsecond');
    expect(read.structuredContent.complete).toBe(true);
    expect(read.structuredContent.resourceCount).toBe(2);
  });

  it('renders heading outlines and exact Markdown sections without including their siblings', () => {
    const content = '# Root\nintro\n## Alpha\nalpha body\n### Child\nchild body\n## Beta\nbeta body\n';
    expect(memoryMarkdownOutline(content)).toContain('## Alpha');
    expect(memoryMarkdownOutline(content)).toContain('bytes)');
    expect(selectMemoryMarkdownSection(content, '## Alpha')).toBe('## Alpha\nalpha body\n### Child\nchild body\n');
    expect(selectMemoryMarkdownSection(content, 'Alpha')).not.toContain('## Beta');
  });

  it('ignores ATX pseudoheadings inside backtick and tilde code fences', () => {
    const content = [
      '# Root',
      '```sh',
      '# Install',
      'echo pseudo',
      '```',
      '~~~python',
      '## Usage',
      'print("pseudo")',
      '~~~~',
      '## Install',
      'real instructions',
      '## Usage',
      'real usage',
      '',
    ].join('\n');

    const outline = memoryMarkdownOutline(content);
    expect(outline.match(/Install/gu)).toHaveLength(1);
    expect(outline.match(/Usage/gu)).toHaveLength(1);
    expect(selectMemoryMarkdownSection(content, 'Install')).toBe('## Install\nreal instructions\n');
    expect(selectMemoryMarkdownSection(content, 'Usage')).toBe('## Usage\nreal usage\n');
  });

  it('keeps fenced pseudoheadings out of section selection for arbitrary fence lengths', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('`' as const, '~' as const),
        fc.integer({max: 8, min: 3}),
        fc.array(
          fc
            .stringMatching(/^[A-Za-z][A-Za-z0-9 -]{0,20}$/)
            .filter(title => title !== 'Real section' && title !== 'Next'),
          {maxLength: 8},
        ),
        (character, length, pseudoTitles) => {
          const fence = character.repeat(length);
          const content = [
            `${fence} language`,
            ...pseudoTitles.map(title => `## ${title}`),
            fence,
            '## Real section',
            'authoritative body',
            '## Next',
            '',
          ].join('\n');

          expect(selectMemoryMarkdownSection(content, 'Real section')).toBe('## Real section\nauthoritative body\n');
          const outline = memoryMarkdownOutline(content);
          for (const title of pseudoTitles) expect(outline).not.toContain(`## ${title} (`);
        },
      ),
      {numRuns: 50},
    );
  });
});
