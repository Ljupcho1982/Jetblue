# Aircraft Deal Platform

A web platform for brokers who sell and lease aircraft. An AI assistant qualifies buyers, proposes counter-offers inside limits the broker sets, and drafts replies. A human broker approves every message before it is sent.

- **[platform/](platform/README.md)**: the application (Node 22, no npm dependencies, SQLite). Start here.
- **[platform/PILOT.md](platform/PILOT.md)**: a two-week pilot checklist (setup, per-deal routine, weekly review, go/no-go).
- **[platform/DEPLOY.md](platform/DEPLOY.md)**: running it for real (Docker, HTTPS, backups).
- **[platform/finetune/](platform/finetune/README.md)**: optional fine-tuning of an open-source model on your brokers' approved replies.
- **[docs/business-plan.md](docs/business-plan.md)**: the original business plan and negotiation rules this was built from.

Try it:

```
cd platform
npm start        # http://127.0.0.1:3000, then create the admin account
npm test         # 16 test suites
```

What it does: inventory with private price limits, lead intake with counterparty screening, AI-drafted negotiation with broker approval, email to buyers, roles and two-factor sign-in, CSV inventory import, audit log, backups, and a training area to tune the assistant.

Status: working and tested against mocks. Not yet exercised against a live model, a real email provider, a built Docker image, or a GPU training run. Screening is a first gate, not a compliance programme. See the "Not production-ready yet" section of the platform README before using real customer data.
