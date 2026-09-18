# Organization operations and recovery evidence (O5a)

This is the operator runbook for preparing the configured Okta pilot. The manifest, verifier, runtime, and commands are
provider-neutral. Okta is the pilot identity-provider configuration, not a production-code branch.

**O5 acceptance remains pending until real isolated restore, recovery/rotation, and rollback drills are observed.**
The commands below perform no provider actions, make no database connections, and never enable writes or routes. A
`verified` receipt means complete, internally consistent, fresh **operator-attested** evidence passed these checks. It
is neither a signed provider attestation nor independent proof that a restore happened. Keep the underlying provider
proof in the restricted operations system and review it before approving a deployment. Digests provide binding and
tamper detection, not authenticity. Example/test evidence is never deployment acceptance evidence.

## Prepare a reviewed manifest

Copy [the versioned draft](examples/org-operations.v1.json) into a private operator directory. Replace every example
identifier/digest and timestamp. The example contains no observed evidence. Set a measured, approved recovery policy:

- `scheduleSeconds`: maximum age of the latest verified full snapshot. `retentionSeconds`: required PITR coverage;
  retention must cover a snapshot interval plus RTO and at least the RPO.
- `rpoSeconds`: maximum verified PITR lag and measured restore data loss. `rtoSeconds`: maximum measured isolated
  restore time, including reconciliation and readiness; the operator measures the entire recovery exercise.
- `maxEvidenceAgeSeconds`: the review window; verification requires an explicit current UTC `--at`, never the time of a
  historical passing receipt. Verification must be at or after `plannedAt` and no later than
  `plannedAt + maxEvidenceAgeSeconds`; outside that window every check is blocked, including pending checks.
  Fresh observations cannot extend an old manifest. Repeat expired drills under a newly reviewed manifest.
- `deploymentId`, operator, support, and escalation IDs: independent random lowercase 32-hex opaque registry IDs.
  These four IDs must be distinct; every alert must also have three pairwise-distinct role IDs.
  Resolve each owner to a **named human**, contact route, coverage window and delegate in the restricted roster. Bind
  its reviewed snapshot with `ownerRosterDigest`. No email addresses, user names or contact URLs enter these files.
- `baseline`: SHA-256 digests of the reviewed Git authority inventory, database checkpoint/receipt inventory, alias
  catalog, current grant policy, deployed runtime artifact, and compatible rollback artifact. Set `expectedRecords` to
  the complete reviewed inventory count (at least one pilot record); both reconciliation observations must match it. Use canonical JSON and
  opaque record IDs in these inventories. Never hash passwords, tokens, low-entropy raw identities or queries into
  evidence; use independently assigned opaque IDs. Store sensitive provider references separately.
- All 22 `alerts` must occur exactly once with opaque operator, support and escalation owners, a bounded safe first
  action, and the reviewed rollback action. Confirm the owners resolve in the same bound roster. The sample assigns
  isolation retention for backup/restore/reconciliation failures, worker pause for health failures, and write disable
  for identity, credential, readiness and rollback failures. The catalog also requires `auth`, `recall`, `read`,
  `write`, `cas`, `git-synchronization`, `registry-publication`, `database-saturation`, and `canary` alerts.
  Authentication/read/canary failures withdraw the route; write/CAS/synchronization/publication/saturation failures
  disable writes. Every alert requires independently recorded delivery and action evidence.

Use the exact deployed Threadnote version. Operator-only tooling and private files belong outside the hosted runtime
image; no migration, backup, IdP admin or infrastructure credentials belong in runtime/worker roles.

```sh
umask 077
threadnote remote-memory-operator operations-plan \
  --input operations-draft.json --output operations-manifest.json
threadnote remote-memory-operator operations-template \
  --manifest operations-manifest.json \
  --drill <random-32-hex-drill-id> --target <random-32-hex-isolated-target-id> \
  --output operations-evidence.json
```

The isolated target ID must differ from the deployment ID. Template creation exits **2** and writes every check as
`pending`. This is expected and must not be overridden to green by automation. Plan creation exits 0. Invalid input,
unknown/duplicate options, linked/nonregular/oversized input, and unavailable or existing output fail with exit 1 and a
content-free error. Receipt writes are exclusive and mode 0600. Keep parent directories private and owned by the
operator; do not use a shared writable directory. No command replaces an existing receipt.

## Execute actual drills in isolation

