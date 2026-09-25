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

Context Check makes a transitive claim only for the exact-current bounded graph result included in that invocation. A
`clean-with-evidence-warning` result is successful for automation but explicitly does not prove that callers,
dependants, or uncited architectural changes are absent.

## Local proposal materialization

The provider-neutral Knowledge Delta Git proposal is separately materialized through an explicit local action. Preview
is the default. Apply rechecks the proposal hash, repository identity, exact base commit, and every target CAS before
creating the deterministic proposal branch and commit. A retry reuses an existing matching branch result; a changed
binding is a stable conflict. Materialization never pushes, opens a pull request, calls a hosted provider, or schedules
hosted work.

## Hosted read-only Context CI (O4a)

The hosted operator builds on the same versioned Context Check parser and SARIF projection. It accepts legacy v1 and
current v2 reports and is disabled by default.
It adds no stdio tool, automatic repair, branch mutation, or Context PR automation. Context PR automation remains a
separately gated follow-up requiring its own provider write identity, review policy, and rollout approval.

A trusted deployment integrates the provider-neutral entry points in
`src/remote_memory/hosted_context_ci_postgres.ts`: `enqueueHostedContextCiWebhook` accepts events and
`runHostedContextCiOperator` advances one durable stage for one explicitly selected tenant. The evaluator call omits
`publisher`; the publication call supplies it. Run tenants in bounded rounds with a deployment concurrency cap. The
store serializes each tenant across replicas and uses `SKIP LOCKED` to avoid duplicate work. Initialize each fixed-role
SQL pool with `initializeHostedContextCiStorage` at startup (first use also initializes it). Catalog and exact privilege
checks run once for that pool, before tenant work. Reinitialize after any migration, role, grant, or lifecycle-helper
change, or replace the pool; never use `SET ROLE` or mutate its authenticated identity. Failed initialization blocks
all subsequent work until explicit successful reinitialization. There is no public webhook
listener or native Git-provider adapter in this slice; the host must supply the authenticated gateway, pinned reader,
and check publisher described below before enabling traffic.

### Admission and identity boundary

Register a policy for an existing tenant/share/project with exact `source`, `installationId`, `repositoryId`, `refs`,
and `baseRefs` allowlists. Wildcards are unsupported. Registering a policy does not opt the target in. The source is a
configured trusted webhook gateway, which must authenticate the Git provider's native signature and derive trust,
installation, repository, and fork metadata from that verified event. Never derive these claims from PR text or an
unverified request. The gateway signs its normalized envelope using HMAC-SHA256 over
`JSON.stringify([source, deliveryId, timestamp, body])`; `timestamp` is Unix milliseconds as a string. The signature is
lowercase hex, the secret is at least 32 bytes, and admission allows at most five minutes of clock skew. Native Git
providers use different signature schemes; a gateway must verify those before producing this envelope.

The body is a strict JSON object with `version: 1`, `kind` (`push`, `pull_request`, or `rerun`), `trusted: true`,
`installationId`, `repositoryId`, `headRepositoryId`, `ref`, `baseRef`, `headCommit`, and `baseCommit`. Both commits must
be full lowercase Git object IDs. Forks, untrusted events, privileged trigger kinds, unknown fields, wrong sources,
and mismatched allowlists are rejected before reader or publisher invocation. A rerun for the same tenant, policy,
repository, refs, and immutable commits reuses the existing job even when its signed delivery ID or event kind changes.
Policy changes require opt-out first and create a new comparison identity; existing jobs cannot borrow the new policy.

Use three separate service identities:

- The gateway/queue account uses `deploy/remote-memory/grants/003-context-ci-worker.sql`. It can operate only the
  content-free CI queue and receipts, with forced tenant RLS; it cannot read memory bodies or modify policy/opt-in.
- The evaluator identity has exactly `repository:read` and `context:check`. Resolve the allowlisted head and base refs
  to the admitted commits before and after evaluation and again immediately before publication. The trusted adapter
  runs a pinned Threadnote evaluator against an isolated immutable checkout; it must never execute repository scripts,
  hooks, workflows, or PR-supplied commands. Missing or moved refs fail closed.
