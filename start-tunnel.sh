#!/usr/bin/env bash
# Runs the real app on this computer and gives it a public https address through a Cloudflare quick tunnel.
# The address changes every time. Keep this window open; closing it takes the app offline.
set -e
cd "$(dirname "$0")"
[ -f platform/server.js ] || { echo "Cannot find the platform folder next to this file."; exit 1; }
command -v node >/dev/null || { echo "Node.js 22.13 or newer is required: https://nodejs.org"; exit 1; }
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)" || { echo "Node.js $(node -v) is too old. Version 22.13 or newer is needed."; exit 1; }
command -v cloudflared >/dev/null || { echo "cloudflared is not installed. See https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"; exit 1; }
if [ ! -f platform/data/platform.db ]; then
  echo "No admin account exists yet. Run ./start.sh once, create the admin there, close it, then run this again."
  echo "Otherwise the first stranger who opens the public address could create the admin account."
  exit 1
fi
cd platform
export APP_SECRET="$(node tools/ensure-secret.js)"
export PORT=3000 COOKIE_SECURE=1 TRUST_PROXY=1 REQUIRE_2FA=admin NODE_OPTIONS=--disable-warning=ExperimentalWarning
node server.js &
APP_PID=$!
trap 'kill $APP_PID 2>/dev/null' EXIT INT TERM
sleep 4
kill -0 $APP_PID 2>/dev/null || { echo "The app did not start. Read the message above."; exit 1; }
echo
echo "Your public address appears below (https://....trycloudflare.com). Sign in with your admin account."
echo
cloudflared tunnel --url http://localhost:3000
