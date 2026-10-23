# Deploying

One small server with Docker, a domain name, and ports 80/443 open. Caddy gets and renews the HTTPS certificate for you.

> The image has not been built in the environment this repo was written in (no Docker daemon there). `docker-compose.yml` is validated and the app was run with exactly the files the Dockerfile copies, but expect to fix small things on your first build.

## First deploy
1. Point a DNS `A` record for your domain (for example `deals.yourcompany.com`) at the server. Open ports 80 and 443 only.
2. On the server: `git clone` this repo, `cd platform`, then `cp .env.example .env` and set `DOMAIN` and `APP_SECRET` (`openssl rand -hex 32`; keep a copy somewhere safe, it protects the two-factor secrets). Add email and model settings if you want them (see README).
3. `docker compose up -d --build`
4. Open `https://<your domain>`. The first visit asks you to create the admin account. Do this right away, before sharing the address.
5. Set up your own two-factor sign-in on the **Account** page (`.env.example` requires it for admins by default). Then add brokers on the **Users** page and load your aircraft with **Inventory → Import from CSV** (the image starts empty, `SEED_DEMO=0`). Test with `MAIL_ALLOWED_DOMAINS` set before letting email reach real buyers.

Optional local model: `docker compose --profile ollama up -d`, then `docker compose exec ollama ollama pull llama3.1:8b`, and set `LLM_PROVIDER=ollama`, `LLM_BASE_URL=http://ollama:11434/v1` in `.env` and `docker compose up -d`. A 8B model on CPU is slow; use a GPU or a smaller model.

## Screening list
Download the sanctions lists that apply to you, save as `platform/sanctions/list.csv`, and set `SANCTIONS_FILE=/sanctions/list.csv` in `.env`. Refresh it regularly (a cron job that overwrites the file is enough; changes are picked up automatically). If `SANCTIONS_FILE` is set but the file is missing or unreadable, every new lead is held with a screening error rather than waved through.

## What is already handled
- HTTPS and cookie security (`COOKIE_SECURE=1`), only Caddy is exposed; the app is not published directly.
- Correct client IPs behind the proxy (`TRUST_PROXY=1`), so one person's failed logins do not lock out everyone.
- `/healthz` health check, automatic restart, graceful shutdown (SIGTERM checkpoints the database).
- Daily backups to the `backups` volume, last 14 kept. Change with `BACKUP_EVERY_HOURS`, `BACKUP_KEEP`.

## You still need to do
- **Copy backups off the server.** They live on the same machine as the database. Example nightly cron on the host:
  `docker run --rm -v platform_backups:/b -v /mnt/offsite:/out alpine sh -c 'cp -n /b/* /out/'` (adjust the volume name with `docker volume ls`).
- Keep `.env` private (it holds API keys). Do not commit it.
- Keep the host patched, and use a firewall that allows only 22 (restricted), 80 and 443.

## Restore from a backup
```
docker compose stop app
docker compose run --rm --no-deps -v platform_backups:/b --entrypoint sh app -c 'cp /b/platform-<timestamp>.db /data/platform.db && rm -f /data/platform.db-wal /data/platform.db-shm'
docker compose start app
```
Practice a restore once before you need it.

## Upgrade
Upgrades and restores are covered by `upgrade.test.js`: databases created at every earlier schema version are built, filled with data, opened by the current code and checked (users keep their sessions and do not suddenly get two-factor, deals and messages are intact, a second start changes nothing), and a backup is restored with the steps above. It cannot test your own data, so still take a backup first.

`git pull && docker compose up -d --build`. Schema changes run automatically at start (versioned migrations). Take a backup first: `docker compose exec app node backup.js /backups/manual-$(date +%F).db`.

## Move from the old JSON store
`docker compose run --rm -v $PWD/data/db.json:/old.json:ro app node migrate-json.js /old.json`

## Not covered
Several app servers behind a load balancer (SQLite is single-server), SSO, and monitoring/alerting. Watch `docker compose logs -f app` and point an uptime monitor at `/healthz`.
