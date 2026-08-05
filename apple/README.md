# Threadnote for macOS

The macOS app is a native menu-bar shell around Threadnote's existing TypeScript core. It targets macOS 13 or later,
runs outside App Sandbox, and enables Hardened Runtime for Developer ID distribution.

## Development

The active command-line developer directory can remain unchanged. Build and test with the bootstrapped Xcode beta:

```sh
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer \
  xcodebuild -project Threadnote/Threadnote.xcodeproj \
  -scheme Threadnote -destination 'platform=macOS' \
  CODE_SIGNING_ALLOWED=NO test
```

Debug builds adopt an existing `threadnote` command. A release build stages the pinned Node runtime, uv, the built
Threadnote core, and a signed native launcher into `AppRuntime`. To exercise that path in Debug, pass
`THREADNOTE_STAGE_RUNTIME=1` after adding the Stage App Runtime build phase.

The nested Node executable is signed with only the Hardened Runtime exceptions V8 requires for JIT execution. uv and
the native launcher receive no exception entitlements.

The app installs its bundled runtime under `~/Library/Application Support/Threadnote/runtime`, and copies the signed
launcher to the stable `bin/threadnote` and `bin/threadnote-mcp-server` paths. MCP integrations therefore survive app
relocation and whole-app replacement.

## Self-distribution

Create the notarytool profile once with `xcrun notarytool store-credentials`, then run:

```sh
THREADNOTE_DEVELOPER_ID_APPLICATION='Developer ID Application: Example (TEAMID)' \
THREADNOTE_NOTARY_PROFILE='threadnote-notary' \
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  ./scripts/archive-and-notarize.sh
```

The script archives a Developer ID build, verifies nested signatures, creates and signs a DMG, submits it for
notarization, staples the ticket, and runs Gatekeeper assessment. It intentionally fails when credentials are absent.

Phase 2 packages an arm64-only app and rejects mismatched Node or uv binaries. Supporting Intel Macs remains a release
decision: either stage universal private runtimes or publish separate architecture downloads before broad distribution.
