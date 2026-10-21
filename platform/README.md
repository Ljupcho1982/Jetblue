# Aircraft Deal Platform

Platform for aircraft sales and leasing: inventory, leads, deals negotiated with an AI assistant, broker approval, email to buyers, and a training area. No npm dependencies. Needs Node 22.13+ (uses the built-in `node:sqlite`).

```
cd platform
npm start                              # http://127.0.0.1:3000, rule-based templates only
LLM_PROVIDER=ollama npm start          # wording by an open-source model via Ollama
npm test                               # all test suites
```
First visit asks you to create the admin account. Deploying for real: see [DEPLOY.md](DEPLOY.md). Fine-tuning a model: see [finetune/README.md](finetune/README.md).

## How a deal works
1. A lead comes in (Leads page). Demo screening runs, then matching against inventory.
2. Open a deal for an aircraft. Enter the buyer's offer.
3. The **rules engine** (`logic.js`) decides accept / counter / escalate and the price, inside limits set per aircraft (floor, max discount, minimum lease and term). The model cannot change that decision.
4. A draft reply is written (template, or an open-source/Claude model that only words the decision). Every reply is a **draft**.
5. A broker approves, edits or rejects it. Approved text is optionally emailed to the buyer.
6. Accepts move the deal to LOI (a human step), stalled or far-too-low offers escalate to the broker.

## Pages
- **Dashboard:** counts and recent activity.
- **Inventory:** aircraft, including private floor price and limits.
- **Leads:** intake, screening, matching, open a deal.
- **Deals:** negotiation thread, drafts, approval, email status and retry.
- **Training** (admin): playbook, style examples, examples learned from broker edits, test scenarios, fine-tuning export.
- **Users** (admin): add users, change roles, disable, reset password or two-factor.
- **Account:** change your password, set up two-factor.

## The AI and how it is "trained"
The model is not fine-tuned by default. Behaviour is controlled by:
1. **Rules engine** decides the action and price. The model only chooses the wording.
2. **Playbook** (Training page): instructions, tone, negotiation rules (concession per round, escalation threshold, max rounds, required disclaimer) and style examples.
3. **Learning loop:** when a broker edits a draft before approving, the edited text is saved as an example and used in later prompts. Promote good ones to permanent examples.
4. **Guardrail** (`validateMessage`): model text is rejected, and the template used instead, if it mentions any dollar amount other than the decided price and the buyer's offer, leaks a private limit, or uses binding language ("guarantee", "legally binding").
5. **Test scenarios** (Training page): check decisions, that prices never fall below the floor, and that no private limit appears in a message. Run them after every playbook change.
6. **Real fine-tuning** (open-source models): Training page, "Download finetune.jsonl", then follow `finetune/README.md`.

Prompts never contain private limits (floor, minimum lease), so the model cannot reveal them.

### Choosing the model
```
LLM_PROVIDER=ollama LLM_MODEL=llama3.1:8b npm start
```
- `LLM_PROVIDER`: `ollama`, `openai` (any OpenAI-compatible server: vLLM, llama.cpp server, LM Studio) or `anthropic` (needs `ANTHROPIC_API_KEY`). Unset means templates only.
- `LLM_BASE_URL`: default `http://127.0.0.1:11434/v1` (ollama) or `http://127.0.0.1:8000/v1` (openai). `LLM_MODEL`: default `llama3.1:8b`. `LLM_API_KEY`: optional bearer token. `LLM_TIMEOUT_MS`: default 60000.
- Small open models make more mistakes than large ones. The guardrail catches wrong amounts and brokers approve every message. If the model is unreachable or its output is rejected, the template is used and the draft says why.

## Login, roles and two-factor
First run: "Create the admin account" (only possible while no users exist). The admin adds users on the Users page.

| Role | Can do |
|---|---|
| admin | Everything: users, playbook/training, test scenarios, export, reset, delete aircraft |
| broker | Leads, deals (offers, approve/reject drafts), add/edit inventory; sees private limits |
| viewer | Read-only. No private limits (floor, max discount, minimum lease), no draft internals, no playbook, no buyer emails |

- Passwords: scrypt hashes, 12+ characters required. Sessions: server-side, HttpOnly SameSite=Strict cookie, 8 h idle / 24 h absolute, revoked on role change, disable, delete, password reset/change.
- 5 failed logins lock that IP+email for 15 minutes. The last active admin cannot be removed or demoted. Cross-origin and non-JSON writes are rejected. Private limits are enforced on the server, never only hidden in the UI. Every approved message records who approved it.
- **Two-factor (TOTP, RFC 6238).** Anyone can turn it on under Account with any authenticator app. Setup shows a setup key to type in (no QR code), then asks for a code and shows 10 one-time recovery codes. Codes cannot be replayed; wrong-code streaks lock the sign-in; recovery codes are stored hashed. Turning it off or regenerating recovery codes needs the password plus a valid code. Admins can reset a user who lost their phone (Users, Reset), which also signs them out.
  - `REQUIRE_2FA=admin|all` forces enrolment: affected users can reach only the Account page (enforced by the server) and cannot turn it off. Default `off`.
  - `APP_SECRET` encrypts stored two-factor secrets (AES-256-GCM). Without it they are stored unencrypted, so set it in production, keep it with your backups, and do not change it afterwards or existing 2FA users must be reset.
