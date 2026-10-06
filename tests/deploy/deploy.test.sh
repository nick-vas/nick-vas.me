#!/usr/bin/env bash
# End-to-end check of deploy.sh / rollback.sh with ssh and rsync pointed at a local directory
# and hugo replaced by a stub that writes a tiny site. Everything else is the real script.
# Needs Linux, rsync and git (CI has them; on Windows use WSL).
#   bash tests/deploy/deploy.test.sh
set -uo pipefail
src=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
mkdir -p "$work/repo/deploy" "$work/bin" "$work/remote"
cp "$src"/deploy/{deploy,rollback,remote-switch}.sh "$work/repo/deploy/"
cd "$work/repo" || exit 1
git init -q . && git config user.email t@t && git config user.name t && git add -A && git commit -qm init

# Fake hugo: builds public/ with a page that changes with $BUILD_TAG, plus an unchanged asset.
cat > "$work/bin/hugo" <<'EOF'
#!/usr/bin/env bash
rm -rf public; mkdir -p public/assets
printf '<html>%s %s</html>\n' "${BUILD_TAG:-v1}" "$(head -c 2000 /dev/zero | tr '\0' x)" > public/index.html
head -c 3000 /dev/zero | tr '\0' y > public/assets/app.css
EOF
# Fake ssh: ignore the host, run the command locally. Fake rsync: drop the "host:" prefix.
cat > "$work/bin/ssh" <<'EOF'
#!/usr/bin/env bash
shift                      # the target
if [ "$1" = bash ]; then shift; exec bash "$@"; else exec bash -c "$*"; fi
EOF
cat > "$work/bin/rsync" <<'EOF'
#!/usr/bin/env bash
args=(); for a in "$@"; do args+=("${a#*@host:}"); done
exec /usr/bin/rsync "${args[@]}"
EOF
chmod +x "$work/bin/"*
export PATH="$work/bin:$PATH" DEPLOY_TARGET=user@host DEPLOY_PATH="$work/remote" KEEP_RELEASES=2 GITHUB_OUTPUT="$work/out"
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: expected '$2', got '$3'"; fail=1; fi; }

BUILD_TAG=v1 bash deploy/deploy.sh >/dev/null 2>&1; check "first deploy succeeds" 0 $?
r1=$(readlink "$work/remote/current"); check "current is a release" "releases" "${r1%%/*}"
check "release has index.html" yes "$([ -f "$work/remote/current/index.html" ] && echo yes || echo no)"
check "text files are pre-compressed" yes "$([ -f "$work/remote/current/index.html.gz" ] && echo yes || echo no)"
check "output names the release" "release=${r1#releases/}" "$(tail -1 "$work/out")"

sleep 1; BUILD_TAG=v2 bash deploy/deploy.sh >/dev/null 2>&1; check "second deploy succeeds" 0 $?
r2=$(readlink "$work/remote/current")
check "current moved to the new release" yes "$([ "$r1" != "$r2" ] && echo yes || echo no)"
check "unchanged asset is hard-linked, not copied" "$(stat -c %i "$work/remote/$r1/assets/app.css")" "$(stat -c %i "$work/remote/$r2/assets/app.css")"
check "changed page differs between releases" yes "$(cmp -s "$work/remote/$r1/index.html" "$work/remote/$r2/index.html" && echo no || echo yes)"

sleep 1; BUILD_TAG=v3 bash deploy/deploy.sh >/dev/null 2>&1
check "keeps only KEEP_RELEASES=2" 2 "$(find "$work/remote/releases" -mindepth 1 -maxdepth 1 -type d | wc -l)"

bash deploy/rollback.sh >/dev/null 2>&1; check "rollback succeeds" 0 $?
check "rollback reports the live release" "release=${r2#releases/}" "$(tail -1 "$work/out")"
DEPLOY_PATH=relative/path bash deploy/deploy.sh >/dev/null 2>&1; check "relative DEPLOY_PATH is rejected" 1 $?
check "rollback serves the previous release" "releases/${r2#releases/}" "$(readlink "$work/remote/current")"
check "perms are world-readable" "644" "$(stat -c %a "$work/remote/current/index.html")"
exit $fail
