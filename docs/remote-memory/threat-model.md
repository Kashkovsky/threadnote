# Remote-memory threat model

Status: engineering review baseline. Production writes remain release-gated until an independent security/privacy
review and penetration test are complete.

## Assets and trust boundaries

Protected assets are canonical Markdown bodies, tenant/share membership and policy, immutable revision history,
idempotency outcomes, workload-attribution evidence, backups, and the confidentiality of query intent. Repository source
and dirty overlays are explicitly outside the managed service and must remain on the Cursor VM.

Trust boundaries:

- untrusted repository files, memories, MCP descriptions, and model-generated tool arguments;
- the ephemeral Cursor VM and every process executing inside it;
- Cursor's OIDC issuer and Unix-socket token endpoint;
- OAuth clients, authorization server, access-token/JWKS verification, and revocation;
- the public HTTP/TLS edge;
- application authorization, PostgreSQL roles/RLS, derived index, workers, backups, observability, and operator access.

Cursor OIDC attests the VM/run, not one trusted process. A compromised process may legitimately request the VM token;
nonce binding, short expiry, OAuth authorization, policy matching, CAS, scrubbing, and auditing remain required.

## Threats and required controls

| Threat                                               | Required controls and verification                                                                                                                                                                                         |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt injection in source or memory                 | Label memory as untrusted evidence; keep graph/source local; never execute memory content; bound results; require explicit tools and schemas.                                                                              |
| Cross-tenant storage or index confusion              | Resolve OAuth grant before storage/index; immutable tenant/share keys; application predicates; forced RLS; share-partitioned index and cache; two-tenant negative tests.                                                   |
| Privileged runtime database identity                 | Bootstrap superuser never reaches services; separate `NOSUPERUSER NOBYPASSRLS` migrator/runtime roles; runtime has no DDL and cannot auto-migrate; audit role grants and test forced RLS.                                  |
| URI/alias traversal                                  | Canonical parser; encoded-separator/dot-segment rejection; authorize share before alias lookup; alias target must remain in the same immutable share; expiry enforced.                                                     |
| OAuth confused deputy or audience error              | Exact issuer/audience/algorithm validation; resource indicator and protected-resource metadata; least scopes; Host/Origin validation; TLS; no bearer token in URL/config/logs.                                             |
| Token theft/replay                                   | Short access-token lifetime, secure authorization server, no token persistence in service, revocation within target window, no token output or support-bundle capture.                                                     |
| Forged/replayed Cursor claims                        | RS256/JWKS verification; exact issuer/audience/time; require managed-agent runtime; one-time nonce/challenge; unique token ID; current owner/team/complete canonical repository-set matching; bounded attempts and expiry. |
| Compromised VM mints valid workload token            | Treat attestation as attribution only; require OAuth/grant and write feature flag; limit scopes/rate/body; server scrub; CAS/idempotency; auditable attribution.                                                           |
| Credentials, customer data, or local paths in bodies | Canonical parse and fail-closed server scrubber before commit/import; bounded body; deployment DLP extension; errors report category only, never matched values.                                                           |
| Idempotency abuse/write amplification                | Principal/tenant/operation key; request hash; expiry; per-operation rate limits; body and batch caps; exact replay outcome.                                                                                                |
| Lost update/stale-head race                          | Per-logical-key lock and mandatory CAS; at most one winner; explicit conflict requires re-read; no automatic prose merge.                                                                                                  |
| Index leakage after revocation/deletion              | Authorization before every index access; tenant/share-partitioned rows; authoritative DB overlay; index rebuild; deletion propagates through an audited tombstone design before destructive deletion ships.                |
| Backup/export misuse                                 | Restricted operator identity and destination; encrypted transport/storage; manifest/content hashes; audit; retention and deletion schedule; never place exports in public artifacts.                                       |
| Log/trace/error leakage                              | Allowlisted event fields only: tool, result class, privacy-safe tenant bucket, duration, generations, conflict/attestation class; never body, query, URI path, source, token, or absolute path.                            |
| Availability attack                                  | Content/response limits; request deadline; rate limits; connection pools; circuit breakers; outbox retry/dead letter; bounded worker batches; memory fails closed, local graph stays available.                            |
| Hot tenant/share starves worker queues               | Rotating per-share rounds; one item per share per round; bounded batches; atomic claim outcome; lag/dead-letter readiness aggregate.                                                                                       |
| Expired control state retains unnecessary identity   | Bounded cleanup for active/disabled/deleted tenant state; permanent request-hash tombstone but expiring replay outcome; alias deletion; expired workload identity minimization.                                            |
| Machine-local paths escape a cloud VM                | Fail-closed server scrubber covers POSIX homes, Cursor `/workspace`, temporary directories, Windows/Git-Bash/UNC paths, and WSL mounts; deployments may add stricter patterns.                                             |
| Malicious operator input                             | Strict schema; file and total size limits; no symlinks; output is exclusive/atomic; plan digest; post-apply record/hash/alias verification; no source deletion or dual-write.                                              |

## Data handling

- PostgreSQL and backups require encryption at rest with managed-key rotation; all non-local connections require TLS.
- Tokens and raw OIDC JWTs are transient verification inputs and must not be persisted.
- Workload attestations keep only bounded verified claims and hard expiry.
- Audit events contain identifiers/result metadata, not content or query text.
- Operator exports are sensitive customer data: mode `0600`, restricted destination, encrypted transfer, named owner, and
  an expiry/deletion ticket.
- Production support previews must be generated from allowlisted metadata. Never attach raw logs or database rows.

## Abuse cases to test before writable rollout

1. Two tenants with identical aliases, projects, topics, query terms, and cache keys cannot observe each other.
2. A missing application tenant predicate still cannot cross RLS.
3. Encoded separators, Unicode normalization variants, dot segments, other namespaces, and expired aliases fail closed.
4. Wrong issuer/audience/nonce/signature/time and replayed challenges fail without revealing claims.
5. A token revoked during a run stops new reads/writes within 60 seconds.
6. Duplicate operation IDs replay only identical requests; changed requests fail.
7. Concurrent same-base writes have at most one winner; independent topics progress.
8. Scrubber-blocked bodies/imports leave no revision, outbox, audit content, or idempotent success.
9. Oversize/slow/cancelled requests stay bounded and do not leave acknowledged writes outside PostgreSQL.
10. Export/backup access, restoration, and deletion are audited and hash reconciled.

## Production security gate

Before enabling writable flags for an external tenant, record approval for this model, dependency/SBOM scan, container
scan, penetration test, OAuth review, key-rotation exercise, RLS integration tests, support-preview inspection,
backup/restore drill, deletion/backup-expiry policy, and live Cursor canaries. Any unresolved cross-tenant, credential,
source-upload, acknowledged-write-loss, or authorization issue blocks rollout.
