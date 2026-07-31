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
THREADNOTE_SITE_BASE=/ bun run site:build
```

The production output is `site-dist/`. It is ignored by Git and rejected if it appears inside `dist/`.

The researched Graphify comparison remains in the FAQ source but is hidden in normal development and production
builds. Set `VITE_SHOW_GRAPHIFY_COMPARISON=true` only when the comparison is ready to be shown again.

## Content and interaction contracts

- Treat current source, CLI help, MCP schemas, checked-in guides, and ADRs as authoritative. The historical GitHub wiki
  describes Threadnote 3 and must not supply 4.0 commands or architecture facts.
- Memory simulations show `recall_context` returning `threadnote://` pointers followed by `read_context`.
- Scoped current-source questions use `inspect_code_graph`; whole-repository statistics, communities, hubs, and
  surprising links use the separate `analyze_code_graph` tool.
- The landing-page graph showcase keeps both MCP flows visible and uses fictional repository names, symbols, paths,
  topology signals, and Manager data.
- Publishing simulations show the preview and explicit approval boundary.
- The Manager demo must always say that it uses mock data and does not read local files.
- Keep useful content in the DOM when animation is disabled. Honor reduced motion and keep canvas scenes decorative.

## GitHub Pages

`.github/workflows/pages.yml` builds the site with the repository-pinned Bun version, uploads only `site-dist/`, and
deploys it through GitHub Pages Actions. The production origin is `https://threadnote.io`, so the workflow builds with
`THREADNOTE_SITE_BASE=/` and all public routes live directly under the domain root.

The repository Pages source must be **GitHub Actions**, not the legacy `main:/docs` source. The transition page formerly
at `docs/index.html` has been retired; do not recreate it or configure Pages to publish the checked-in documentation
tree. A repository `CNAME` file is intentionally absent: GitHub ignores it for custom Actions-based Pages deployments,
and the custom domain is configured in repository settings.

### Custom-domain cutover

Perform the control-plane changes in this order to avoid domain takeover and certificate failures:

1. In personal **GitHub Settings → Pages**, add and verify `threadnote.io`. Publish the TXT record GitHub supplies at
   `_github-pages-challenge-Kashkovsky.threadnote.io` and retain it after verification.
2. After the Website workflow exists on `main`, set **Repository Settings → Pages → Source** to **GitHub Actions**.
3. In the same repository Pages settings, set the custom domain to `threadnote.io` before changing its public DNS.
4. Replace any registrar parking records with all four GitHub Pages apex `A` records:
   `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, and `185.199.111.153`.
5. Set `www` as a `CNAME` directly to `Kashkovsky.github.io` (without `/threadnote`), so GitHub can redirect it to the
   canonical apex. Do not point `www` at the apex and do not publish wildcard records.
6. Optionally add GitHub's four IPv6 `AAAA` records: `2606:50c0:8000::153`, `2606:50c0:8001::153`,
   `2606:50c0:8002::153`, and `2606:50c0:8003::153`.
7. After DNS propagation and certificate provisioning, enable **Enforce HTTPS**, dispatch the Website workflow, and
   verify `/`, `/docs/`, `/pro-tips/`, `/manager-demo/`, `/faq/`, `/robots.txt`, and `/sitemap.xml`.

After cutover, set the repository About homepage to `https://threadnote.io/` and submit
`https://threadnote.io/sitemap.xml` to the search-engine webmaster consoles in use. The default project Pages URL and
the configured `www` variant should redirect to the canonical apex.

The CLI release pipeline copies only `assets/`, `config/`, and `manager/`. `bun run check:self-contained` rejects
`docs/`, `website/`, or `site-dist/` inside a compiled release.
