import type {DocsArticle} from './docsTypes.js';

export const localAiDocsArticle: DocsArticle = {
  id: 'local-ai',
  title: 'Local AI',
  summary:
    'Core local embeddings plus an optional generation model that writes retrieval keywords for memory enrichment.',
  keywords: [
    'memory enrichment',
    'enrich-memories',
    'generation model',
    'retrieval keywords',
    'local generation',
    'models select generation',
  ],
  body: [
    {
      type: 'paragraph',
      text: 'Install and repair automatically extract, verify, select, and preserve the pinned 36.7 MB BGE Small embedding model bundled in the standalone executable. Model manifests pin revision, filename, byte size, SHA-256, license, runtime compatibility, and memory class before atomic promotion.',
    },
    {
      type: 'paragraph',
      text: 'The parent CLI, MCP, or Manager process lazily starts one supervised local-model child from the same standalone executable. The worker keeps model sessions warm and isolates native-addon crashes from the long-lived parent. Threadnote requests prebuilt node-llama-cpp binaries only and never silently compiles llama.cpp.',
    },
    {
      type: 'code',
      language: 'sh',
      code: `threadnote models list
threadnote models runtime
threadnote models verify bge-small-en-v1.5-q8
threadnote index status`,
    },
    {
      type: 'note',
      text: 'Embedding is core functionality. Reranking and structured generation are optional roles and are not silently selected; the measured Jina reranker failed the frozen no-answer gate.',
    },
    {
      type: 'heading',
      text: 'Memory enrichment',
    },
    {
      type: 'paragraph',
      text: 'Semantic recall uses the core embedding model. Memory enrichment is a separate, optional step: a selected local generation model proposes retrieval keywords that Threadnote stores on the memory. Those keywords participate in later lexical ranking. Recall still works without them.',
    },
    {
      type: 'heading',
      text: 'Enable enrichment',
    },
    {
      type: 'paragraph',
      text: 'Install a catalog model whose role is generation, then select it for that role. A download alone does not enable enrichment.',
    },
    {
      type: 'code',
      language: 'sh',
      code: `threadnote models list
threadnote models install <model-id>
threadnote models select generation <model-id>`,
    },
    {
      type: 'paragraph',
      text: 'After a generation model is selected, new remember and MCP store writes try enrichment automatically. If the local worker cannot run, Threadnote still stores the memory and prints a skip warning. Backfill existing memories with enrich-memories; preview first, then apply.',
    },
    {
      type: 'code',
      language: 'sh',
      code: `threadnote enrich-memories
threadnote enrich-memories --apply
# Install and select the pinned catalog generation model when none is selected:
threadnote enrich-memories --apply --install-local-ai`,
    },
    {
      type: 'note',
      text: 'enrich-memories skips smoke records and memories with pending code anchors. --force regenerates keywords. Shared memories are written locally; run threadnote share sync to publish them. threadnote local-ai remains a deprecated compatibility alias for the models surface.',
    },
  ],
};
