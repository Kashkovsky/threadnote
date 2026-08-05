#!/bin/zsh
set -euo pipefail

: "${THREADNOTE_DEVELOPER_ID_APPLICATION:?Set THREADNOTE_DEVELOPER_ID_APPLICATION to the Developer ID Application identity}"
: "${THREADNOTE_NOTARY_PROFILE:?Set THREADNOTE_NOTARY_PROFILE to a notarytool keychain profile}"

script_dir="${0:A:h}"
apple_root="${script_dir:h}"
project="$apple_root/Threadnote/Threadnote.xcodeproj"
build_root="$apple_root/build/release"
archive="$build_root/Threadnote.xcarchive"
staging="$build_root/dmg"
dmg="$build_root/Threadnote.dmg"

rm -rf "$build_root"
mkdir -p "$staging"

THREADNOTE_STAGE_RUNTIME=1 \
THREADNOTE_CODE_SIGN_IDENTITY="$THREADNOTE_DEVELOPER_ID_APPLICATION" \
xcodebuild archive \
  -project "$project" \
  -scheme Threadnote \
  -destination "generic/platform=macOS" \
  -archivePath "$archive" \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY="$THREADNOTE_DEVELOPER_ID_APPLICATION"

app="$archive/Products/Applications/Threadnote.app"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$app"
cp -R "$app" "$staging/Threadnote.app"
ln -s /Applications "$staging/Applications"
hdiutil create -volname Threadnote -srcfolder "$staging" -ov -format UDZO "$dmg"
/usr/bin/codesign --force --timestamp --sign "$THREADNOTE_DEVELOPER_ID_APPLICATION" "$dmg"
xcrun notarytool submit "$dmg" --keychain-profile "$THREADNOTE_NOTARY_PROFILE" --wait
xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"
echo "$dmg"

