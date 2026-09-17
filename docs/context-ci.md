# Context CI

`threadnote context check` is a local, provider-neutral CI gate. It compares the current checkout with a Git base and
reports bounded citation, graph-impact, conflict, documentation, and capture findings. It does not call a hosted Threadnote
service, mutate memory, prepare a code graph, push a branch, or include source and memory bodies in its output. When a
current local graph is already ready, the same check also traces bounded reverse impact from changed paths.

## Command contract

Fetch the comparison base, then run one of the stable output formats:

```sh
threadnote context check --project "$THREADNOTE_PROJECT" --base origin/main --format text
threadnote context check --project "$THREADNOTE_PROJECT" --base origin/main --format json
threadnote context check --project "$THREADNOTE_PROJECT" --base origin/main --format sarif > threadnote-context.sarif
```

The legacy `--json` and `--sarif` flags remain aliases. Do not combine selectors for different formats.

| Exit | CI meaning                                                                                     |
| ---: | ---------------------------------------------------------------------------------------------- |
|  `0` | Evidence is complete and no affected or project-conflict finding exists.                       |
|  `1` | At least one actionable citation, graph-impact, conflict, document, or capture finding exists. |
|  `2` | Invocation is invalid or required Git, graph, citation, or health evidence is unavailable.     |

Treat exit `2` as a failed gate, never as clean. Shallow checkouts must fetch the requested base commit. JSON and SARIF
contain bounded categories, severity, repairability, counts, and stable fingerprints. They omit source fragments,
memory bodies, memory URIs, changed paths, repository identities, queries, and credentials.

The report combines five bounded evidence lanes: direct citation health, exact-current graph impact, active candidate
or relation conflicts, changed or missing documentation citations, and capture advisories for uncited impacted code.
Capture advisories are capped at eight. Graph impact never starts indexing: a missing, stale, partial, timed-out, or
limit-truncated graph returns `graph-impact-evidence-*` with exit `2`, while retaining any independently proven
findings. An empty Git diff does not require graph evidence.

## CI-provider pattern

Every provider can use the same three stages:

1. Check out enough Git history to resolve the base ref.
2. Capture the JSON or SARIF artifact even when the command exits `1` or `2`.
3. Publish the artifact if the provider supports annotations, then fail the job with the captured Threadnote exit code.

The checked-in [GitHub Actions example](../.github/examples/context-check.yml) follows this pattern. Configure the
`THREADNOTE_MEMORY_REPOSITORY` Actions variable with the clone URL of the reviewed Git memory share. The job connects
it read-only and explicitly fails when the selected project loads zero canonical records, preventing a fresh runner
from passing vacuously. It uploads SARIF to GitHub code scanning but grants Threadnote no repository write credential
and never pushes. Copy it into `.github/workflows/` in a consuming repository and replace the example project name.

Context Check makes a transitive claim only for the exact-current bounded graph result included in that invocation. It
never treats an incomplete graph as proof that no callers, dependants, or uncited architectural changes exist.

## Local proposal materialization

The provider-neutral Knowledge Delta Git proposal is separately materialized through an explicit local action. Preview
is the default. Apply rechecks the proposal hash, repository identity, exact base commit, and every target CAS before
creating the deterministic proposal branch and commit. A retry reuses an existing matching branch result; a changed
binding is a stable conflict. Materialization never pushes, opens a pull request, calls a hosted provider, or schedules
hosted work.
