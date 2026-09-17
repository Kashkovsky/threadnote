import type {DocsArticle} from './docsTypes.js';

export const projectGuidanceDocsArticle: DocsArticle = {
  id: 'project-guidance',
  title: 'Project guidance across agent surfaces',
  summary: 'Review native project instructions and safely reuse approved Threadnote knowledge across agents.',
  body: [
    {
      type: 'paragraph',
      text: 'Existing AGENTS.md, CLAUDE.md, Cursor rules, and Copilot instructions are adapter-declared import sources and project targets. Import creates only a private Knowledge Delta candidate for review; it never approves or publishes. Approved active durable memories can then be projected to another agent surface without maintaining a second canonical copy.',
    },
    {
      type: 'code',
      language: 'sh',
      code: `threadnote guidance import <surface> --project <name> [--cwd <path>] [--apply] [--json]

threadnote guidance project <surface> --project <name> \\
  --memory <uri> [--memory <uri> ...] [--cwd <path>] [--apply] [--force] [--json]

threadnote guidance status <surface> --project <name> [--cwd <path>] [--json]
threadnote guidance remove <surface> --project <name> [--cwd <path>] [--apply] [--force] [--json]`,
    },
    {
      type: 'list',
      items: [
        'All commands preview by default; import --apply creates or reuses a private candidate review.',
        'Projection is deterministic and records provenance and hashes in a managed block.',
        'Conflicts require --force, and force never overwrites unmanaged text.',
        'Status reports current, missing, modified, stale, or evidence-unavailable.',
        'Removal is preview-first and preserves unmanaged content; drift feeds context health and Context Check.',
      ],
    },
  ],
};