Bind provider-specific commands, accounts, backup locations, deployment IDs and contact routes in the restricted
operator procedure before starting. The file verifier cannot discover these and supplies no pretend provider command.
Record the approved provider procedure revision in the external proof referenced by each evidence digest. Use an
isolated network/account/database/clone with no production route, no production write capability and independently
scoped credentials. Do not redirect a live tenant or test destructive recovery against production.

1. **Backup/PITR**: take and verify both Git and PostgreSQL snapshots, encryption and restore-account access. Verify
   the actual continuous recovery window and replay lag. Retain the Git authority plus PostgreSQL lifecycle, grants,
   idempotency/acknowledgement/proposal receipts and revision pointers together. A Git clone alone does not recover
   grants or acknowledgement history; database body copies cannot become a second memory authority.
2. **Isolated restore and reconciliation**: restore both stores to the reviewed recovery point. Measure data loss and
   full time to safe service. Fence every writer, compare Git heads/body hashes and database pointers, replay Git-landed
   but DB-rolled-back acknowledgements with the existing idempotent recovery flow, verify aliases and revalidate grants
   against the current authorization policy (do not resurrect revoked grants from a backup). Rebuild derived indexes
   from authoritative Git. Require zero hash, alias, grant, index or unresolved-write discrepancies, the complete
   reviewed pilot record count, and one fenced writer. Retain isolation on any discrepancy; never resolve a mismatch by
   making PostgreSQL canonical or force-pushing over Git history.
3. **Account/MFA recovery**: use the configured IdP's approved recovery procedure with a separate authorized recovery
   operator and pilot test identity. Verify recovery access, revoke prior sessions, replace and reject the old factor,
   accept the new factor, and confirm least privilege and continued MFA. Never disable MFA as the recovery method.
4. **JWKS/workload recovery and rotation**: follow configured issuer/audience policy and cache/expiry windows; accept
   the new key, reject retired and unknown keys after the approved overlap ends. Recover and rotate the workload
   credential through the provider's supported procedure; verify the old credential is denied and the replacement
   retains only its original workload privileges. Include Git/database/worker credentials used by this deployment in
   the protected workload proof. Never restore compromised credentials as a rollback. Keep writes disabled if recovery
   or rotation cannot be verified. Both rotation observations must attest `approvedOverlapHandoffVerified`,
   `authenticatedServiceContinuous`, and `authenticatedReadsContinuous`: verify the approved overlap or handoff
   across the complete rotation and test authenticated service and reads before, during, and after it. Keep provider
   timing, cache, credential handoff, and continuity proof in the restricted packet; an unapproved gap or any
   authenticated downtime blocks acceptance even if the new key/credential eventually works.
5. **Start/readiness**: start the isolated runtime from the pinned artifact with runtime-only grants. Verify schema and
   privilege preflight, Git binding/ingestion, one fenced writer, authenticated reads and unauthorized-read denial.
   Start health/CI worker schedules only through their separate reviewed operator contracts. See
   [pilot provisioning](org-pilot-provisioning.md) and [Context CI](context-ci.md).
6. **Write disable/read continuity**: replace all affected writable grants with reviewed `memory:read` grants using
   `provision-plan --for-apply` and `provision-apply`, remove write-capable admission, and drain admitted mutations.
   Pause health schedules with `health-pause`, disable hosted CI with `ci-control`, and fence/stop any background
   writer or ingestion process before claiming `backgroundWritersDisabled`. If the deployment cannot separate these
   processes while retaining hosted reads, preserve verified local read-only Git/stdio access, withdraw the hosted
   route and stop the service. Changing client configuration alone does not revoke credentials. Verify actual durable,
   handoff and proposal writes are denied; verify authorized safe reads, unauthorized denial, and local stdio.
7. **Route withdrawal/safe stop**: withdraw the platform ingress route and verify new remote requests cannot enter.
   Stop admission, drain in-flight work, stop timers/workers and the process under the platform deadline. Setting
   `THREADNOTE_REMOTE_ENABLED=false` only gates HTTP MCP/discovery; it does **not** stop background Git ingestion or
   retention. Preserve canonical Git, private backups and local read-only stdio. Hosted reads are unavailable after
   withdrawal; the continuity requirement is met by the verified authorized local read path, never by opening a
   bypass route or widening a grant.
8. **Rollback/post-rollback reconciliation**: restore the pinned compatible runtime artifact/configuration in the
   isolated target with writes still disabled. Confirm schema compatibility before starting; never blindly downgrade
   database schema. Repeat Git/DB/hash/alias/grant/index reconciliation and safe read/stdio checks. Route restoration
   or write resumption is a separate reviewed deployment action after all checks pass. A receipt performs neither.
