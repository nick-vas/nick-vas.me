#!/usr/bin/env bash
# Build the site and upload it to the droplet.
#   DEPLOY_TARGET=user@your-droplet ./deploy/deploy.sh
# Optional: DEPLOY_PATH (default /var/www/nick-vas.me).
set -euo pipefail

target=${DEPLOY_TARGET:?set DEPLOY_TARGET, e.g. DEPLOY_TARGET=user@your-droplet}
path=${DEPLOY_PATH:-/var/www/nick-vas.me}
cd "$(dirname "$0")/.."

git submodule update --init --recursive
hugo --minify --cleanDestinationDir

# Pre-compress text files once, so Nginx serves them with gzip_static instead of
# compressing on every request. Tiny files are skipped (not worth it).
find public -type f \( -name '*.html' -o -name '*.css' -o -name '*.js' -o -name '*.json' \
  -o -name '*.xml' -o -name '*.svg' -o -name '*.txt' \) -size +1k -exec gzip -9 -k -f {} +

# World-readable so Nginx (www-data) can serve the files whatever the local permissions.
rsync -avz --delete --chmod=D755,F644 public/ "$target:$path/"
