# Organization productization and dogfood deployment

Status: reviewed with zero blocking findings after two dev-cycle iterations, 2026-09-07.
Audit baseline: main `9b63eb0b` (4.6.7). The implementation audit below records the original findings;
the execution evidence here tracks which have since been addressed. Daily cutover and enterprise completion remain open.

Execution evidence as of 2026-09-07:

- #378 binds Git to one tenant/share; #379 adds dedicated ingestion authority, persistent failure readiness, and
  rejection of body edits that cannot preserve rich metadata.
- #380 preserves exact OAuth issuers and supports optional `nbf`; #381 supports registered external client IDs.
  Auth0's dedicated tenant and native clients have passed real PKCE. Codex 0.153.4 has completed authenticated
  recall/read, canary creation, CAS replacement/stale rejection, laptop Git synchronization, and native refresh.
  Cursor Agent 2026.09.02-c22c1a3 has completed native PKCE, refresh and a canary write. Its text-only tool delivery
  exposed missing read revisions and recall pointers. #390 corrected both; the live native read/CAS/read/recall
  sequence now passes. Its intentional stale-CAS probe remains blocked by client approval before reaching the server.
- #382 isolates development installation repair. #383 confirms upstream Git persistence before acknowledgement;
  #384 recovers crashed worktree-lock owners. Isolated global service smokes covered rejected pushes and crash/restart.
- #385 rejects unsafe database credentials before listening and reports every applied migration. It passed 111
  focused tests, dev-cycle review, global startup smoke against PostgreSQL/Neon, and full PR CI.
- #386 adds monotonic snapshot admission, immutable observation provenance, external lifecycle/removal
  reconciliation, strict managed metadata validation, bounded legacy progress, and persistent rejection recovery.
  It passed 142 focused tests, lint/types, two dev-cycle iterations with zero remaining findings, source and exact
  global lifecycle smokes, and full PR CI.
- #387's dedicated Fly bootstrap/image passed 101 focused tests, two dev-cycle iterations without remaining findings, and container
  checks for nonroot credentials, SSH trust, Neon TLS, fresh clone and restart persistence. Runtime dependency
  packaging defects were repaired. Full PR CI passed and the image is deployed on one Frankfurt Machine with one
  persistent encrypted volume. Health/readiness, unauthorized MCP denial and restart persistence passed. The runbook is
  [Fly organization deployment](remote-memory/fly-org.md).

Neon PostgreSQL 17 in Frankfurt supports the required separate SQL-created migration/runtime roles and strict TLS.
The incompatible, empty Fly Managed Postgres trial was removed. Fly is enabled for bounded canaries; its repository-scoped
SSH credential has passed pinned-host clone and acknowledged push verification. Daily org use remains gated on paid
Neon capacity/restore history and P5 recovery acceptance. The user's Codex org entry remains disabled outside explicit
canary sessions; personal stdio and the existing Git share are preserved.

#388 adds explicit provider scopes and org-only native Codex attach with append/no-op/conflict handling before
stdio or receipt mutation. Actual Codex and Cursor refresh exchanges passed. Initial login remains an explicit
client command; automatic login honoring persisted provider scopes is not claimed. #389 selects two shared vCPUs
at the same 512 MiB after the first sustained test exposed exhausted CPU burst capacity.

The first P5 sustained native Codex run remains failed evidence: eleven acknowledged writes were verified, then
minute twelve exceeded the unchanged 10-second deadline. Git ingestion recovered the timed-out body; the original
operation remains `outcome_ambiguous`, not an acknowledgement. Exact operation replay preserved that outcome.

A fresh 30-minute native Codex run on two shared vCPUs passed: 180 reads, 180 recalls, 30 CAS acknowledgements and
30 verified ingestions, with at most two concurrent requests. p95 read was 470 ms, recall 565 ms, write 5,055 ms and
ingestion 2,821 ms. No unexpected authorization failure or lost acknowledged write occurred. CPU burst balance
increased over the run and the steady portion, with no throttling across 121 samples.

The Git plus PostgreSQL checkpoint and isolated recovery drill also passed. All 25 table digests and catalog
definitions matched before workers started; all 30 workload acknowledgements and 214 historical Git bodies were
verified. The real indexer rebuilt 214 events with no pending events or missing projections and unchanged authoritative
state. Same-state binary rollback preserved newer acknowledgements and idempotent replay. Recovery took 17 minutes
20 seconds against the 60-minute gate. Production checkpoint restart downtime was 29 seconds.

