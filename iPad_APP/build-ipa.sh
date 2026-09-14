#!/bin/bash
#
# build-ipa.sh — build CRMiPad.app for iPad and package it as an unsigned .ipa.
#
# Signing is left to whatever installs it (Xcode, or a re-signer such as the Sideloader), so this
# needs no Apple ID. Output: iPad_APP/dist/CRMiPad.ipa

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DIST="$HERE/dist"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

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

# Stamp the build so it is obvious which one is on the iPad: the version is the day it was built
# (shown as "Version" in the Apple TV Refresh app and in the iPad's Settings), the build number is
# the repo's commit count.
VERSION="$(date +%Y.%m.%d)"
BUILD="$(git -C "$HERE/.." rev-list --count HEAD 2>/dev/null || echo 1)"

echo "==> Building CRMiPad $VERSION ($BUILD) (Release, unsigned)"
"$DEVELOPER_DIR/usr/bin/xcodebuild" -project "$HERE/CRMiPad.xcodeproj" -target CRMiPad \
    -sdk iphoneos -configuration Release CODE_SIGNING_ALLOWED=NO \
    MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD" \
    SYMROOT="$WORK/build" OBJROOT="$WORK/obj" build >"$WORK/build.log" 2>&1 \
    || { tail -30 "$WORK/build.log" >&2; exit 1; }

echo "==> Packaging"
mkdir -p "$WORK/Payload" "$DIST"
cp -R "$WORK/build/Release-iphoneos/CRMiPad.app" "$WORK/Payload/"
rm -f "$DIST/CRMiPad.ipa"
(cd "$WORK" && zip -qry "$DIST/CRMiPad.ipa" Payload)

echo "Built $DIST/CRMiPad.ipa  (version $VERSION, build $BUILD)"
