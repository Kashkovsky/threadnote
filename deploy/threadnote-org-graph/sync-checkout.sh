#!/bin/bash
set -euo pipefail

checkout="${THREADNOTE_GRAPH_CHECKOUT:?}"
remote="${THREADNOTE_GRAPH_GIT_REMOTE_URL:?}"
branch="${THREADNOTE_GRAPH_GIT_BRANCH:?}"

sync_once() {
  if [[ ! -d "$checkout/.git" || -L "$checkout" || -L "$checkout/.git" ]]; then
    echo 'Publisher checkout is missing or unsafe.' >&2
    return 1
  fi
  if [[ "$(git -C "$checkout" remote get-url origin)" != "$remote" ||
        "$(git -C "$checkout" branch --show-current)" != "$branch" ||
        "$(git -C "$checkout" rev-parse --is-shallow-repository)" != false ||
        -n "$(git -C "$checkout" status --porcelain)" ]]; then
    echo 'Publisher checkout identity or clean state changed.' >&2
    return 1
  fi
  if ! timeout 20s git -C "$checkout" fetch --no-tags origin "refs/heads/$branch" >/dev/null 2>&1; then
    echo 'Publisher source fetch is temporarily unavailable.' >&2
    return 75
  fi
  if ! git -C "$checkout" merge-base --is-ancestor HEAD FETCH_HEAD; then
    echo 'Publisher source branch is not a fast-forward descendant.' >&2
    return 1
  fi
  if [[ "$(git -C "$checkout" rev-parse HEAD)" != "$(git -C "$checkout" rev-parse FETCH_HEAD)" ]]; then
    git -C "$checkout" merge --ff-only --no-edit FETCH_HEAD >/dev/null 2>&1 || {
      echo 'Publisher source fast-forward failed.' >&2
      return 1
    }
  fi
}

if [[ "${1:-}" == '--once' ]]; then
  sync_once
  exit $?
fi
if [[ $# -ne 0 ]]; then
  echo 'Usage: sync-checkout.sh [--once]' >&2
  exit 2
fi

while :; do
  if sync_once; then
    :
  else
    status=$?
    if [[ $status -ne 75 ]]; then exit "$status"; fi
  fi
  sleep 15
done