- The publisher identity is distinct and has only `checks:publish`, scoped to the installation/repository. It receives
  the immutable head, a stable idempotency key, and validated content-free diagnostics. It receives no memory, source,
  reader credential, or checkout. The host must verify actual provider scopes when constructing these adapters; capability
  fields describe that verified identity, not assertions accepted from webhook input. Provider upsert must honor the
  idempotency key and reject a changed diagnostic digest. Exit `1` and exit `2` both publish a failed check.

The pilot uses Okta through the existing provider-neutral OAuth/OIDC issuer, audience, client, and subject bindings.
There are no Okta-specific authorization branches and no reuse of end-user identity tokens as Git write credentials.
Set finite provider request deadlines shorter than the 60-second database transaction deadline. Retries after an
ambiguous provider timeout use the same publication key and the already persisted diagnostic digest.

### Queue, diagnostics, and receipts

`queueLimit` bounds unarchived jobs per tenant (1–10,000), including terminal jobs awaiting archival. Exhaustion returns
`queue-full`. The operator-only `archive` action compacts published and failed jobs under the lifecycle and tenant locks,
clearing their job payload and diagnostics while retaining an immutable tombstone with the comparison identity, input
digest, terminal outcome, and at most 20 bounded attempt receipts. Archived rows no longer consume queue capacity;
replayed events still return `replay` indefinitely. Tombstones and receipts cannot be updated or deleted, and the worker
cannot archive jobs. Archival is explicit and remains available after rollback or opt-out. `requestsPerMinute` (1–1,000) is shared by that tenant's
repositories. Where active policies differ, the smallest bound applies. Rate rejection returns a retry delay; already
admitted reruns do not consume another slot or rate allowance. One tenant's limit never consumes another tenant's quota.

Evaluation is committed before publication, and its JSON/SARIF is reused unchanged for every publication retry. Reports
have at most 500 findings, bounded input bytes, closed categories, counts, and fingerprints. The hosted projection
replaces the local project label with `hosted-context-ci` and rejects arbitrary fields; it never publishes memory/source
bodies, URIs, paths, raw errors, or credentials. Missing evidence remains exit `2`, never clean.

Each attempt persists an immutable content-free receipt: job ID, attempt, stage/outcome, report/publication digests, and
an optional closed failure category and retry time. Provider publication IDs are hashed. Backoff starts at 30 seconds,
doubles to a one-hour ceiling, and stops at the configured attempt budget (one additional publication stage is allowed
after evaluation). Changed policy or immutable refs are terminal failures. Competing workers cannot advance the same
job or tenant concurrently. A process crash releases the database lock, and an ambiguous publication can be safely
retried only by an adapter honoring the stable idempotency key.

### Operator control and rollback

Apply migration 009 with the existing `remote-memory-operator migrate` command. Use an operator account for policy
registration and switches; use the dedicated queue role for admission. The control command reads a bounded JSON file:

```sh
threadnote remote-memory-operator ci-control --input action.json --receipt receipt.json
```

Supported actions are `{"action":"register","policy":{...}}`, `{"action":"enable","enabled":true}`,
`{"action":"opt-in","tenantId":"...","repositoryId":"...","enabled":true}`,
`{"action":"archive","tenantId":"...","repositoryId":"..."}`, and
`{"action":"enqueue","tenantId":"...","repositoryId":"...","webhook":{...}}`. Registration builds the immutable
policy digest from the policy fields described above plus `tenantId`, `shareId`, `project`, `readerIdentity`,
`publisherIdentity`, `queueLimit`, `requestsPerMinute`, and `maxAttempts` (1–10). Database credentials are supplied only
through `THREADNOTE_REMOTE_DATABASE_URL`; admission reads `THREADNOTE_CONTEXT_CI_WEBHOOK_KEY` from the environment.
Secrets never belong in action files or receipts.

Opt-out (`enabled: false` on `opt-in`) stops new admissions and both pending stages for that repository. Global rollback
(`enabled: false` on `enable`) stops the entire hosted CI path. Lifecycle share locks serialize these changes with an
in-flight stage; a successful switch receipt means that stage has finished and new stages cannot start. Apply deployment
request deadlines so rollback cannot wait indefinitely. Preserve the queue and receipts for review and replay. Neither
switch changes local `threadnote context check`, local stdio, hosted Context Health, Git memory, or OAuth grants.
