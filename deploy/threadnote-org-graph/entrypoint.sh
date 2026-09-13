#!/bin/bash
set -euo pipefail
umask 077

fail() {
  echo 'Graph publisher bootstrap failed; check the persistent volume, authority, or scoped credentials.' >&2
  exit 1
}

[[ "$(id -u)" != 0 && -d /data && ! -L /data ]] || fail
[[ -n "${THREADNOTE_GRAPH_GIT_SSH_KEY_B64:-}" ]] || fail
[[ ! -L /run/threadnote && ! -L /run/nginx ]] || fail
mkdir -p /run/threadnote/docker /run/nginx/body /run/nginx/proxy
chmod 700 /run/threadnote /run/threadnote/docker /run/nginx
[[ ! -e /run/threadnote/git_key && ! -L /run/threadnote/git_key ]] || fail
printf '%s' "$THREADNOTE_GRAPH_GIT_SSH_KEY_B64" | base64 -d > /run/threadnote/git_key 2>/dev/null || fail
unset THREADNOTE_GRAPH_GIT_SSH_KEY_B64
chmod 600 /run/threadnote/git_key
ssh-keygen -y -P '' -f /run/threadnote/git_key >/dev/null 2>&1 || fail

export THREADNOTE_HOME=/data/signed/threadnote
export THREADNOTE_GRAPH_CHECKOUT=/data/signed/repository
export DOCKER_CONFIG=/run/threadnote/docker
export GIT_SSH_COMMAND='/usr/bin/ssh -F /dev/null -i /run/threadnote/git_key -o UserKnownHostsFile=/etc/threadnote/github_known_hosts -o GlobalKnownHostsFile=/dev/null -o StrictHostKeyChecking=yes -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none -o ForwardAgent=no -o ConnectTimeout=10 -o HostKeyAlgorithms=ssh-ed25519'
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0

[[ -d "$THREADNOTE_GRAPH_CHECKOUT/.git" && -d "$THREADNOTE_HOME" ]] || fail
bun /opt/threadnote/graph-publisher-preflight.js || fail
command -v docker-credential-threadnote-auth0-publisher-m2m >/dev/null 2>&1 || fail
registry_host="${THREADNOTE_GRAPH_REGISTRY_ORIGIN#https://}"
printf '{"credHelpers":{"%s":"threadnote-auth0-publisher-m2m"}}\n' "$registry_host" > "$DOCKER_CONFIG/config.json"
chmod 600 "$DOCKER_CONFIG/config.json"
nginx -c /etc/threadnote/graph-nginx.conf -t >/dev/null 2>&1 || fail

if /usr/local/bin/threadnote-org-graph-sync --once; then
  :
else
  status=$?
  [[ $status == 75 ]] || fail
fi

/usr/local/bin/threadnote-org-graph-sync &
sync_pid=$!
threadnote graph publisher serve \
  --cwd "$THREADNOTE_GRAPH_CHECKOUT" \
  --authorization-policy /data/signed/control-policy.json \
  --listen 127.0.0.1:18765 &
publisher_pid=$!
nginx -c /etc/threadnote/graph-nginx.conf -g 'daemon off;' &
proxy_pid=$!

stop_children() {
  kill "$sync_pid" "$publisher_pid" "$proxy_pid" 2>/dev/null || true
  wait "$sync_pid" "$publisher_pid" "$proxy_pid" 2>/dev/null || true
}
trap 'stop_children; exit 0' TERM INT
set +e
wait -n "$sync_pid" "$publisher_pid" "$proxy_pid"
stop_children
exit 1
