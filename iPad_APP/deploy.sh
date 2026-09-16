#!/bin/bash
#
# deploy.sh — put the working tree's web pages on the iPad, in one step, from Terminal.
#
#   iPad_APP/deploy.sh           build the working tree, re-sign and install
#   iPad_APP/deploy.sh --build   build dist/CRMiPad.ipa only, install nothing
#
# This is the developer's route: it ships uncommitted edits too, so a fix can be tried on the iPad
# before it is committed. Such a build shows as "+ uncommitted edits" in the Apple TV Refresh app.
# For everyone else there is the app's Update iPad button, which only ever installs the last commit.
#
# build-ipa.sh checks the bundle list before building, so a page loading a file web-files.txt is
# missing can't reach the iPad. Installing also re-signs, so the 7-day clock restarts on every
# deploy.
#
# The iPad needs to be unlocked, and plugged in or on the same Wi-Fi.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PROFILE="${CRM_IPAD_PROFILE:-ipad}"

"$HERE/build-ipa.sh" --worktree

if [ "${1:-}" = "--build" ]; then
    echo "Built only; nothing installed."
    exit 0
fi

CLI="$(command -v atvrefresh || true)"
[ -n "$CLI" ] || CLI="$HOME/.local/bin/atvrefresh"
[ -x "$CLI" ] || {
    echo "error: atvrefresh not found — run the Sideloader's ./install.sh once" >&2
    exit 1
}

# update --ipa installs this exact build, and only once it is on the iPad does it become the copy
# Refresh Now re-signs. A failed install leaves the previous version in place on both sides.
"$CLI" --profile "$PROFILE" update --ipa "$HERE/dist/CRMiPad.ipa"
