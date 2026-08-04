# Cursor plugin

Threadnote's Cursor integration is a bundled local plugin containing an always-applied `.mdc` rule. Cursor documents
`.cursor/rules` as project scope; Threadnote no longer writes user instructions there. When Cursor is detected,
Threadnote installs the plugin at `~/.cursor/plugins/local/threadnote` during install, update, and repair. The MCP server
remains a separate global Cursor configuration because it contains the user's Threadnote home, identity, toolset, and
platform-specific absolute launcher path.

The implementation follows Cursor's [plugin reference](https://cursor.com/docs/reference/plugins) and
[rule anatomy](https://cursor.com/docs/rules).

## Local verification

1. Install Threadnote and configure its Cursor MCP server:

   ```sh
   threadnote mcp-install cursor --apply
   ```

2. Run `threadnote install` or `threadnote repair`. Threadnote atomically installs the bundled plugin at
   `~/.cursor/plugins/local/threadnote/`; the destination contains `.cursor-plugin/plugin.json` directly beneath the
   `threadnote` directory.
3. In Cursor, run **Developer: Reload Window**, then confirm that Threadnote appears in
   **Cursor Settings > Plugins > Installed**.
4. Run the repository checks and Threadnote diagnostics:

   ```sh
   bun run cursor-plugin:check
   threadnote doctor
   ```

The doctor reports a Cursor plugin check only when Cursor is installed. It recognizes the managed local directory and
Cursor's Marketplace cache, verifies the plugin manifest and version, and confirms that `rules/threadnote.mdc` has a
description, `alwaysApply: true`, and the complete managed Threadnote instruction block. Install, update, repair, and
uninstall only replace or remove a local plugin carrying Threadnote's ownership marker; an unmarked directory or a
symlink is preserved with a warning.

## Optional: publish to the Cursor Marketplace

Cursor requires Marketplace plugins to be open source and permissively licensed. Its current
[publisher terms](https://cursor.com/marketplace-publisher-terms) expressly exclude AGPL, GPL, and LGPL components from
submitted plugins. The distributable `cursor-plugin/` subtree and root Marketplace metadata are therefore licensed
separately under MIT; the Threadnote executable and the rest of this repository remain AGPL-3.0-or-later. Do not move
runtime code or the repository's AGPL license into the plugin subtree without resolving that Marketplace license
conflict first.

For the first submission:

1. Make the repository public and merge the plugin source into the default branch. The root
   `.cursor-plugin/marketplace.json` must point to `cursor-plugin`, whose own manifest is
   `cursor-plugin/.cursor-plugin/plugin.json`.
2. Keep the plugin manifest, Marketplace entry, rule, README, changelog, and MIT license in the public commit being
   submitted. Confirm that the rule body still matches `config/agent-instructions.md` with
   `bun run cursor-plugin:check`.
3. Test that exact default-branch commit locally using the steps above. Verify the MCP server and plugin independently
   in `threadnote doctor`, start a fresh Cursor agent chat, and confirm that the rule is listed as active.
4. Sign in to Cursor and open <https://cursor.com/marketplace/publish>. Submit
   `https://github.com/Kashkovsky/threadnote` as the public repository and complete the publisher application. Cursor
   reviews publisher identity, source, security, quality, and data handling before listing the plugin.
5. After approval, verify discovery in <https://cursor.com/marketplace> and installation from Cursor with
   `/add-plugin threadnote`. Remove or rename any local test copy first so the Marketplace installation is the one being
   exercised.

For an update, increment `version` in `cursor-plugin/.cursor-plugin/plugin.json`, add a matching changelog entry, run
the checks again, and merge the update to the submitted repository. Then request a re-index from Cursor through the
publisher workflow; the publisher terms say a new publisher application is not required for each modification, but
updates remain subject to review.

The Marketplace name, publisher identity, listing copy, and MIT licensing must be reviewed by the repository owner
before submission. Publishing accepts Cursor's Marketplace Publisher Terms and is an external action; it is not part of
the Threadnote release workflow.
