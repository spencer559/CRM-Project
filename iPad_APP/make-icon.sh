#!/bin/bash
#
# make-icon.sh — (re)draw the app icon.
#
#   iPad_APP/make-icon.sh                          the drawn icon
#   iPad_APP/make-icon.sh path/to/pic.jpg           any image, scaled and centre-cropped
#   iPad_APP/make-icon.sh path/to/pic.jpg 0.4 0.55  ...kept around that point instead
#
# Focus is a fraction of the picture: x 0 = left, 1 = right; y 0 = top, 1 = bottom. Use it when a
# wide picture has its subject off to one side, since the square drops the rest.
#
# Writes CRMiPad/Assets.xcassets/AppIcon.appiconset/icon-1024.png, which the next build picks up.
# Deploy afterwards to put it on the iPad: iPad_APP/deploy.sh

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HERE/CRMiPad/Assets.xcassets/AppIcon.appiconset/icon-1024.png"
SOURCE="${1:-}"
FOCUS_X="${2:-0.5}"
FOCUS_Y="${3:-0.5}"

# swiftc needs a full Xcode for the macOS SDK; find one without changing system state.
if [ -z "${DEVELOPER_DIR:-}" ] || [ ! -x "$DEVELOPER_DIR/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc" ]; then
    DEVELOPER_DIR=""
    for d in "$(xcode-select -p 2>/dev/null)" /Applications/Xcode.app/Contents/Developer \
             /Applications/Xcode-beta.app/Contents/Developer; do
        if [ -d "$d/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk" ]; then DEVELOPER_DIR="$d"; break; fi
    done
fi
[ -n "$DEVELOPER_DIR" ] || { echo "error: needs a full Xcode to draw the icon" >&2; exit 1; }
export DEVELOPER_DIR

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

"$DEVELOPER_DIR/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc" -O \
    -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
    -target "$(uname -m)-apple-macosx13.0" \
    -o "$WORK/make-icon" "$HERE/make-icon.swift"

if [ -n "$SOURCE" ]; then
    [ -f "$SOURCE" ] || { echo "error: no such file: $SOURCE" >&2; exit 1; }
    "$WORK/make-icon" "$DEST" "$SOURCE" "$FOCUS_X" "$FOCUS_Y"
else
    "$WORK/make-icon" "$DEST"
fi

echo "Icon updated: $DEST"
