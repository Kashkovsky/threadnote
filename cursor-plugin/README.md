# Threadnote for Cursor

This plugin gives Cursor an always-applied `.mdc` rule for using Threadnote as shared local context, engineering memory,
code-graph search, and agent handoffs. Plugin rules are a documented user-level integration, unlike writing a rule into
the project-only `~/.cursor/rules` path.

## Prerequisites

- Cursor 2.5 or newer
- A working Threadnote installation
- The Threadnote MCP server configured for Cursor with `threadnote mcp-install cursor --apply`

The plugin intentionally does not bundle `mcp.json`. Threadnote's MCP configuration contains user-specific storage
settings and an absolute, platform-specific launcher path. The Threadnote CLI owns that configuration so installing the
plugin cannot create a second, conflicting `threadnote` MCP server.

## Install

When Threadnote detects Cursor, `threadnote install`, `threadnote update`, and `threadnote repair` install or refresh
this directory at `~/.cursor/plugins/local/threadnote`. Reload the Cursor window after the first installation or an
update.

For source development before building a standalone release, this directory can also be copied to that location
manually. The plugin should appear under Cursor Settings > Plugins > Installed.

After optional Marketplace publication, users can instead find **Threadnote** in Cursor Settings > Plugins or run
`/add-plugin threadnote` in a Cursor agent chat. A Threadnote-managed local copy takes precedence and should be removed
with `threadnote uninstall` before testing the Marketplace copy.

Run `threadnote doctor` to verify both the global Cursor MCP entry and the installed plugin rule. Threadnote only runs
the plugin check when it detects a Cursor installation. Threadnote refuses to overwrite or remove an unmarked local
plugin directory at the same path.

## License

The files distributed from this plugin directory are licensed under the MIT License. The Threadnote runtime and the
rest of its repository remain licensed under AGPL-3.0-or-later.
