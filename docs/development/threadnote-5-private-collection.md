# Private Threadnote 5 collection seam

Verified candidate-process capture currently runs on a macOS collection workstation because it depends on the
platform's suspended-spawn identity check. Descriptor-relative private file handling remains portable across supported
macOS/Linux (POSIX) hosts and accepts only
a canonical interpreter protected by root-owned, non-writable path components.

`scripts/collect-threadnote-5-release-readiness.ts` adds a process runner in front of the existing capture validator.
It does **not** supply a completed release-evidence run or make the full matrix independently runnable. All fifteen
reviewed scenario recipes, source-native projections, the 4.7 migration boundary observations, and independently
collected authority must still be supplied. Missing recipes fail preflight. Missing native fields, cardinalities,
authority, or replayable source contracts fail closed; there is no fixture mode or passing fallback.

## Workflow

1. Prepare a private plan matching `Threadnote5CollectionPlan` in
   `src/evaluation/threadnote-5-release-collection.ts`. Use the canonical candidate descriptor and a new run ID.
   Preview it with `bun scripts/collect-threadnote-5-release-readiness.ts preview --plan <plan.json>`.
2. Review the complete plan, including every CLI/MCP operation and synthetic input write. Collection requires the
   exact preview's SHA-256 via `--approved-plan-sha256`, the absolute canonical native standalone payload (ELF/Mach-O,
   never the installed shell launcher), and a new private output reference. The runner makes a private read-only copy
   of the exact payload and executes that verified copy. It does not install, update, or globally activate the candidate.
3. Collect independent observer artifacts while the scenarios execute. This runner does not observe network/write
   syscalls, judge citations, verify procedure command outcomes independently, or certify human approval. Assemble
   the authority manifest outside this runner against the retained record digests. Its reviewed hash must come from
   outside the manifest. Product output cannot establish this authority.
4. Independently review a collection binding `{version:1, collectionHash, authorityManifestHash}` and retain its hash:
   SHA-256 of `threadnote-5-collection-authority-binding-v1` + NUL + canonical JSON of the binding. The authority hash
   names the unchanged legacy manifest; the collection hash names this exact plan/transcript/source/runtime envelope.
5. Run `seal` with private `collection.json`, `plan.json`, and `transcripts.json`, the canonical fixture/candidate,
   raw legacy authority manifest and independently reviewed hash, plus `--collection-authority-binding` and its
   independently supplied `--collection-authority-binding-sha256`. Seal reconstructs the plan hash, transcript digest,
   every native record/provenance entry and collection hash before applying the existing strict source replay gate.
   Successful sealing writes only `evidence.json` and content-free `digests.json` in a new directory reference.

Use `--help` for exact command arguments. Preview and collection emit counts and hashes, never private source contents.

## Recipe contract

The canonical matrix is exactly fifteen scenarios and twenty-four source records. A measured source has 10–64 trials;
static sources have exactly one. `interrupted-resumed` has one activation source trial but measured closeout trials;
`output-budgets` has exactly one Context Brief and one closeout. Recipe order is canonicalized before hashing.

Each trial gets separate primary/secondary homes, a temporary Git repository, its detached worktree, and a bare local
test remote. Each surface has its own mode-0700 `TMPDIR` under its own home, separate from identity-only checks.
`HOME`, `THREADNOTE_HOME`, XDG directories, temporary storage, and Git configuration are isolated; ambient
credentials and other environment variables are not inherited. Only local file Git transport is enabled. This is state
isolation, not an operating-system security sandbox or independent proof of zero network activity.

Recipes support candidate `cli` steps, candidate stdio `mcp` calls, bounded `read-json` steps under an isolated home or
repository, and exclusive-create `write` steps for synthetic inputs. There is no arbitrary shell step. CLI output is
captured as `{stdout, stderr, exitCode, elapsedMilliseconds, json}`; non-JSON stdout leaves `json` null. MCP responses
are captured natively. Managed retrieval proof can therefore use the candidate's own MCP session rather than a
fabricated attestation. Recipes must actually implement the required product flows; merely naming a tool is not proof.

Bindings are `{{home}}` (THREADNOTE_HOME), `{{userHome}}`, `{{repo}}`, `{{primaryRepo}}`, `{{secondaryRepo}}`,
`{{remote}}`, `{{laneId}}`, `{{trialId}}`, `{{reviewId}}`, `{{proposalId}}`, and `{{activationId}}`.
`{{output:step-id:/json/pointer}}` selects a previously captured scalar. Product-generated identities may differ from
the suggested bindings, but observed lane/trial/review/proposal/activation identities cannot be reused across trials.

Native projections support four forms: `{select, pointer, trial}`, `{collect, pointer, flatten}`, `{object: {...}}`, and
`{array: [...]}`. Every leaf selects an executed native source; literal success flags and synthesized measurements are
not supported. A synthetic input write cannot itself be a projection source or be reread as native evidence.
The primary observation array of every measured artifact must be a `collect`; each trial must contribute exactly one
native object. Flattening accepts only singleton arrays. Static sources select trial 0 only. Duplicate observation
digests fail closed, and the private envelope preserves each observation digest with its deterministic trial ID.
Source-native adapters remain necessary where existing commands do not expose all replay inputs. In particular,
activation history/challenge exports, Context Brief timing/citation linkage, feedback/value-report event linkage,
health report/repair inputs, closeout review/application state, proposal approval audit, procedure verification inputs,
guidance stale rejection, dirty read-fence evidence, and native 4.7 migration boundary state must not be guessed.

## Runtime and privacy boundaries

The installed candidate and pinned payload are verified by bytes and inode; the actual executed payload's SHA-256,
filesystem identity and exact commit-bearing `--version` are checked around each CLI/MCP step and scenario. Drift,
missing selectors, unexpected exits, duplicate identities or invalid provenance/cardinality aborts collection.
Every CLI and MCP server has an owned POSIX process group. Successful leaders and their remaining group members are
terminated and group absence is verified before capture/cleanup proceeds. MCP protocol and stderr bytes are bounded
incrementally before SDK buffering/parsing; the post-parse object limit remains a second check. This is not a sandbox
against hostile processes deliberately escaping their process group; independently observed execution remains required.

Publication uses an exclusive-create relative directory symlink to the completed private staging directory. It cannot
replace a raced regular file, directory, or symlink. The destination path is therefore a completion reference, while
the data remains under its private sibling `.threadnote-collection-*` target. Failed staging is removed only after
process-group quiescence; when cleanup cannot establish quiescence the stage is quarantined and never published.

Private collection retains native records, raw transcripts and isolated homes, with mode 0700 directories/0600 capture
files. `retention.json` records a deletion deadline of at most seven days. The operator must delete the entire private
collection directory target and its completion reference by that deadline after establishing quiescence; this command
does not schedule unattended deletion. Never upload these homes,
source contents, transcripts, secrets, personal paths, or raw logs as release evidence. Fixtures/test doubles are used
only by unit tests and cannot be selected through the production collection command.

The authority integration surface is deliberately narrow: the collector emits candidate-bound native record digests,
exact scenario runtime boundaries, a plan digest, private transcript digest and collection hash; sealing consumes the
existing strict authority manifest plus separately reviewed hashes for both the manifest and collection binding.
No authority schema or baseline protocol is weakened here. These are private engineering details and do not belong in
public release notes.
