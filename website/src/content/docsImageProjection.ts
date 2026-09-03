import type {CliCommandReference, DocsArticle} from './docsTypes.js';

export const optionalImageProjectionCliCommand: CliCommandReference = {
  command: 'image-projection',
  summary: 'Inspect or persist optional MCP memory image projection for read_context.',
  examples: [
    'threadnote image-projection',
    'threadnote image-projection --enable',
    'threadnote image-projection --disable',
  ],
};

export const optionalImageProjectionDocsArticle: DocsArticle = {
  id: 'optional-image-projection',
  title: 'Optional MCP image projection',
  summary: 'Opt in to return a complete memory as PNG pages instead of paged text.',
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
      text: 'MCP read_context stays paged text by default. When image projection is enabled, a content read that would otherwise page returns the full memory as PNG pages in one result, plus a verbatim appendix of Threadnote URIs and IDs. threadnote read on the CLI stays text. Restart connected MCP clients after changing the setting.',
    },
    {
      type: 'list',
      items: [
        'THREADNOTE_IMAGE_PROJECTION=0 disables imaging without removing the persisted setting.',
        'THREADNOTE_IMAGE_PROJECTION_MODEL selects a pxpipe render profile. Otherwise THREADNOTE_MCP_CLIENT (set by mcp-install) maps Claude Code to dense Claude pages and Cursor and Codex to 14px profiles. Copilot and unknown hosts use the same 84-column 14px strip. MCP does not expose the live chat model.',
        'Imaging is lossy for hex and identifiers; trust the text appendix over glyphs.',
        'Cursor continuations, outline mode, and section reads stay on the paged text path.',
      ],
    },
  ],
};
