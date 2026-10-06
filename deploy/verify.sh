#!/usr/bin/env bash
# Check that a running copy of the site is healthy. Used by the deploy workflow after going
# live, and by hand against the local preview:
#   deploy/verify.sh https://nick-vas.me
#   deploy/verify.sh http://localhost:8080
# Exits non-zero (with a ::error:: line GitHub shows) on the first problem.
set -euo pipefail

url="${1:?usage: verify.sh <site url>}"
url="${url%/}"

headers=$(curl -fsSI --retry 5 --retry-delay 3 --retry-all-errors "$url/")
echo "$headers" | head -1
echo "$headers" | grep -qi '^content-security-policy:' || { echo "::error::no Content-Security-Policy header; is the security snippet included?"; exit 1; }

page=$(curl -fsS --retry 3 "$url/")
# Every stylesheet and script the page references must load: a broken deploy usually shows up
# as a 404 on the fingerprinted assets. Hugo's minifier drops the quotes around attribute
# values, so they are optional in the pattern.
assets=$(grep -oE '(href|src)="?[^" >]+\.(css|js)[^" >]*' <<<"$page" | sed -E 's/^(href|src)="?//' | grep -E '\.(css|js)(\?.*)?$' || true)
[ -n "$assets" ] || { echo "::error::found no stylesheet or script in the page; check the pattern or the deploy"; exit 1; }
while read -r asset; do
  case "$asset" in
    http*) full="$asset" ;;
    //*) full="https:$asset" ;;
    *) full="$url/${asset#/}" ;;
  esac
  code=$(curl -s -o /dev/null -w '%{http_code}' "$full")
  echo "$code $asset"
  [ "$code" = 200 ] || { echo "::error::$asset returned $code"; exit 1; }
done <<<"$assets"

# And a few other pages, so a half-broken release is not judged by the home page alone.
for page_path in /about/ /posts/ /index.xml; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$url$page_path")
  echo "$code $page_path"
  [ "$code" = 200 ] || { echo "::error::$page_path returned $code"; exit 1; }
done
echo "site looks healthy: $url"
