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
version. A standalone release bundles the plugin source only as a read-only doctor reference; install, update, repair,
and uninstall never place it into Cursor. Follow [the Cursor plugin publishing guide](./cursor-plugin.md); a Threadnote
version tag does not submit or re-index the plugin automatically.

## Build matrix

CI bytecode-compiles the exact standalone entrypoint for all eight Bun base targets:

- macOS arm64 and x64
- Linux arm64 and x64 with glibc
- Linux arm64 and x64 with musl
- Windows arm64 and x64

Threadnote 4 publishes four archives: macOS and glibc Linux for arm64 and x64. The two musl executables and both
Windows executables remain compile gates only. Musl lacks a distinct compatible bundled local-inference payload, and
Windows publication is disabled until Authenticode signing is approved and verified. Every enabled native release
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

The dormant Windows release jobs retain the previous native build and Azure signing implementation for future work,
but both jobs are hard-disabled and are not publication dependencies. No Windows 4 archive is created. Re-enabling
Windows requires an approved Authenticode provider, a reviewed ownership policy for bundled upstream `.dll` and `.node`
files, and clean-machine x64 and arm64 verification. Linux artifacts are protected by the immutable GitHub release and
checksums but are not OS code-signed.

## Publishing

For a prerelease, use a full SemVer prerelease such as `4.1.0-beta.1` in `package.json`,
`.github/release-notes/v4.1.0-beta.1.md`, and the `v4.1.0-beta.1` tag. The publisher detects the hyphenated tag and
creates a GitHub prerelease; do not use an unnumbered `-beta` suffix.

1. Add `.github/release-notes/vX.Y.Z.md` for the exact version being released. Begin with `## What's new`, describe
   user-visible value rather than implementation history, include concrete commands when useful, and do not add a
   validation/checks section.
2. Merge the release source and ensure ordinary CI is green.
3. Dispatch `Platform benchmarks` on the exact clean release-candidate SHA with
   `include_context_brief_citations_scale=true`. Before tagging, require its Context Brief citation artifact to report
   `gate.passed=true`, the exact candidate commit, `dirty=false`, 100,000 indexed memory candidates, 25 samples, five
   warmups, and the `local-100k`, `workset-50`, and `workset-128` profiles. This gate is mandatory for a release that
   changes Context Brief, recall, citation, or graph-validation behavior; production-large evidence is not a substitute.
4. Review the candidate's retained production-large and heavy-tail evidence plus required PR checks when assessing
   graph correctness and performance. The tag starts one separate exact-tag production-large capacity classification
   and, only on an admitted runner, one `code-graph-production-large-n1` observation automatically. Do not dispatch a
   duplicate hosted run for that tag; if the runner is not admitted, use a separately governed capable environment.
5. Confirm immutable releases are enabled and the Apple signing secrets below are configured.
6. Create and push the version tag matching both `package.json` and the release-notes filename, for example
   `v4.0.1`.
7. Wait for `Publish standalone release`. Do not create a GitHub Release manually. Every channel publishes after all
   four enabled archives are verified while its bounded production-large observation continues independently.

The main-branch website build includes the prepared stable `package.json` version when its matching release note is
checked in but its tag does not exist yet. Merge only a ready-to-tag stable version and push its tag immediately; until
a later main deployment observes the tag, What's New uses the release-preparation commit date and its release link is
intentionally future-facing.

The release evidence record must distinguish a clean candidate run from exact-tag evidence. Candidate evidence can
close implementation gates before merge, but only the tag-triggered artifact may claim exact release provenance. Keep
public surrogate results, private path-free aggregate evidence, and checked-in same-machine comparisons separate; do
not combine them into a synthetic percentile. The current beta closeout contract is documented in
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
architectures. A manual run executes source verification, builds the exact standalone payloads, imports the Developer
ID certificate, signs and verifies every Mach-O file, submits the payloads to Apple's notary service, assesses them
through notarization acceptance, and uploads the signed archives as private workflow artifacts. Linux, Windows, and
the GitHub Release job are tag-only and stay skipped, so the test cannot publish a release.

The manual trigger must first exist on the repository's default branch. After it is merged, open **Actions**,
select **Publish standalone release**, choose **Run workflow**, and select the branch to test. Do not create a version
tag for a signing test. The disabled Windows jobs remain skipped for both manual and tag-triggered runs.

## Moving users from Threadnote 3

Do not publish an npm transition package. Threadnote 3 discovers updates through npm and cannot cross the standalone
runtime boundary with `threadnote update`. Existing macOS and Linux users install v4 fresh with `scripts/install.sh`
and verify the new launcher with `threadnote doctor`. The installer identifies and removes
verified global npm-distributed Threadnote packages, including early Node-based 4.0 betas, and Threadnote-owned
OpenViking tool installations before writing the standalone launcher; it preserves `~/.openviking` for migration and
rollback. The streamed form is
`curl -fsSL https://raw.githubusercontent.com/Kashkovsky/threadnote/main/scripts/install.sh | sh`. Once v4
is installed, `threadnote update` handles later stable and beta 4.x releases directly from immutable GitHub Releases.
The PowerShell bootstrap also accepts `-Beta`, ready for use after Windows publishing is re-enabled.

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
