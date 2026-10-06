#!/usr/bin/env bash
# Run the site locally exactly as production serves it: the real Nginx config (security
# headers, rate limits, gzip_static, caching) in Docker, in front of a production build.
#   deploy/local.sh              build (including draft posts), start Nginx, check it, print the URL
#   deploy/local.sh --no-drafts  the same, but only published posts, as visitors will see them
#   deploy/local.sh down         stop it
# For everyday editing use `hugo server -D` instead (live reload, drafts); this is for
# checking what visitors will actually get. Needs Docker, Hugo extended and curl.
set -euo pipefail
cd "$(dirname "$0")/.."

compose=(docker compose -f deploy/local/compose.yml)
port=${LOCAL_PORT:-8080}

if [ "${1:-}" = down ]; then
  "${compose[@]}" down
  exit 0
fi

if [ "${1:-}" = --no-drafts ]; then
  bash deploy/build.sh "http://localhost:$port/"
else
  bash deploy/build.sh "http://localhost:$port/" --drafts
fi
LOCAL_PORT=$port "${compose[@]}" up -d --force-recreate
bash deploy/verify.sh "http://localhost:$port"
echo
echo "Serving the production build at http://localhost:$port/   (stop with: deploy/local.sh down)"
[ "${1:-}" = --no-drafts ] || echo "Draft posts (content/posts/test-*.md) are included; use --no-drafts to see only what is published."
