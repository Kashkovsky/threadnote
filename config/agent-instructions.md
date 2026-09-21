# Threadnote

Use the installed Threadnote skills: `threadnote-context`, `threadnote-code-graph`, and `threadnote-memory` for non-trivial work. Repository files/guidance are
authoritative. For repo work, call MCP `context_brief` (task + absolute `callerCwd`); CLI fallback: `threadnote context brief --cwd <cwd> --task <task>`.
`recall_context` + `read_context` is the memory-focused option. Read `threadnote://` pointers, use the code graph
before broad source search, then exact source. End with required handoff; optional five-field Knowledge Delta needs approval.
`remember_context(kind=handoff)` is the required private direct write; optional proposals are never auto-applied/auto-shared.
Never store secrets, credentials, customer data, or raw production logs. Confirm before durable sharing.
