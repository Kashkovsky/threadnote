import type {DocsArticle} from './docsTypes.js';

export const projectGuidanceDocsArticle: DocsArticle = {
  id: 'project-guidance',
  title: 'Project guidance across agent surfaces',
  summary: 'Review native project instructions and safely reuse approved Threadnote knowledge across agents.',
  body: [
    {
      type: 'paragraph',
      text: 'User-level Threadnote instructions and project guidance solve different problems. Setup installs a generic user-level bootstrap that teaches one agent surface how to invoke the local Threadnote lifecycle across repositories. Project guidance is repository- or worktree-scoped, host-native policy: the conventions, constraints, and approved decisions that should travel with this project and participate in its normal review and version history. Repository files remain authoritative; see [Authority and storage](authority-and-storage/).',
    },
    {
      type: 'table',
      headers: ['Layer', 'Scope and role', 'Lifecycle'],
      rows: [
        [
          'User-level Threadnote instructions',
          'Generic bootstrap for using Threadnote from one installed agent surface',
          'Managed by setup for that user and surface; not repository policy',
        ],
        [
          'Project guidance',
          'Repository/worktree-specific rules in the host-native target selected by the agent catalog',
          'Reviewed and versioned with the project; managed blocks can be inspected or removed through ownership receipts',
        ],
      ],
    },
    {
      type: 'paragraph',
      text: 'Verified project-guidance targets and explicit safety holds are declared by the canonical agent catalog, keeping documentation aligned with the adapters that implement support—including surfaces that do not read the same global instruction file. Import creates only a private Knowledge Delta candidate for review; it never approves or publishes. Approved active durable memories can then be projected to another agent surface without maintaining a second canonical copy. Shared physical targets use one target-owned receipt. The agent catalog reports unsupported project projection explicitly when precedence, target selection, or activation metadata is not yet safe to automate.',
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
        'threadnote agents list reports the managed project-guidance target or the reason it is unavailable.',
      ],
    },
  ],
};
