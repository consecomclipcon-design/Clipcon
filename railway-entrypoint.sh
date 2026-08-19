#!/bin/sh
set -eu

if [ "${CLIPCON_ROLE:-api}" = "worker" ]; then
  exec node apps/worker/dist/worker.js
fi

exec node apps/api/dist/server.js
