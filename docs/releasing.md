# Standalone release signing

Threadnote releases are built from a pushed version tag. Pull-request and ordinary CI builds stay unsigned; the
release workflow fails closed when a signing or notarization credential is missing.

Enable **immutable releases** in the GitHub repository settings before publishing. The workflow builds, signs,
notarizes, archives, and checksums every target before `gh release create` uploads the complete set and makes the
release public. It then verifies GitHub reports the release as immutable. The CLI and bootstrap installers ignore
mutable releases, so a repository with immutability disabled cannot distribute an installable Threadnote 4 release.
GitHub's immutable-release attestation binds the tag, commit, and assets; the per-archive SHA-256 file protects the
local download path. Official installers and the built-in updater also require Apple notarization/signature validation
or valid Windows Authenticode before promotion. Linux uses the immutable GitHub release as its publisher trust root;
an offline project signing authority is not part of the Threadnote 4 release model.

## Build matrix

CI bytecode-compiles the exact standalone entrypoint for all eight Bun base targets:

- macOS arm64 and x64
- Linux arm64 and x64 with glibc
- Linux arm64 and x64 with musl
- Windows arm64 and x64

The release publishes six archives: macOS, glibc Linux, and Windows for arm64 and x64. The two musl executables are
compile gates only because the bundled local-inference runtime does not publish a distinct compatible musl payload.
Every native release runner installs the core GGUF model and produces a real embedding with its exact `dist/` payload
before signing or archiving.

## Signing order

macOS builds sign each nested Mach-O native library first, then sign the Bun executable with hardened runtime and the
minimal JIT entitlements in `scripts/macos-entitlements.plist`. CI verifies the signatures, submits a ZIP containing
the exact `dist/` payload to Apple notarization, waits for acceptance, and assesses the executable. Only then does it
create the release archive and checksum.

Windows arm64 payloads are assembled and smoke-tested on the native `windows-11-arm` runner, then transferred to the
x64 signing job because the Azure signing action runs there. Azure Artifact Signing recursively signs every `.exe`,
`.dll`, and `.node` file. CI validates every Authenticode signature before creating the archive and checksum. Linux
artifacts are protected by the immutable GitHub release and checksums but are not OS code-signed.

## Publishing

1. Merge the release source and ensure ordinary CI is green.
2. Confirm immutable releases are enabled and all signing secrets below are configured.
3. Create and push the version tag matching `package.json`, for example `v4.0.0-beta.9`.
4. Wait for `Publish standalone release`. Do not create a GitHub Release manually; the workflow creates it only after
   all six archives are ready.

## Moving users from Threadnote 3

Do not publish an npm transition package. Threadnote 3 discovers updates through npm and cannot cross the standalone
runtime boundary with `threadnote update`. Existing users install Threadnote 4 fresh with `scripts/install.sh` or
`scripts/install.ps1`, verify the new launcher with `threadnote doctor`, and remove an old npm launcher if it still
shadows the standalone command. Once v4 is installed, `threadnote update` handles later stable and beta 4.x releases
directly from immutable GitHub Releases.

## Required GitHub secrets

macOS:

- `APPLE_CERTIFICATE_P12_BASE64`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_KEYCHAIN_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_NOTARY_ISSUER_ID`
- `APPLE_NOTARY_KEY_ID`
- `APPLE_NOTARY_KEY_P8_BASE64`

Windows:

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `AZURE_ARTIFACT_SIGNING_ENDPOINT`
- `AZURE_ARTIFACT_SIGNING_ACCOUNT`
- `AZURE_ARTIFACT_SIGNING_PROFILE`

The Azure identity uses GitHub OIDC. Long-lived Azure client secrets are not required.
