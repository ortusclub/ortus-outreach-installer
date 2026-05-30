#!/bin/bash
# Ortus Outreach -- one-line installer.
#
# Downloads the latest DMG, copies the app into /Applications, strips the
# quarantine attribute (so macOS Gatekeeper does not block it), and launches.
#
# Usage (paste into Terminal):
#   curl -fsSL https://raw.githubusercontent.com/ortusclub/ortus-outreach-installer/main/install.sh | bash

set -eo pipefail

REPO="ortusclub/ortus-outreach-installer"
APP_NAME="The Ortus Outreach.app"
APP_DEST="/Applications/$APP_NAME"

if [ "$(uname -m)" = "arm64" ]; then
  DMG="Ortus-Outreach-arm64.dmg"
else
  DMG="Ortus-Outreach-intel.dmg"
fi

URL="https://github.com/$REPO/releases/latest/download/$DMG"
TMP_DMG="/tmp/ortus-outreach-$$.dmg"
MOUNT="/tmp/ortus-mount-$$"

cleanup() {
  /usr/bin/hdiutil detach "$MOUNT" -quiet 2>/dev/null || true
  /bin/rm -f "$TMP_DMG"
  /bin/rmdir "$MOUNT" 2>/dev/null || true
}
trap cleanup EXIT

echo ">> Downloading $DMG..."
/usr/bin/curl -fSL "$URL" -o "$TMP_DMG"

echo ">> Mounting DMG..."
/bin/mkdir -p "$MOUNT"
/usr/bin/hdiutil attach "$TMP_DMG" -nobrowse -quiet -mountpoint "$MOUNT"

# Quit any running instance so we can replace it.
/usr/bin/pkill -x "The Ortus Outreach" 2>/dev/null || true
sleep 1

echo ">> Installing to /Applications..."
/bin/rm -rf "$APP_DEST"
/bin/cp -R "$MOUNT/$APP_NAME" "$APP_DEST"

echo ">> Removing quarantine attributes..."
/usr/bin/xattr -cr "$APP_DEST"

echo ">> Launching The Ortus Outreach..."
/usr/bin/open "$APP_DEST"

echo "Done."
