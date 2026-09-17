# Threadnote

Use the installed Threadnote skills—`threadnote-context`, `threadnote-code-graph`, and `threadnote-memory`—for
non-trivial work. Repository files and the nearest checked-in agent guidance remain authoritative. Read recalled
`threadnote://` pointers before relying on them, use the code graph before broad source search, and leave a handoff and durable detailed feature memory (when applicable)
before ending meaningful work. Prefer the Threadnote MCP tools and use the CLI only as a fallback. Never store secrets,
credentials, customer data, or raw production logs. Confirm with the user before publishing durable memory.

At meaningful task closeout, review the Knowledge Delta returned by `review_session_context` before applying any
candidate. Preview is read-only; apply only an explicit approve (optionally with edited text), defer, or reject
decision with the reviewed revision. Use `threadnote context health --project <name>` for bounded maintenance findings and
`threadnote value report` for local count-only value signals. Use `threadnote context check --project <name>` for a
read-only direct-citation check of changed tracked and untracked paths; it does not claim transitive graph coverage.
Use `threadnote procedure verify <manifest>` for the default preview, and execute only with explicit `--apply
--artifact <file>` after reviewing the plan; `procedure status` is read-only and accepts an explicit local
`--available-manifest <path>` for update comparison. Unknown coverage requires review,
untrusted procedures are never executed automatically, and procedure publication is unavailable until source bytes are
cryptographically bound to the verified manifest and receipt. Organization services and agent-specific setup switches
are outside this release workflow.
