# Standalone release signing

Threadnote releases are built from a pushed version tag. Pull-request and ordinary CI builds stay unsigned; the
release workflow fails closed when a signing or notarization credential is missing.

Enable **immutable releases** in the GitHub repository settings before publishing. The workflow builds, signs,
notarizes, archives, and checksums every enabled target before `gh release create` uploads the complete set and makes the
release public. It then verifies GitHub reports the release as immutable. The CLI and bootstrap installers ignore
mutable releases, so a repository with immutability disabled cannot distribute an installable Threadnote 4 release.
GitHub's immutable-release attestation binds the tag, commit, and assets; the per-archive SHA-256 file protects the
local download path. Official installers and the built-in updater also require Apple notarization/signature validation.
Linux uses the immutable GitHub release as its publisher trust root; an offline project signing authority is not part
of the Threadnote 4 release model.

Cursor Marketplace publication is a separate reviewed workflow with its own permissive-license boundary and plugin
version. A standalone release bundles the plugin source for package validation and publishing; global doctor health
does not require it, and install, update, repair, and uninstall never place it into Cursor. Follow the
[Cursor plugin publishing guide](./cursor-plugin.md); a Threadnote version tag does not submit or re-index the plugin
automatically.

## Build matrix

CI bytecode-compiles the exact standalone entrypoint for all eight Bun base targets:

- macOS arm64 and x64
- Linux arm64 and x64 with glibc
- Linux arm64 and x64 with musl
- Windows arm64 and x64

Threadnote 4.6 publishes six archives: macOS, glibc Linux, and Windows for arm64 and x64. The two musl executables
remain compile gates only because musl lacks a distinct compatible bundled local-inference payload. Windows archives
are explicitly unsigned until Authenticode signing is approved; publication and installation require an immutable
GitHub release plus the archive's SHA-256 checksum, and the installer warns before activation. Every native release
runner installs the core GGUF model and produces a real embedding with its exact `dist/` payload before signing or
archiving. The same payload must contain the pinned Tree-sitter runtime, Java/Kotlin/Swift grammar WASM, source/ABI/
version/checksum manifest, and all four parser licenses. Source checks, archive smoke tests, and updater validation each
reject missing or altered code-graph assets.

Pull-request distribution CI retains `ubuntu-latest` and `windows-latest` and gates the exact `macos-15` Apple Silicon
and `macos-15-intel` runner labels used by the release workflow. Their real-model installed-release E2E—including the
supervised local-model worker and disk-capacity admission—is therefore a pre-tag gate rather than being exercised for
the first time after a tag is pushed.

## Signing order

macOS builds sign each nested Mach-O native library first, then sign the Bun executable with hardened runtime and the
minimal JIT entitlements in `scripts/macos-entitlements.plist`. CI verifies the signatures, submits a ZIP containing
the exact `dist/` payload to Apple notarization, waits for acceptance, and verifies the executable signature again.
Only then does it create the release archive and checksum. `spctl` app assessment is not used because Threadnote is a
standalone command-line executable rather than an application bundle.

Windows x64 and arm64 build, strict-doctor, real-embedding, archive, and clean-machine installer verification are
publication dependencies. Their release metadata declares the payload unsigned, and official installers reject a
Windows archive that omits or contradicts that policy. The dormant Azure Authenticode job remains hard-disabled for a
future signed release. Enabling it still requires an approved provider and a reviewed ownership policy for bundled
upstream `.dll` and `.node` files. Linux and Windows artifacts are protected by the immutable GitHub release and
checksums but are not OS code-signed.

## Publishing

For a prerelease, use a full SemVer prerelease such as `4.1.0-beta.1` in `package.json`,
`.github/release-notes/v4.1.0-beta.1.md`, and the `v4.1.0-beta.1` tag. The publisher detects the hyphenated tag and
creates a GitHub prerelease; do not use an unnumbered `-beta` suffix.

1. Add `.github/release-notes/vX.Y.Z.md` for the exact version being released. Begin with `## What's new`, then open
   with one sentence (at most 240 characters after the `Threadnote X.Y.Z` prefix) that states the release's main
   feature; the website uses that sentence to generate the release social card automatically. Describe user-visible
   value rather than implementation history, include concrete commands when useful, and do not add a validation/checks
   section.
