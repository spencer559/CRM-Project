#!/bin/bash
#
# deploy.sh — put the current web pages on the iPad, in one step.
#
#   iPad_APP/deploy.sh           check, build, re-sign and install
#   iPad_APP/deploy.sh --build   build dist/CRMiPad.ipa only, install nothing
#
# Everything installed comes from this repo: build-ipa.sh copies the files listed in web-files.txt
# into the app, and the check below fails if a page loads something that list is missing. Installing
# also re-signs, so the 7-day clock restarts on every deploy.
#
# The iPad needs to be unlocked, and plugged in or on the same Wi-Fi.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PROFILE="${CRM_IPAD_PROFILE:-ipad}"

echo "==> Checking the bundle list"
node "$HERE/../tests/ipad-bundle-complete.test.js"

"$HERE/build-ipa.sh"

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

# setup adopts the fresh .ipa (atvrefresh keeps its own copy of it, so a rebuild here is not
# picked up until it is re-adopted); refresh then re-signs that copy and installs it.
echo "==> Adopting the new build"
"$CLI" --profile "$PROFILE" setup "$HERE/dist/CRMiPad.ipa" >/dev/null
"$CLI" --profile "$PROFILE" refresh --force
