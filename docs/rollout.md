# Rollout

Start with a local-only pilot.

## Pilot Steps

1. Run `doctor --dry-run`.
2. Run `install --dry-run`, review paths, then run `install`.
3. For a solo pilot, use the default local embedding backend; for broader rollout, configure a company-approved
   embedding and summary provider in `~/.openviking/ov.conf`.
4. Run `start` and confirm `doctor` reports a healthy server.
5. Run `seed --dry-run` and inspect every planned import.
6. Run `seed`.
7. Run `seed-skills --dry-run`, then `seed-skills`.
8. Install MCP for one agent, validate recall, then install the second.

## Acceptance Criteria

- Install completes in under 10 minutes after prerequisites.
- `doctor` reports clear actionable checks.
- Codex and Claude can both store and recall a shared handoff.
- Seeding curated guidance does not import known secret patterns.
- Fresh agents can recall repo testing guidance and discover relevant skills.
- `uninstall --dry-run` previews removal, and `uninstall` leaves memories intact unless `--erase-memories` is explicit.
