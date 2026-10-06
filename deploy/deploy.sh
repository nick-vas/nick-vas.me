#!/usr/bin/env bash
# Build the site and publish it to the droplet as a new release, switched on atomically.
#   DEPLOY_TARGET=user@your-droplet ./deploy/deploy.sh
# Optional: DEPLOY_PATH (default /var/www/nick-vas.me), KEEP_RELEASES (default 5).
# Used by the GitHub Actions deploy workflow and by hand. Undo with deploy/rollback.sh.
set -euo pipefail

target=${DEPLOY_TARGET:?set DEPLOY_TARGET, e.g. DEPLOY_TARGET=user@your-droplet}
path=${DEPLOY_PATH:-/var/www/nick-vas.me}
keep=${KEEP_RELEASES:-5}
case "$path" in /*) ;; *) echo "DEPLOY_PATH must be an absolute path, got: $path" >&2; exit 1 ;; esac
cd "$(dirname "$0")/.."

# Minified build with pre-compressed copies of the text files (see build.sh).
bash deploy/build.sh

release="$(date -u +%Y%m%d%H%M%S)-$(git rev-parse --short HEAD)"

# Upload next to the live site, never into it. --link-dest hard-links files that did not
# change from the live release, so a deploy only transfers and stores what is new. Files are
# compared by content (--checksum) and times are not preserved, because Hugo rewrites every
# file on each build, so modification times never match; unchanged files then keep one
# inode (and one ETag) across releases. World-readable so Nginx (www-data) can serve the
# files whatever the local permissions.
# shellcheck disable=SC2029 # $path is meant to expand here, on this machine
ssh "$target" "mkdir -p '$path/releases'"
rsync -rlpz --checksum --delete --chmod=D755,F644 --link-dest="$path/current/" \
  public/ "$target:$path/releases/$release/"

# Switch over (one atomic symlink rename) and prune old releases, on the droplet.
ssh "$target" bash -s -- "$path" activate "$release" "$keep" < deploy/remote-switch.sh

echo "deployed $release"
[ -z "${GITHUB_OUTPUT:-}" ] || echo "release=$release" >> "$GITHUB_OUTPUT"
