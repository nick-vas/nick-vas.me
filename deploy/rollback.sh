#!/usr/bin/env bash
# Point the live site back at the previous release (instant; nothing is rebuilt or uploaded).
#   DEPLOY_TARGET=user@your-droplet ./deploy/rollback.sh
# Optional: DEPLOY_PATH (default /var/www/nick-vas.me).
set -euo pipefail

target=${DEPLOY_TARGET:?set DEPLOY_TARGET, e.g. DEPLOY_TARGET=user@your-droplet}
path=${DEPLOY_PATH:-/var/www/nick-vas.me}
cd "$(dirname "$0")/.."

out=$(ssh "$target" bash -s -- "$path" rollback < deploy/remote-switch.sh)
echo "$out"
# "now serving releases/<name>" -> release=<name>, for the workflow summary
release=${out##*releases/}
[ -z "${GITHUB_OUTPUT:-}" ] || echo "release=$release" >> "$GITHUB_OUTPUT"
