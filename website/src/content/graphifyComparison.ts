export const graphifyReviewedSource = {
  commit: '282976b2f4066b55cf2fa346c3d5568f7ac044e2',
  reviewedAt: '2026-08-25',
  version: 'v0.9.49',
  sourceUrl: 'https://github.com/Graphify-Labs/graphify/tree/282976b2f4066b55cf2fa346c3d5568f7ac044e2',
  packageUrl: 'https://pypi.org/project/graphifyy/0.9.49/',
} as const;

export const graphifySharedCapabilities = [
  {
    title: 'Architecture signals',
    body: 'Both expose communities, hubs and god nodes, and surprising links. The algorithms and identifiers differ, but the investigative workflow is shared.',
  },
  {
    title: 'Relationships beyond pairs',
    body: 'Both represent n-ary or hyperedge-style groups so one relationship can connect more than two graph members without pretending it is only a pair.',
  },
  {
    title: 'Auditable analysis',
    body: 'Both provide confidence audits and generated reports. Each product records provenance differently, so compare the underlying evidence—not just the label.',
  },
  {
    title: 'Portable core formats',
    body: 'Both can produce JSON, GraphML, HTML, and SVG outputs. Additional destinations differ, but these core export families are parity rather than a differentiator.',
  },
] as const;

export const graphifyVerifiedDifferences = [
  {
    dimension: 'Product workflow',
    threadnote:
      'Keeps durable decisions, handoffs, and team memory beside current-source code intelligence for repeated agent sessions.',
    graphify:
      'Builds, analyzes, and queries a project graph, with installable assistant skills and an optional local or shared MCP server.',
  },
  {
    dimension: 'Storage architecture',
    threadnote:
      'Pages immutable graph generations through SQLite, promotes snapshots atomically, and keeps the previous ready snapshot queryable during refresh.',
    graphify:
      'Persists one graph file and hydrates it into NetworkX for analysis and traversal; v0.9.49 documents a configurable 512 MiB graph-file load guard.',
  },
  {
    dimension: 'Repository change model',
    threadnote:
      'Models exact commits plus isolated staged, unstaged, renamed, deleted, and untracked worktree overlays; compatible commits can reuse a ready anchor.',
    graphify:
      'Uses code extraction caches plus update, watch, and Git-hook workflows; semantic document or media refresh can be tracked separately.',
  },
  {
    dimension: 'Retrieval model',
    threadnote:
      'Combines exact and lexical retrieval with an installed local embedding model for vector seeds—without a hosted embedding service or provider-token spend—then returns bounded current-snapshot evidence and stable follow-up identifiers.',
    graphify:
      'Uses graph traversal and term or trigram matching for query, path, explain, neighbors, and impact workflows; its package explicitly is not a vector index.',
  },
  {
    dimension: 'Document and media semantics',
    threadnote:
      'Extracts supported document text locally and keeps image, audio, and video assets at deterministic filename and metadata scope rather than claiming OCR or transcription.',
    graphify:
      'Can use an assistant or configured model for document, PDF, and image semantics, and offers an optional local faster-whisper path for audio or video transcription.',
  },
  {
    dimension: 'Additional destinations',
    threadnote:
      'Centers agent tools, a bounded Manager, and explicit selected-memory projection to Obsidian rather than remote graph-database sinks.',
    graphify:
      'Adds project-graph destinations such as Obsidian, wiki and call-flow artifacts, Cypher, Neo4j, and FalkorDB.',
  },
] as const;
