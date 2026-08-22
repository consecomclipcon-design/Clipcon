#!/bin/sh
set -eu

echo "[entrypoint] starting bgutil PO Token Provider server on :4416..."
cd /opt/bgutil-pot-provider/server
node build/main.js &
BGUTIL_PID=$!
cd /app

# Give the provider a moment to boot; the worker retries anyway.
sleep 2

echo "[entrypoint] starting clipcon worker..."
node apps/worker/dist/worker.js &
WORKER_PID=$!

trap 'kill $BGUTIL_PID $WORKER_PID 2>/dev/null || true' TERM INT

# Wait on the worker; if it dies, container exits and Railway restarts both.
wait -n $BGUTIL_PID $WORKER_PID 2>/dev/null || wait $WORKER_PID