#!/bin/sh
set -eu
umask 077

fail() { echo 'Zot bootstrap failed; check the volume and scoped identity configuration.' >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail
[ -d /data ] && [ ! -L /data ] || fail
[ ! -L /data/registry ] && [ ! -L /run/zot ] || fail
mkdir -p /data/registry /run/zot
chown bun:bun /data /data/registry /run/zot
chmod 700 /data/registry /run/zot
bun /opt/threadnote-org-registry/render-config.ts > /run/zot/config.json || fail
chmod 600 /run/zot/config.json
chown bun:bun /run/zot/config.json
unset ZOT_PUBLISHER_SUBJECT ZOT_WORKER_SUBJECTS_JSON ZOT_READER_SUBJECTS_JSON
/usr/local/bin/zot verify /run/zot/config.json >/dev/null 2>&1 || fail
exec gosu bun:bun /usr/local/bin/zot serve /run/zot/config.json