2. Merge the release source and ensure ordinary CI is green.
3. Dispatch `Platform benchmarks` on exact clean candidate **C** with
   `include_context_brief_citations_scale=true`, `include_code_memory_link_scale=true`, and
   `include_memory_connections_scale=true`. Before tagging, require its Context Brief citation artifact to report
   v2 `evidenceClass=release-scale`, `gate.passed=true`, the exact candidate commit, `dirty=false`, 100,000 indexed
   memory candidates, exactly 100 samples, exactly 5 warmups, and the `local-100k`, `workset-50`, and `workset-128`
   profiles. A development-smoke artifact is deliberately release-failing regardless of its measurements. This gate is
   mandatory for a release that changes Context Brief, recall, citation, or graph-validation behavior;
   production-large evidence is not a substitute.
   Require the deterministic fixture hash to match repeated construction of the same reviewed inputs. The artifact
   separately retains the actual 50- and 128-member workset generation digests because their checkout/worktree-bound
   routing identities are intentionally materialization-specific and must not make the semantic fixture hash unstable.
   The untimed memory series runs before any production timing invocation so first-use caches cannot disappear into its
   initial baseline. It resets instrumentation and performs full GC before each acknowledged begin barrier, then runs
   and retains the production workload before its end barrier. After the last workload, another full GC precedes the
   required stop-barrier sample. The observer exits before the latency series begins, so timing has no observer or
   boundary-RSS instrumentation. The exact bundled target recomputes its own wrapper-supplied
   SHA-256 and launches that same bundle as the observer; the observer and its descendants are excluded from the
   recursive process tree. The v2 observer schedules against absolute monotonic deadlines and skips missed deadlines
   instead of adding a fixed delay after a slow sample. Each memory observation must have at least three successful
   samples, no failed samples, a root-only baseline, and valid root/tree baseline, peak, and growth arithmetic. Across
   the ordered memory series, observations whose maximum successful-sample gap exceeds 100 ms may comprise at most
   10%, with at most two such observations consecutively and an absolute 350 ms hard maximum; retain the raw maximum,
   breach count, rate, and maximum consecutive run in the artifact. The
   single-repository profile must sample a workload descendant at least once; each sustained multi-repository Workset
   profile must do so in at least 80% of its observations. This avoids pretending that the roughly 45 ms macOS `ps`
   cadence can reliably catch every short-lived local Git child while preserving a strong fan-out coverage gate.
   Apply the fixed 64 MiB ceiling independently to the maximum sampled transient process-tree growth and retained root
   growth across memory-pass baselines plus the post-final-GC sample. That final sample must contain only the benchmark
   root. Boundary-sampled current-process RSS comes from the memory workload and remains
   diagnostic only. The retained `memoryWorkload` must independently pass the same selection, citation, fan-out, lease,
   and no-cold-work correctness checks. This is probabilistic sampled process-tree high-water evidence: it recursively
   accounts for processes present at each sample, but it is not exhaustive accounting of every short-lived child or an
   unsampled peak.
   The absolute latency gate runs on the reviewed `macos-15`/ARM64/Apple-M1 class. Its artifact must bind the explicit
   candidate argument to the observed clean checkout; require observed Git status, GitHub Actions,
   `RUNNER_ENVIRONMENT=github-hosted`, `RUNNER_OS=macOS`, runner class `github-hosted-macos-15-ARM64`, arm64, an
   Apple-M1-class CPU, `bun/1.3.14`, and `threadnote-4.6.0`. Do not substitute a pass from the heterogeneous Ubuntu x64
   pool or normalize two failed absolute observations through a parent-relative comparison.
   Also require `bun run eval:code-memory-link-bench` to pass on that SHA for changes to code-anchored retrieval. Treat
   its 256-noise-memory latency result as the deterministic CI smoke only; do not relabel it as the 100,000-memory
   inverse-selector scale gate.
   The inverse-selector job must run after C on the same pinned `macos-15`/arm64/Bun class used by tag verification. It
   produces a passed `release-scale` artifact with exact runner class `github-hosted-macos-15-ARM64`,
   `candidateCommit=observedCommit=C`, `dirty=false`, the frozen 100,000-memory budget, and a built-target digest. Download the job artifact at its staged content-addressed path
   `test/evaluation/retained/code-memory-link-scale/<artifact-sha256>.json`; review it, but do not add it in C or A.
   Confirm the frozen dense-selector scenario indexes exactly 99,996 backlinks, returns the exact first eight
   canonical URIs, and records exactly two bounded selector truncations per lookup within both pooled and per-scenario
   latency budgets. Those truncations are required abstention evidence for the shadowed file-selector prefix, not a
   claim that the unexamined prefix contains no other eligible link. Require zero truncations for the true no-answer
   scenario.
   For Memory Connections, run `bun run eval:memory-connections-retrieval` on C and require the approved
   `memory-connections-retrieval-bench-v1` fixture hash
   `f14272e99ae45c04169df0f761fba6bacb77d73eb9b2b67489a7a443900b1fad` with `gate.passed=true`. The frozen suite must
   cover all five reviewed abilities and all ten one-hop, multi-seed, cycle, unresolved/conflicted, historical,
   supersession, authorization, and no-connection scenarios. Require precision, recall, premise-currentness accuracy,
   and no-answer accuracy of exactly 1; zero authorization leaks, false-authority claims, and duplicate results; and no
   response above 1,500 estimated tokens.
   Require the Memory Connections scale artifact to report suite `memory-connections-one-hop-scale-v1`, version 1,
   `evidenceClass=release-scale`, and `gate.passed=true` on exact clean C. Its identity must bind
   `candidateCommit=observedCommit=C`, runner class `github-hosted-macos-15-ARM64`, and a 64-hex built-artifact digest;
   a development-smoke artifact cannot pass. Require the approved fixture hash
   `136c49200cb5661faa60db25a682faa8793dcbb3cfe9da7387d396f32d0a5ee7`, exactly 100,000 materialized and indexed
   memories, exactly 99,994 authorized dense-hub memories, and the ordered `incoming-hub`, `sparse-incoming`, and
   `no-answer` scenarios with at least 5 warmups and 25 measured samples each. The query limit is 8: the dense hub must
   return the exact first eight frozen neighbors with truncation, sparse incoming must return its exact two neighbors
   without truncation, and no-answer must return none without truncation. Across cold, warmup, and measured evidence,
   require exact precision, recall, no-answer, truncation, bounded-result, projected-connection-coverage,
   projected-output-completeness, and projected-receipt-accounting accuracy; zero duplicate or unexpected results and
   receipt identities; and exact connection identity, direction, roles, ordinal, resolution/currentness, and premise
   identity/currentness. No response may exceed 1,500 estimated tokens, 257 raw link rows, or 322 canonical rereads.
   Measured lookup p95 must be at most 250 ms and every measured lookup at most 1,000 ms. The materialized corpus must
   be at most 256 MiB, recall storage at most 2 GiB, added peak RSS at most 3 GiB, materialization at most 5 minutes,
   and index construction at most 10 minutes. Download and review the retained 90-day workflow artifact before tagging.
   Run the three-arm Code Memory Link agent experiment independently after publication. It is research and regression
   evidence, not a release gate: an incomplete, insufficient, or failed experiment must never block a patch, tag,
   platform build, or immutable release. Retain an experiment artifact whose gate status is `passed`, whose clean
   candidate/build identity matches the evaluated release SHA, and whose preregistered
   manifest and post-run evidence hashes are both present in the source-reviewed allowlists. It must cover at least two
   reviewed client roster entries, 12 hidden-constraint tasks, 16 negative controls, task-only memory versus no-memory,
   and anchored v3 versus task-only v2. Two model configurations routed through one client implementation satisfy the
   roster gate but do not support a scientific claim of replication across independent client implementations. An
   empty allowlist or an `insufficient`/`failed` result invalidates the experiment claim and should inform a later
   patch; it does not change the publication status of the evaluated release.
   Because the post-run evidence hash can only be approved after execution, keep the tested candidate/build identity
   immutable: the later approval or release commit may contain only reviewed evaluation-governance metadata (for
   example, allowlist entries and retained evidence references), with no runtime or product-logic delta from the tested
   build. If runtime or product logic changes, rerun the experiment against the new candidate.
   Coordinate three signed, single-parent commits on the experiment branch: tested candidate **C**, manifest approval
   **A**, then final governance **G**. C is the exact published commit under evaluation; do not freeze main or move the
   immutable release tag while the experiment runs. A must be
   the immediate child of C and may add only the manifest hash to
   `src/evaluation/code-memory-link-approvals.json`. G must be the immediate child of A and may only update that JSON,
   add the exact hash-named bundle under `test/evaluation/retained/code-memory-link/`, add the exact content-addressed
   scale artifact under `test/evaluation/retained/code-memory-link-scale/`, and add the version-bound final descriptor
   under `.github/release-evidence/code-memory-link/vX.Y.Z.json`. Put documentation and all executable
   experiment-control changes in C, not A or G. External receipts must name A. The executable verifier checks this exact
   C→A→G ancestry, parses the allowlist deltas, proves the outcome hashes did not preexist G, requires the bundle and
   descriptor and scale artifact to be newly added at G, and rejects dirty, merged, delayed, change-then-revert, executable
   approval-loader changes, extra hashes, or any other post-candidate history.
   Follow the complete executable experiment procedure in
   [`test/evaluation/README.md`](../test/evaluation/README.md#codememorylinkbench-v1); do not infer the preregistration
   or ledger protocol from the scorer alone. From an exact clean C checkout with the exact C development runtime
   installed, prepare the sealed experiment and independently review the emitted manifest and its printed hash before
   creating A:

   ```sh
   bun run eval:code-memory-link-agent-prepare -- \
     --assignment-seed <64-lowercase-hex> \
     --auth-source <absolute-codex-auth-source> \
     --bun-executable <absolute-reviewed-bun> \
     --candidate-commit <candidate-sha> \
     --codex-executable <absolute-reviewed-codex-0.144.5> \
     --git-executable <absolute-reviewed-git> \
     --harness-governance-commit <candidate-sha> \
     --model-provider openai \
     --output <absolute-new-prepared-root> \
     --reasoning-effort medium \
     --safe-executable-path <absolute-directory-list> \
     --schedule-seed <64-lowercase-hex> \
     --temporary-root <absolute-private-temporary-directory> \
     --turn-timeout-ms 1800000
   ```

   After A is the immediate child of C, run the frozen release schedule and score its exact ledgers from the clean A
   checkout. Any failed, interrupted, or retried governed attempt invalidates the evidence and requires a fresh
   preregistration rather than an automatic matrix retry:

   ```sh
   bun run eval:code-memory-link-agent-matrix -- \
     --mode release \
     --root <absolute-prepared-root> \
     --approval-commit <approval-sha> \
     --candidate-commit <candidate-sha> \
     --trials <absolute-trials.jsonl> \
     --attempts <absolute-trials.jsonl.attempts.jsonl> \
     --evidence <absolute-trials.jsonl.evidence.jsonl>

   bun run eval:code-memory-link-agent-ab -- \
     --assignment <prepared-root>/assignment.json \
     --attempts <trials.jsonl.attempts.jsonl> \
     --candidate-commit <candidate-sha> \
     --evidence <trials.jsonl.evidence.jsonl> \
     --manifest <prepared-root>/manifest.json \
     --trials <trials.jsonl>
   ```

   This pre-G scorer inspection is expected to exit nonzero because A cannot yet approve the newly computed outcome
   hash. Accept only `gate.status=insufficient`, `gate.qualityFailures=[]`, and the sole insufficiency
   `external evidence hash is not in the code-reviewed release allowlist`; record `evidence.externalEvidenceHash` for
   independent review and G. Any other insufficiency, any quality failure, or a missing hash invalidates that experiment
   run without blocking release publication.

   The standalone experiment verifier requires linear C→A→G ancestry and does not publish or move a release tag.
   Signed-commit enforcement, required review, and protection against updating or deleting `v*` tags remain repository
   ruleset prerequisites for product releases; the local verifier does not claim to authenticate Git signatures or make
   a movable tag immutable by itself.
   Capture each external trial with `bun run eval:code-memory-link-agent-trial`; its harness launches the reviewed client
   with the canonical managed executable in the environment. It requires an explicit roster id, verifies the invoked
   command, argument vector, implementation artifacts, and configuration against that client's reviewed descriptor,
   and appends the outcome to the frozen-schedule receipt chain. The retained privacy-safe outcome projection is bound
   to unique invocation/output digests plus matching pre/post source-commit and executable-SHA observations. These local
   runs also require an explicit canonical `<trials>.attempts.jsonl` sidecar. The runner holds one heartbeat-backed
   cross-process lock across read, external execution, postchecks, and append; it writes a hash-chained start before
   execution and a categorical failure after any observed failure. A retry requires the exact prior attempt id and
   recorded reason. Failed, interrupted, or retried attempts block the release and require a new preregistered manifest,
   and the reviewed external-evidence hash binds the complete attempt journal as well as successful receipts.
   The local self-seals and retained bundle establish local cryptographic consistency and reviewability, not
   authentication against a hostile local author who can rewrite evidence, Git history, and approvals together.
   Independent review of the exact allowlisted artifacts and protected clean governance history is the trust root.
   Finally, retain exact-installed-candidate dogfood evidence from the reviewed manifest-approval checkout for
   task-only memory recall, file and symbol backlinks, multi-anchor retrieval, no-backlink and stale-graph abstention,
   and bounded output. The same artifact must attest the deferred-anchor lifecycle: a strict cited write rejects
   atomically without starting indexing; the default private write returns task-recallable durable memory within
   10 seconds while preserving the stale graph; its private intent is not exposed as a backlink before graph preparation;
   an explicit graph refresh automatically adds exactly one citation without a separate finalizer command; and the
   resulting exact backlink appears in the first post-refresh code-linked Context Brief without changing the memory body,
   identity, lifecycle, or creation/update timestamps. The private intent count must move from one to zero. Its canonical
   evidence hash must be present in the separate source-reviewed practical-dogfood allowlist. Generate it only with the
   isolated-home, exact-installed runner from that same canonical clean checkout:

   ```sh
   bun run eval:code-memory-link-dogfood -- \
     --approval-commit <approval-sha> \
     --candidate-commit <candidate-sha> \
     --repository <executing-checkout> \
     --output <json>
   ```

   The runner rejects a `--repository` that differs from the checkout supplying its own bytes. It writes a valid,
   tamper-evident artifact before reporting a quality-gate failure so negative observations remain reviewable rather
   than disappearing with a nonzero exit. Retain the independently reviewed inputs with:

   ```sh
   bun run eval:code-memory-link-retain -- \
     --attempts <trials.jsonl.attempts.jsonl> \
     --candidate-commit <candidate-sha> \
     --dogfood <json> \
     --evidence <trials.jsonl.evidence.jsonl> \
     --prepared-root <prepared-root> \
     --trials <jsonl>
   ```

   This command rejects auth material and absolute paths and writes the
   complete assignment, manifest, sealed suite/layout plus every referenced fixture/judge/task/rubric, scrubbed client
   descriptors/config projections, ledgers, dogfood, scored result, and blob map to a hash-named checked-in directory.
   Add that bundle hash with the reviewed outcome and dogfood hashes in G. In the same commit, add the canonical final
   descriptor at `.github/release-evidence/code-memory-link/vX.Y.Z.json` (substitute exact lowercase hashes and the
   build target recorded by the tested C runtime):

   ```json
   {
     "candidate": {
       "commit": "<40-character-candidate-C-sha>",
       "dependencyInstallation": "bun install --frozen-lockfile",
       "payloadBytes": 123456,
       "payloadFileCount": 123,
       "payloadManifestSha256": "<64-character-tested-C-payload-manifest-sha256>",
       "releaseMetadataSha256": "<64-character-tested-C-release-metadata-sha256>",
       "runtime": "<tested-C-runtime>",
       "sourceLockfileSha256": "<64-character-C-lockfile-sha256>",
       "sourcePackageManifestSha256": "<64-character-C-package-manifest-sha256>",
       "target": "bun-darwin-arm64",
       "testedCandidateExecutableSha256": "<64-character-tested-C-executable-sha256>",
       "version": "X.Y.Z-local.g<40-character-candidate-C-sha>"
     },
     "releaseTag": "vX.Y.Z",
     "retainedBundle": {
       "path": "test/evaluation/retained/code-memory-link/<bundle-sha256>/bundle.json",
       "sha256": "<bundle-sha256>"
     },
     "scaleArtifact": {
       "path": "test/evaluation/retained/code-memory-link-scale/<scale-artifact-sha256>.json",
       "sha256": "<scale-artifact-sha256>"
     },
     "type": "code-memory-link-release-governance",
     "version": 1
   }
   ```

   Copy the path-free candidate fields from the verified JSON result of the exact C development install; do not infer
   or omit copied assets/native-runtime payload hashes. The filename, `releaseTag`, tracked `package.json` version,
   development version, bundle directory hash/SHA, and scale filename/SHA must agree. The descriptor must use the exact canonical
   field order/format shown and end with a newline. From exact G, run:

   ```sh
   bun run eval:code-memory-link-release -- \
     --release-descriptor .github/release-evidence/code-memory-link/vX.Y.Z.json \
     --release-tag vX.Y.Z
   ```

   Require `gate.status=passed` before making an experiment claim; this reads exact non-executable Git blobs from G,
   rejects arbitrary ephemeral evidence
   paths, rederives the tracked scale artifact against the frozen budget, requires a passed release-scale gate with
   exact clean C identity, and independently rebuilds the scale target to match its recorded digest. It also revalidates the complete managed C payload against its source commit, executable, copied payload
   manifest, release metadata, dependency manifests, runtime, target, version, counts, and hashes. Run the verifier in
   an isolated environment on the reviewed `macos-15`/arm64 class with pinned Bun and an explicit
   `bun-darwin-arm64` target. It resolves C only from the tracked descriptor, builds and installs exact C in a detached
   clean worktree, then runs the full verifier from exact G. Treat a cross-machine executable-hash mismatch as an
   experiment blocker to investigate; do not weaken the binding. This verifier is deliberately absent from the
   release-publishing workflow.

4. Review the candidate's retained production-large and heavy-tail evidence plus required PR checks when assessing
   graph correctness and performance. The tag starts one separate exact-tag production-large capacity classification
   and, only on an admitted runner, one `code-graph-production-large-n1` observation automatically. Do not dispatch a
   duplicate hosted run for that tag; if the runner is not admitted, use a separately governed capable environment.
5. Confirm immutable releases are enabled, the Apple signing secrets below are configured, the protected-main ruleset
   still requires signed linear reviewed merges, and an active `v*` tag ruleset forbids tag updates and deletion. The
   workflow can compare the pushed tag, exact checkout, protected-main ancestry, and remote tag peel; repository tag
   protection is what closes the remaining check-to-publication movement window.
6. Verify that HEAD is the exact reviewed release commit, create the version tag matching both `package.json` and the
   release-notes filename (for example `v4.0.1`) on that commit, and push it immediately. Do not merge or push another
   main-branch commit between the final check and the tag. The publish workflow binds its checkout, every platform
   build, and the reusable publisher to that tag-event Git object and rechecks that the remote tag still peels to the
   same protected-main commit before creating the immutable release.
7. Wait for `Publish standalone release`. Do not create a GitHub Release manually. Every channel publishes after all
   four enabled archives are verified while its bounded production-large observation continues independently.

The main-branch website build includes the prepared stable `package.json` version when its matching release note is
checked in but its tag does not exist yet. Merge only a ready-to-tag release commit and push the matching tag promptly.
Until a later main deployment observes the tag, What's New uses the release-preparation commit date and its release
link is intentionally future-facing. If tagging cannot finish promptly, stop the release window instead of continuing
ordinary main development under unreleased stable-version wording.

Optional experiment evidence must distinguish a clean candidate run from exact-tag evidence. Candidate evidence can
close implementation gates before merge, but only a tag-triggered artifact may claim exact release provenance. None of
these experiments are publication dependencies. Keep public surrogate results, private path-free aggregate evidence,
and checked-in same-machine comparisons separate; do not combine them into a synthetic percentile. The current beta
closeout contract is documented in
[`4.1.0-beta.2-release-evidence.md`](./4.1.0-beta.2-release-evidence.md).

Every Threadnote 4 version tag starts a separate production-large evidence workflow on `ubuntu-24.04`; publication
never waits for it. Before fixture construction, the workflow pins benchmark temporary storage to the runner-temp
filesystem and records whether that filesystem satisfies the unchanged 120 GiB governed admission floor. A runner
that does not satisfy the floor does not start the benchmark: the exact-tag capacity classification is retained, and
the independent evidence workflow fails so a missing observation cannot look successful. This failure does not affect
release publication. This fallback does not name or assume a self-hosted runner. Configure a capable runner explicitly
before changing `runs-on`; do not add a speculative label.
On an admitted runner, the evidence job has a hard 30-minute ceiling: its measured phase gets 20
minutes, leaving bounded time to upload the latest privacy-safe checkpoint and summary. Incomplete admitted release observations are reported but never delay publication;
scheduled or explicitly requested strict runs still fail when the profile does not complete inside the same bound.
Capacity classifications, aggregate phase/materialization evidence, failure checkpoints, exact source commit, and
upload digest are retained for 90 days. Treat a successful completed result as `n=1` same-runner evidence, not as a portable p95. The heavy-tail job remains
separate parser/cache coverage and must not be used as a substitute for production-scale materialization evidence.

Completed release evidence remains provenance-strict: the artifact must name the Threadnote 4 tag and exact matching commit,
the local checkout must resolve that tag through `ref^{commit}` to the same SHA, and the measured checkout must be
clean. The benchmark workflow explicitly checks out the event ref and verifies that resolution before measurement. A
production-shaped run without that provenance remains useful development evidence, but it cannot be presented as
exact-release evidence.

The tag workflow fails before building or signing when its versioned release-notes file is absent, empty, or does not
start with the required heading. It prepends this checked-in copy to GitHub's automatically generated changelog, so
every release preserves a curated summary even when the release branch has no merged pull requests.

## Testing Apple signing without publishing

Use the manual `workflow_dispatch` entry for `Publish standalone release` to exercise the release build on both macOS
and Windows architectures. A manual run executes source verification; builds the exact standalone payloads; runs
strict doctor and real-embedding checks; signs, verifies, and notarizes the macOS payloads; and uploads the macOS and
unsigned Windows archives as private workflow artifacts. Linux and the GitHub Release job are tag-only and stay
skipped, so the test cannot publish a release.

The manual trigger must first exist on the repository's default branch. After it is merged, open **Actions**,
select **Publish standalone release**, choose **Run workflow**, and select the branch to test. Do not create a version
tag for a signing or Windows packaging test. The dormant Windows Authenticode job remains skipped for both manual and
tag-triggered runs.

## Moving users from Threadnote 3

Do not publish an npm transition package. Threadnote 3 discovers updates through npm and cannot cross the standalone
runtime boundary with `threadnote update`. Existing macOS and Linux users install v4 fresh with `scripts/install.sh`
and verify the new launcher with `threadnote doctor`. The installer identifies and removes
verified global npm-distributed Threadnote packages, including early Node-based 4.0 betas, and Threadnote-owned
OpenViking tool installations before writing the standalone launcher; it preserves `~/.openviking` for migration and
rollback. The streamed form is
`curl -fsSL https://raw.githubusercontent.com/Kashkovsky/threadnote/main/scripts/install.sh | sh`. Once v4
is installed, `threadnote update` handles later stable and beta 4.x releases directly from immutable GitHub Releases.
The PowerShell bootstrap also accepts `-Beta` for the inclusive preview channel.

## Required GitHub secrets

macOS:

- `APPLE_CERTIFICATE_P12_BASE64`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_KEYCHAIN_PASSWORD`
- `APPLE_NOTARY_ISSUER_ID`
- `APPLE_NOTARY_KEY_ID`
- `APPLE_NOTARY_KEY_P8_BASE64`

The workflow selects the single valid Developer ID Application identity imported from the PKCS#12 file and signs by
its certificate fingerprint. An identity-name secret is not required.

Deferred Windows configuration, not required for the current release line:

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `AZURE_ARTIFACT_SIGNING_ENDPOINT`
- `AZURE_ARTIFACT_SIGNING_ACCOUNT`
- `AZURE_ARTIFACT_SIGNING_PROFILE`

The Azure identity uses GitHub OIDC. Long-lived Azure client secrets are not required. These values do not enable
Windows publication while the release jobs remain hard-disabled. Restore `id-token: write` only when the Windows
signing job is re-enabled.
