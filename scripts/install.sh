#!/usr/bin/env sh
set -eu

REPOSITORY="${THREADNOTE_REPOSITORY:-Kashkovsky/threadnote}"
CHANNEL="${THREADNOTE_CHANNEL:-latest}"
RELEASES_API="${THREADNOTE_RELEASE_SOURCE:-https://api.github.com/repos/$REPOSITORY/releases?per_page=100}"
INSTALL_LOCK_WAIT_SECONDS=600
installation_lock_path=""
installation_lock_token=""

argument_count=$#
while [ "$argument_count" -gt 0 ]; do
  argument="$1"
  shift
  case "$argument" in
    --beta) CHANNEL=beta ;;
    *) set -- "$@" "$argument" ;;
  esac
  argument_count=$((argument_count - 1))
done

say() {
  printf '%s\n' "$*"
}

die() {
  say "ERROR: $*" >&2
  exit 1
}

have() {
  command -v "$1" >/dev/null 2>&1
}

require_command() {
  have "$1" || die "$1 is required to install Threadnote."
}

release_installation_lock() {
  [ -n "$installation_lock_path" ] || return 0
  observed="$(sed -n '1p' "$installation_lock_path" 2>/dev/null || true)"
  if [ "$observed" = "$installation_lock_token" ]; then
    rm -f -- "$installation_lock_path"
  fi
  installation_lock_path=""
  installation_lock_token=""
}

acquire_installation_lock() {
  installation_lock_path="$1"
  installation_lock_token="$$:bootstrap-installer"
  started_at="$(date +%s)"
  while ! (
    umask 077
    set -C
    printf '%s\n' "$installation_lock_token" >"$installation_lock_path"
  ) 2>/dev/null; do
    observed="$(sed -n '1p' "$installation_lock_path" 2>/dev/null || true)"
    owner_pid="${observed%%:*}"
    case "$owner_pid" in
      '' | *[!0-9]*) ;;
      *)
        if ! kill -0 "$owner_pid" 2>/dev/null; then
          current="$(sed -n '1p' "$installation_lock_path" 2>/dev/null || true)"
          if [ "$current" = "$observed" ]; then
            rm -f -- "$installation_lock_path"
            continue
          fi
        fi
        ;;
    esac
    now="$(date +%s)"
    [ $((now - started_at)) -lt "$INSTALL_LOCK_WAIT_SECONDS" ] ||
      die "Timed out waiting for Threadnote installation lock: $installation_lock_path"
    sleep 1
  done
}

cleanup() {
  release_installation_lock
  rm -rf -- "$temporary_root"
  [ -z "$staged_root" ] || rm -rf -- "$staged_root"
}

release_objects() {
  awk '
    BEGIN { depth = 0; in_string = 0; escaped = 0; object = "" }
    {
      for (position = 1; position <= length($0); position++) {
        character = substr($0, position, 1)
        if (depth > 0) object = object character
        if (in_string) {
          if (escaped) escaped = 0
          else if (character == "\\") escaped = 1
          else if (character == "\"") in_string = 0
          continue
        }
        if (character == "\"") {
          in_string = 1
          continue
        }
        if (character == "{") {
          if (depth == 0) object = "{"
          depth++
        } else if (character == "}") {
          depth--
          if (depth == 0) {
            print object
            object = ""
          }
        }
      }
    }
  '
}

resolve_version() {
  requested_version="${THREADNOTE_VERSION:-}"
  requested_version="${requested_version#v}"
  if [ -z "$requested_version" ]; then
    case "$CHANNEL" in
      latest | stable) prerelease=false ;;
      beta) prerelease=true ;;
      *) die "THREADNOTE_CHANNEL must be latest, stable, or beta." ;;
    esac
  else
    prerelease=any
  fi
  releases="$(curl -fsSL -H 'Accept: application/vnd.github+json' -H 'User-Agent: threadnote-installer' "$RELEASES_API")"
  version=$(
    printf '%s' "$releases" |
      release_objects |
      awk -v desired="$prerelease" -v requested="$requested_version" '
        function greater(candidate, current, candidate_core, current_core, candidate_dash, current_dash,
          candidate_parts, current_parts, candidate_pre, current_pre, candidate_ids, current_ids,
          candidate_count, current_count, count, index_, candidate_id, current_id, candidate_numeric, current_numeric) {
          if (current == "") return 1
          candidate_dash = index(candidate, "-")
          current_dash = index(current, "-")
          candidate_core = candidate_dash ? substr(candidate, 1, candidate_dash - 1) : candidate
          current_core = current_dash ? substr(current, 1, current_dash - 1) : current
          split(candidate_core, candidate_parts, ".")
          split(current_core, current_parts, ".")
          for (index_ = 1; index_ <= 3; index_++) {
            if ((candidate_parts[index_] + 0) != (current_parts[index_] + 0))
              return (candidate_parts[index_] + 0) > (current_parts[index_] + 0)
          }
          if (!candidate_dash && current_dash) return 1
          if (candidate_dash && !current_dash) return 0
          if (!candidate_dash) return 0
          candidate_pre = substr(candidate, candidate_dash + 1)
          current_pre = substr(current, current_dash + 1)
          candidate_count = split(candidate_pre, candidate_ids, ".")
          current_count = split(current_pre, current_ids, ".")
          count = candidate_count < current_count ? candidate_count : current_count
          for (index_ = 1; index_ <= count; index_++) {
            candidate_id = candidate_ids[index_]
            current_id = current_ids[index_]
            if (candidate_id == current_id) continue
            candidate_numeric = candidate_id ~ /^[0-9]+$/
            current_numeric = current_id ~ /^[0-9]+$/
            if (candidate_numeric && current_numeric) return (candidate_id + 0) > (current_id + 0)
            if (candidate_numeric != current_numeric) return !candidate_numeric
            return candidate_id > current_id
          }
          return candidate_count > current_count
        }
        {
          compact = $0
          gsub(/[[:space:]]/, "", compact)
        }
        index(compact, "\"draft\":false") && index(compact, "\"immutable\":true") {
          candidate_prerelease = index(compact, "\"prerelease\":true") ? "true" : "false"
          count = split(compact, fields, "\"")
          for (field = 1; field < count; field++) {
            if (fields[field] == "tag_name") {
              tag = fields[field + 2]
              sub(/^v/, "", tag)
              if (tag !~ /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/) continue
              if (requested != "") {
                if (tag == requested) best = tag
              } else if (candidate_prerelease == desired && greater(tag, best)) {
                best = tag
              }
            }
          }
        }
        END { if (best != "") print best }
      '
  )
  if [ -z "$version" ] && [ -n "$requested_version" ]; then
    die "Threadnote $requested_version is not a published immutable release."
  fi
  [ -n "$version" ] || die "No immutable $CHANNEL Threadnote release is currently published."
  printf '%s' "$version"
}