9. **Alert delivery**: trigger and acknowledge every configured alert in the isolated drill. Verify the named operator
   and support owner, actual escalation delivery, safe first action, and rollback procedure. Backup overdue/restore
   failure/reconciliation drift retain isolation; health backlog/check/staleness/lag/heartbeat alerts pause the
   affected observer; identity/rotation/readiness/write-disable/rollback alerts preserve denied writes and escalate.
   If safe reads are suspect, withdraw the route and retain local verified reads. Do not resume merely because a
   heartbeat recovers. Trigger auth, recall, read, write, CAS, Git synchronization, registry publication, database
   saturation, and canary failures as well, then exercise each alert's reviewed safe action and rollback. Record unresolved issues outside content-free evidence and leave the check pending or failed.

For steps with a predecessor, observation timestamps must be strictly later (equal timestamps fail), following backup → isolated restore → restore reconciliation → start →
readiness → write disable → read continuity → route withdrawal → safe stop → rollback → post-rollback reconciliation.
`isolated-restore.elapsedSeconds` measures restore execution; `readiness.recoveryElapsedSeconds` measures the full
recovery from its start through reconciliation and readiness. Both must fit RTO. All observations must be at or after the
manifest's `plannedAt`, no later than verification, and within its age limit.

## Record observations and verify receipts

Only after an actual observation, replace its pending record with this shape (illustrative; do not use as acceptance):

```json
{
  "check": "mfa-recovery",
  "status": "observed",
  "observedAt": "2026-09-18T00:04:00.000Z",
  "observerId": "11111111111111111111111111111111",
  "evidenceDigest": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "facts": {"recoveryAccessVerified": true, "oldFactorRejected": true, "newFactorAccepted": true, "noMfaBypass": true},
  "metrics": {}
}
```

`observerId` must equal the reviewed manifest operator. `evidenceDigest` binds a restricted proof packet from that real
observation; it cannot establish authenticity by itself. Keep every unobserved check exactly `{check, status:"pending"}`.
A failed observation records false facts or failing measured metrics, yielding `blocked`. Do not convert a failure into
a fabricated success. The exact required facts and metrics are the exported `OPERATIONS_CHECK_SPECIFICATIONS` in
[`operations_contract.ts`](../src/remote_memory/operations_contract.ts); unknown and missing fields fail closed.
For `alert-delivery`, the exact facts are six keys for every alert kind: `<kind>:namedOwnersResolved`,
`<kind>:operatorAcknowledged`, `<kind>:supportAcknowledged`, `<kind>:escalationTested`, `<kind>:safeActionTested`, and
`<kind>:rollbackTested`. Its evidence digest binds a packet with delivery/action proof for each of the 22 alerts;
a single aggregate acknowledgment is insufficient. Every fact must be true. Metrics are bounded non-negative integer seconds/counts; isolated restore duration must be
positive and within RTO, data loss/PITR lag within RPO, and reconciliation discrepancy counts must be zero.

No memory contents, file paths, repository names, queries, raw identities, secrets, credentials, free-text explanations
or raw logs are accepted in manifest/evidence/receipt fields. All nesting is strict. Do not attach a raw provider export.
The commands also suppress parser/file errors that might echo input or paths. Digests and registry IDs are opaque;
operators remain responsible for never encoding sensitive text in them.

```sh
threadnote remote-memory-operator operations-verify \
  --manifest operations-manifest.json --evidence operations-evidence.json \
  --at <current-canonical-UTC-timestamp> --receipt operations-receipt.json
threadnote remote-memory-operator operations-receipt-verify \
  --manifest operations-manifest.json --evidence operations-evidence.json \
  --at <current-canonical-UTC-timestamp> --receipt operations-receipt.json
```

Verification exits 0 only for complete passing observations, 2 for valid pending/blocked evidence, and 1 for malformed,
misbound or tampered input. Receipt verification recomputes the original receipt, checks current evidence freshness and
rejects a changed result. Alert/check order and JSON object-key order do not change canonical digests. Commands read no
clock implicitly, execute no provider operation, and mutate only a newly requested private output file. Preserve
manifest, evidence, receipt, roster mapping and protected proof together under the operator's retention/access policy.
A new observation or manifest requires a new receipt file. Do not mark O5 complete based on unit tests or this runbook.
