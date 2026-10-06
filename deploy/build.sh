#!/usr/bin/env bash
# Build the site into public/ the way production serves it: minified, with pre-compressed
# copies of the text files. Used by deploy.sh and by local.sh.
#   deploy/build.sh                                  # uses baseURL from hugo.toml
#   deploy/build.sh http://localhost:8080/           # for a local preview
#   deploy/build.sh http://localhost:8080/ --drafts  # local preview including draft posts
# Only the explicit --drafts argument turns drafts on (deploy.sh never passes it).
set -euo pipefail
cd "$(dirname "$0")/.."

git submodule update --init --recursive
# Hugo only warns (and exits 0) when the theme is missing, then builds a nearly empty site.
[ -d themes/PaperMod/layouts ] || { echo "themes/PaperMod is empty: run git submodule update --init" >&2; exit 1; }

# Drafts and future-dated posts are not published, whatever hugo.toml or HUGO_* variables say,
# unless --drafts is passed. An exported HUGO_BUILDDRAFTS=true overrides even the flags below,
# so clear those variables first.
unset HUGO_BUILDDRAFTS HUGO_BUILDFUTURE HUGO_BUILDEXPIRED
drafts=false
base=""
for arg in "$@"; do
  case "$arg" in
    --drafts) drafts=true ;;
    *) base="$arg" ;;
  esac
done
flags=(--minify --cleanDestinationDir "--buildDrafts=$drafts" --buildFuture=false --buildExpired=false)
[ -z "$base" ] || flags+=(--baseURL "$base")
hugo "${flags[@]}"

# Pre-compress text files once, so Nginx serves them with gzip_static instead of
# compressing on every request. Tiny files are skipped (not worth it). -n leaves the
# timestamp out of the .gz, so unchanged files stay byte-identical between deploys.
find public -type f \( -name '*.html' -o -name '*.css' -o -name '*.js' -o -name '*.json' \
  -o -name '*.xml' -o -name '*.svg' -o -name '*.txt' \) -size +1k -exec gzip -9 -n -k -f {} +
