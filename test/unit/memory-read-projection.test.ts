import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  memoryMarkdownOutline,
  memoryReadCursorToken,
  memoryReadPageEstimatedTokens,
  memoryReadSourceHashes,
  memoryReadSourcesMatch,
  memoryReadWouldPage,
  projectMemoryReadPage,
  selectMemoryMarkdownSection,
  type MemoryReadPosition,
  type MemoryReadResource,
} from '../../src/memory/read_projection.js';

describe('bounded memory read projection', () => {
  it('concatenates every Unicode page back to the exact source within the requested budget', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({maxLength: 800}), {maxLength: 3, minLength: 1}),
        fc.integer({max: 350, min: 128}),
        (texts, budgetTokens) => {
          const resources = texts.map((text, index) => ({text, uri: `threadnote://test/${index}.md`}));
          const reconstructed: string[] = [];
          let position: MemoryReadPosition | undefined;
          for (let pageNumber = 0; pageNumber < 10_000; pageNumber += 1) {
            const page = projectMemoryReadPage(resources, {
              budgetTokens,
              continuationCursor: memoryReadCursorToken('deterministic-property-cursor'),
              ...(position === undefined ? {} : {position}),
            });
            expect(page.structuredContent.content).toBe(page.content);
            reconstructed.push(page.structuredContent.content);
            expect(memoryReadPageEstimatedTokens(page)).toBeLessThanOrEqual(budgetTokens);
            expect(page.structuredContent.estimatedTokens).toBe(memoryReadPageEstimatedTokens(page));
            if (page.complete) break;
            expect(page.nextPosition).toBeDefined();
            position = page.nextPosition;
            if (pageNumber === 9_999) throw new Error('Memory read pagination did not terminate.');
          }
          expect(reconstructed.join('')).toBe(texts.join(''));
        },
      ),
      {numRuns: 50},
    );
  });

  it('is deterministic for a stable source, cursor token, and position', () => {
    const resources = [{text: `${'🙂 bounded evidence\n'.repeat(500)}`, uri: 'threadnote://test/stable.md'}];
    const options = {
      budgetTokens: 128,
      continuationCursor: memoryReadCursorToken('stable-cursor'),
    } as const;
    expect(projectMemoryReadPage(resources, options)).toEqual(projectMemoryReadPage(resources, options));
  });

  it('reports measured response tokens instead of the allotted budget for a short complete page', () => {
    const page = projectMemoryReadPage([{text: 'short evidence', uri: 'threadnote://test/short.md'}], {
      budgetTokens: 1_500,
      continuationCursor: memoryReadCursorToken('short-page-cursor'),
    });

    expect(page.complete).toBe(true);
    expect(page.structuredContent.content).toBe('short evidence');
    expect(page.structuredContent.estimatedTokens).toBe(memoryReadPageEstimatedTokens(page));
    expect(page.structuredContent.estimatedTokens).toBeLessThan(page.structuredContent.budgetTokens);
  });

  it('reports whether a first page would be incomplete', () => {
    expect(
      memoryReadWouldPage([{text: 'short evidence', uri: 'threadnote://test/short.md'}], {budgetTokens: 1_500}),
    ).toBe(false);
    expect(
      memoryReadWouldPage(
        [{text: `${'ASCII evidence line\n'.repeat(800)}terminal`, uri: 'threadnote://test/long.md'}],
        {
          budgetTokens: 1_500,
        },
      ),
    ).toBe(true);
  });

  it('mirrors a complete outline with its measured response budget', () => {
    const page = projectMemoryReadPage(
      [{text: '# Root\nintro\n## Details\nevidence\n', uri: 'threadnote://test/outline.md'}],
      {
        budgetTokens: 400,
        continuationCursor: memoryReadCursorToken('outline-page-cursor'),
        mode: 'outline',
      },
    );

    expect(page.complete).toBe(true);
    expect(page.content).toContain('## Details');
    expect(page.structuredContent.content).toBe(page.content);
    expect(page.structuredContent.estimatedTokens).toBe(memoryReadPageEstimatedTokens(page));
    expect(page.structuredContent.estimatedTokens).toBeLessThan(page.structuredContent.budgetTokens);
  });

  it('mirrors relocation guidance for content-only and structured-first clients within one budget', () => {
    const requestedUri = 'threadnote://user/test/memories/durable/projects/threadnote/old.md';
    const canonicalUri = 'threadnote://user/test/memories/shared/default/durable/projects/threadnote/current.md';
    const page = projectMemoryReadPage(
      [
        {
          canonicalUri,
          requestedUri,
          text: 'Complete canonical evidence.',
          uri: canonicalUri,
        },
      ],
      {
        budgetTokens: 1_500,
        continuationCursor: memoryReadCursorToken('relocated-page-cursor'),
      },
    );

    expect(page.complete).toBe(true);
    expect(page.content).toBe('Complete canonical evidence.');
    expect(page.receipt).toContain(`requested ${requestedUri}`);
    expect(page.receipt).toContain(`canonical ${canonicalUri}`);
    expect(page.structuredContent).toMatchObject({canonicalUri, content: page.content, requestedUri});
    expect(memoryReadPageEstimatedTokens(page)).toBeLessThanOrEqual(1_500);
  });

  it('keeps relocation identity and exact bytes stable across every bounded page', () => {
    fc.assert(
      fc.property(fc.string({maxLength: 1_000}), fc.integer({max: 1_500, min: 512}), (text, budgetTokens) => {
        const requestedUri = 'threadnote://user/test/memories/durable/projects/threadnote/old.md';
        const canonicalUri = 'threadnote://user/test/memories/shared/default/durable/projects/threadnote/new.md';
        const resources = [{canonicalUri, requestedUri, text, uri: canonicalUri}];
        const reconstructed: string[] = [];
        let position: MemoryReadPosition | undefined;
        for (let pageNumber = 0; pageNumber < 10_000; pageNumber += 1) {
          const page = projectMemoryReadPage(resources, {
            budgetTokens,
            continuationCursor: memoryReadCursorToken('relocation-property-cursor'),
            ...(position === undefined ? {} : {position}),
          });
          expect(page.structuredContent).toMatchObject({canonicalUri, requestedUri});
          expect(page.receipt).toContain(requestedUri);
          expect(page.receipt).toContain(canonicalUri);
          expect(memoryReadPageEstimatedTokens(page)).toBeLessThanOrEqual(budgetTokens);
          reconstructed.push(page.content);
          if (page.complete) break;
          position = page.nextPosition;
          if (pageNumber === 9_999) throw new Error('Relocated memory pagination did not terminate.');
        }
        expect(reconstructed.join('')).toBe(text);
      }),
      {numRuns: 30},
    );
  });

  it('drops optional metadata before rejecting a leading four-byte Unicode scalar at minimum budget', () => {
    const page = projectMemoryReadPage(
      [{text: `🙂${'bounded evidence\n'.repeat(100)}`, uri: 'threadnote://test/minimum-budget.md'}],
      {
        budgetTokens: 128,
        continuationCursor: memoryReadCursorToken('minimum-budget-cursor'),
        warnings: ['optional warning '.repeat(100)],
      },
    );

    expect(page.content.startsWith('🙂')).toBe(true);
    expect(page.structuredContent.content).toBe(page.content);
    expect(page.structuredContent.warnings).toBeUndefined();
    expect(memoryReadPageEstimatedTokens(page)).toBeLessThanOrEqual(128);
  });

  it('retrieves a 100k-character memory exactly through bounded successive pages', () => {
    const content = `${'🙂漢字 bounded memory\n'.repeat(5_000)}terminal`;
    expect(content.length).toBeGreaterThan(100_000);
    const resources = [{text: content, uri: 'threadnote://test/large.md'}];
    const reconstructed: string[] = [];
    let position: MemoryReadPosition | undefined;
    for (let pageNumber = 0; pageNumber < 1_000; pageNumber += 1) {
      const page = projectMemoryReadPage(resources, {
        budgetTokens: 1_500,
        continuationCursor: memoryReadCursorToken('large-memory-cursor'),
        ...(position === undefined ? {} : {position}),
      });
      expect(page.structuredContent.content).toBe(page.content);
      reconstructed.push(page.structuredContent.content);
      if (page.complete) break;
      position = page.nextPosition;
      if (pageNumber === 999) throw new Error('Large memory pagination did not terminate.');
    }
    expect(reconstructed.join('')).toBe(content);
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

  it('uses opaque cursor tokens and rejects changed sources', () => {
    const cursor = memoryReadCursorToken('private entropy and threadnote://secret/source.md');
    expect(cursor).toMatch(/^tnrc_[0-9a-f]{32}$/u);
    expect(cursor).not.toContain('secret');

    const resources: MemoryReadResource[] = [{text: 'original', uri: 'threadnote://test/source.md'}];
    const state = {
      mode: 'content' as const,
      position: {characterOffset: 3, resourceIndex: 0},
      sourceHashes: memoryReadSourceHashes(resources),
      uris: resources.map(resource => resource.uri),
    };
    expect(memoryReadSourcesMatch(resources, state.sourceHashes)).toBe(true);
    expect(memoryReadSourcesMatch([{...resources[0], text: 'changed'}], state.sourceHashes)).toBe(false);
  });
});