platform_name() {
  case "$(uname -s)" in
    Darwin) printf '%s' darwin ;;
    Linux) printf '%s' linux ;;
    *) die "Threadnote standalone releases support macOS, Linux, and Windows." ;;
  esac
}

architecture_name() {
  case "$(uname -m)" in
    arm64 | aarch64) printf '%s' arm64 ;;
    x86_64 | amd64) printf '%s' x64 ;;
    *) die "Threadnote standalone releases support arm64 and x64." ;;
  esac
}

sha256_file() {
  if have sha256sum; then
    sha256sum "$1" | awk '{print $1}'
  elif have shasum; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "sha256sum or shasum is required to verify Threadnote."
  fi
}

require_command curl
require_command tar
version="$(resolve_version)"
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' ||
  die "Resolved release version is invalid."
platform="$(platform_name)"
architecture="$(architecture_name)"
artifact="threadnote-$platform-$architecture.tar.gz"
tag="v$version"
download_root="${THREADNOTE_RELEASE_DOWNLOAD_ROOT:-https://github.com/$REPOSITORY/releases/download/$tag}"
temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/threadnote-install.XXXXXX")"
staged_root=""
trap cleanup EXIT HUP INT TERM
archive="$temporary_root/$artifact"
checksum_file="$archive.sha256"

say "Downloading Threadnote $version for $platform-$architecture"
curl -fsSL "$download_root/$artifact" -o "$archive"
curl -fsSL "$download_root/$artifact.sha256" -o "$checksum_file"
expected="$(awk 'NF {print tolower($1); exit}' "$checksum_file")"
checksum_name="$(awk 'NF {name=$2; sub(/^\\*/, "", name); print name; exit}' "$checksum_file")"
actual="$(sha256_file "$archive" | tr '[:upper:]' '[:lower:]')"
[ "${#expected}" -eq 64 ] || die "Release checksum document is invalid."
[ -z "$checksum_name" ] || [ "$checksum_name" = "$artifact" ] ||
  die "Release checksum document names $checksum_name instead of $artifact."
[ "$expected" = "$actual" ] || die "Checksum verification failed for $artifact."

install_root="${THREADNOTE_INSTALL_ROOT:-$HOME/.local/share/threadnote}"
versions_root="$install_root/versions"
release_root="$versions_root/$version"
staged_root="$versions_root/.$version.$$.staging"
backup_root="$versions_root/.$version.$$.backup"
mkdir -p "$versions_root"
acquire_installation_lock "$install_root/.installation.lock"
rm -rf "$staged_root" "$backup_root"
mkdir -p "$staged_root"
tar -xzf "$archive" -C "$staged_root"
[ -x "$staged_root/threadnote" ] || chmod 755 "$staged_root/threadnote"
[ -f "$staged_root/release.json" ] || die "Release metadata is missing."
[ -f "$staged_root/runtime/node-llama-cpp.js" ] || die "Release native runtime is missing."
grep -F "\"version\": \"$version\"" "$staged_root/release.json" >/dev/null ||
  die "Release metadata does not match $version."
if [ "$platform" = "darwin" ] &&
  [ "$REPOSITORY" = "Kashkovsky/threadnote" ] &&
  [ -z "${THREADNOTE_RELEASE_SOURCE:-}" ] &&
  [ -z "${THREADNOTE_RELEASE_DOWNLOAD_ROOT:-}" ]; then
  require_command codesign
  require_command file
  find "$staged_root/runtime" -type f -print |
    while IFS= read -r native_file; do
      if file "$native_file" | grep -q 'Mach-O'; then
        codesign --verify --strict --verbose=2 "$native_file" ||
          die "Release signature validation failed for $native_file."
      fi
    done
  codesign --verify --strict --verbose=2 "$staged_root/threadnote" ||
    die "Release signature validation failed for the Threadnote executable."
fi

if [ -e "$release_root" ]; then
  mv "$release_root" "$backup_root"
fi
if ! mv "$staged_root" "$release_root"; then
  [ ! -e "$backup_root" ] || mv "$backup_root" "$release_root"
  die "Could not promote Threadnote $version."
fi
rm -rf "$backup_root"
staged_root=""
chmod 755 "$release_root/threadnote"
release_installation_lock

say "Installed standalone Threadnote $version"
THREADNOTE_INSTALL_ROOT="$install_root" "$release_root/threadnote" install "$@"

say ""
say "Threadnote is installed. Next:"
say "  threadnote doctor --dry-run"
say "  threadnote mcp-install codex --apply    # if you use Codex"
say "  threadnote mcp-install claude --apply   # if you use Claude"
say "  threadnote mcp-install cursor --apply   # if you use Cursor"
