# Threadnote website

The public Threadnote 4 website is a separate React, TypeScript, and Three.js application under `website/`. It is not a
Manager asset and is never copied into a standalone CLI release.

## Local development

```bash
bun install --frozen-lockfile
bun run site:dev
```

The site uses independent HTML entry points so every public route has a real document and works without hash routing:

- `/` — product landing page
- `/docs/` — searchable 4.0 documentation
- `/pro-tips/` — animated workflow simulations
- `/manager-demo/` — an interactive Manager using synthetic data only
- `/faq/` — product questions and comparisons

Run the website checks and a production build with:

```bash
bun run site:check
THREADNOTE_SITE_BASE=/threadnote/ bun run site:build
```

The production output is `site-dist/`. It is ignored by Git and rejected if it appears inside `dist/`.

## Content and interaction contracts

- Treat current source, CLI help, MCP schemas, checked-in guides, and ADRs as authoritative. The historical GitHub wiki
  describes Threadnote 3 and must not supply 4.0 commands or architecture facts.
- Memory simulations show `recall_context` returning `threadnote://` pointers followed by `read_context`.
- Current-source questions use the separate `inspect_code_graph` tool.
- Publishing simulations show the preview and explicit approval boundary.
- The Manager demo must always say that it uses mock data and does not read local files.
- Keep useful content in the DOM when animation is disabled. Honor reduced motion and keep canvas scenes decorative.

## GitHub Pages

`.github/workflows/pages.yml` builds the site with the repository-pinned Bun version, uploads only `site-dist/`, and
deploys it through GitHub Pages Actions. The workflow sets `THREADNOTE_SITE_BASE=/threadnote/` for project Pages URLs.

The repository Pages source must be **GitHub Actions**, not the legacy `main:/docs` source. This is a one-time repository
setting when the website workflow reaches the default branch. Keep the lightweight `docs/index.html` transition page
until that switch is complete so the existing project Pages URL never returns a 404:

1. Merge the website workflow and source into `main`.
2. In **Settings → Pages → Build and deployment**, change **Source** to **GitHub Actions**.
3. Dispatch the **Website** workflow, verify the production deployment, then the transition page may be removed in a
   later change.

The CLI release pipeline copies only `assets/`, `config/`, and `manager/`. `bun run check:self-contained` rejects
`docs/`, `website/`, or `site-dist/` inside a compiled release.
