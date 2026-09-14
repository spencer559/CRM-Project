#!/bin/sh
# Xcode build phase: copy the offline web pages listed in web-files.txt into the app bundle.
# The repo stays the single source of truth — nothing under iPad_APP/ duplicates the web code.
set -eu
REPO="${SRCROOT}/.."
DEST="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}/www"
rm -rf "$DEST"
while IFS= read -r f || [ -n "$f" ]; do
  case "$f" in ''|\#*) continue ;; esac
  mkdir -p "$DEST/$(dirname "$f")"
  cp "$REPO/$f" "$DEST/$f"
done < "${SRCROOT}/web-files.txt"
