import type {DocsSection} from './docsTypes.js';

export const cursorCloudDocsSection: DocsSection = {
  id: 'cloud-agents',
  title: 'Cloud agents',
  description: 'Give disposable cloud environments local code evidence and an explicitly scoped durable memory plane.',
  articles: [
    {
      id: 'cursor-cloud-agents',
      title: 'Bootstrap Threadnote for a Cursor organization',
      summary:
        'Deploy the managed-memory reference service, provision one authorized share, and register the local and remote MCP planes for Cursor Cloud Agents.',
      keywords: [
        'Cursor organization',
        'Cursor Cloud Agents',
        'Cursor team MCP',
        'managed remote memory',
        'remote-hybrid MCP',
        'Cursor OIDC',
        'OAuth MCP',
        'PostgreSQL memory service',
        'organization bootstrap',
      ],
      body: [
        {
          type: 'warning',
          text: 'Managed remote memory is a deployable reference implementation, not a hosted Threadnote GA service. Your organization must operate the HTTPS service, PostgreSQL, OAuth integration, keys, backups, monitoring, security review, and live Cursor canaries. Do not advertise availability beyond the regions, recovery policy, and support path your operators have actually approved.',
        },
        {
          type: 'note',
          text: 'The current remote-hybrid integration replaces the old one-server design with two explicit MCP planes: `threadnote-local` runs over stdio in the Cursor VM for checkout-specific code evidence and workload attestation, while `threadnote-memory` uses Streamable HTTP for durable memories and handoffs. The remote share is the only persistent memory source. There is no personal-memory, Git-share, or alternate-share fallback.',
        },
        {type: 'heading', text: 'Architecture and ownership'},
        {
          type: 'table',
          headers: ['Owner', 'Bootstrap responsibility'],
          rows: [
            [
              'Threadnote service operator',
              'Deploy TLS, PostgreSQL, migrations, least-privilege runtime grants, workers, backups, health checks, and canaries.',
            ],
            [
              'Identity administrator',
              'Configure the OAuth issuer, exact MCP audience and scopes, JWKS rotation, revocation, and principal mapping.',
            ],
            [
              'Cursor team admin',
              'Create the team environment and active Build, register both shared MCP servers, and control who can enable them.',
            ],
            [
              'Repository owner',
              'Approve the project catalog, complete repository binding set, cloud-only agent instructions, and rollout canaries.',
            ],
          ],
        },
        {
          type: 'paragraph',
          text: 'Use one opaque share ID for the complete path from provisioning to Dashboard configuration. The service authorizes that share from the OAuth grant and requires the same `threadnote-share-id` header; the model never chooses a tenant or share. Decide the tenant ID, share ID, region, projects, exact repository set, Cursor team ID, allowed owners or service accounts, OAuth subjects, capabilities, retention policy, and incident owner before changing Cursor.',
        },
        {type: 'heading', text: 'Prerequisites'},
        {
          type: 'list',
          items: [
            'A Cursor team with Cloud Agents enabled, connected source control, a team admin who can manage Dashboard → Integrations & MCP, and a saved environment for the intended repository or repository group.',
            'A production HTTPS origin such as `https://memory.example.com`; the MCP URL must be exactly `/mcp`, credential-free, and have no query or fragment.',
            'A standards-compatible OAuth authorization server and JWKS. Its access tokens must use the exact public MCP URL as audience and grant only the Threadnote scopes the member needs.',
            'Managed PostgreSQL in one approved region, with distinct bootstrap, migrator/operator, and runtime identities; encrypted backups and a rehearsed restore path.',
            'A secret manager, private database networking, signed and scanned service images, restricted operator access, privacy-safe monitoring, and an explicit kill-switch owner.',
            'Outbound access from the local Cloud Agent adapter to the Threadnote HTTPS origin for attestation completion. If egress is restricted, allow the Threadnote origin and the identity endpoints required by your OAuth flow.',
          ],
        },
        {type: 'heading', text: '1. Deploy the remote-memory service'},
        {
          type: 'paragraph',
          text: 'Start from the repository reference deployment in `deploy/remote-memory`, but treat Docker Compose as a loopback development example only. Production needs managed TLS at the edge and to PostgreSQL, network isolation, managed secrets, immutable images, regional backups, and supervised HTTP, indexer, and retention work. Follow the full [remote-memory operations runbook](https://github.com/Kashkovsky/threadnote/blob/main/docs/remote-memory/operations.md) and [threat model](https://github.com/Kashkovsky/threadnote/blob/main/docs/remote-memory/threat-model.md).',
        },
        {
          type: 'code',
          language: 'sh',
          code: `THREADNOTE_REMOTE_PUBLIC_URL=https://memory.example.com
THREADNOTE_REMOTE_ENABLED=false
THREADNOTE_REMOTE_ALLOWED_HOSTS=memory.example.com
THREADNOTE_REMOTE_ALLOWED_ORIGINS=https://cursor.com

THREADNOTE_REMOTE_OAUTH_ISSUER=https://identity.example.com
THREADNOTE_REMOTE_OAUTH_AUDIENCE=https://memory.example.com/mcp
THREADNOTE_REMOTE_OAUTH_JWKS_URL=https://identity.example.com/.well-known/jwks.json

THREADNOTE_REMOTE_CURSOR_ISSUER=https://api.cursor.com
THREADNOTE_REMOTE_CURSOR_AUDIENCE=https://memory.example.com/attest/cursor
THREADNOTE_REMOTE_CURSOR_JWKS_URL=https://api.cursor.com/keys

THREADNOTE_REMOTE_AUTO_MIGRATE=false
THREADNOTE_REMOTE_DATABASE_URL=postgresql://threadnote_remote_runtime:REDACTED@db.internal/threadnote_remote?sslmode=verify-full`,
        },
        {
          type: 'warning',
          text: 'Keep `THREADNOTE_REMOTE_ENABLED=false` during initial deployment. Never inject the PostgreSQL bootstrap superuser or migrator URL into the HTTP service, workers, canary, Cursor, or repository. The runtime role must be `NOSUPERUSER NOBYPASSRLS`, must not own tables, and must not have DDL or control-plane mutation privileges.',
        },
        {
          type: 'paragraph',
          text: 'Run migrations once with the migrator/operator identity, then apply `deploy/remote-memory/grants/001-runtime.sql` as a separate reviewed job. The runtime deliberately refuses automatic migration. A changed checksum for an applied migration or a schema change missing from the grant allowlist is a release blocker.',
        },
        {
          type: 'code',
          language: 'sh',
          code: `THREADNOTE_REMOTE_DATABASE_URL="$THREADNOTE_REMOTE_MIGRATOR_DATABASE_URL" \\
  bun src/standalone.ts remote-memory-operator migrate

# Run this with the migrator identity in your one-shot database job.
psql --set=ON_ERROR_STOP=1 \\
  --file=deploy/remote-memory/grants/001-runtime.sql`,
        },
        {
          type: 'paragraph',
          text: 'Before client traffic, require `/healthz` for process liveness and `/readyz` for constant-time worker readiness. Verify that the runtime role cannot bypass row-level security with a two-tenant negative test. Record the image digest, migration result, runtime-grant result, region, restore point, and rollback owner without recording connection strings, tokens, memory text, queries, URIs, or source paths.',
        },
        {type: 'heading', text: '2. Configure OAuth and Cursor workload identity'},
        {
          type: 'paragraph',
          text: 'OAuth and Cursor OIDC have different jobs. Cursor-managed MCP OAuth authenticates each human or service principal to `threadnote-memory`; OAuth remains per-user even when the MCP server is shared at team level. The local adapter separately completes a short-lived, nonce-bound Cursor OIDC challenge before a protected write. That attestation attributes the Cloud Agent run but cannot widen the OAuth grant or share policy.',
        },
        {
          type: 'list',
          items: [
            'Register `https://memory.example.com/mcp` as the only resource audience. Configure only `memory:read`, `memory:write:durable`, `memory:write:handoff`, or operator-only `memory:admin` scopes.',
            'Map the OAuth issuer and immutable `sub` to one active Threadnote principal. Do not authorize by display name or email.',
            'Trust Cursor workload tokens only from issuer `https://api.cursor.com`, JWKS `https://api.cursor.com/keys`, algorithm RS256, and exact audience `https://memory.example.com/attest/cursor`.',
            'Pin `agent_runtime: managed`, the allowed default Cursor subject, team ID, owner user or service-account IDs, and the complete `repo_urls`/`repo_count` set. Do not treat the primary `repo_url` as proof of a single-repository workspace.',
            'Keep bearer and raw Cursor OIDC tokens transient. Threadnote stores only the verified bounded claim subset and never returns the raw workload JWT.',
            'Exercise JWKS rotation, revocation, wrong audience, wrong team, wrong owner, incomplete repository set, expired nonce, and clock-skew failures before enabling writes.',
          ],
        },
        {
          type: 'note',
          text: 'Cursor documents the current token socket, claims, issuer, and five-minute token lifetime in [OIDC tokens](https://cursor.com/docs/cloud-agent/identity). The token identifies the whole VM run, not a trusted process inside it; scope the share grant to what the complete run may access.',
        },
        {type: 'heading', text: '3. Provision one organization share'},
        {
          type: 'paragraph',
          text: 'Create one versioned provisioning document per OAuth principal. Keep it in an access-controlled operator workspace and delete it according to your normal change record. It must not contain an access token, client secret, database password, private key, or memory content.',
        },
        {
          type: 'code',
          language: 'json',
          code: `{
  "tenantId": "tenant-acme",
  "shareId": "sh_acme_engineering",
  "principalId": "principal-12345",
  "issuer": "https://identity.example.com",
  "subject": "opaque-oauth-subject",
  "displayName": "Acme engineering memory",
  "region": "eu-example-1",
  "sharePolicyVersion": "share-v1",
  "policyVersion": "grant-v1",
  "projects": ["platform"],
  "repositoryBindings": {
    "platform": ["https://github.com/acme/platform"]
  },
  "allowedProjects": ["platform"],
  "capabilities": [
    "memory:read",
    "memory:write:durable",
    "memory:write:handoff"
  ],
  "cursorSubjects": ["user:12345"],
  "cursorOwnerIds": ["12345"],
  "cursorTeamId": "6789",
  "cursorAttestationRequired": true,
  "featureFlags": [
    "remote_memory_read",
    "remote_memory_durable_write",
    "remote_memory_handoff_write",
    "cursor_oidc_required",
    "remote_memory_ga"
  ]
}`,
        },
        {
          type: 'code',
          language: 'sh',
          code: `chmod 600 ./provision.v1.json
THREADNOTE_REMOTE_DATABASE_URL="$THREADNOTE_REMOTE_MIGRATOR_DATABASE_URL" \\
  bun src/standalone.ts remote-memory-operator provision \\
  --input ./provision.v1.json`,
        },
        {
          type: 'warning',
          text: 'Provisioning is desired-state and versioned. A later share-wide change must provide a new `sharePolicyVersion`, the exact `expectedCurrentSharePolicyVersion`, and the complete projects, repository bindings, and feature flags. A member-grant change uses its own `policyVersion` and `expectedCurrentPolicyVersion`. Never add a member by replaying a stale document or by editing PostgreSQL directly.',
        },
        {
          type: 'paragraph',
          text: 'For a read-only first stage, grant only `memory:read` and enable only `remote_memory_read`, `cursor_oidc_required`, and `remote_memory_ga`. Add each write capability and its matching feature flag only after the protected read canary is healthy. Once the isolated share is provisioned and readiness is green, enable `THREADNOTE_REMOTE_ENABLED=true` for the intended environment; both the global switch and share-level `remote_memory_ga` gate must be on for MCP traffic.',
        },
        {type: 'heading', text: '4. Install the local adapter in the team environment'},
        {
          type: 'paragraph',
          text: 'Create or update the saved team environment for the exact repository or repository group. Cursor resolves environments in this order: checked-in `.cursor/environment.json`, personal saved environment, then team saved environment. Audit the first two layers before rollout or they can legitimately override the organization default. See [Cloud Environment Setup](https://cursor.com/docs/cloud-agent/setup) and [Cloud Agent Builds](https://cursor.com/docs/cloud-agent/builds).',
        },
        {
          type: 'paragraph',
          text: 'Put the standalone installation and remote-hybrid bootstrap in the environment `install` command. The command must be idempotent because Cursor runs it for every Build and may reuse prepared disk. Builds preserve disk state, not running processes or shell exports. The endpoint and share ID are identifiers rather than bearer credentials; keep all actual credentials in Cursor or the identity provider.',
        },
        {
          type: 'code',
          language: 'sh',
          code: `set -eu

curl -fsSL https://raw.githubusercontent.com/Kashkovsky/threadnote/main/scripts/install.sh | \\
  sh -s -- --no-start

"$HOME/.local/bin/threadnote" cloud cursor bootstrap \\
  --mode remote-hybrid \\
  --endpoint https://memory.example.com/mcp \\
  --share-id sh_acme_engineering \\
  --cwd "$PWD" \\
  --user cursor-cloud \\
  --agent-id cursor-cloud

test -x "$HOME/.local/bin/threadnote-mcp-server"
"$HOME/.local/bin/threadnote" doctor --dry-run`,
        },
        {
          type: 'paragraph',
          text: 'Trigger a new Build, inspect its log, and make the latest successful Build active. A failed Build does not replace the last good one. For a multi-repository environment, ensure every repository in the environment matches the provisioned complete repository binding; use an existing absolute checkout as `--cwd`, and let each graph call supply the relevant checkout path.',
        },
        {type: 'heading', text: '5. Register both organization MCP servers'},
        {
          type: 'paragraph',
          text: 'Generate the deterministic configuration from a trusted Threadnote installation. The command changes no service or Cursor state:',
        },
        {
          type: 'code',
          language: 'sh',
          code: `threadnote cloud cursor config \\
  --mode remote-hybrid \\
  --endpoint https://memory.example.com/mcp \\
  --share-id sh_acme_engineering \\
  --user cursor-cloud \\
  --agent-id cursor-cloud`,
        },
        {
          type: 'code',
          language: 'json',
          code: `{
  "mcpServers": {
    "threadnote-local": {
      "type": "stdio",
      "command": "/bin/sh",
      "args": ["-lc", "exec \\"$HOME/.local/bin/threadnote-mcp-server\\""],
      "env": {
        "THREADNOTE_ACCOUNT": "local",
        "THREADNOTE_AGENT_ID": "cursor-cloud",
        "THREADNOTE_CURSOR_MEMORY_ENDPOINT": "https://memory.example.com/mcp",
        "THREADNOTE_CURSOR_MEMORY_SHARE_ID": "sh_acme_engineering",
        "THREADNOTE_MCP_TOOLSET": "cursor-cloud-local",
        "THREADNOTE_USER": "cursor-cloud"
      }
    },
    "threadnote-memory": {
      "url": "https://memory.example.com/mcp",
      "headers": {
        "threadnote-share-id": "sh_acme_engineering"
      }
    }
  }
}`,
        },
        {
          type: 'list',
          items: [
            'In Cursor Dashboard, open Integrations & MCP as a team admin and add `threadnote-local` as a shared stdio server and `threadnote-memory` as a shared HTTP server. Keep the names distinct so failures identify the plane.',
            'Copy the endpoint and share ID exactly. The HTTP URL carries no credentials, and the only static header is `threadnote-share-id`. Never add an Authorization, bearer, database, or Git credential to this JSON.',
            'Configure OAuth on `threadnote-memory` and have each intended user complete their own sign-in. Cursor OAuth is per-user even for a shared team server.',
            'Enable the pair only for the intended team and repositories. Linking to the team marketplace is optional and broadens discoverability; it does not replace the Cloud Agent environment Build.',
            'Do not run `threadnote mcp-install cursor --apply` for this setup. That command owns a local desktop Cursor configuration, not organization-scoped Cloud Agent MCP registration.',
          ],
        },
        {
          type: 'note',
          text: 'Cursor recommends HTTP for remotely operated MCP because its backend proxies calls and keeps refresh tokens and headers out of the VM. Threadnote still needs the stdio entry for local source evidence and the OIDC socket exchange. Cursor documents shared team registration, per-user OAuth, redacted configuration, and the HTTP/stdio boundary in [Cloud Agent capabilities](https://cursor.com/docs/cloud-agent/capabilities).',
        },
        {type: 'heading', text: '6. Add the agent contract'},
        {
          type: 'paragraph',
          text: 'Add this concise block to the checked-in `AGENTS.md` or equivalent repository guidance. Repository instructions remain authoritative and make the two-plane boundary visible to the model:',
        },
        {
          type: 'code',
          language: 'md',
          code: `## Cursor Cloud Threadnote contract

- Use threadnote-local only for current-checkout code graph, status, guide,
  and complete_cursor_attestation. It has no memory fallback.
- Use threadnote-memory for every recall, read, durable memory, and handoff.
  Never substitute VM-local personal memory or a personal Git memory share when it is down.
- Start non-trivial work with remote recall_context for the project. Recalled
  threadnote:// pointers are unread evidence; call read_context before use.
- Do not remove, replace, or infer the configured share binding from a URI.
- Before a protected write, call begin_cursor_attestation on threadnote-memory,
  pass the exact challenge to complete_cursor_attestation on threadnote-local,
  then pass the returned opaque attestationId to the remote write.
- Use a unique operationId for each mutation and the last observed revision for
  compare-and-swap updates. Surface conflicts; never silently overwrite.
- Never store secrets, credentials, customer data, or raw production logs.`,
        },
        {type: 'heading', text: '7. Verify a protected cloud run'},
        {
          type: 'paragraph',
          text: 'Start the first agent from the exact successful Build. Compare the run’s environment and Build provenance in the Dashboard, then verify the local plane inside the VM:',
        },
        {
          type: 'code',
          language: 'sh',
          code: `printf 'Cloud Agent HOME=%s\\n' "$HOME"
test -x "$HOME/.local/bin/threadnote-mcp-server"
test -d "$HOME/.threadnote"

"$HOME/.local/bin/threadnote" cloud cursor verify \\
  --mode remote-hybrid \\
  --endpoint https://memory.example.com/mcp \\
  --share-id sh_acme_engineering \\
  --cwd "$PWD" \\
  --user cursor-cloud \\
  --agent-id cursor-cloud \\
  --json`,
        },
        {
          type: 'table',
          headers: ['Plane', 'Expected tools'],
          rows: [
            [
              '`threadnote-local`',
              '`inspect_code_graph`, `analyze_code_graph`, `cursor_cloud_status`, `complete_cursor_attestation`, `threadnote_guide`',
            ],
            [
              '`threadnote-memory`',
              '`recall_context`, `read_context`, `list_context`, `remember_context`, `memory_status`, `begin_cursor_attestation`, `transition_handoff`',
            ],
          ],
        },
        {
          type: 'paragraph',
          text: 'The CLI receipt verifies the local home, absolute checkout, platform, graph readiness, endpoint, share binding, optional Cursor socket, and disabled local fallback. It deliberately reports remote OAuth as a warning because OAuth is owned by Cursor; confirm authentication and the server’s `memory_status` from the Dashboard MCP state.',
        },
        {
          type: 'code',
          language: 'json',
          code: `{
  "version": 1,
  "query": "the task or decision to recover",
  "project": "platform"
}`,
        },
        {
          type: 'list',
          items: [
            'Run `memory_status` and confirm the expected share, policy version, committed/indexed generations, and writable capabilities.',
            'Recall and read a durable fixture, then verify a request for another project or share fails closed.',
            'For write stages, run the remote `begin_cursor_attestation` → local `complete_cursor_attestation` → remote write sequence. Confirm the challenge audience and completion URL use the configured Threadnote origin.',
            'Write one durable memory and one handoff with unique operation IDs, then recall both from a fresh VM and a fresh OAuth-backed MCP session.',
            'Race two agents on the same base revision and require one commit plus one explicit conflict or idempotent replay; write different topics concurrently and require both to progress.',
            'Disable the remote service and confirm local graph inspection still works while every memory operation fails—without selecting local or Git memory.',
          ],
        },
        {type: 'heading', text: '8. Roll out and operate it safely'},
        {
          type: 'paragraph',
          text: 'Roll out one isolated fixture share first, then internal read-only, protected durable writes, handoffs, selected external canaries, and only then broader availability. At every stage record the owner, region, backup/deletion policy, OAuth client policy, alert route, observation window, success threshold, and exact switches to disable. Follow the [canary and staged-release matrix](https://github.com/Kashkovsky/threadnote/blob/main/docs/remote-memory/canaries-and-release.md).',
        },
        {
          type: 'list',
          items: [
            'Kill traffic with `THREADNOTE_REMOTE_ENABLED=false`; narrow a share with its feature flags or revoke the principal grant. Revocation must win over a concurrent stale authorization before commit.',
            'Page on authorization failure classes, request latency, conflicts/replays, outbox age, indexing lag, worker health, database saturation, backup/restore evidence, and canary state—never on memory bodies or raw identity tokens.',
            'Back up every authoritative table. Rehearse point-in-time restore, content-hash and head/revision reconciliation, two-tenant RLS, alias/idempotency behavior, and a full derived-index rebuild.',
            'Keep Git-beta migration explicit and one-way. Import never deletes the source, never dual-writes, and still requires a reviewed Dashboard transport switch.',
            'Rollback after cutover requires a verified export to a new restricted Git checkout and an explicit Dashboard change. Never make the old pre-cutover checkout writable again.',
          ],
        },
        {type: 'heading', text: 'What persists'},
        {
          type: 'table',
          headers: ['State', 'Remote-hybrid contract'],
          rows: [
            [
              'Durable memories',
              'Immutable PostgreSQL revisions in the authorized remote share; available to later VMs after authorization.',
            ],
            [
              'Handoffs',
              'Remote, revisioned, and durable across sessions, with explicit supersede, archive, and expiry transitions.',
            ],
            [
              'Code graph',
              'Derived inside each VM from the current checkout and dirty overlay; rebuildable and never uploaded by the memory service.',
            ],
            [
              'OAuth and Cursor OIDC',
              'OAuth is per-user in Cursor; raw tokens remain transient. Threadnote retains only bounded verified attribution.',
            ],
            [
              'Repository changes',
              'Persist through the normal branch, commit, pull request, and task workflow—not through Threadnote memory.',
            ],
          ],
        },
        {type: 'heading', text: 'Personal setup is separate'},
        {
          type: 'paragraph',
          text: 'For individual use without an organization-operated memory service, follow [Personal Cursor Cloud setup](personal-cursor-cloud/). It uses one personal stdio MCP with one or more private Git memory shares and Cloud-specific skills. Do not register the personal and remote-hybrid profiles in the same environment, and never use one as an automatic fallback for an outage. Migration requires the explicit [plan, import, cutover, export, and rollback workflow](https://github.com/Kashkovsky/threadnote/blob/main/docs/remote-memory/migration.md).',
        },
      ],
    },
  ],
};
