#!/usr/bin/env bash
# Point the GitHub Pages front end at a new API base URL and deploy it.
# Usage: scripts/publish_config.sh https://xxxx.trycloudflare.com
set -euo pipefail
cd "$(dirname "$0")/.."
URL="${1:?api url}"
case "$URL" in https://*) ;; *) echo "bad url" >&2; exit 1;; esac
printf '{"api": "%s"}\n' "$URL" > docs/config.json
git add docs/config.json
if git diff --cached --quiet; then echo "config unchanged"; exit 0; fi
git commit -qm "api: tunnel url updated"
for i in 1 2 3 4 5; do git push -q origin main && break; sleep 10; done
echo "pages config -> $URL"
