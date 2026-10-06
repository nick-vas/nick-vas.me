#!/usr/bin/env bash
# Runs ON THE DROPLET (piped over ssh by deploy.sh / rollback.sh) to change which release Nginx
# serves. Layout under <base>:
#   releases/<UTC timestamp>-<commit>/   one full copy of the site per deploy
#   current -> releases/<one of them>    what Nginx serves (root <base>/current)
# Switching is one atomic rename of the symlink, so visitors never see a half-uploaded site.
#
#   remote-switch.sh <base> activate <release> [keep]   make <release> live, prune old ones
#   remote-switch.sh <base> rollback                    go back to the previous release
set -euo pipefail

base=${1:?usage: remote-switch.sh <base> activate <release> [keep] | rollback}
action=${2:?missing action}
shift 2
cd "$base"

# A real directory here means the web root still has the old flat layout (see deploy/CD.md).
if [ -e current ] && [ ! -L current ]; then
  echo "$base/current exists but is not a symlink: migrate to the release layout first (deploy/CD.md)" >&2
  exit 1
fi

# Newest first: release names start with a UTC timestamp, so name order is time order.
list_releases() { find releases -mindepth 1 -maxdepth 1 -type d | sort -r; }

point_at() {
  ln -sfn "$1" current.new
  mv -T -f current.new current # rename(2): atomic
  echo "now serving $1"
}

case "$action" in
  activate)
    release=${1:?missing release name}
    keep=${2:-5}
    [[ "$release" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "bad release name: $release" >&2; exit 1; }
    [[ "$keep" =~ ^[1-9][0-9]*$ ]] || { echo "keep must be a positive integer, got: $keep" >&2; exit 1; }
    [ -f "releases/$release/index.html" ] || { echo "releases/$release has no index.html; refusing to go live" >&2; exit 1; }
    point_at "releases/$release"
    live=$(readlink current)
    # Keep the newest $keep releases (and never the live one), so a rollback target always exists.
    # Past the point of no return: a failure to prune must not fail a deploy that is already live.
    list_releases | tail -n +"$((keep + 1))" | while read -r old; do
      [ "$old" = "$live" ] || rm -rf -- "$old" || echo "warning: could not remove $old" >&2
    done
    ;;
  rollback)
    [ -L current ] || { echo "$base/current is not a symlink: nothing to roll back from" >&2; exit 1; }
    live=$(readlink current)
    # The newest release that is older than the live one.
    prev=$(list_releases | awk -v live="$live" 'seen { print; exit } $0 == live { seen = 1 }')
    [ -n "$prev" ] || { echo "no older release to roll back to" >&2; exit 1; }
    [ -f "$prev/index.html" ] || { echo "$prev has no index.html" >&2; exit 1; }
    point_at "$prev"
    ;;
  *)
    echo "unknown action: $action" >&2
    exit 1
    ;;
esac
