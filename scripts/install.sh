#!/usr/bin/env sh
set -eu

PACKAGE="${THREADNOTE_PACKAGE:-threadnote@latest}"
REGISTRY="${THREADNOTE_NPM_REGISTRY:-https://registry.npmjs.org/}"
RUNTIME="${THREADNOTE_RUNTIME:-auto}"

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

select_runtime() {
  case "$RUNTIME" in
    npm | bun | deno)
      have "$RUNTIME" || die "$RUNTIME was requested but was not found on PATH."
      say "$RUNTIME"
      ;;
    auto | "")
      if have npm; then
        say npm
      elif have bun; then
        say bun
      elif have deno; then
        say deno
      else
        die "Install Node/npm, Bun, or Deno, then rerun this installer."
      fi
      ;;
    *)
      die "THREADNOTE_RUNTIME must be npm, bun, deno, or auto."
      ;;
  esac
}

npm_global_bin() {
  prefix="$(npm prefix --global 2>/dev/null || true)"
  if [ -n "$prefix" ]; then
    say "$prefix/bin"
  fi
}

bun_global_bin() {
  bun pm bin -g 2>/dev/null || true
}

runtime_threadnote_bin() {
  runtime="$1"
  dir=""
  case "$runtime" in
    npm) dir="$(npm_global_bin)" ;;
    bun) dir="$(bun_global_bin)" ;;
    deno) dir="${DENO_INSTALL:-$HOME/.deno}/bin" ;;
  esac
  if [ -n "$dir" ]; then
    say "$dir/threadnote"
  fi
}

find_threadnote() {
  runtime="$1"
  preferred="$(runtime_threadnote_bin "$runtime")"
  if [ -n "$preferred" ] && [ -x "$preferred" ]; then
    say "$preferred"
    return 0
  fi

  for dir in "$(npm_global_bin)" "$(bun_global_bin)" "${DENO_INSTALL:-$HOME/.deno}/bin" "$HOME/.local/bin"; do
    if [ -n "$dir" ] && [ -x "$dir/threadnote" ]; then
      say "$dir/threadnote"
      return 0
    fi
  done

  if have threadnote; then
    command -v threadnote
    return 0
  fi

  return 1
}

install_package() {
  runtime="$1"
  case "$runtime" in
    npm)
      npm install --global "$PACKAGE" --registry="$REGISTRY"
      ;;
    bun)
      bun install --global "$PACKAGE" --registry="$REGISTRY"
      ;;
    deno)
      case "$PACKAGE" in
        npm:*) deno_package="$PACKAGE" ;;
        *) deno_package="npm:$PACKAGE" ;;
      esac
      NPM_CONFIG_REGISTRY="$REGISTRY" deno install --global --name threadnote \
        --allow-read --allow-write --allow-run --allow-env --allow-net \
        "$deno_package"
      ;;
  esac
}

runtime="$(select_runtime)"
say "Installing $PACKAGE with $runtime from $REGISTRY"
install_package "$runtime"

threadnote_bin="$(find_threadnote "$runtime")" || die "Installed $PACKAGE, but could not find the threadnote command."

say "Running threadnote install"
"$threadnote_bin" install "$@"

if ! have threadnote; then
  say ""
  say "threadnote is installed, but it is not on PATH in this shell."
  say "Add ~/.local/bin or your package-manager global bin directory to PATH."
fi

say ""
say "Threadnote is installed. Next:"
say "  threadnote doctor --dry-run"
say "  threadnote mcp-install codex --apply    # if you use Codex"
say "  threadnote mcp-install claude --apply   # if you use Claude"
say "  threadnote mcp-install cursor --apply   # if you use Cursor"
