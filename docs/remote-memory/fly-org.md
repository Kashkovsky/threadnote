# Single-organization Fly deployment

The dedicated application is `threadnote-org`, in Frankfurt, using Auth0 and Neon PostgreSQL 17. This deployment
supports one active composer and one Git share. A single persistent clone has restart downtime; it is not HA.
The root `fly.toml` belongs to telemetry. Run the commands below from the repository root and always specify
`deploy/threadnote-org/fly.toml`.

## Compute capacity and sustained validation

The initial profile is two shared vCPUs and 512 MiB on the single writer. Fly gives this profile an aggregate
12.5% sustained CPU allowance; a single shared vCPU has 6.25%, regardless of available RAM. Burst capacity can
make a short smoke look healthy while masking insufficient sustained capacity. See
[Fly CPU performance](https://fly.io/docs/machines/cpu-performance/).

The first native Codex workload on one shared vCPU failed its twelfth minute's write with HTTP 503 at the
10-second deadline. Eleven prior acknowledged writes were verified. Fly's `fly_instance_cpu_balance` depleted
as write latency rose, followed by increasing `fly_instance_cpu_throttle`. The twelfth body reached Git and was
admitted by ingestion; its original operation retained `outcome_ambiguous` and must not be blindly retried with
a new operation ID. Read and reconcile the current revision first. This was a failed acceptance run.

Two shared vCPUs are the next measured candidate, not completed capacity evidence. Repeat the complete P5
30-minute workload after deployment, retaining client latencies, acknowledgements, CPU balance and throttling
over the same window. Require the existing latency/error gates and no sustained burst-balance depletion; a
restart that temporarily replenishes burst capacity does not establish steady-state readiness. Keep the
10-second request deadline unchanged. The published base compute price is approximately $4.04 per 30 days
for this profile, excluding region adjustments, storage, network and database charges; verify
[current pricing](https://fly.io/docs/about/pricing/) when deploying.

Query metrics using the organization slug reported by `fly orgs list` (`personal` for this deployment), with an
app/Machine selector. The Prometheus authorization scheme follows the actual token format: `FlyV1` for `fm2_`
tokens, including when returned by `fly auth token`, and `Bearer` for legacy tokens. Keep tokens out of command
arguments, logs and receipts. [Fly metrics](https://fly.io/docs/monitoring/metrics/) defines the CPU metric units
and API. CPU capacity is independent of the paid Neon and recovery gates below.

## Release prerequisites

Use a reviewed, clean commit whose focused checks and full PR CI pass. Build from that commit and record its image
digest, source revision, migration versions and volume ID in the private operations receipt. The image includes
Bun 1.3.14, Git, OpenSSH, CA certificates and the repository's dependency patches. Its Docker context allowlist
excludes `.context`, `.env`, `.git`, local databases and operator credentials. Fly explicitly uses the same allowlist
for upload/archive paths; the build file paths in `fly.toml` are relative to that configuration directory. These images support the remote service and operator; they do not package the local CLI
model assets. Use the image revision label and recorded digest for release identity.

Provision a dedicated PostgreSQL database with distinct migrator and runtime roles. Apply all registered migrations
(currently 1–3), then `deploy/remote-memory/grants/001-runtime.sql`, using the migrator outside Fly. The runtime
must pass the startup privilege preflight; it cannot own the schema, change grants, bypass RLS or disable triggers.
Keep verified TLS (`sslmode=verify-full`). Do not put a migrator URL, bootstrap role or migration release command in
this application's configuration or secrets. See [operations](operations.md) for role creation and provisioning.

Use the operator's versioned `provision` input to create tenant `threadnote-org`, share `default`, and the member's
exact verified issuer/subject mapping. Provisioning also establishes the separate Git ingestion identity. The
issuer is `https://threadnote-org.eu.auth0.com/` and the audience is `https://threadnote-org.fly.dev/mcp`.
Email addresses are not principal identity keys. Keep the subject and provisioning input in private operator state.
Enable only the intended memory capabilities; scope project policy deliberately.

Neon's Free plan is suitable for bounded validation, not this continuously polling deployment's routine usage and
recovery requirements. Enable the approved paid capacity and restore history before daily cutover. Verify actual
plan/branch settings and execute the recovery gate in [the productization plan](../org-productization.md).

## Git access and bootstrap

Create an Ed25519 deploy key restricted to the memory repository, with write access. Store the private key only in
private operator state and Fly secrets. Never use a personal GitHub token or agent token as the service's Git identity.
The configured endpoint is exactly `git@github.com:Kashkovsky/threadnote-share.git`, branch `main`, remote `origin`.
A private HTTPS URL does not use the SSH deploy key.

The image pins GitHub's published Ed25519 host key in a root-owned file. It disables interactive prompts, ambient
SSH configuration and agent forwarding. The root entrypoint decodes the key into an ephemeral mode-0600 file,
removes the base64 secret from the child environment, prepares the volume root and execs the service as user `bun`.
The service can traverse the root-owned credential directory and read its key; it cannot replace the pinned trust
file. The private key is not stored on the persistent Git volume.

`THREADNOTE_REMOTE_MEMORY_GIT_CLONE_URL` opts into repeatable clone bootstrap. After database preflight and before
listening, the service clones an absent/empty worktree, verifies every effective fetch and push URL exactly, and
runs a locked refresh. URL rewrites, extra destinations, a wrong branch, dirty state and unconfirmed local commits
fail closed. An existing mismatched repository is preserved. Local filesystem clone URLs are accepted only for
localhost fixtures. Generic pre-cloned service configurations remain supported without this optional variable.

If an initial clone is killed and leaves a nonempty incomplete directory, stop the Machine and inspect it. Preserve
or quarantine the directory before an operator retries with an empty destination. Startup never deletes unknown
state or resets an existing clone. Do not repair ownership recursively to hide an unexpected volume state.

Before production use, prove a designated canary push with this deploy key and verify that GitHub branch rules
permit it. Fetch access alone is insufficient. For rotation, create the replacement repository key, stage its Fly
secret, restart and prove fetch/write, then revoke the old repository key. Never log private key material.

## Create and deploy one writer

Create the reserved app only if absent. Inspect existing Machine and volume inventory before each operation:

```sh
fly machines list -a threadnote-org
fly volumes list -a threadnote-org
fly volumes create threadnote_org_git --region fra --size 1 -a threadnote-org
fly config validate -c deploy/threadnote-org/fly.toml
```

Reuse the intended existing volume; do not create duplicates on reruns. The named volume mounts at `/data`; the
clone is `/data/memory-git`. Volume snapshots are supplementary protection, not the Git plus PostgreSQL restore drill.

Import the following values through `fly secrets import --stage -a threadnote-org` on standard input, using a private
operator helper or password manager. Do not put secret values on the command line or print them:

- `THREADNOTE_REMOTE_DATABASE_URL`: the restricted runtime URL only.
- `THREADNOTE_ORG_GIT_SSH_KEY_B64`: base64 of the repository deploy private key.

Build and deploy the exact source, retaining a single writer:

```sh
docker build -f deploy/threadnote-org/Dockerfile \
  --build-arg THREADNOTE_SOURCE_REVISION="$(git rev-parse HEAD)" \
  -t threadnote-org:verified .
fly deploy . -c deploy/threadnote-org/fly.toml --ha=false \
  --build-arg THREADNOTE_SOURCE_REVISION="$(git rev-parse HEAD)"
fly machines list -a threadnote-org
fly checks list -a threadnote-org
```

The configuration uses rolling replacement of the sole Machine, so deployment waits for readiness. Never select
canary/blue-green, scale out, or introduce another mutable clone without a reviewed writer-coordination design.
Verify that the final inventory contains exactly one service Machine and the intended mounted volume. Readiness
checks send the exact public Host header to the private listener; autostop is off because background workers poll.
The 60-second signal drain and startup grace periods are explicit. Failed readiness must block release acceptance.

## Enable canaries, then daily use

The versioned configuration starts with `THREADNOTE_REMOTE_ENABLED=false`. Health/readiness still work; MCP and
OAuth discovery return 503 while disabled. This switch gates HTTP, not background ingestion or retention. Therefore
initial startup uses the intended bound share and applies its background reconciliation even before client access.

Verify image identity, final process UID, strict Neon TLS, pinned Git access, clone persistence after restart, and
health/readiness. Then deliberately enable HTTP for the provisioned canary identity by staging the enablement value
and performing a controlled single-Machine deployment. Confirm unauthorized MCP is denied, then prove actual
Codex/Cursor PKCE login, refresh/reconnect and scoped memory operations. Do not copy bearer tokens into agent files.

P4 permits designated canaries only. Routine organization writes remain gated on P5's isolated Git plus PostgreSQL
restore, rollback and measured acceptance workload. Preserve local stdio and personal memory; org HTTP routing is
additive. An enabled endpoint or written configuration file alone does not prove successful cutover.

To close HTTP access, stage `THREADNOTE_REMOTE_ENABLED=false` and restart the sole Machine. To stop all background
Git/database activity as well, stop the Machine. Preserve the volume and authoritative Git repository.

## Registered client setup

Use a public native application registered with the organization IdP, authorization code with S256 PKCE, and the
exact callback URI used by the client. Keep issuer checks enabled. Auth0 refresh tokens require both API offline
access and a requested `offline_access` scope. Configure this explicitly; the installer retains the three required
memory scopes and does not add provider consent scopes implicitly.

For Cursor, target the intended project and supply that client's public registration:

```sh
threadnote mcp-install cursor --project /absolute/repository \
  --composer-url https://threadnote-org.fly.dev/mcp --share-id default \
  --composer-client-id CURSOR_PUBLIC_CLIENT_ID --composer-oauth-scope offline_access --apply
cursor-agent mcp login threadnote-org
cursor-agent mcp list-tools threadnote-org
```

Repeat `--composer-oauth-scope` for additional deliberate provider scopes. Tokens are case-sensitive, bounded to
256 ASCII characters, and cannot contain whitespace, quotes or backslashes; the combined set is at most 32 scopes
and 2048 bytes. Equivalent scope sets produce the same managed configuration. Explicit reattach updates Cursor's
requested scopes; ordinary repair preserves existing provider scopes. Customized scopes do not expand the local
demo's removal ownership. Copilot does not yet have a verified mapping for these additional scope options.

For Codex, **0.153.4 is the minimum verified version for this Auth0 flow**. Version 0.144.5 drops the callback issuer
parameter and fails issuer validation. Update through the client's supported installation channel; Threadnote does
not replace Codex. Configure the exact registered direct-loopback URL and matching listener port, including any
client-specific callback path. The example below requires that exact URI to be registered:

```sh
threadnote mcp-install codex \
  --composer-url https://threadnote-org.fly.dev/mcp --share-id default \
  --composer-client-id CODEX_PUBLIC_CLIENT_ID --composer-oauth-scope offline_access \
  --composer-callback-url http://127.0.0.1:18789/callback --composer-callback-port 18789 --apply
codex mcp login threadnote-org \
  --scopes memory:read,memory:write:durable,memory:write:handoff,offline_access
```

Codex attach adds only `mcp_servers.threadnote-org` to `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`).
It preserves personal stdio, instructions, integration receipts, global callback settings, unrelated configuration
and comments. A compatible existing entry is left byte-for-byte unchanged, including `enabled=false`; explicitly
enable it when ready for cutover. Conflicting bindings/scopes/callbacks and incompatible inline TOML require manual
resolution. New entries require the callback pair; omitting it on a compatible existing entry preserves its callback.
Symbolic links, nonregular or unreadable files are preserved and require manual configuration; regular-file permissions
are retained. Codex's native login syntax cannot preserve commas inside individual scopes, so Codex attach rejects them.
The installer rejects detected concurrent edits and never stores OAuth credentials. Protected-resource discovery
supplies the audience/resource; do not add a redundant `oauth_resource` to this flow.

Run the printed **explicit initial-login command** so requested provider scopes are part of consent. Fresh automatic
login honoring persisted provider scopes has not been proven. Let the CLI open its authorization flow once, complete
it, then exercise authenticated MCP requests through the actual client. Discovery alone is insufficient: verify a
read, designated write, reconnect and refresh after the short access token expires. Inspect bounded provider exchange
events without copying tokens or identity details into receipts.

Observed client evidence on 2026-09-07: Codex 0.153.4 completed seven-tool discovery, recall/read, acknowledged write,
CAS replacement/stale rejection, laptop Git sync and native refresh. Cursor GUI 3.19.13 / Agent 2026.09.02-c22c1a3
completed PKCE and seven-tool discovery; execution and refresh after adding `offline_access` still require acceptance.
These canaries do not complete P5 recovery or authorize a daily cutover by themselves.

Client references: [Codex MCP configuration and callbacks](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[Auth0 refresh-token requirements](https://auth0.com/docs/secure/tokens/refresh-tokens/get-refresh-tokens),
[OAuth scope-token grammar](https://www.rfc-editor.org/rfc/rfc6749#section-3.3).

## Recovery and release evidence

Back up Git history and PostgreSQL control-plane state together. Recovery must preserve immutable revision pointers,
member grants, idempotency receipts and acknowledgement evidence; rebuild only derived search state. Run the drill
against isolated resources before reopening routine writes. A Git clone alone cannot restore PostgreSQL receipts.

A prior image is a rollback candidate only after its runtime privilege allowlist accepts the deployed schema/grants.
Do not blindly roll back across an incompatible migration or restore older control-plane state over acknowledged
writes. Record the compatible image digest, schema versions and volume identity, then test the rollback privately.

Record bounded canary results and operator actions without memory contents, credentials, subjects or raw production
logs. Track SMTP delivery, account MFA/recovery, actual client login, alerts and recovery evidence as separate gates.

References checked 2026-09-07: [Fly configuration](https://fly.io/docs/reference/configuration/),
[Fly availability](https://fly.io/docs/apps/app-availability/),
[Git remote URLs](https://git-scm.com/docs/git-remote),
[GitHub deploy keys](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys),
[GitHub host keys](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints).
