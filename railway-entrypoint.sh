#!/bin/sh
set -eu

case "${CLIPCON_ROLE:-api}" in
  worker) exec node apps/worker/dist/worker.js ;;
  web) exec node apps/web/server.mjs ;;
esac

exec node apps/api/dist/server.js
