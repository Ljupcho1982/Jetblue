#!/usr/bin/env bash
# Starts the Aircraft Deal Platform on this computer (Mac or Linux).
#   bash start.sh          sample aircraft included, good for trying it out
#   bash start.sh real     starts empty, for your own aircraft (use this for real work)
# Your browser opens by itself. Press Ctrl+C in this window to stop it. Your data is kept in platform/data.
cd "$(dirname "$0")" || exit 1
echo; echo "Aircraft Deal Platform"; echo "Folder: $(pwd)"
if [ ! -f platform/server.js ]; then
  echo; echo "Cannot find the 'platform' folder next to this file."; echo "Extract the zip file first, then run start.sh from the extracted folder."; exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo; echo "Node.js is not installed."; echo "Install the LTS version from https://nodejs.org , open a NEW terminal window, and run this again."; exit 1
fi
echo "Node.js version: $(node -v)"
if ! node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)"; then
  echo; echo "This Node.js is too old. Version 22.13 or newer is needed."; echo "Install the LTS version from https://nodejs.org , open a NEW terminal window, and run this again."; exit 1
fi
cd platform || exit 1
[ "$1" = "real" ] && export SEED_DEMO=0
export OPEN_BROWSER=1 NODE_OPTIONS="--disable-warning=ExperimentalWarning"
echo; echo "Starting. Your browser opens by itself. First time: create the admin account and write the password down."; echo "To stop: press Ctrl+C."; echo
exec node server.js
