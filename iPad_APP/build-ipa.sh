#!/bin/bash
#
# build-ipa.sh — build CRMiPad.app for iPad and package it as an unsigned .ipa.
#
#   build-ipa.sh                  build the last commit (uncommitted edits are left out)
#   build-ipa.sh --worktree       build the working tree as it is, uncommitted edits included
#   build-ipa.sh --output PATH    write the .ipa to PATH instead of iPad_APP/dist/CRMiPad.ipa
#   build-ipa.sh --describe [--worktree] [--since COMMIT]
#                                 build nothing; print JSON about the build that would be made
#
# Signing is left to whatever installs it (Xcode, or a re-signer such as the Sideloader), so this
# needs no Apple ID.
#
# Committed is the default because this is what the Apple TV Refresh app's Update iPad button runs:
# a half-finished edit sitting in the working tree must not reach the clinic iPad by accident.
# deploy.sh passes --worktree, for trying an edit on the iPad before committing it.
#
# Every build is stamped, in a SideloadBuildInfo dictionary in its Info.plist, with the commit it
# came from, when it was built, whether it carries uncommitted edits, and a fingerprint of exactly
# the files that go into the app. The Apple TV Refresh app reads that to show which version is on
# the iPad, and compares the fingerprint with --describe to tell whether a newer one is waiting.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
OUTPUT="$HERE/dist/CRMiPad.ipa"
MODE=committed
DESCRIBE=0
SINCE=""

while [ $# -gt 0 ]; do
    case "$1" in
        --worktree)  MODE=worktree ;;
        --committed) MODE=committed ;;
        --describe)  DESCRIBE=1 ;;
        --since)     SINCE="${2:?--since needs a commit}"; shift ;;
        --output)    OUTPUT="${2:?--output needs a path}"; shift ;;
        *) echo "error: unknown option $1" >&2; exit 2 ;;
    esac
    shift
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- what goes into the app ----------------------------------------------------------------------
# The Swift app, its project, and the web files web-files.txt lists. Nothing else: tests, README and
# the pages the app leaves out can change without the iPad needing an update.

APP_INPUTS="iPad_APP/CRMiPad
iPad_APP/CRMiPad.xcodeproj/project.pbxproj
iPad_APP/Info.plist
iPad_APP/copy-web.sh
iPad_APP/web-files.txt"

input_paths() {
    printf '%s\n' "$APP_INPUTS"
    if [ "$MODE" = committed ]; then
        git -C "$REPO" show HEAD:iPad_APP/web-files.txt
    else
        cat "$HERE/web-files.txt"
    fi | sed -e 's/[[:space:]]*$//' | grep -v -e '^#' -e '^$' | sed -e 's|^|site/|'   # listed relative to site/
}

# "<blob id> <path>" for every input file, sorted by path. git hash-object gives the same blob IDs
# git ls-tree reports, so the two modes agree exactly whenever the working tree matches the commit.
input_blobs() {
    local IFS=$'\n'
    local paths=($(input_paths))
    if [ "$MODE" = committed ]; then
        git -C "$REPO" ls-tree -r HEAD -- "${paths[@]}" \
            | awk -F'\t' '{ split($1, m, " "); print m[3] " " $2 }'
    else
        (cd "$REPO" && git ls-files -co --exclude-standard -- "${paths[@]}" | LC_ALL=C sort -u \
            | while IFS= read -r f; do [ -f "$f" ] && printf '%s\n' "$f"; done) >"$WORK/paths"
        (cd "$REPO" && git hash-object --stdin-paths <"$WORK/paths") | paste -d' ' - "$WORK/paths"
    fi | LC_ALL=C sort -k2
}

fingerprint() { input_blobs | shasum -a 256 | cut -c1-16; }

# The version is the last commit that changed the app, not HEAD: a README-only commit is still the
# same app, and naming it by HEAD would make an unchanged build look new.
FINGERPRINT="$(fingerprint)"
IFS=$'\n' read -r -d '' COMMIT COMMIT_TIME SUBJECT < <(
    IFS=$'\n'; git -C "$REPO" log -1 --format='%h%n%ct%n%s' HEAD -- $(input_paths); printf '\0'
) || true
WORKTREE_DIRTY=false
if [ "$MODE" = worktree ]; then
    [ "$FINGERPRINT" != "$(MODE=committed fingerprint)" ] && WORKTREE_DIRTY=true
else
    [ "$FINGERPRINT" != "$(MODE=worktree fingerprint)" ] && WORKTREE_DIRTY=true
fi
UNCOMMITTED=false
[ "$MODE" = worktree ] && UNCOMMITTED=$WORKTREE_DIRTY

CHANGES=""
if [ -n "$SINCE" ] && git -C "$REPO" rev-parse -q --verify "$SINCE^{commit}" >/dev/null; then
    CHANGES="$(IFS=$'\n'; git -C "$REPO" log --format='%h%x09%ct%x09%s' "$SINCE..HEAD" -- $(input_paths))"
    [ -n "$CHANGES" ] || CHANGES=" "   # known commit, nothing since: an empty list rather than null
fi

