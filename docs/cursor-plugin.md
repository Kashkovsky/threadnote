# Cursor plugin

Threadnote's Cursor instructions are an always-applied `.mdc` rule distributed through Cursor's public or team
Marketplace. Cursor documents `.cursor/rules` as project scope, so Threadnote no longer writes a supposed user rule
under `~/.cursor/rules`. It also never writes to `~/.cursor/plugins/local`: Cursor and, where applicable, the
organization administrator own plugin installation, updates, and removal.

The implementation follows Cursor's [plugin reference](https://cursor.com/docs/reference/plugins) and
[rule anatomy](https://cursor.com/docs/rules). The root `.cursor-plugin/marketplace.json` points to `cursor-plugin/`,
whose `.cursor-plugin/plugin.json` exposes `rules/threadnote.mdc`. The standalone Threadnote payload includes a copy of
that source only so `threadnote doctor` can validate the installed Marketplace version; lifecycle commands never copy
it into Cursor.

The MCP server remains a separate global Cursor configuration because it contains the user's Threadnote home,
identity, toolset, and platform-specific absolute launcher path. The plugin intentionally has no `mcp.json` and cannot
create a duplicate server entry.

## Install and verify

1. Install Threadnote and configure its Cursor MCP server:

   ```sh
   threadnote mcp-install cursor --apply
   ```

2. Install **Threadnote** from Cursor's Marketplace after the public listing is approved, or run
   `/add-plugin threadnote` in a Cursor agent chat.
3. On a managed Teams or Enterprise account, ask an administrator to allow the public plugin or add the Threadnote
   repository to a team marketplace. The administrator can make it opt-in, default-on, or required according to the
   organization's policy.
4. Reload Cursor or open a new window, then run `threadnote doctor`.

Before the public listing is approved, an administrator-controlled team marketplace is the supported way to exercise
the exact default-branch plugin source. Do not test by copying it to `~/.cursor/plugins/local`.

## Doctor contract

`threadnote doctor` adds a Cursor plugin check only when Cursor is detected. The check is read-only:

- An exact local installation at `~/.cursor/plugins/local/threadnote` fails as unsupported and must be removed outside
  Threadnote before installing the Marketplace version.
- An installed Marketplace copy is discovered in Cursor's plugin cache. Doctor validates the plugin name and semantic
  version, then confirms that `rules/threadnote.mdc` has a description, `alwaysApply: true`, and the complete Threadnote
  instruction block.
- A version older than the source bundled with Threadnote warns that it should be updated through Cursor. A same-version
  rule mismatch fails. A valid newer Marketplace version is accepted.
- A missing plugin warns with public- and team-Marketplace installation guidance.

Install, update, repair, and uninstall do not mutate either local or Marketplace plugin state. They still remove the
legacy Threadnote-managed instruction block from the ignored `~/.cursor/rules/threadnote.md` or `.mdc` paths.

## Why local injection is unsupported

The withdrawn local-plugin implementation copied this bundle to `~/.cursor/plugins/local/threadnote` during Threadnote
install, update, and repair. On a managed enterprise Cursor installation, that copy coincided with Cursor losing access
to every model. Recovery in the observed incident required reinstalling Cursor after clearing its local application
state. An administrator restriction is plausible, but has not been proven as the root cause.

Because the impact was severe, local injection is a hard unsupported boundary. If doctor finds the old copy, fully quit
Cursor and move only that exact plugin directory aside before restarting. If model access is already affected, preserve
any settings you need and coordinate with the Cursor administrator or Cursor support before clearing broader Cursor
state. Threadnote will report the condition but will not delete anything.

## Publish to the public Marketplace

Cursor requires Marketplace plugins to be open source and permissively licensed. Its current
[publisher terms](https://cursor.com/marketplace-publisher-terms) expressly exclude AGPL, GPL, and LGPL components from
submitted plugins. The distributable `.cursor-plugin/` metadata and `cursor-plugin/` subtree are therefore licensed
separately under MIT; the Threadnote executable and the rest of this repository remain AGPL-3.0-or-later. Do not move
runtime code or the repository's AGPL license into the plugin subtree without resolving that Marketplace license
conflict first.

For the first submission:

1. Merge the plugin source into the public repository's default branch. Keep `.cursor-plugin/marketplace.json`,
   `cursor-plugin/.cursor-plugin/plugin.json`, the rule, README, changelog, logo reference, and MIT license in the exact
   commit being submitted.
2. Validate the package and standalone copy:

   ```sh
   bun run cursor-plugin:check
   bun run build
   bun run check:self-contained
   ```

3. Import that default-branch source into an administrator-controlled team marketplace and verify that Cursor lists the
   plugin, the rule is active in a fresh agent chat, the MCP server works independently, and `threadnote doctor` passes.
4. An authorized publisher must sign in and submit `https://github.com/Kashkovsky/threadnote` at
   <https://cursor.com/marketplace/publish>. Submission accepts Cursor's Marketplace Publisher Terms and supplies the
   publisher identity, so it is deliberately not automated by the Threadnote release process.
5. After approval, verify discovery at <https://cursor.com/marketplace>, install the public copy with
   `/add-plugin threadnote`, and repeat the fresh-chat and doctor checks on both unmanaged and admin-managed Cursor.

For an update, increment `version` in `cursor-plugin/.cursor-plugin/plugin.json`, add a matching changelog entry, merge
the source update, and request a re-index through Cursor's publisher workflow. Cursor's publisher terms say that a new
publisher application is not required for every modification, though updates remain reviewable.

The Marketplace name, publisher identity, listing copy, and MIT license boundary must be reviewed by the repository
owner before submission. A Threadnote version tag does not submit or re-index the Cursor plugin.
