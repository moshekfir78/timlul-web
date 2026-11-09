#!/usr/bin/env bash
# Runs the תמלול API on 127.0.0.1 and exposes it through a Cloudflare quick tunnel.
# Keeps both alive; whenever the tunnel URL changes it updates docs/config.json and redeploys GitHub Pages.
# Usage: nohup scripts/serve.sh > data/serve.log 2>&1 &
# The Gemini key is read by the server at runtime from GEMINI_API_KEY or ~/.secrets/gemini.env (never stored here).
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$PATH"          # yt-dlp, deno, cloudflared
PORT="${PORT:-8795}"
mkdir -p data
log(){ echo "$(date '+%F %T') $*"; }
if [ ! -x .venv/bin/uvicorn ]; then python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt; fi

start_api(){
  log "starting api on 127.0.0.1:$PORT"
  .venv/bin/uvicorn server.main:app --host 127.0.0.1 --port "$PORT" --proxy-headers --forwarded-allow-ips 127.0.0.1 >> data/server.log 2>&1 &
  API_PID=$!
}
start_tunnel(){
  : > data/tunnel.log
  cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" >> data/tunnel.log 2>&1 &
  TUN_PID=$!
  URL=""
  for _ in $(seq 1 60); do
    URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' data/tunnel.log | head -1)
    [ -n "$URL" ] && break; sleep 1
  done
  if [ -z "$URL" ]; then log "tunnel did not start"; kill $TUN_PID 2>/dev/null; return 1; fi
  echo "$URL" > data/tunnel_url
  log "tunnel: $URL"
  scripts/publish_config.sh "$URL" || log "publish failed"
}

API_PID=""; TUN_PID=""; FAILS=0
start_api; sleep 3
start_tunnel
while true; do
  sleep 60
  if ! kill -0 "$API_PID" 2>/dev/null; then log "api died, restarting"; start_api; sleep 3; fi
  if ! kill -0 "$TUN_PID" 2>/dev/null; then log "tunnel died, restarting"; start_tunnel; FAILS=0; continue; fi
  if curl -sf -m 20 "$(cat data/tunnel_url)/api/health" > /dev/null; then FAILS=0; else FAILS=$((FAILS+1)); log "health via tunnel failed ($FAILS)"; fi
  if [ "$FAILS" -ge 5 ]; then log "tunnel unhealthy, recreating"; kill "$TUN_PID" 2>/dev/null; sleep 2; start_tunnel; FAILS=0; fi
done