Isolated database outage, Git push rejection/replay, fresh-write recovery, membership revocation, unprovisioned identity
denial and HTTP disablement passed. Overlapping signing-key rotation passed through the production JWKS verifier with
a local test issuer; this does not claim an Auth0 tenant key rotation. All task-created drill containers, network,
volumes and the local tunnel were removed; the private checkpoint and bounded receipts were retained.

| Phase                      | Current status             | Remaining exit work                                                                         |
| -------------------------- | -------------------------- | ------------------------------------------------------------------------------------------- |
| P0 — Plan review           | Complete                   | None                                                                                        |
| P1 — Safe Git storage      | Complete                   | None for the reviewed single-share deployment                                               |
| P2 — OAuth and clients     | Normal flows verified      | Cursor stale-conflict visibility remains pending client approval                            |
| P3 — Fly bootstrap         | Complete                   | None for the single-writer topology                                                         |
| P4 — Daily cutover         | Gated                      | Verified configuration/routing, a normal repository task and outage/local-floor acceptance  |
| P5 — Operations            | Drills and workload passed | Ongoing encrypted backups/PITR, alerts, support contract and account setup                  |
| P6 — Product consistency   | Open                       | Trusted-context capability parity, retrieval evidence and durable roadmap updates           |
| P7 — Enterprise completion | Open                       | Graph security/distribution, member lifecycle, isolation/HA and release/support gates below |

Neon paid capacity and restore history, SMTP delivery confirmation, and account MFA/recovery remain open. A successful
isolated checkpoint restore does not establish ongoing backup coverage or prove recovery of writes after that checkpoint.
The [Fly runbook](remote-memory/fly-org.md) records the supported client setup and recovery boundaries.

The outcome is a deployable organization product and a real single-member deployment at
`https://threadnote-org.fly.dev/mcp`. Our laptops retain local stdio, personal memory, exact-worktree graphs,
and the existing Git share. The org composer writes the same Git memory repository. A successful deployment
must be demonstrated through the actual agent client, including a write visible after laptop Git sync.

Single-member dogfooding is the first release gate, not evidence that HA, SCIM, distributed graph operations,
or every enterprise roadmap item is complete. The enterprise completion gates below remain explicit work.

## Authority and reviewed evidence

Read these Threadnote topics before changing their contracts:

- `product-vision-roadmap`: shared-first org add-on, local personal floor, S0–S6 sequencing.
- `local-org-topology`: personal loopback fixture topology, existing global runtime ownership, existing Git share.
- `shared-first-org-architecture`: Git body authority, external IdP, optional graph workers, no token passthrough.
- `shared-first-org-implementation-plan`: W0–W7, including settled W4.2 scope decisions.
- `shared-code-graph-frontier-specification`: protocol, security, phase gates, acceptance criteria.