build_json() {
    B_FINGERPRINT="$FINGERPRINT" B_COMMIT="$COMMIT" B_COMMIT_TIME="$COMMIT_TIME" B_SUBJECT="$SUBJECT" \
    B_UNCOMMITTED="$UNCOMMITTED" B_WORKTREE_DIRTY="$WORKTREE_DIRTY" B_MODE="$MODE" \
    B_CHANGES="$CHANGES" B_BUILT_AT="${1:-}" python3 - <<'PY'
import json, os, time
e = os.environ
commit_time = int(e["B_COMMIT_TIME"]) if e["B_COMMIT_TIME"] else None
built_at = int(e["B_BUILT_AT"]) if e["B_BUILT_AT"] else None
uncommitted = e["B_UNCOMMITTED"] == "true"
when = built_at if uncommitted else commit_time   # an uncommitted build has no commit time of its own
stamp = time.strftime("%b %-d, %-I:%M %p", time.localtime(when)) if when else ""
label = e["B_COMMIT"] + (" + uncommitted edits" if uncommitted else "") + (" · " + stamp if stamp else "")
out = {
    "label": label,
    "fingerprint": e["B_FINGERPRINT"],
    "commit": e["B_COMMIT"],
    "commit_time": commit_time,
    "subject": e["B_SUBJECT"],
    "uncommitted": uncommitted,
    "mode": e["B_MODE"],
    "worktree_dirty": e["B_WORKTREE_DIRTY"] == "true",
}
if built_at:
    out["built_at"] = built_at
if e["B_CHANGES"]:
    out["changes"] = [
        dict(zip(("commit", "time", "subject"), line.split("\t", 2)))
        for line in e["B_CHANGES"].splitlines() if line.strip()
    ]
    for c in out["changes"]:
        c["time"] = int(c["time"])
print(json.dumps(out))
PY
}

if [ "$DESCRIBE" = 1 ]; then
    build_json
    exit 0
fi

# --- the source to build --------------------------------------------------------------------------

if [ "$MODE" = committed ]; then
    SRC="$WORK/src"
    mkdir -p "$SRC"
    (IFS=$'\n'; git -C "$REPO" archive HEAD -- $(input_paths) tests/ipad-bundle-complete.test.js) \
        | tar -x -C "$SRC"
    echo "==> Building the last commit ($COMMIT)"
    [ "$WORKTREE_DIRTY" = true ] && echo "    uncommitted edits to the app are not included"
else
    SRC="$REPO"
    echo "==> Building the working tree ($COMMIT$([ "$UNCOMMITTED" = true ] && echo ' + uncommitted edits'))"
fi

# A page that loads a file web-files.txt is missing would ship without it, silently. Checked against
# the same source that is about to be built.
NODE="$(command -v node || true)"
for n in /usr/local/bin/node /opt/homebrew/bin/node; do [ -n "$NODE" ] || { [ -x "$n" ] && NODE="$n"; }; done
if [ -n "$NODE" ]; then
    echo "==> Checking the bundle list"
    "$NODE" "$SRC/tests/ipad-bundle-complete.test.js"
else
    echo "warning: node not found, so the bundle list was not checked" >&2
fi

# `xcode-select -p` often points at the Command Line Tools, which have no iOS SDK. Find a full
# Xcode for our own subprocesses instead of changing system state.
if [ -z "${DEVELOPER_DIR:-}" ] || [ ! -d "$DEVELOPER_DIR/Platforms/iPhoneOS.platform" ]; then
    DEVELOPER_DIR=""
    for d in "$(xcode-select -p 2>/dev/null)" /Applications/Xcode.app/Contents/Developer \
             /Applications/Xcode-beta.app/Contents/Developer; do
        if [ -d "$d/Platforms/iPhoneOS.platform" ]; then DEVELOPER_DIR="$d"; break; fi
    done
fi
[ -n "$DEVELOPER_DIR" ] || { echo "error: needs a full Xcode with the iOS platform installed" >&2; exit 1; }
export DEVELOPER_DIR

# The version is the day it was built (the iPad's Settings shows it), the build number the repo's
# commit count. Neither says which code is inside — SideloadBuildInfo below does.
VERSION="$(date +%Y.%m.%d)"
BUILD="$(git -C "$REPO" rev-list --count HEAD 2>/dev/null || echo 1)"

echo "==> Compiling CRMiPad $VERSION ($BUILD)"
"$DEVELOPER_DIR/usr/bin/xcodebuild" -project "$SRC/iPad_APP/CRMiPad.xcodeproj" -target CRMiPad \
    -sdk iphoneos -configuration Release CODE_SIGNING_ALLOWED=NO \
    MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD" \
    SYMROOT="$WORK/build" OBJROOT="$WORK/obj" build >"$WORK/build.log" 2>&1 \
    || { tail -30 "$WORK/build.log" >&2; exit 1; }

echo "==> Packaging"
APP="$WORK/Payload/CRMiPad.app"
mkdir -p "$WORK/Payload" "$(dirname "$OUTPUT")"
cp -R "$WORK/build/Release-iphoneos/CRMiPad.app" "$WORK/Payload/"
build_json "$(date +%s)" >"$WORK/stamp.json"
python3 - "$APP/Info.plist" "$WORK/stamp.json" <<'PY'
import json, plistlib, sys
path, stamp = sys.argv[1], json.load(open(sys.argv[2]))
for transient in ("mode", "worktree_dirty", "changes"):
    stamp.pop(transient, None)
with open(path, "rb") as f:
    info = plistlib.load(f)
info["SideloadBuildInfo"] = {k: v for k, v in stamp.items() if v is not None}
with open(path, "wb") as f:
    plistlib.dump(info, f, fmt=plistlib.FMT_BINARY)
PY
rm -f "$OUTPUT"
(cd "$WORK" && zip -qry "$OUTPUT" Payload)

echo "Built $OUTPUT"
echo "    $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["label"])' "$WORK/stamp.json")"
