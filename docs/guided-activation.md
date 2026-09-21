# Guided two-agent activation

Threadnote 5 can prove a local decision moves from reviewed repository evidence to a second managed agent surface. The
journey is local/offline, resumable, and preview-first. It does not provision an organization service.

Start from the bounded [request fixture](examples/threadnote-activation-request.json). Copy it, replace both absolute
paths, select two distinct managed catalog surface IDs from `threadnote agents list --json`, and edit the decision and
ADR list. Leave `publicationMode` as `direct`, or change it to `proposal` for a local Git branch and commit that you
merge yourself.

```sh
cp docs/examples/threadnote-activation-request.json /tmp/threadnote-activation.json
threadnote activate start --request /tmp/threadnote-activation.json
threadnote activate start --request /tmp/threadnote-activation.json --apply
```

The apply stops at one approval boundary per invocation. Read the preview and use the exact emitted command/token to
approve imports, the Structured Closeout/Knowledge Delta, its apply, and direct publish or proposal materialization.
Every continuation re-reads the unchanged request and re-observes the repository, catalog installations, candidate
review, and team Git state.

For the final proof, activation prints one `complete_activation_retrieval_proof` call. Invoke that MCP tool from the
named secondary surface with the emitted challenge ID, repository path, project, query, and topic. The installed
Threadnote MCP process verifies its surface/runtime identity, runs bounded project-scoped recall, requires that recall
discover the exact shared memory identity, and only then reads it; pasted recall/read JSON cannot complete the proof.
Then resume:

```sh
threadnote activate continue --activation-id <activation-id> --request /tmp/threadnote-activation.json --apply
threadnote activate status --activation-id <activation-id>
```

If `publicationMode` is `proposal`, merge the local proposal into the configured team branch and sync it before running
the secondary-surface challenge. The reference path is designed to finish within ten minutes from `start --apply` to
the attested second-surface receipt; status reports the measured first-brief and completion timing without content.

Undo is separately previewed and approved. It removes only unchanged, activation-owned local artifacts and never
silently deletes a published team decision or a materialized proposal:

```sh
threadnote activate undo --activation-id <activation-id> --request /tmp/threadnote-activation.json
# Re-run the exact approval command printed by the preview.
```
