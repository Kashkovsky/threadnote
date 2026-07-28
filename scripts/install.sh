#!/usr/bin/env sh
set -eu

PACKAGE="${THREADNOTE_PACKAGE:-threadnote@latest}"
REGISTRY="${THREADNOTE_NPM_REGISTRY:-https://registry.npmjs.org/}"
RUNTIME="${THREADNOTE_RUNTIME:-auto}"
SUPPORTED_NODE_RANGE="^22.22.2 || ^24.15.0 || >=26.0.0"

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

format_install_source_for_log() {
  printf '%s' "$1" |
    sed -E \
      -e 's#([Hh][Tt][Tt][Pp][Ss]?://)[^/@[:space:]]+@#\1[REDACTED]@#g' \
      -e 's#\?[^#[:space:]]+#?[REDACTED]#g'
}

require_supported_node() {
  have node || die "Node.js was not found on PATH. Install the current Node.js 24 LTS release, then rerun this installer."
  node_version="$(node -p 'process.versions.node' 2>/dev/null || true)"
  if node -e '
    const [major, minor, patch] = process.versions.node.split(".").map(Number);
    const supported =
      (major === 22 && (minor > 22 || (minor === 22 && patch >= 2))) ||
      (major === 24 && (minor > 15 || (minor === 15 && patch >= 0))) ||
      major >= 26;
    process.exit(supported ? 0 : 1);
  '; then
    return
  fi

  say "ERROR: Threadnote requires Node $SUPPORTED_NODE_RANGE; current runtime is ${node_version:-unknown}." >&2
  say "Upgrade Node, open a new terminal, and rerun this installer on the same stable or beta channel." >&2
  node_path="$(command -v node 2>/dev/null || true)"
  if [ -n "${NVM_DIR:-}" ] || printf '%s' "$node_path" | grep -qi '/nvm/'; then
    say "nvm: nvm install 24 && nvm use 24" >&2
  elif [ "$(uname -s 2>/dev/null || true)" = "Darwin" ] && printf '%s' "$node_path" | grep -Eqi 'homebrew|Cellar'; then
    say "Homebrew: brew update && brew upgrade node (or install/upgrade node@24)." >&2
  else
    say "Install the current Node.js 24 LTS release with your existing package or version manager." >&2
  fi
  say "For beta, rerun with THREADNOTE_PACKAGE=threadnote@beta." >&2
  say "Threadnote does not change the system Node installation automatically." >&2
  exit 1
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
      NODE_LLAMA_CPP_POSTINSTALL=skip npm install --global "$PACKAGE" --registry="$REGISTRY"
      ;;
    bun)
      NODE_LLAMA_CPP_POSTINSTALL=skip bun install --global "$PACKAGE" --registry="$REGISTRY"
      ;;
    deno)
      case "$PACKAGE" in
        npm:*) deno_package="$PACKAGE" ;;
        *) deno_package="npm:$PACKAGE" ;;
      esac
      NODE_LLAMA_CPP_POSTINSTALL=skip NPM_CONFIG_REGISTRY="$REGISTRY" deno install --global --name threadnote \
        --allow-read --allow-write --allow-run --allow-env --allow-net \
        "$deno_package"
      ;;
  esac
}

runtime="$(select_runtime)"
require_supported_node
logged_package="$(format_install_source_for_log "$PACKAGE")"
logged_registry="$(format_install_source_for_log "$REGISTRY")"
say "Installing $logged_package with $runtime from $logged_registry"
install_package "$runtime"

threadnote_bin="$(find_threadnote "$runtime")" || die "Installed $logged_package, but could not find the threadnote command."

say "Running threadnote install"
if { true </dev/tty; } 2>/dev/null; then
  "$threadnote_bin" install "$@" </dev/tty
else
  "$threadnote_bin" install "$@"
fi

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
