#!/bin/zsh
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <AppRuntime destination>" >&2
  exit 64
fi

script_dir="${0:A:h}"
repo_root="${script_dir:h:h}"
destination="${1:A}"
if [[ "$destination" != */Contents/Resources/AppRuntime ]]; then
  echo "Refusing to stage outside an app Contents/Resources/AppRuntime directory: $destination" >&2
  exit 64
fi
node_version="$(tr -d '[:space:]' < "$repo_root/.nvmrc")"
node_binary="${THREADNOTE_NODE_BINARY:-$HOME/.nvm/versions/node/v${node_version}/bin/node}"
uv_binary="${THREADNOTE_UV_BINARY:-$(command -v uv || true)}"

if [[ ! -x "$node_binary" ]]; then
  echo "Pinned Node v${node_version} was not found at $node_binary. Set THREADNOTE_NODE_BINARY." >&2
  exit 1
fi
if [[ -z "$uv_binary" || ! -x "$uv_binary" ]]; then
  echo "uv was not found. Install uv or set THREADNOTE_UV_BINARY." >&2
  exit 1
fi

node_actual="$($node_binary --version)"
if [[ "$node_actual" != "v${node_version}" ]]; then
  echo "Expected Node v${node_version}, found ${node_actual}." >&2
  exit 1
fi
node_archs="$(/usr/bin/lipo -archs "$node_binary")"
uv_archs="$(/usr/bin/lipo -archs "$uv_binary")"
if [[ "$node_archs" != "arm64" || "$uv_archs" != "arm64" ]]; then
  echo "Phase 2 packages arm64 only; expected arm64 Node and uv, found Node '$node_archs' and uv '$uv_archs'." >&2
  exit 1
fi

PATH="${node_binary:h}:$PATH" npm --prefix "$repo_root" run build --silent

staging="${destination}.staging.$$"
rm -rf "$staging"
mkdir -p "$staging/bin" "$staging/licenses" "$staging/threadnote"
cp "$node_binary" "$staging/bin/node"
cp "$uv_binary" "$staging/bin/uv"
cp -R "$repo_root/bin" "$staging/threadnote/bin"
cp -R "$repo_root/config" "$staging/threadnote/config"
cp -R "$repo_root/dist" "$staging/threadnote/dist"
cp -R "$repo_root/docs" "$staging/threadnote/docs"
cp -R "$repo_root/manager" "$staging/threadnote/manager"
cp "$repo_root/package.json" "$repo_root/LICENSE" "$repo_root/THIRD_PARTY.md" "$staging/threadnote/"
cp "$repo_root/.threadnoteignore" "$staging/threadnote/.threadnoteignore"
cp "${node_binary:h:h}/LICENSE" "$staging/licenses/Node-LICENSE"
uv_root="${uv_binary:A:h:h}"
cp "$uv_root/LICENSE-APACHE" "$staging/licenses/uv-LICENSE-APACHE"
cp "$uv_root/LICENSE-MIT" "$staging/licenses/uv-LICENSE-MIT"
printf '%s\n' "$($node_binary -p "require('$repo_root/package.json').version")" > "$staging/version"

developer_dir="${DEVELOPER_DIR:-$(xcode-select -p)}"
DEVELOPER_DIR="$developer_dir" xcrun --sdk macosx swiftc \
  -O -parse-as-library -target "arm64-apple-macos13.0" \
  "$script_dir/../Launcher/main.swift" \
  -o "$staging/bin/threadnote-launcher"

identity="${THREADNOTE_CODE_SIGN_IDENTITY:-${EXPANDED_CODE_SIGN_IDENTITY:--}}"
if [[ "$identity" == "-" ]]; then
  timestamp_arguments=(--timestamp=none)
else
  timestamp_arguments=(--timestamp)
fi
/usr/bin/codesign --force --options runtime "${timestamp_arguments[@]}" \
  --entitlements "$script_dir/../Config/Node.entitlements" \
  --sign "$identity" "$staging/bin/node"
for executable in "$staging/bin/uv" "$staging/bin/threadnote-launcher"; do
  /usr/bin/codesign --force --options runtime "${timestamp_arguments[@]}" --sign "$identity" "$executable"
done

content_id="$(
  cd "$staging"
  find . -type f -print | LC_ALL=C sort | while IFS= read -r file; do
    digest="$(/usr/bin/shasum -a 256 "$file" | awk '{print $1}')"
    printf '%s  %s\n' "$digest" "$file"
  done | /usr/bin/shasum -a 256 | awk '{print $1}'
)"
printf '%s\n' "$content_id" > "$staging/content-id"

chmod 755 "$staging/bin/node" "$staging/bin/uv" "$staging/bin/threadnote-launcher"
rm -rf "$destination"
mv "$staging" "$destination"
