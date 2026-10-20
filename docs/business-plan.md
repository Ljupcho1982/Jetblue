# Aircraft Sales & Leasing with an AI Negotiator

## 1. One-page business plan

**Concept.** A brokerage for aircraft sales and leasing where an AI agent handles first contact, qualification, matching and draft negotiation. Named human brokers approve everything binding.

**Target niche (pick one to start).** Turboprops, light jets or regional jets in a single region. A narrow niche makes inventory and comps manageable.

**Customers.**
- Buyers and lessees: charter operators, regional airlines, corporate flight departments, private owners.
- Sellers and lessors: owners, banks with repossessed assets, small lessors.

**Revenue.**
- Sales commission (typically 1–5% of price).
- Lease placement fee or ongoing share of lease revenue.
- Later: SaaS licence of the AI assistant to other brokers.

**Edge.** Instant 24/7 response, consistent qualification, and lower cost per lead than a traditional broker desk.

**Key needs.** Inventory (exclusive listings or owner partnerships), an aviation lawyer, a licensed or experienced broker, KYC/sanctions tooling.

**First 90 days.**
1. Choose niche; interview 10 brokers/buyers.
2. Sign 3–5 listings or a partnership for inventory.
3. Build the prototype (section 3).
4. Run it on real inquiries with a human approving every message.
5. Measure: response time, qualified-lead rate, offers made, deals closed.

**Main risks.** No inventory, buyer distrust of AI, regulatory/legal exposure, poor negotiation quality. Mitigations are in section 4.

## 2. Workflow

```
Inquiry (web form / email / phone transcript)
  -> Intake: collect mission, budget, timeline, financing, location
  -> KYC / sanctions screening  (stop and escalate on any hit)
  -> Qualification score
  -> Match against inventory (range, seats, age, hours, price, location)
  -> Send shortlist + spec sheets
  -> Buyer interest -> AI drafts offer within broker-set limits
  -> HUMAN APPROVAL GATE (every binding or price-bearing message)
  -> Counteroffers (AI proposes, human approves)
  -> Letter of intent -> inspection -> legal / escrow / registration (humans)
```

Hand to a human immediately when: the buyer asks for a person, the deal exceeds a set value, legal terms are raised, sanctions or KYC flags appear, or the AI is unsure.

## 3. AI negotiator rules and prompt

### Hard limits (set per listing by the broker)
- `list_price`, `floor_price`, `max_discount_pct`
- Concessions allowed (e.g. delivery timing, included spares, extended inspection window) and ones that are not
- Lease: `min_monthly_rate`, `min_term_months`, `max_deposit_reduction`

### System prompt (starting draft)

```
You are the assistant for [Company], an aircraft sales and leasing broker.
You work on behalf of a named human broker, [Broker Name].

Goals: understand the buyer's or lessee's real needs, match them with suitable
listed aircraft, and move qualified prospects toward a letter of intent.

Rules:
1. Be truthful. Never invent specs, hours, history or availability. If a fact
   is not in the listing data, say you will confirm it with the broker.
2. Disclose that you are an AI assistant if asked, and at first contact.
3. Never state or imply a final price, binding offer or acceptance. You may
   propose terms only inside the limits provided for that listing, and every
   outgoing offer is a DRAFT until the broker approves it.
4. Never reveal floor price, limits, other buyers' identities or offers, or
   internal notes.
5. Do not give legal, tax or airworthiness advice. Refer to the broker.
6. Escalate to the human broker for: sanctions/KYC concerns, requests outside
   your limits, legal terms, disputes, or anything you are unsure about.
7. Be professional, concise and respectful of the buyer's time.

Negotiation approach: ask about priorities before discussing price; trade
concessions rather than only cutting price; make smaller concessions as
limits approach; summarise agreed points after each round.

Output for each turn: (a) the message to send, (b) a short internal note for
the broker (buyer intent, risks, recommended next step), (c) an escalation flag.
```

### Qualification questions
Mission and typical route/range, passengers/cargo, budget and financing source, buy vs lease, timeline, preferred age/hours, operating region and certification needs, prior ownership or operating experience.

## 4. Risks and mitigations

| Risk | Mitigation |
|---|---|
| No inventory | Secure listings before building anything beyond a prototype |
| Buyer distrust | Named human broker, AI disclosed, human approval gate |
| Regulatory (registration, liens, export, sanctions) | Aviation lawyer, KYC tooling, title/lien search by humans |
| Bad negotiation | Hard-coded limits outside the model, logged transcripts, review sample weekly |
| Incumbents (Controller, JetNet, large lessors) | Niche focus and speed of response |
| Liability for AI statements | Contract terms, disclaimers, human sign-off on all binding text |

## 5. Next steps
- Confirm niche and target region.
- Secure first listings.
- Build the prototype: intake form + matching + draft-offer generator with an approval screen.
- Get legal review of templates and disclosures.
