#!/bin/sh
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
PORT=${1:-5173}
case "$PORT" in ''|*[!0-9]*) echo 'Port must be a number.' >&2; exit 1;; esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then echo 'Port must be between 1 and 65535.' >&2; exit 1; fi
ENTRY="$ROOT/server.js"
RUNTIME="$ROOT/.forge-runtime"
STATE="$RUNTIME/server-$PORT.pid"
URL="http://127.0.0.1:$PORT"
command -v node >/dev/null 2>&1 || { echo 'Node.js is required.' >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo 'curl is required.' >&2; exit 1; }
[ -f "$ROOT/node_modules/express/package.json" ] || { echo 'Dependencies are missing. Run npm install in the studio folder.' >&2; exit 1; }
[ -f "$ROOT/dist/index.html" ] || { echo 'Studio build is missing. Run npm run build first.' >&2; exit 1; }
get_server_pid() {
  node -e 'const http=require("http"),path=require("path");const root=path.resolve(process.argv[1]),port=Number(process.argv[2]);const r=http.get(`http://127.0.0.1:${port}/api/diagnostics`,{timeout:1500},res=>{let b="";res.on("data",x=>b+=x);res.on("end",()=>{try{const s=JSON.parse(b).server,p=s.supervisorPid||s.pid;if(s.port===port&&path.resolve(s.projectDirectory)===root&&Number.isInteger(p))console.log(p)}catch{}})});r.on("error",()=>{});r.on("timeout",()=>r.destroy())' "$ROOT" "$PORT"
}
verified_process() {
  args=$(ps -p "$1" -o args= 2>/dev/null || true)
  case "$args" in *"$ROOT"/server.js*"--port $PORT"*|*"$ROOT"*vite.js*"--port $PORT"*) return 0;; *) return 1;; esac
}
pid=$(get_server_pid)
if [ -n "$pid" ] && verified_process "$pid"; then echo "Studio is already running at $URL (PID $pid)."; exit 0; fi
if curl -s --connect-timeout 1 --max-time 2 -o /dev/null "$URL/"; then echo "Port $PORT is already in use by another service." >&2; exit 1; fi
if [ -f "$STATE" ]; then
  oldpid=$(sed -n '1p' "$STATE"); oldstart=$(sed -n '2p' "$STATE")
  case "$oldpid" in ''|*[!0-9]*) oldpid=0;; esac
  if [ "$oldpid" -gt 0 ] && kill -0 "$oldpid" 2>/dev/null && verified_process "$oldpid" && [ "$(ps -p "$oldpid" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//')" = "$oldstart" ]; then
    echo "A tracked studio process (PID $oldpid) is still starting or unresponsive. Stop it first with ./stop-server.sh $PORT." >&2; exit 1
  fi
fi
mkdir -p "$RUNTIME"
stamp=$(date +%Y%m%d-%H%M%S)-$$
log="$RUNTIME/server-$PORT-$stamp.log"
err="$RUNTIME/server-$PORT-$stamp-error.log"
cd "$ROOT"
nohup node "$ENTRY" --port "$PORT" >"$log" 2>"$err" </dev/null &
pid=$!
start=$(ps -p "$pid" -o lstart= | sed 's/^[[:space:]]*//')
printf '%s\n%s\n' "$pid" "$start" > "$STATE"
attempt=0
while [ "$attempt" -lt 60 ]; do
  if ! kill -0 "$pid" 2>/dev/null; then echo "Studio exited during startup. Check $err and $log." >&2; exit 1; fi
  found=$(get_server_pid)
  if [ "$found" = "$pid" ] && verified_process "$pid"; then echo "Studio is running at $URL (PID $pid)."; echo "Log: $log"; exit 0; fi
  attempt=$((attempt+1)); sleep 0.5
done
echo "Studio did not become ready. Check $err and $log; use ./stop-server.sh $PORT to stop it." >&2
exit 1
