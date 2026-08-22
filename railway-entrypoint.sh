#!/bin/sh
set -eu

case "${CLIPCON_ROLE:-api}" in
  worker)
    echo "[entrypoint] starting bgutil PO Token Provider on :4416..."
    cd /opt/bgutil-pot-provider/server
    node build/main.js &
    cd /app
    sleep 2
    exec node apps/worker/dist/worker.js
    ;;
  web) exec node apps/web/server.mjs ;;
esac

exec node apps/api/dist/server.js