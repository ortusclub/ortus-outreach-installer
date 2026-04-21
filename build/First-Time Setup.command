#!/bin/bash
# First-Time Setup for The Ortus Outreach
# Strips macOS quarantine flag and launches the app.
# Required once because the app is unsigned (no Apple Developer cert).

APP_PATH="/Applications/The Ortus Outreach.app"

if [ ! -d "$APP_PATH" ]; then
  /usr/bin/osascript -e 'display dialog "Please drag The Ortus Outreach to your Applications folder first, then run First-Time Setup again." buttons {"OK"} default button "OK" with icon caution with title "Ortus Outreach Setup"'
  exit 1
fi

/usr/bin/xattr -cr "$APP_PATH"
/usr/bin/open "$APP_PATH"
exit 0
