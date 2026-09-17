export const LEGACY_ARTIFACT_TARGETS = {
  claude: {instruction: {kind: 'block', path: '~/.claude/CLAUDE.md'}, skillRoot: '~/.claude/skills'},
  codex: {instruction: {kind: 'block', path: '~/.codex/AGENTS.md'}, skillRoot: '~/.agents/skills'},
  copilot: {
    instruction: {kind: 'file', path: '~/.copilot/instructions/threadnote.instructions.md'},
    skillRoot: '~/.copilot/skills',
  },
  cursor: {instruction: {kind: 'file', path: '~/.cursor/rules/threadnote.mdc'}, skillRoot: '~/.cursor/skills'},
} as const;
