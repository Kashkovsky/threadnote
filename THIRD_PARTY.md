# Third-party software

Threadnote orchestrates third-party software that it does not bundle or redistribute. This file records that software
and its licensing for attribution and clarity.

## OpenViking

- **Homepage:** https://openviking.ai/
- **Distribution:** PyPI — `openviking` (installed via `uv tool install openviking[local-embed]`, with `pipx` / `pip --user` fallbacks)
- **License:** GNU Affero General Public License v3.0 (AGPL-3.0)

Threadnote is a thin workflow layer over OpenViking. At runtime it:

- installs OpenViking onto the user's machine from PyPI;
- invokes the `ov` / `openviking` command-line program as a separate process; and
- communicates with `openviking-server` over MCP / local HTTP.

Threadnote does **not** incorporate OpenViking's source code, does **not** modify OpenViking, and does **not** ship
OpenViking binaries or source inside its npm package. OpenViking is obtained directly by the user from PyPI under its own
AGPL-3.0 license, and its source and license notices are distributed with that package independently of Threadnote.

Because OpenViking is used as a separate program at arm's length (subprocess + inter-process communication) rather than
linked or incorporated, Threadnote is not a derivative work of OpenViking. Threadnote's own license (AGPL-3.0-or-later,
see [`LICENSE`](./LICENSE)) applies only to Threadnote's own code.

This acknowledgment is provided as good-faith attribution to the OpenViking project; it is not legal advice.

## npm dependencies

Runtime npm dependencies are declared in [`package.json`](./package.json) and retain their own licenses. As of this
writing the direct runtime dependencies are:

- `react-markdown` (MIT)
- `remark-gfm` (MIT)

Each is installed from npm under its respective license; consult the package's own metadata for the authoritative terms.