The old plan memory stops at W4.1/W4.2 planning. Main includes W4.1 through W4.2d (#370–374), the publisher
freeze correction (#375), and local composer/attach/ingestion (#376–377). Its referenced
`docs/shared-first-org-implementation.md` is absent from main. This document records the current audit and
execution sequence; it does not silently amend the architecture or publish recalled personal topology.

Current source was located using Threadnote's code graph, then read at the baseline commit. Tests listed
below are existing coverage, not a claim that live production or the entire suite has passed.

## Implementation audit

| Area                        | Implemented evidence                                                                               | Gap or inconsistency                                                                                                                                                                            | Gate         |
| --------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Local floor                 | `test/unit/shared-first-local-floor.test.ts`, stdio and Git share                                  | Must remain usable without OAuth or composer; adding HTTP must not replace it                                                                                                                   | Every slice  |
| Git body authority          | `git_canonical_store.ts`, revision pointer migration, Git composer integration tests               | One process-wide Git worktree is reused for every database share; ingestion loops over all active shares. RLS does not bind a Git repository to a tenant/share                                  | P1 blocker   |
| Concurrent Git writers      | Fetch/fast-forward, file CAS, lock, push-rejection detection                                       | Verify crash/push failure recovery, clean worktree ownership, and acknowledged durability. A local commit must never become a successful retry without confirmed upstream persistence           | P1 blocker   |
| Git ingestion               | Startup ingestion in local composer; periodic production indexer ingestion; bounded blob hydration | Indexer swallows ingestion failures. Missing Git files and frontmatter lifecycle are not reconciled by the path-only scan. A revoked/unpublished memory must stop appearing as active           | P1 blocker   |
| Canonical/index split       | Postgres stores empty body plus Git commit/path; derived lexical search                            | Restore must recover Git history and control-plane/idempotency state together. Existing Postgres-body restore instructions are insufficient for org mode                                        | P3/P5        |
| Production OAuth            | RS256/JWKS, issuer/audience validation, short token lifetime, protected-resource discovery         | No selected/provisioned IdP. Issuer normalization removes trailing slash; verifier requires `nbf`, which is not universal. Verify selected provider's exact signed claims                       | P2 blocker   |
| Demo OAuth                  | `local_idp.ts`, `composer serve`, PKCE, loopback-only listener                                     | Fixed local subject, ephemeral keys, no real user authentication. Preserve loopback restriction; never deploy this issuer publicly                                                              | P2 invariant |
| Client attach               | `composer_attach.ts`, project Cursor configuration, additive `threadnote-org`                      | Hard-coded demo OAuth client ID. Need external client registration/discovery and actual client canaries; Codex/global wiring must be inspected separately                                       | P2/P4        |
| Authorization               | Immutable issuer/subject mapping, grants, project policy, feature flags, RLS, revocation checks    | Explicit service-to-share binding required; no automatically trusting authenticated strangers. One org member still needs negative tenant/share tests                                           | P1/P2        |
| Org memory capability       | HTTP recall/read/list/remember/status/handoff lifecycle                                            | HTTP tool schemas differ from local memory APIs; no remote context-brief/code-reference finalization/memory-connection workflow. Preserve local tools; document and test routing before cutover | P4/P6        |
| Deployment                  | Hardened remote-memory Docker/Compose, migration/runtime role split                                | Existing root Fly file deploys telemetry. No org image/startup/volume/bootstrap/Fly config or production Git credentials path. Runtime image lacks SSH client                                   | P3 blocker   |
| Database compatibility      | PostgreSQL 17 development/tests; `transaction_timeout` use                                         | Verify selected managed database version and TLS support; PostgreSQL 16 cannot accept that setting. Do not weaken TLS or give runtime schema ownership                                          | P3 blocker   |
| Operations                  | Health, readiness, worker supervision, rate limiting, operator provisioning                        | No live org monitoring, Git-aware backup/restore drill, release rollback evidence, or measured end-to-end latency                                                                               | P5 blocker   |
| Shared graph phases 0–2     | Checkpoints, receipt validation, publisher state machine, OCI descriptors in CAS, TCG1 deltas      | More complete than stale plan memory. Still HTTP CAS descriptors, not a live OCI Distribution registry; coordinator is loopback-only and unauthenticated                                        | P6/P7        |
| Enterprise graphs           | Enrollment, trust, profiles, local fallback primitives                                             | Provider login/credential discovery, authenticated coordinator, registry ACLs, revocation, retention evidence, HA fencing, worker policies and scale gates remain                               | P7           |
| Enterprise organization ops | Provisioning and scoped grants exist                                                               | SCIM/member lifecycle automation, enterprise installation/support contract, HA/recovery SLO evidence and external security review remain                                                        | P7           |

Filenames without directories above are under `src/remote_memory/`. This is a bounded audit of deployment
and contract boundaries, not an assertion that unrelated algorithms are defect-free.

## Deployment decisions

1. **Identity:** Auth0 managed tenant, initially one explicitly provisioned subject. Use authorization code +
   S256 PKCE; public clients have no secret. Enable resource-parameter compatibility and issuer responses;
   register `https://threadnote-org.fly.dev/mcp` as the API audience, with the existing memory scopes and
   five-minute access tokens. Keep provider authentication separate from Threadnote grants. Use a supported
   pre-registered client or controlled dynamic registration, proven with the chosen clients. No bespoke public IdP.
2. **Memory:** reuse the existing team Git remote after inspecting its clean/synchronized state. A dedicated
   composer clone lives on a persistent Fly volume. A repository-scoped write credential stays in Fly secrets;
   no personal GitHub token is copied to the service or agent configuration. Never import personal memories wholesale.
3. **Runtime:** dedicated `threadnote-org` app in Frankfurt, HTTPS at Fly edge, one active Git writer for the
   initial dogfood deployment. Explicit service tenant/share binding. No automatic second machine or blue/green
   strategy that introduces two independent mutable clones. This initial topology has restart downtime.
4. **Control plane:** dedicated PostgreSQL database and separate migrator/runtime roles. Prefer a managed
   service with verified TLS and backups after checking version compatibility and cost. Provision/migrate with
   a short-lived operator credential, then remove it from runtime. No automatic migration in the public service.
5. **Graphs:** keep current local graphs and the existing fixture coordinator while bringing org memory online.
   Do not expose the unauthenticated coordinator, enroll the Threadnote source repository, raise the 32 MiB CAS
   cap, or claim an OCI descriptor blob is a production registry. Public graph sharing requires P7's auth gates.
6. **Cutover:** authenticated HTTP memory is additive. Personal handoffs/preferences remain local. Local team
   recall continues to read synchronized Git. Cloud agents use exclusive org memory and fail closed when it is
   unavailable. Exact local graph evidence always stays on stdio.

Provider references, checked 2026-09-07:
[Auth0 MCP setup](https://auth0.com/ai/docs/mcp/get-started/authorization-for-your-mcp-server),
[Auth0 registration](https://auth0.com/docs/get-started/applications/dynamic-client-registration),
[Fly volumes](https://fly.io/docs/volumes/overview/),
[Fly Managed Postgres](https://fly.io/docs/mpg/),
[Fly app configuration](https://fly.io/docs/reference/configuration/).

## Execution sequence and acceptance

### P0 — Review this plan

Independent dev-cycle review checks architecture consistency, authorization boundaries, sequencing,
operability, and test evidence. Resolve every critical/important finding before product implementation.
Record decisions and findings locally. No public issue or durable-memory publication without user approval.

### P1 — Make Git organization storage safe to deploy

- Bind one Git deployment to one configured tenant/share and apply that boundary to request authorization,
  ingestion, projection, retention, and all canonical reads/writes. Reject missing/ambiguous bindings.
- Verify and repair Git push-failure recovery and lock/crash behavior with isolated bare-remotes and restart cases.
- Reconcile external Git publication, replacement, lifecycle changes, and removal without deleting history or
  resurrecting unpublished content. Expose ingestion failure/freshness through readiness or bounded status.
- Give ingestion an explicit system identity bound to the configured share and its active project catalog.
  Do not borrow the first writable member's grant. Member ordering, adding a narrower member, and revoking
  an interactive member must not change background ingestion authority; share/project disablement still applies.
- Preserve existing Git metadata when HTTP replaces a record, including stable identity, citations, typed
  relations, references, and keywords. Reject a replacement before writes when its metadata cannot be preserved
  safely. Add a rich-record Git → HTTP CAS replacement → laptop parse round trip and unsupported-schema rejection.
- Add focused two-tenant/overlapping-project regressions, runtime-role integration tests, and properties for
  isolation, membership permutation noninterference, repeated ingest idempotence, and external-update convergence.
  Keep Postgres hosted mode separate. Audit system ingestion distinctly from interactive writes.

Exit: unrelated tenant/share operations cannot touch the Git store; failed pushes are never reported durable;
the composer follows laptop Git changes, and failures are visible rather than reported as healthy freshness.
An HTTP edit cannot silently remove metadata used by the local product; broad remote feature parity remains P6.

### P2 — Real OAuth and supported client attach

The provider compatibility slice preserves exact OAuth issuer identifiers and accepts an absent optional `nbf`
claim while retaining signature, audience, expiry and lifetime checks. Regression examples and a bounded issuer
preservation property cover this contract. Provider provisioning and actual client login remain separate gates.

- Configure the selected Auth0 tenant/API/client and one user's subject grant through operator provisioning.
- Match issuer exactly, support standards-valid optional claims without relaxing audience/signature/lifetime
  checks, and retain negative tests for expired/wrong issuer/wrong audience/wrong scope tokens.
- Make attach work with external IdP client IDs or discovery; keep loopback demo behavior supported.
- Prove discovery → browser sign-in → PKCE exchange → authorized MCP call → refresh/reconnect.
- Prove unprovisioned identity denial and grant revocation without relying on client cooperation.

Exit: actual Cursor and Codex clients can authenticate without copied bearer tokens; logs/support output
contain no credentials. User interaction is required only for account login/consent that tools cannot complete.

### P3 — Fly packaging and repeatable bootstrap

- Add a dedicated org Dockerfile/Fly configuration and an operator runbook with explicit region, volume,
  process count, readiness host header, deploy strategy, database compatibility, and secret names.
- Prepare the Git clone with pinned host trust and a repository-scoped credential; never print secrets.
- Run migrations/grants/provisioning separately from the restricted runtime, verify RLS and startup failures.
- Build/run the image locally, then deploy the reviewed exact image to Fly and verify TLS/health/readiness.

Exit: a fresh deployment can be reproduced from versioned configuration; a restart preserves Git history,
control-plane state, and OAuth operation; runtime has no superuser, schema owner, or operator secret.

### P4 — Move our daily usage onto the organization

P4 is a bounded acceptance exercise against designated canary records. Keep routine org writes disabled
until P5 recovery acceptance passes; then enable ongoing daily use with the verified configuration.

- Inspect and back up relevant local agent configuration. Use the existing default share; sync and inventory
  canonical shared records without publishing private handoffs/preferences or recording their contents in logs.
- Attach org HTTP MCP using supported per-client configuration and preserve local stdio/graph tools.
- Run an isolated canary project: recall/read an existing shared record, write a clearly designated canary,
  verify Git push and laptop sync, replace with CAS, reject stale CAS, and verify attribution.
- Confirm routing instructions and the differing HTTP/local schemas, then exercise a normal repository task.
- Test org outage and revoked grant: personal/local graph still works; remote memory does not silently fall back.

Exit: the real user completes daily org memory operations through a signed-in agent. A configuration file
alone is not cutover evidence. Keep a reversible local configuration backup and existing Git authority.

### P5 — Operations acceptance for supported single-org deployment

- Document and execute Git + Postgres backup/restore into isolated infrastructure; verify acknowledged writes,
  immutable revisions, grants, idempotency and index rebuild, then destroy only task-created drill resources.
- Exercise restart, dependency outage, Git rejection, OAuth rotation/revocation, binary rollback and kill switch.
- Configure privacy-safe alerts and record bounded latency/error/index-lag evidence from canaries.
- Initial acceptance workload: 30 minutes of one authenticated read/recall each 10 seconds and one fixture
  CAS write each minute, with at most two concurrent requests. From the dogfood client, require p95 read ≤2 s,
  recall ≤3 s, write ≤10 s, successful Git ingestion within 30 s, and zero unexpected authorization failures or
  lost acknowledged writes. Injected outage cases are measured separately. These are dogfood thresholds, not SLAs.
- Recovery objectives: RPO zero for acknowledged Git bodies; durable PostgreSQL receipts/grants must be
  recovered or explicitly reconciled against Git before reopening writes. Demonstrate RTO ≤60 minutes for
  the isolated restore drill. Any missed threshold fails this gate until fixed or explicitly accepted as a
  documented support limitation; recording measurements alone is insufficient.
- Publish an honest support matrix: one active composer, one bound share, exact supported DB/IdP/client versions,
  known downtime behavior, recovery procedure, and operator ownership. Do not call this HA or general availability.

Exit: documented recovery is demonstrated, not hypothetical; the single-org deployment is ready for routine use.

### P6 — Complete shared-first product consistency

- Resolve stale roadmap/runbook claims with user-approved durable updates after implementation is verified.
- Specify and implement org memory capability parity where daily usage needs citations, typed connections,
  review-gated writes, and graph-linked briefs; maintain the same Git authority and private-overlay boundary.
- Measure team-first retrieval and ensure source freshness/coverage is explicit across local and org evidence.

Exit: organization adoption preserves the complete trusted task-context loop, with supported limitations explicit.

### P7 — Enterprise completion

These are real remaining requirements, not prerequisites to start single-user memory dogfooding:

- Authenticated graph coordinator with per-repository/profile authorization, enrollment revocation, bounded
  rate limits and audit; standard OCI registry distribution, scoped read/write credentials and signing-key rotation.
- Graph retention dry runs and recovery, publisher leadership fencing, managed login and credential discovery;
  verification and independent clean-build equivalence under adversarial contributions and sustained updates.
- SCIM/member lifecycle or a documented supported IdP provisioning equivalent, least-privilege role management,
  multi-instance service/worker isolation, Git writer coordination, restore/HA failover and measured SLO gates.
- Customer-controlled self-host deployment, security review, support/upgrade/runbook coverage and release evidence.
- Optional REAPI, idle workers and shards remain separately gated roadmap work; do not advertise them as shipped.

Exit: every capability claimed in enterprise packaging has code, negative tests, deployment evidence and an
operator recovery contract. Unimplemented roadmap capabilities remain visibly unavailable.

## Delivery policy

Each cohesive slice runs focused tests plus applicable lint/type checks, then the dev-cycle full review;
fixes get incremental review only. After zero critical/important findings, commit and open a PR. The user
has authorized PR creation and merge after dev-cycle is clear and CI is green. Full-suite CI is authoritative.
Do not run the full suite locally. Investigate CI failures before merging.

Runtime changes also require a clean exact-HEAD global install, ownership release from the existing worktree,
termination of superseded processes, and a global CLI smoke. Use the checked-in contributor skills. Leave a
privacy-safe Threadnote handoff with checks, blockers, and next steps. Ask before durable writes/publication
where contributor guidance requires it; do not create public dogfood issues without explicit approval.
