#!/usr/bin/env bash
# Deploy the API to a free Hugging Face Docker Space and point the GitHub Pages site at it.
# Needs a one-time `hf auth login` (write token). The Gemini key is copied from ~/.secrets/gemini.env
# straight into the Space's secret store, never printed and never written to the repo.
# Usage: scripts/deploy_hf.sh [space-name]   (default: timlul)
set -euo pipefail
cd "$(dirname "$0")/.."
NAME="${1:-timlul}"
HFUSER=$(python3 -c "from huggingface_hub import HfApi; print(HfApi().whoami()['name'])" 2>/dev/null || true)
[ -n "$HFUSER" ] || { echo "run: hf auth login" >&2; exit 1; }
ID="$HFUSER/$NAME"
STAGE=$(mktemp -d)
cp -a Dockerfile requirements.txt server docs "$STAGE"/
rm -rf "$STAGE"/server/__pycache__
printf -- '---\ntitle: תמלול\nemoji: 📝\ncolorFrom: purple\ncolorTo: pink\nsdk: docker\napp_port: 7860\npinned: false\n---\nתמלול – API. האתר: https://moshekfir78.github.io/timlul-web/\n' > "$STAGE/README.md"
python3 - "$ID" "$STAGE" <<'PY'
import os, re, sys
from huggingface_hub import HfApi
rid, stage = sys.argv[1], sys.argv[2]
api = HfApi()
api.create_repo(rid, repo_type="space", space_sdk="docker", exist_ok=True, private=False)
k = os.environ.get("GEMINI_API_KEY")
if not k:
    m = re.search(r"GEMINI_API_KEY\s*=\s*['\"]?([^'\"\s]+)", open(os.path.expanduser("~/.secrets/gemini.env")).read())
    k = m.group(1)
api.add_space_secret(rid, "GEMINI_API_KEY", k)
api.upload_folder(repo_id=rid, repo_type="space", folder_path=stage, commit_message="deploy")
print("space ok")
PY
rm -rf "$STAGE"
URL="https://$(echo "$HFUSER-$NAME" | tr '[:upper:]_.' '[:lower:]--').hf.space"
echo "waiting for $URL ..."
for _ in $(seq 1 60); do curl -sf -m 10 "$URL/api/health" >/dev/null && break; sleep 15; done
scripts/publish_config.sh "$URL"
