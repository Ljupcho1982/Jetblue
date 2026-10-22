# Pilot checklist

A two-week trial with one or two brokers and a handful of real (or realistic) deals. The aim is to find out where the drafts, matches and decisions are wrong, using the app's own feedback tools.

## Before you start (one person, about an hour)
- [ ] Deploy per [DEPLOY.md](DEPLOY.md), or run locally with `npm start` for a first look.
- [ ] Create the admin account, turn on two-factor under **Account**, save the recovery codes somewhere safe.
- [ ] Load your aircraft (**Inventory → Import from CSV**). For each, check the private limits: floor price, max discount, minimum lease rate and term. These bound everything the AI can propose.
- [ ] Add your sanctions list (`SANCTIONS_FILE`) or screening provider, and have compliance confirm it is adequate for your business.
- [ ] Invite the pilot brokers (**Users**, role *broker*), each with two-factor on.
- [ ] Set `MAIL_ALLOWED_DOMAINS` to your own domain(s) so no real buyer can be emailed by mistake. Send yourself a test deal first.
- [ ] Decide the model: templates only (default), an open-source model (`LLM_PROVIDER=ollama`), or Claude. Start with templates if unsure; it is the safest.
- [ ] Take a backup and practise one restore (DEPLOY.md).

## Each deal
1. Add the lead (**Leads**). Check the screening result and the suggested aircraft: do they make sense?
2. Open the deal, enter the buyer's offer (and the lease term if leasing).
3. Read the draft before approving. Ask yourself: is the price right? is the tone right? would I send this to a real buyer?
4. If something is wrong, press **Flag a problem** and say what you expected. Do this even if you then fix it by editing, because the flag is how the system learns.
5. Approve (or reject). Edits that introduce a different amount ask for confirmation. That is intended.

## What to watch for
- Drafts that state a price you did not expect, or mention a number that is not the offer or the drafted price.
- Matches that look wrong: aircraft shown that you would never offer, or missing ones you would.
- Escalations that came too early or too late.
- Anything confusing in the screens. Use **Send feedback** on the Dashboard.

## Each week (the admin)
- [ ] Open **Training → Pilot feedback**. For each flagged draft, press **Make test** and say what the decision should have been, then fix the rules or the playbook and re-run the scenarios until they pass. Resolve the item.
- [ ] Check the **Needs attention** list on the Dashboard is empty at the end of each day.
- [ ] Look at the activity log for failed logins or odd entries.
- [ ] Confirm backups are being written and copied off the machine.

## Go / no-go after two weeks
Go on to wider use only if:
- [ ] No draft that reached a buyer contained a wrong or leaked price.
- [ ] Brokers say the drafts save them time, not cost them time.
- [ ] Open feedback is resolved or consciously accepted.
- [ ] Compliance and legal have reviewed screening, privacy handling and the disclosure footer on emails.

## Things this app does not do
Registry or title checks, contracts and e-signature, financing, inspections, escrow, tax, buyer replies by email (they go to the broker's own inbox), several app servers, and single sign-on. Those stay human.