- Forgot the only admin password: stop the server, run `sqlite3 data/platform.db "DELETE FROM sessions; DELETE FROM users;"`, restart and run setup again.

## Database
SQLite at `data/platform.db` (override with `DB_FILE`), accessed only through `store.js`. WAL mode, foreign keys on, versioned migrations (`PRAGMA user_version`), file mode 0600.
- Real tables: users, sessions, aircraft, leads, deals, messages, learned, activity, settings.
- Enforced by the database: floor <= list price, valid roles and deal modes, unique emails, **at most one pending draft per deal**, aircraft with deals cannot be deleted (409).
- Multi-step writes are transactions. Offers use optimistic concurrency, so two brokers submitting at once cannot create two drafts or skip a round, even while a slow model is answering.
- **Backup** (safe while running): `npm run backup -- backups/platform-2026-10-20.db`. The server can also back itself up on a schedule: `BACKUP_DIR`, `BACKUP_EVERY_HOURS` (default 24), `BACKUP_KEEP` (default 14).
- **Import the old JSON store:** `node migrate-json.js data/db.json`. Refuses to run on a non-empty database and changes nothing if it fails. Sessions are not imported.
- New columns or tables: append to `MIGRATIONS` in `store.js`; never edit an applied one.
- Limit: one server process (SQLite has one writer; login throttling and pending two-factor tickets are in memory). For several app servers, replace `store.js` with a Postgres version exposing the same functions.

## Email to buyers
Off until configured, so nothing is sent by accident.
```
MAIL_PROVIDER=resend   MAIL_API_KEY=...  MAIL_FROM="Deals <deals@yourdomain.com>"
MAIL_PROVIDER=webhook  MAIL_WEBHOOK_URL=https://your-relay/send  [MAIL_API_KEY=...]  MAIL_FROM=...
MAIL_ALLOWED_DOMAINS=yourdomain.com,example.com    # optional: only send to these domains (use while testing)
```
`webhook` POSTs JSON `{from, to, subject, text, replyTo}` to your own relay. `resend` calls the Resend API. Use a verified domain (SPF/DKIM) or mail lands in spam.
- Only broker-approved text is sent, exactly as approved, plus a footer: "drafted with AI assistance and approved by <broker>". Reply-To is the approving broker.
- Each message shows its status: emailed, failed, blocked (domain not allowed), skipped (no buyer email), with **Retry email** and **Add buyer email**. A message cannot be sent twice, even if two people click at once.
- Limits: sending happens inside the approve request (15 s timeout), no background queue, no bounce handling, outbound only. A crash mid-send leaves a message "sending": clear with `UPDATE messages SET delivery_status=NULL WHERE delivery_status='sending'`.

## Deploying
[DEPLOY.md](DEPLOY.md): Docker Compose with automatic HTTPS (Caddy), health check, graceful shutdown, scheduled backups. Settings: `HOST` (default 127.0.0.1), `PORT`, `TRUST_PROXY` (number of reverse proxies in front, so lockouts use real client IPs), `COOKIE_SECURE=1`. `GET /healthz` returns `{"ok":true}` when the database responds. The Docker image itself has not been built in the environment this was written in.

## Tests
`npm test` runs: rules engine, API flow, open-source model path (mock model server), auth and roles, database (constraints, concurrency, JSON import, backup), email (mock relay), operations (health, proxy IPs, backups, shutdown), two-factor (RFC 6238 vectors, replay, lockout, policy), hardening (input validation, malformed cookies and bodies, path traversal, activity-log privacy). `python3 -m unittest discover -s finetune -p "test_*.py"` tests the fine-tuning data scripts.

## Input handling and privacy
- All write endpoints validate types and ranges (ids, prices, floor <= list, discounts, offers, playbook rules, scenarios) and return 400 instead of failing deep inside; text fields are length-limited.
- The UI escapes every value it renders. Hostile data planted directly in the database (bypassing the API) was checked in a browser to render as inert text. That browser check used Playwright and is not part of `npm test`.
- Request bodies over 1 MB get 413. Malformed cookies are ignored. Static files are served only from `public/`.
- The activity log shows sign-in, user and two-factor events to admins only. Failed logins are recorded only for real accounts, so a password typed into the email box is never written to the log.

## Not production-ready yet
- Inventory is mock data and screening is a country-list stub, not a real sanctions/KYC provider.
- No SSO or hardware keys, no password reset by email, no inbound email (buyer replies are not tracked).
- Model calls were only tested against a mock server in this repo, not a live Ollama or Claude instance, and `finetune/train.py` was never run on a GPU.
- Single-server SQLite.
