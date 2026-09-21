#!/usr/bin/env bash
# Start the shared local Redis (127.0.0.1:6379, db0) and Redis Commander UI
# (http://127.0.0.1:8081/) used by this app. Commander is started with --noload
# so it always connects to that instance instead of a saved config.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REDIS_START="${REDIS_START_SCRIPT:-/home/lenny/Dev/db/redis/start-redis.sh}"
REDIS_HOST="127.0.0.1"
REDIS_PORT="6379"
REDIS_DB="0"
UI_HOST="127.0.0.1"
UI_PORT="8081"
UI_URL="http://${UI_HOST}:${UI_PORT}/"
LOG="${TMPDIR:-/tmp}/redis-commander-local.log"

if [[ ! -x "$REDIS_START" && ! -f "$REDIS_START" ]]; then
	echo "error: Redis start script not found at $REDIS_START" >&2
	exit 1
fi

bash "$REDIS_START"

if curl -sf -o /dev/null --max-time 1 "$UI_URL"; then
	echo "Redis Commander already running at $UI_URL (redis://${REDIS_HOST}:${REDIS_PORT}/${REDIS_DB})"
	exit 0
fi

cd "$ROOT"
nohup npx --yes redis-commander \
	--noload \
	--nosave \
	--redis-host "$REDIS_HOST" \
	--redis-port "$REDIS_PORT" \
	--redis-db "$REDIS_DB" \
	--redis-label local \
	--address "$UI_HOST" \
	--port "$UI_PORT" \
	>"$LOG" 2>&1 &
disown || true

for _ in $(seq 1 50); do
	if curl -sf -o /dev/null --max-time 1 "$UI_URL"; then
		echo "Redis Commander UI: $UI_URL → redis://${REDIS_HOST}:${REDIS_PORT}/${REDIS_DB}"
		exit 0
	fi
	sleep 0.2
done

echo "warning: redis-commander started but UI not yet ready at $UI_URL (see $LOG)" >&2
exit 0
