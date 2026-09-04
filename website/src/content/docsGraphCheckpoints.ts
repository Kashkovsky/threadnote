import type {CliCommandReference, DocsArticle} from './docsTypes.js';

export const graphCliCommand: CliCommandReference = {
  command: 'graph',
  summary: 'Build, inspect, analyze, report on, and export the current snapshot-aware polyglot code graph.',
  examples: [
    'threadnote graph query --query "session refresh"',
    'threadnote graph query --workset commerce --query "checkout contract" --budget-tokens 1250',
    'threadnote graph query --workset commerce --cursor cgwc_…',
    'threadnote graph node --node-id cgs_…',
    'threadnote graph neighbors --node-id cgs_… --direction incoming',
    'threadnote graph explain --symbol RefreshSession',
    'threadnote graph path --from LoginScreen --to TokenStore',
    'threadnote graph path --workset commerce --from cgr_… --to cgr_…',
    'threadnote graph impact --base origin/main',
    'threadnote graph impact --workset commerce --query cgr_…',
    'threadnote graph topology --workset commerce --json',
    'threadnote graph analyze --view full',
    'threadnote graph report --output architecture-report.md',
    'threadnote graph export --format graphml --output code-graph.graphml',
    'threadnote graph checkpoint export --output threadnote-graph.cgcp',
    'threadnote graph checkpoint verify --input threadnote-graph.cgcp --expected-digest sha256:…',
    'threadnote graph checkpoint import --input threadnote-graph.cgcp --expected-digest sha256:…',
    'threadnote graph share init --write-config --organization acme',
    'threadnote graph share join --read-only',
    'threadnote graph share join --coordinator http://127.0.0.1:18765',
    'threadnote graph publisher bootstrap',
    'threadnote graph publisher serve',
    'threadnote graph publisher serve --listen 127.0.0.1:18765',
    'threadnote graph contribute status',
    'threadnote graph worker --json',
    'threadnote graph index',
  ],
};

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
    'graph share',
    'shared checkpoint',
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
      type: 'paragraph',
      text: 'Organization graph sharing reuses this checkpoint contract. A checked-in `.threadnote/graph-share.json` pointer names a digest-pinned profile and publisher key fingerprint. `threadnote graph share join --read-only` records local trust only. The next `threadnote graph index` or committed-base ensure imports a verified shared ancestor and builds only the local overlay. `graph share status` reports `lastImport` without replacing last-good provenance when a transfer misses. `graph publisher serve` observes canonical HEAD, freezes a descendant batch, verifies receipts, hydrates the publisher parse cache, then exports a signed compaction checkpoint. Failed verification and unrelated HEAD keep the last signed frontier. `graph publisher serve --listen 127.0.0.1:port` walks `/v1/status.phase` through frozen→assembling→verifying→published and serves the loopback coordinator and digest CAS so additional homes can join without sharing a filesystem CAS directory. HTTP digest CAS remains 32 MiB per blob: publishers still store the assembled `.cgcp`, but HTTP transfers independently digest-addressed cgcp prefix and TCG1 frames from checkpoint metadata (`application/vnd.threadnote.graph.checkpoint.v1+json`), and clients assemble on disk before import. Clients select the newest published ancestor. After a contributing join, local parse batches enqueue parse-result artifacts (never source text) and upload them once the coordinator is reachable. Worker CAS is separate from the canonical frontier, and the coordinator API never accepts source or graph records. MCP then reports `source.kind: shared-base-plus-local-overlay` with the profile digest, frontier commit, and local commit. Missing enrollment keeps ordinary local indexing. Invalid signatures stay fail-closed for the candidate and preserve the last ready local graph. Recall does not start this work.',
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
