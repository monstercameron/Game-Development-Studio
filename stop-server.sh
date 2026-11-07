#!/bin/sh
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
PORT=${1:-5173}
case "$PORT" in ''|*[!0-9]*) echo 'Port must be a number.' >&2; exit 1;; esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then echo 'Port must be between 1 and 65535.' >&2; exit 1; fi
command -v node >/dev/null 2>&1 || { echo 'Node.js is required.' >&2; exit 1; }
STATE="$ROOT/.forge-runtime/server-$PORT.pid"
pid=$(node -e 'const http=require("http"),path=require("path");const root=path.resolve(process.argv[1]),port=Number(process.argv[2]);const r=http.get(`http://127.0.0.1:${port}/api/diagnostics`,{timeout:1500},res=>{let b="";res.on("data",x=>b+=x);res.on("end",()=>{try{const s=JSON.parse(b).server,p=s.supervisorPid||s.pid;if(s.port===port&&path.resolve(s.projectDirectory)===root&&Number.isInteger(p))console.log(p)}catch{}})});r.on("error",()=>{});r.on("timeout",()=>r.destroy())' "$ROOT" "$PORT")
if [ -z "$pid" ] && [ -f "$STATE" ]; then pid=$(sed -n '1p' "$STATE"); fi
case "$pid" in ''|*[!0-9]*) echo "No matching studio server found on port $PORT."; exit 0;; esac
if ! kill -0 "$pid" 2>/dev/null; then echo "Studio server is not running on port $PORT."; exit 0; fi
args=$(ps -p "$pid" -o args= 2>/dev/null || true)
case "$args" in *"$ROOT"/server.js*"--port $PORT"*|*"$ROOT"*vite.js*"--port $PORT"*) ;; *) echo "PID $pid is not a verified studio server; nothing was stopped." >&2; exit 1;; esac
if [ -f "$STATE" ] && [ "$(sed -n '1p' "$STATE")" = "$pid" ]; then
  expected=$(sed -n '2p' "$STATE"); actual=$(ps -p "$pid" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//')
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then echo "PID $pid has been reused; nothing was stopped." >&2; exit 1; fi
fi
kill "$pid"
if [ -f "$STATE" ] && [ "$(sed -n '1p' "$STATE")" = "$pid" ]; then rm -f -- "$STATE"; fi
echo "Stopped studio server on port $PORT (PID $pid)."
