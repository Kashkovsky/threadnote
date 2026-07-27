# Security

Threadnote stores local canonical content under `~/.threadnote` with private directories and files. Every `threadnote://`
identifier is parsed into validated portable segments; traversal, ambiguous encodings, escaping links, and unsupported
file types are rejected.

Writes use per-resource locks, compare-and-swap where replacement semantics require it, a same-directory temporary
file, durable close, and atomic rename. Derived index generations are activated by a checksummed pointer only after
the full generation exists.

Model artifacts are pinned by immutable repository revision, byte count, SHA-256, role, runtime version, and license.
Install and repair provision the core embedding model automatically; additional model roles require an explicit
selection. Partial downloads are never loaded. The llama adapter requests prebuilt binaries and refuses runtime
compilation or implicit binary download.

Share publishing scrubs known credential and machine-local path patterns before writing or pushing. Handoffs and
preferences are not publishable. Publish order preserves the personal source until the shared canonical write,
verification, git commit, and push succeed.

Obsidian sources require an explicit include allowlist and always exclude `.obsidian/**`, trash, configured Inbox
folders, and managed projection folders. Source traversal rejects symbolic links and vault-boundary escapes. Content is
secret-scanned before the sanitized copy is committed to the native store. External resource URIs impose `external`
authority and `untrusted` trust; source frontmatter cannot elevate either value.

Obsidian projections write only managed paths, preserve edited and unmanaged files by default, and secret-scan each
generated note before atomic replacement. Inbox notes form review candidates but never silently create durable memory.

The manager binds to loopback, uses a per-process bearer token, and never exposes a model or memory server. MCP uses
stdio. Threadnote has no background daemon, listening storage port, or native HTTP MCP endpoint.
