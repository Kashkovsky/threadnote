---
name: publish-release
description: Prepare a Threadnote patch release (version bump, curated notes, PR, then tag after merge). Use when cutting 4.6.x, writing .github/release-notes, running release:prepare, or publishing a standalone release.
---

# Publish a patch release

Authority: `docs/releasing.md`. This skill is the mechanical path only.

## Prepare (this PR)

1. Write `.github/release-notes/vX.Y.Z.md` first. Start with `## What's new`, then one user-visible opening sentence (social-card headline ≤ 240 characters after the `Threadnote X.Y.Z` prefix). No validation/checks section. Follow `v4.6.4`–`v4.6.6`.
2. Dry-run, then apply:

```sh
bun run release:prepare -- --patch --dry-run --json
bun run release:prepare -- --version X.Y.Z --json
```

`--patch` increments the checked-in `package.json` patch. The script refuses missing/invalid notes and does not commit, push, merge, or tag. 3. Commit notes + `package.json` on the release PR. Let CI run the full suite.

## After merge

Tagging happens **after** the release commit is on protected main, not from the PR branch:

1. Confirm HEAD is that exact reviewed commit and matches `package.json` + `vX.Y.Z.md`.
2. `git tag vX.Y.Z` and push the tag immediately. Do not land another main commit in between.
3. Do not create the GitHub Release by hand. Wait for `Publish standalone release`.
4. If tagging cannot finish promptly, stop the release window rather than continuing main work under unreleased stable wording.

## Do not

- Skip hooks, force-push, or move a `v*` tag.
- Treat Context Brief / Memory Connections / code-memory-link scale jobs as optional when those surfaces changed; `docs/releasing.md` lists the gates.
- Mention contributor-only skills in user-facing notes unless the website needs a line.

---
