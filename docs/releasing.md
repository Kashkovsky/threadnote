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

## Build matrix

CI bytecode-compiles the exact standalone entrypoint for all eight Bun base targets:

- macOS arm64 and x64
- Linux arm64 and x64 with glibc
- Linux arm64 and x64 with musl
- Windows arm64 and x64

The current beta publishes four archives: macOS and glibc Linux for arm64 and x64. The two musl executables and both
Windows executables remain compile gates only. Musl lacks a distinct compatible bundled local-inference payload, and
Windows publication is disabled until Authenticode signing is approved and verified. Every enabled native release
runner installs the core GGUF model and produces a real embedding with its exact `dist/` payload before signing or
archiving. The same payload must contain the pinned Tree-sitter runtime, Java/Kotlin/Swift grammar WASM, source/ABI/
version/checksum manifest, and all four parser licenses. Source checks, archive smoke tests, and updater validation each
reject missing or altered code-graph assets.

## Signing order

macOS builds sign each nested Mach-O native library first, then sign the Bun executable with hardened runtime and the
minimal JIT entitlements in `scripts/macos-entitlements.plist`. CI verifies the signatures, submits a ZIP containing
the exact `dist/` payload to Apple notarization, waits for acceptance, and verifies the executable signature again.
Only then does it create the release archive and checksum. `spctl` app assessment is not used because Threadnote is a
standalone command-line executable rather than an application bundle.

The dormant Windows release jobs retain the previous native build and Azure signing implementation for future work,
but both jobs are hard-disabled and are not publication dependencies. No Windows 4 beta archive is created. Re-enabling
Windows requires an approved Authenticode provider, a reviewed ownership policy for bundled upstream `.dll` and `.node`
files, and clean-machine x64 and arm64 verification. Linux artifacts are protected by the immutable GitHub release and
checksums but are not OS code-signed.

## Publishing

1. Add `.github/release-notes/vX.Y.Z.md` for the exact version being released. Begin with `## What's new`, describe
   user-visible value rather than implementation history, include concrete commands when useful, and do not add a
   validation/checks section.
2. Merge the release source and ensure ordinary CI is green.
3. Confirm immutable releases are enabled and the Apple signing secrets below are configured.
4. Create and push the version tag matching both `package.json` and the release-notes filename, for example
   `v4.0.0-beta.9`.
5. Wait for `Publish standalone release`. Do not create a GitHub Release manually; the workflow creates it only after
   all four enabled archives are ready.

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
runtime boundary with `threadnote update`. Existing macOS and Linux users install the beta fresh with
`scripts/install.sh --beta` and verify the new launcher with `threadnote doctor`. The installer identifies and removes
verified global npm-distributed Threadnote packages, including early Node-based 4.0 betas, and Threadnote-owned
OpenViking tool installations before writing the standalone launcher; it preserves `~/.openviking` for migration and
rollback. The streamed form is
`curl -fsSL https://raw.githubusercontent.com/Kashkovsky/threadnote/main/scripts/install.sh | sh -s -- --beta`. Once v4
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

Deferred Windows configuration, not required for the current beta:

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `AZURE_ARTIFACT_SIGNING_ENDPOINT`
- `AZURE_ARTIFACT_SIGNING_ACCOUNT`
- `AZURE_ARTIFACT_SIGNING_PROFILE`

The Azure identity uses GitHub OIDC. Long-lived Azure client secrets are not required. These values do not enable
Windows publication while the release jobs remain hard-disabled. Restore `id-token: write` only when the Windows
signing job is re-enabled.
