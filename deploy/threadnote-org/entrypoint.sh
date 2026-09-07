#!/bin/sh
set -eu
umask 077

fail() { echo 'Threadnote org bootstrap failed; check volume and SSH secret configuration.' >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail
[ -d /data ] && [ ! -L /data ] || fail
[ -n "${THREADNOTE_ORG_GIT_SSH_KEY_B64:-}" ] || fail
[ ! -L /run/threadnote ] || fail
mkdir -p /run/threadnote
chown root:bun /run/threadnote
chmod 750 /run/threadnote
[ ! -L /run/threadnote/git_key ] || fail
printf '%s' "$THREADNOTE_ORG_GIT_SSH_KEY_B64" | base64 -d > /run/threadnote/git_key 2>/dev/null || fail
unset THREADNOTE_ORG_GIT_SSH_KEY_B64
chmod 600 /run/threadnote/git_key
ssh-keygen -y -P '' -f /run/threadnote/git_key >/dev/null 2>&1 || fail
chown bun:bun /run/threadnote/git_key /data
export GIT_SSH_COMMAND='/usr/bin/ssh -F /dev/null -i /run/threadnote/git_key -o UserKnownHostsFile=/etc/threadnote/github_known_hosts -o GlobalKnownHostsFile=/dev/null -o StrictHostKeyChecking=yes -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none -o ForwardAgent=no -o ConnectTimeout=10 -o HostKeyAlgorithms=ssh-ed25519'
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0
exec su-exec bun:bun "$@"
