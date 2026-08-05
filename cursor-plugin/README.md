# Threadnote for Cursor

This plugin gives Cursor an always-applied `.mdc` rule for using Threadnote as shared local context, engineering memory,
code-graph search, and agent handoffs. Plugin rules provide user- or team-level distribution without pretending that
Cursor's documented project rule directory is a user-level rule location.

The Marketplace logo is bundled at `assets/logo.svg`. It keeps the canonical Threadnote mark unchanged and places it
on a dark plate so the mint geometry remains legible on both light and dark Marketplace surfaces.

## Prerequisites

- Cursor 2.5 or newer
- A working Threadnote installation
- The Threadnote MCP server configured for Cursor with `threadnote mcp-install cursor --apply`

The plugin intentionally does not bundle `mcp.json`. Threadnote's MCP configuration contains user-specific storage
settings and an absolute, platform-specific launcher path. The Threadnote CLI owns that configuration so installing the
plugin cannot create a second, conflicting `threadnote` MCP server.

## Install

Once the plugin is publicly listed, find **Threadnote** in Cursor's Marketplace or run `/add-plugin threadnote` in a
Cursor agent chat. On a managed Teams or Enterprise account, ask an administrator to allow the public plugin or add
this repository to a team marketplace and choose the appropriate install policy.

The Threadnote CLI does not copy, refresh, or remove this plugin under `~/.cursor/plugins/local`. Installation and
updates remain owned by Cursor and the organization's Marketplace policy. Reload Cursor after installation, then run
`threadnote doctor` to verify both the global Cursor MCP entry and the installed rule. The plugin check is omitted when
Threadnote does not detect Cursor.

Contributors can validate the source with `bun run cursor-plugin:check`. Exercise an unpublished build through an
administrator-controlled team marketplace; do not inject it into Cursor's local-plugin directory.

## License

The files distributed from this plugin directory are licensed under the MIT License. The Threadnote runtime and the
rest of its repository remain licensed under AGPL-3.0-or-later.
