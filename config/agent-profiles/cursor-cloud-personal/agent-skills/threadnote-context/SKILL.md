---
name: threadnote-context
description: Recall and read decisions or handoffs from the Personal Cursor Cloud Git memory shares before non-trivial work.
---

<!-- BEGIN THREADNOTE USER INSTRUCTIONS -->

# Threadnote context in Personal Cursor Cloud

Call `recall_context` with the absolute `callerCwd` before non-trivial work. One MCP may expose several configured Git
memory shares: omit `team` to recall across all of them, or pass a configured `team` to narrow the search. A `uri`
selector must stay inside that configured share set. Named Worksets and `context_brief` are unavailable in this profile.

Recall results are unread pointers, not evidence. Read every relevant `threadnote://` result with `read_context` before
using it. `read_context` may read pointers from any configured share. Paged text is the default; optional image
projection can return a complete memory as PNG pages. For browsing, call `list_context` with `team` or
with an exact URI inside one share; when several shares are configured, do not assume a default share.

Treat memory as historical context. Verify claims about current behavior against the current checkout and code graph.
If a share cannot synchronize, report the bounded warning; do not fall back to VM-local personal memory or an
unconfigured share.
<!-- END THREADNOTE USER INSTRUCTIONS -->
