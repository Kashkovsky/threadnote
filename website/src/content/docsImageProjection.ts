import type {CliCommandReference, DocsArticle} from './docsTypes.js';

export const optionalImageProjectionCliCommand: CliCommandReference = {
  command: 'image-projection',
  summary: 'Inspect optional MCP memory image projection settings. read_context returns complete text, not PNG pages.',
  examples: [
    'threadnote image-projection',
    'threadnote image-projection --enable',
    'threadnote image-projection --disable',
  ],
};

export const optionalImageProjectionDocsArticle: DocsArticle = {
  id: 'optional-image-projection',
  title: 'Optional MCP image projection',
  summary: 'Image projection settings remain available; read_context returns complete text instead of PNG pages.',
  keywords: ['image projection', 'pxpipe', 'read_context', 'vision', 'MCP'],
  body: [
    {
      type: 'code',
      language: 'sh',
      code: `threadnote image-projection
threadnote image-projection --enable
threadnote image-projection --disable`,
    },
    {
      type: 'paragraph',
      text: 'MCP read_context returns the full memory up to 64 KiB. Larger memories refuse with an outline so you can retry with mode=outline or section. Image projection no longer replaces text with PNG pages. threadnote read on the CLI stays text. Restart connected MCP clients after changing the setting.',
    },
    {
      type: 'list',
      items: [
        'THREADNOTE_IMAGE_PROJECTION=0 disables imaging without removing the persisted setting.',
        'THREADNOTE_IMAGE_PROJECTION_MODEL selects a pxpipe render profile. Otherwise THREADNOTE_MCP_CLIENT (set by mcp-install) maps Claude Code to dense Claude pages and Cursor and Codex to 14px profiles. Copilot and unknown hosts use the same 84-column 14px strip. MCP does not expose the live chat model.',
        'Imaging is lossy for hex and identifiers; trust the text appendix over glyphs.',
        'Outline mode and section reads still select a part of a memory; they are not continuation cursors.',
      ],
    },
  ],
};
