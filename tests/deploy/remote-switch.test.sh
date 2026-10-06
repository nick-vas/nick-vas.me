#!/usr/bin/env bash
# Tests deploy/remote-switch.sh (the part that runs on the droplet) against a temp directory.
# Needs real symlinks and GNU coreutils, so run it on Linux (CI does; on Windows use WSL).
#   bash tests/deploy/remote-switch.test.sh
set -uo pipefail

script="$(cd "$(dirname "$0")/../.." && pwd)/deploy/remote-switch.sh"
base=$(mktemp -d)
trap 'rm -rf "$base"' EXIT
fail=0

check() { # check <description> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: expected '$2', got '$3'"; fail=1; fi
}
run() { bash "$script" "$base" "$@" >/dev/null 2>&1; echo $?; }
live() { readlink "$base/current"; }
releases() { find "$base/releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort | tr '\n' ' '; }

mkdir -p "$base/releases"
for r in 20260101000000-aaa 20260102000000-bbb 20260103000000-ccc 20260104000000-ddd; do
  mkdir "$base/releases/$r"
  echo "$r" > "$base/releases/$r/index.html"
done

check "activate succeeds" 0 "$(run activate 20260102000000-bbb 10)"
check "activate points current at it" "releases/20260102000000-bbb" "$(live)"
check "nothing pruned under the keep limit" "20260101000000-aaa 20260102000000-bbb 20260103000000-ccc 20260104000000-ddd " "$(releases)"

check "activate newest with keep=2" 0 "$(run activate 20260104000000-ddd 2)"
check "prunes everything but the newest two" "20260103000000-ccc 20260104000000-ddd " "$(releases)"

check "rollback succeeds" 0 "$(run rollback)"
check "rollback goes to the previous release" "releases/20260103000000-ccc" "$(live)"
check "rollback with nothing older fails" 1 "$(run rollback)"
check "failed rollback leaves current alone" "releases/20260103000000-ccc" "$(live)"

check "never prunes the live release" 0 "$(run activate 20260103000000-ccc 1)"
check "live release survives keep=1" "releases/20260103000000-ccc" "$(live)"
check "live release still exists" "yes" "$([ -d "$base/releases/20260103000000-ccc" ] && echo yes || echo no)"

mkdir "$base/releases/20260105000000-empty"
check "refuses a release with no index.html" 1 "$(run activate 20260105000000-empty 5)"
check "refusal leaves current alone" "releases/20260103000000-ccc" "$(live)"
check "rejects path traversal in the name" 1 "$(run activate ../../etc 5)"
check "rejects an unknown release" 1 "$(run activate 20991231000000-nope 5)"
check "rejects an unknown action" 1 "$(run explode)"
check "rejects a non-numeric keep before going live" 1 "$(run activate 20260104000000-ddd abc)"
check "rejects keep=0" 1 "$(run activate 20260104000000-ddd 0)"
check "a rejected keep leaves current alone" "releases/20260103000000-ccc" "$(live)"

flat=$(mktemp -d); mkdir "$flat/current" "$flat/releases"
check "refuses the old flat layout (current is a directory)" 1 "$(bash "$script" "$flat" activate x >/dev/null 2>&1; echo $?)"
none=$(mktemp -d); mkdir "$none/releases"
check "rollback with no current fails cleanly" 1 "$(bash "$script" "$none" rollback >/dev/null 2>&1; echo $?)"
rm -rf "$flat" "$none"

check "no stray current.new left behind" "no" "$([ -e "$base/current.new" ] && echo yes || echo no)"

exit "$fail"
