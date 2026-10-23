#!/usr/bin/env bash
# One-command setup on a fresh Ubuntu/Debian server (run as root). Installs Docker if needed, creates the settings
# file with random secrets, and starts the app with automatic HTTPS.
#   sudo bash setup-server.sh deals.yourcompany.com
# Before running: the domain's DNS "A record" must already point at this server, and ports 80 and 443 must be open.
# Add --dry-run to see what it would do without changing anything.
set -euo pipefail
DOMAIN="${1:-}"; DRY=0; for a in "$@"; do [ "$a" = "--dry-run" ] && DRY=1; done
[ -n "$DOMAIN" ] && [ "$DOMAIN" != "--dry-run" ] || { echo "Usage: sudo bash setup-server.sh your.domain.com [--dry-run]"; exit 2; }
case "$DOMAIN" in *[!a-zA-Z0-9.-]*|.*|*..*|-*) echo "That does not look like a domain name: $DOMAIN"; exit 2;; esac
case "$DOMAIN" in *.*) ;; *) echo "Use a full domain name such as deals.yourcompany.com"; exit 2;; esac
cd "$(dirname "$0")/platform"
run() { if [ "$DRY" = 1 ]; then echo "[dry run] $*"; else "$@"; fi; }
[ "$DRY" = 1 ] || [ "$(id -u)" = 0 ] || { echo "Run this as root: sudo bash setup-server.sh $DOMAIN"; exit 1; }

if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker (official install script from get.docker.com)..."
  run bash -c 'curl -fsSL https://get.docker.com | sh'
fi
if [ -f .env ]; then
  echo "Keeping your existing settings file (platform/.env). Delete it and run again to regenerate."
else
  echo "Creating platform/.env with random secrets..."
  SECRET="$( (command -v openssl >/dev/null && openssl rand -hex 32) || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  if [ "$DRY" = 1 ]; then echo "[dry run] would write .env with DOMAIN=$DOMAIN, a random APP_SECRET, REQUIRE_2FA=admin"; else
    sed -e "s|^DOMAIN=.*|DOMAIN=$DOMAIN|" -e "s|^APP_SECRET=.*|APP_SECRET=$SECRET|" -e "s|^REQUIRE_2FA=.*|REQUIRE_2FA=admin|" .env.example > .env
    chmod 600 .env
    echo "IMPORTANT: copy the APP_SECRET line from platform/.env somewhere safe (a password manager). It protects the two-factor secrets."
  fi
fi
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then run ufw allow 80/tcp; run ufw allow 443/tcp; fi
echo "Building and starting the app (the first time takes a few minutes)..."
run docker compose up -d --build
if [ "$DRY" = 1 ]; then echo "[dry run] done. Nothing was changed."; exit 0; fi
for i in $(seq 1 60); do
  if docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then
    echo; echo "The app is running."; echo "Open  https://$DOMAIN  and create the admin account right away (the first visitor becomes the admin)."
    echo "If the page does not load: check the DNS record for $DOMAIN, and run:  docker compose logs --tail 50"; exit 0
  fi; sleep 3
done
echo "The app did not become healthy in time. Run:  docker compose logs --tail 80"; exit 1
