import type {DocsArticle} from './docsTypes.js';

export const graphCheckpointsDocsArticle: DocsArticle = {
  id: 'graph-checkpoints',
  title: 'Portable graph checkpoints',
  summary: 'Move one deterministic verified clean graph between local installations without a Workset or cloud.',
  keywords: [
    'code graph checkpoint',
    'portable graph',
    'offline graph transfer',
    'checkpoint verify',
    'checkpoint import',
  ],
  body: [
    {
      type: 'code',
      language: 'sh',
      code: `threadnote graph index
threadnote graph checkpoint export --output threadnote-graph.cgcp
threadnote graph checkpoint inspect \\
  --input threadnote-graph.cgcp \\
  --expected-digest sha256:<digest>
threadnote graph checkpoint verify \\
  --input threadnote-graph.cgcp \\
  --expected-digest sha256:<digest>
threadnote graph checkpoint import \\
  --input threadnote-graph.cgcp \\
  --expected-digest sha256:<digest>`,
    },
    {
      type: 'paragraph',
      text: 'Checkpoints are a free, manual, offline transport. Export accepts only the exact ready clean root for the current commit and a credential-free repository identity. It reads one SQLite transaction in bounded pages, checks committed file identities against Git, omits absolute local paths, configured remote credential material, and raw source-file bytes, and never overwrites an existing destination. Checkpoints still contain source-derived names, signatures, and documentation. Canonical metadata, deterministic gzip chunks, and SHA-256 identities make the same compatible logical graph reproducible.',
    },
    {
      type: 'paragraph',
      text: 'Inspect validates bounded framing and computes the exact artifact digest without inflating records; pass an independently obtained expected digest to authenticate those bytes. Verify additionally checks compressed-member integrity, chunk and logical digests, canonical record schema, ordering, counts, and coverage. Both commands reject direct symbolic-link inputs and fail when the opened pathname identity or metadata changes.',
    },
    {
      type: 'table',
      headers: ['Receiver state', 'Import publication'],
      rows: [
        ['Exact source commit, clean', 'Activate the imported ready snapshot'],
        ['Exact source commit, dirty', 'Build the current dirty graph from the compatible imported base'],
        ['Current commit descends from source', 'Build the current graph from the compatible imported base'],
        ['Divergent history', 'Store the verified snapshot inactive for later compatible reuse'],
      ],
    },
    {
      type: 'paragraph',
      text: 'Import never fetches Git objects or runs repository code. The same repository and source commit must already exist locally. Threadnote verifies the runtime ABI and every exact-commit file before staging any graph rows, then publishes the ready snapshot and immutable receipt transactionally. Repeated imports reuse the same logical snapshot.',
    },
    {
      type: 'note',
      text: 'No Workset is required. Portable checkpoints touch only disposable native graph storage; schema-v1 memories, uncited legacy memories, stable threadnote:// URIs, and ordinary recall remain available after upgrade.',
    },
    {
      type: 'warning',
      text: 'A digest computed from the same untrusted file proves integrity, not provenance. Obtain the expected SHA-256 digest independently, and treat derived graph structure, names, signatures, and documentation as potentially sensitive internal architecture data. A secret embedded in source can appear in those derived fields even though raw source-file bytes and configured remote credential material are omitted.',
    },
  ],
};
