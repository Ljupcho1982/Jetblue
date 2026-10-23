#!/usr/bin/env bash
# Starts the Aircraft Deal Platform on this computer (Mac or Linux).
#   bash start.sh          sample aircraft included, good for trying it out
#   bash start.sh real     starts empty, for your own aircraft (use this for real work)
# Open the address it prints. Press Ctrl+C in this window to stop it. Your data is kept in platform/data.
cd "$(dirname "$0")/platform" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo; echo "Node.js is not installed."; echo "Install the LTS version from https://nodejs.org , then run this again."; exit 1
fi
if ! node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)"; then
  echo; echo "Your Node.js ($(node -v)) is too old. This needs version 22.13 or newer."; echo "Install the LTS version from https://nodejs.org , then run this again."; exit 1
fi
[ "$1" = "real" ] && export SEED_DEMO=0
export PORT="${PORT:-3000}" NODE_OPTIONS="--disable-warning=ExperimentalWarning"
URL="http://127.0.0.1:$PORT"
echo; echo "Starting... open  $URL  in your web browser."; echo "(First time: it asks you to create the admin account. Write the password down.)"; echo "To stop: press Ctrl+C."; echo
( for _ in $(seq 1 40); do curl -sf "$URL/healthz" >/dev/null 2>&1 && { (command -v open >/dev/null && open "$URL") || (command -v xdg-open >/dev/null && xdg-open "$URL") >/dev/null 2>&1; break; }; sleep 0.25; done ) &
exec node server.js
