// Browser-only stand-in for the server, used by the interactive preview (see build-preview.js).
// It answers the app's /api calls from sample data held in the page and runs the REAL negotiation, matching and
// guardrail code (logic.js). Nothing is saved or sent. Features that need a real server answer "not available".
(function () {
  const L = window.Logic, ME = 'admin@demo.test';
  const id = () => Math.random().toString(16).slice(2, 10), now = () => new Date().toISOString();
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const NOPE = (what) => ({ status: 400, body: { error: `${what} is not available in this preview. It works in the real app.` } });

  const playbook = () => ({
    company: 'Your Aviation Brokers', broker: 'Senior Broker', tone: 'professional, concise, warm',
    systemPrompt: 'You are the assistant for an aircraft sales and leasing broker, working on behalf of a named human broker.\nRules:\n1. Be truthful. Never invent specs, hours, history or availability.\n2. You are an AI assistant; say so if asked.\n3. Never state a final price or binding acceptance. Every offer is a draft until the broker approves it.\n4. Never reveal floor prices, limits, other buyers or internal notes.\n5. No legal, tax or airworthiness advice. Escalate sanctions concerns and anything uncertain.',
    rules: Object.assign({}, L.DEFAULT_RULES),
    examples: [{ situation: 'counter, first round', reply: 'Thank you for your offer. We are keen to find terms that work for both sides. This is subject to contract and broker confirmation.' }, { situation: 'escalate', reply: 'Thank you for your interest. I am bringing in our broker, who will contact you shortly.' }],
    scenarios: [
      { name: 'Fair offer is accepted', aircraftId: 'TP-01', mode: 'buy', offer: 9200000, round: 1, expect: 'accept' },
      { name: 'Low offer gets a counter', aircraftId: 'TP-01', mode: 'buy', offer: 8000000, round: 1, expect: 'counter' },
      { name: 'Far too low escalates', aircraftId: 'TP-01', mode: 'buy', offer: 5000000, round: 1, expect: 'escalate' },
      { name: 'Stalled talks escalate', aircraftId: 'LJ-01', mode: 'buy', offer: 5000000, round: 4, expect: 'escalate' },
      { name: 'Lease below minimum term is not accepted', aircraftId: 'LJ-01', mode: 'lease', offer: 62000, round: 1, termMonths: 12, expect: 'counter' },
      { name: 'Good lease offer, valid term', aircraftId: 'RJ-01', mode: 'lease', offer: 185000, round: 1, termMonths: 60, expect: 'accept' }],
  });
  let db;
  const reset = () => { db = { inventory: clone(L.INVENTORY), leads: [], deals: [], learned: [], activity: [], feedback: [], playbook: playbook() }; };
  const act = (msg) => { db.activity.unshift({ at: now(), msg, who: ME }); db.activity = db.activity.slice(0, 100); };
  const err = (status, error, extra) => ({ status, body: { error, ...(extra || {}) } });
  const aircraft = (aid) => db.inventory.find((a) => a.id === aid);

  // A tiny demo screening list so the review flow can be tried: "Ivan Petrov" is a list match, near spellings need review.
  const lev = (a, b) => { const m = [...Array(b.length + 1).keys()]; for (let i = 1; i <= a.length; i++) { let p = m[0]; m[0] = i; for (let j = 1; j <= b.length; j++) { const t = m[j]; m[j] = Math.min(m[j] + 1, m[j - 1] + 1, p + (a[i - 1] === b[j - 1] ? 0 : 1)); p = t; } } return m[b.length]; };
  function screen(name, company, country) {
    if (!L.screen({ country }).ok) return { ok: false, status: 'hit', reasons: ['Country on the restricted list'], provider: 'builtin' };
    for (const v of [name, company]) {
      const t = L.fold(v).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
      if (t === 'ivan petrov') return { ok: false, status: 'hit', reasons: ['name matches list entry "Petrov, Ivan" (demo list)'], provider: 'builtin' };
      if (t.length >= 5 && lev(t, 'ivan petrov') <= 2 && t !== '') return { ok: false, status: 'review', reasons: ['name is similar to list entry "Petrov, Ivan" (demo list)'], provider: 'builtin' };
    }
    return { ok: true, status: 'clear', reasons: [], provider: 'builtin' };
  }
  const matchesFor = (req) => L.matchAircraft(req, db.inventory).map((x) => ({ aircraftId: x.aircraft.id, score: x.score, reasons: x.reasons }));
  const counts = () => ({ aircraft: db.inventory.length, leads: db.leads.length, leadsQualified: db.leads.filter((l) => l.status === 'qualified').length, deals: db.deals.length,
    dealsNegotiating: db.deals.filter((d) => d.stage === 'negotiating').length, dealsEscalated: db.deals.filter((d) => d.stage === 'escalated').length, dealsLOI: db.deals.filter((d) => d.stage === 'LOI').length,
    draftsPending: db.deals.reduce((n, d) => n + d.messages.filter((m) => m.status === 'draft').length, 0) });

  function editWarnings(msg, text, a, mode) { // same rules as the server
    const offered = msg.facts && msg.facts.buyersOffer ? L.extractAmounts(msg.facts.buyersOffer).map((x) => x.value) : [];
    const facts = a ? [a.year, a.seats, a.rangeNm, a.hours] : [], out = [];
    const v = L.validateMessage(text, { allowed: [msg.price, ...offered, ...facts].filter(Number.isFinite), secrets: [] });
    if (!v.ok) out.push(v.reason === 'binding language' ? 'The text contains binding wording (for example "guarantee").' : `The text states an amount (${(v.reason || '').replace('unapproved amount ', '')}) that is not the drafted price or the buyer's offer.`);
    const floor = a ? (mode === 'lease' ? a.minLeaseMonthly : a.floor) : 0;
    const low = L.extractAmounts(text).filter((t) => (t.currency || t.magnitude || t.value >= 10000) && t.value < floor && !facts.includes(t.value) && !offered.includes(t.value));
    if (low.length) out.push(`It contains ${low[0].raw}, which is below this aircraft's ${mode === 'lease' ? 'minimum lease rate' : 'floor price'}.`);
    return out;
  }

  function newLead(b) {
    if (!b.name) return err(400, 'name required');
    if (!['buy', 'lease'].includes(b.mode)) return err(400, 'mode must be buy or lease');
    const n = (v) => (v === '' || v == null ? undefined : Number(v));
    const request = { mode: b.mode, type: b.type || 'any', seats: n(b.seats), rangeNm: n(b.rangeNm), maxAge: n(b.maxAge), budget: n(b.budget) };
    const s = screen(b.name, b.company, b.country || '');
    const lead = { id: id(), createdAt: now(), name: String(b.name).slice(0, 100), company: b.company || null, email: b.email || null, country: b.country || '', status: s.ok ? 'qualified' : 'compliance-hold', request, screening: s, matches: s.ok ? matchesFor(request) : [] };
    db.leads.unshift(lead); act(`Lead ${lead.id}: ${lead.status}, ${lead.matches.length} match(es)`); return { status: 200, body: lead };
  }
  function offer(d, b) {
    const a = aircraft(d.aircraftId), amt = Number(b.offer), term = b.termMonths ? Number(b.termMonths) : undefined;
    if (d.stage !== 'negotiating') return err(409, 'This deal is no longer negotiating');
    if (d.messages.some((m) => m.status === 'draft')) return err(409, 'resolve the pending draft first');
    if (!Number.isFinite(amt) || amt < 1) return err(400, 'offer must be a number');
    const round = d.round + 1, dec = L.negotiate({ aircraft: a, mode: d.mode, offer: amt, round, termMonths: term, rules: db.playbook.rules });
    const facts = { decision: { action: dec.action, price: dec.price ? L.fmt(dec.price) : null, flags: dec.flags }, buyer: d.buyer, buyersOffer: L.fmt(amt), mode: d.mode, ...(term ? { requestedTermMonths: term } : {}),
      aircraft: { id: a.id, model: a.model, year: a.year, seats: a.seats, rangeNm: a.rangeNm, location: a.location }, mustInclude: db.playbook.rules.disclaimer };
    d.round = round;
    d.messages.push({ id: id(), role: 'buyer', text: `Offer: ${L.fmt(amt)}${d.mode === 'lease' ? '/month' : ''}`, at: now() });
    d.messages.push({ id: id(), role: 'assistant', status: 'draft', action: dec.action, price: dec.price, flags: dec.flags, note: dec.internalNote, text: dec.message, source: 'template', facts, original: dec.message, at: now() });
    act(`Draft (${dec.action}) for deal ${d.id}`); return { status: 200, body: d };
  }
  function newDeal(b) {
    const lead = db.leads.find((l) => l.id === b.leadId), a = aircraft(b.aircraftId);
    if (!lead || !a || !lead.screening.ok) return err(400, 'invalid lead/aircraft or lead on compliance hold');
    const d = { id: id(), leadId: lead.id, buyer: lead.name, company: lead.company, aircraftId: a.id, mode: lead.request.mode, stage: 'negotiating', round: 0, messages: [] };
    db.deals.unshift(d); act(`Deal opened ${d.id} for lead ${lead.id} / ${a.id}`); return { status: 200, body: d };
  }
  const approve = (d, m, b) => {
    if (m.status !== 'draft') return err(409, 'Message is not a pending draft');
    const text = b.text || m.text;
    if (text.trim() !== m.original.trim()) {
      const w = editWarnings(m, text, aircraft(d.aircraftId), d.mode);
      if (w.length && b.confirmPriceChange !== true) return err(409, w.join(' '), { needsConfirm: true });
      if (w.length) act(`Broker confirmed an edited amount on deal ${d.id}`);
      db.learned.push({ situation: m.action + ' (broker-edited)', reply: text });
    }
    m.text = text; m.status = 'sent'; m.approvedBy = ME; m.sentAt = now();
    if (m.action === 'accept') d.stage = 'LOI'; else if (m.action === 'escalate') d.stage = 'escalated';
    act(`Approved message on deal ${d.id}`); return { status: 200, body: d };
  };
  const fold = (s) => L.fold(s);
  const stateBody = () => ({ counts: counts(), inventory: db.inventory, leads: db.leads, deals: db.deals, playbook: db.playbook, learned: db.learned, activity: db.activity.slice(0, 100), llm: { enabled: false }, mail: { enabled: false }, demo: true, screening: { provider: 'builtin' }, currency: L.currency() });

  function route(method, path, body, url) {
    const p = path.split('/'), b = body || {}, q = new URLSearchParams(url.split('?')[1] || '');
    if (p[0] === 'me' && method === 'GET') return { status: 200, body: { user: { id: 'u1', email: ME, name: 'Demo Admin', role: 'admin', twoFactor: false }, perms: ['*'], needsSetup: false, mustEnroll: false, twoFactorPolicy: 'off' } };
    if (p[0] === 'me') return NOPE('Changing your password and two-factor sign-in');
    if (p[0] === 'login' || p[0] === 'setup') return NOPE('Signing in');
    if (p[0] === 'logout') return { status: 200, body: { ok: true } };
    if (p[0] === 'state') return { status: 200, body: stateBody() };
    if (p[0] === 'users') return method === 'GET' && !p[1] ? { status: 200, body: [{ id: 'u1', email: ME, name: 'Demo Admin', role: 'admin', disabled: false, twoFactor: false, createdAt: now() }] } : NOPE('Managing users');
    if (p[0] === 'reset') { reset(); seed(); return { status: 200, body: { ok: true } }; }
    if (p[0] === 'inventory') {
      if (p[1] === 'import') return NOPE('CSV import');
      if (method === 'DELETE') { if (db.deals.some((d) => d.aircraftId === p[1])) return err(409, 'Aircraft has deals and cannot be deleted'); db.inventory = db.inventory.filter((a) => a.id !== p[1]); return { status: 200, body: { ok: true } }; }
      const a = { id: b.id || 'AC-' + id(), model: String(b.model || '').trim(), type: b.type, year: +b.year, hours: +b.hours, seats: +b.seats, rangeNm: +b.rangeNm, location: b.location, listPrice: +b.listPrice, floor: +b.floor, maxDiscountPct: +b.maxDiscountPct, leaseMonthly: +b.leaseMonthly, minLeaseMonthly: +b.minLeaseMonthly, minTermMonths: +b.minTermMonths };
      if (!a.model || !(a.listPrice > 0) || a.floor > a.listPrice) return err(400, 'model and listPrice required; floor must not exceed listPrice');
      const i = db.inventory.findIndex((x) => x.id === a.id); if (i >= 0) db.inventory[i] = a; else db.inventory.push(a); act('Inventory saved: ' + a.id); return { status: 200, body: a };
    }
    if (p[0] === 'leads') {
      if (method === 'POST' && !p[1]) return newLead(b);
      if (p[1] === 'search') { const f = fold(q.get('q') || '').trim(); if (f.length < 2) return err(400, 'Type at least 2 characters'); return { status: 200, body: db.leads.filter((l) => fold(l.name).includes(f) || fold(l.company).includes(f) || fold(l.email).includes(f) || l.id === q.get('q')).slice(0, 50) }; }
      const lead = db.leads.find((l) => l.id === p[1]); if (!lead) return err(404, 'lead not found');
      if (p[2] === 'export') return { status: 200, body: { exportedAt: now(), lead, deals: db.deals.filter((d) => d.leadId === lead.id) } };
      if (p[2] === 'rescreen') { if (lead.screening.override) return err(409, 'This lead was already cleared by a reviewer'); const s = screen(lead.name, lead.company, lead.country); lead.screening = s; lead.status = s.ok ? 'qualified' : 'compliance-hold'; lead.matches = s.ok ? matchesFor(lead.request) : []; return { status: 200, body: lead }; }
      if (p[2] === 'clear') {
        if (lead.screening.ok) return err(409, 'Lead is not on hold'); if (lead.screening.status === 'hit') return err(409, 'A confirmed list match cannot be cleared in this app. Escalate to your compliance officer.');
        const note = String(b.note || '').trim(); if (note.length < 10) return err(400, 'A review note of at least 10 characters is required');
        lead.screening = { ...lead.screening, ok: true, override: { by: ME, note, at: now(), previous: lead.screening.status } }; lead.status = 'qualified'; lead.matches = matchesFor(lead.request); act(`Compliance cleared lead ${lead.id}`); return { status: 200, body: lead };
      }
      if (method === 'PUT') { lead.email = b.email; return { status: 200, body: lead }; }
      if (method === 'DELETE') { const ds = db.deals.filter((d) => d.leadId === lead.id); db.deals = db.deals.filter((d) => d.leadId !== lead.id); db.feedback = db.feedback.filter((f) => !ds.some((d) => d.id === f.dealId)); db.leads = db.leads.filter((l) => l.id !== lead.id); act(`Lead erased: ${lead.id}`); return { status: 200, body: { ok: true, deals: ds.length, messages: ds.reduce((n, d) => n + d.messages.length, 0), scrubbed: 0 } }; }
    }
    if (p[0] === 'deals') {
      if (method === 'POST' && !p[1]) return newDeal(b);
      if (p[1] === 'search') { const f = fold(q.get('q') || '').trim(); if (f.length < 2) return err(400, 'Type at least 2 characters'); return { status: 200, body: db.deals.filter((d) => fold(d.buyer).includes(f) || fold(d.company).includes(f) || fold(d.aircraftId).includes(f) || d.id === q.get('q')).slice(0, 20) }; }
      const d = db.deals.find((x) => x.id === p[1]); if (!d) return err(404, 'deal not found');
      if (p[2] === 'offer') return offer(d, b);
      const m = d.messages.find((x) => x.id === p[3]);
      if (m && p[4] === 'approve') return approve(d, m, b);
      if (m && p[4] === 'reject') { if (m.status !== 'draft') return err(409, 'Message is not a pending draft'); m.status = 'rejected'; d.round = Math.max(0, d.round - 1); act('Rejected draft on deal ' + d.id); return { status: 200, body: d }; }
      if (m && p[4] === 'send') return err(409, 'Email is not configured');
    }
    if (p[0] === 'playbook') {
      if (method === 'PUT') {
        const pb = db.playbook, r = b.rules || {};
        for (const k of ['company', 'broker', 'tone', 'systemPrompt']) if (typeof b[k] === 'string') pb[k] = b[k];
        for (const k of Object.keys(L.DEFAULT_RULES)) if (r[k] !== undefined) pb.rules[k] = typeof L.DEFAULT_RULES[k] === 'number' ? +r[k] : String(r[k]);
        if (Array.isArray(b.examples)) pb.examples = b.examples; if (Array.isArray(b.scenarios)) pb.scenarios = b.scenarios; act('Playbook updated'); return { status: 200, body: pb };
      }
      if (p[1] === 'promote') { const ex = db.learned[+b.index]; if (ex) { db.playbook.examples.push(ex); db.learned.splice(+b.index, 1); } return { status: 200, body: db.playbook }; }
    }
    if (p[0] === 'eval') {
      const rows = db.playbook.scenarios.map((s) => {
        const a = aircraft(s.aircraftId); if (!a) return { name: s.name, pass: false, problems: ['aircraft not found'] };
        const d = L.negotiate({ aircraft: a, mode: s.mode, offer: s.offer, round: s.round, termMonths: s.termMonths, rules: db.playbook.rules }), problems = [];
        if (d.action !== s.expect) problems.push(`expected ${s.expect}, got ${d.action}`);
        const floor = s.mode === 'lease' ? a.minLeaseMonthly : a.floor; if (d.price != null && d.price < floor) problems.push('price below floor');
        const v = L.validateMessage(d.message, { allowed: [s.offer, d.price].filter(Boolean), secrets: [a.floor, a.minLeaseMonthly] }); if (!v.ok) problems.push('message: ' + v.reason);
        return { name: s.name, action: d.action, price: d.price, pass: !problems.length, problems };
      });
      return { status: 200, body: { passed: rows.filter((r) => r.pass).length, total: rows.length, rows } };
    }
    if (p[0] === 'feedback') {
      if (method === 'POST' && !p[1]) {
        const comment = String(b.comment || '').trim(); if (comment.length < 5) return err(400, 'Please describe the problem (at least 5 characters)');
        const f = { id: id(), createdAt: now(), userEmail: ME, kind: b.kind === 'draft' ? 'draft' : 'other', comment, status: 'open' };
        if (f.kind === 'draft') {
          const d = db.deals.find((x) => x.id === b.dealId), m = d && d.messages.find((x) => x.id === b.messageId); if (!m || m.role !== 'assistant') return err(404, 'draft not found');
          f.dealId = d.id; f.messageId = m.id;
          f.snapshot = { aircraftId: d.aircraftId, mode: d.mode, round: Math.max(1, d.messages.filter((x) => x.role === 'buyer' && x.at <= m.at).length - d.messages.filter((x) => x.role === 'assistant' && x.status === 'rejected' && x.at < m.at).length),
            offer: m.facts && m.facts.buyersOffer ? L.extractAmounts(m.facts.buyersOffer)[0].value : undefined, termMonths: m.facts && m.facts.requestedTermMonths, action: m.action, price: m.price, flags: m.flags, source: m.source, text: m.text, status: m.status };
        }
        db.feedback.unshift(f); act(`Feedback ${f.id} (${f.kind})`); return { status: 200, body: { ok: true, id: f.id } };
      }
      if (method === 'GET' && !p[1]) return { status: 200, body: db.feedback.slice().sort((a, b2) => (b2.status === 'open') - (a.status === 'open')) };
      const f = db.feedback.find((x) => x.id === p[1]); if (!f) return err(404, 'feedback not found');
      if (f.status !== 'open') return err(409, 'Already resolved');
      if (p[2] === 'resolve') { Object.assign(f, { status: 'resolved', resolvedBy: ME, resolution: String(b.resolution || '').trim() || 'Resolved' }); return { status: 200, body: { ok: true } }; }
      if (p[2] === 'scenario') {
        const s = f.snapshot; if (!s || !Number.isFinite(s.offer)) return err(400, 'Only flagged drafts can become test scenarios'); if (!['accept', 'counter', 'escalate'].includes(b.expect)) return err(400, 'expect must be accept, counter or escalate');
        db.playbook.scenarios.push({ name: ('Feedback: ' + f.comment).slice(0, 100), aircraftId: s.aircraftId, mode: s.mode, offer: s.offer, round: s.round, ...(s.termMonths ? { termMonths: s.termMonths } : {}), expect: b.expect });
        Object.assign(f, { status: 'resolved', resolvedBy: ME, resolution: 'Added as test scenario (expect ' + b.expect + ')' }); return { status: 200, body: { ok: true, scenarios: db.playbook.scenarios.length } };
      }
    }
    return err(404, 'not found');
  }

  // A few sample deals so every screen has something on it (the real app starts empty or with this same sample fleet).
  function seed() {
    const mk = (name, company, country, mode, req, ac, off, term, approveIt) => { const l = newLead({ name, company, country, mode, ...req }).body; if (!l.screening.ok) return null; const d = newDeal({ leadId: l.id, aircraftId: ac }).body; offer(d, { offer: off, termMonths: term }); const m = d.messages.find((x) => x.status === 'draft'); if (approveIt) approve(d, m, {}); return { d, m }; };
    const first = mk('Elena Vargas', 'Iberia Regional', 'Spain', 'buy', { seats: 60, rangeNm: 700, budget: 9500000 }, 'TP-01', 8000000, undefined, false);
    mk('Tom Becker', 'Becker Charter', 'Germany', 'lease', { seats: 6, budget: 45000 }, 'LJ-03', 44000, 12, false);
    mk('Priya Nair', 'Skyline Air', 'India', 'buy', { seats: 70, budget: 12e6 }, 'TP-01', 9400000, undefined, true);
    mk('Jack Moore', 'Moore Ltd', 'Ireland', 'buy', { seats: 60, budget: 9500000 }, 'TP-01', 4000000, undefined, true);
    newLead({ name: 'Ivan Petrovv', company: 'Volga Air', country: 'Spain', mode: 'buy', seats: 50, budget: 8e6 });
    newLead({ name: 'Dana Lee', country: 'Iran', mode: 'buy', seats: 50 });
    route('POST', 'feedback', { kind: 'draft', dealId: first.d.id, messageId: first.m.id, comment: 'The counter feels too generous for a first round' }, 'feedback');
  }

  reset(); seed();
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, opts) => {
    const u = String(url);
    if (!u.startsWith('/api/')) return realFetch(url, opts);
    let body; try { body = opts && opts.body ? JSON.parse(opts.body) : undefined; } catch { body = undefined; }
    const out = route(((opts && opts.method) || 'GET').toUpperCase(), u.slice(5).split('?')[0], body, u);
    return Promise.resolve(new Response(JSON.stringify(out.body), { status: out.status, headers: { 'content-type': 'application/json' } }));
  };

  // The viewer blocks pop-up dialogs, which the real app uses for short notes and confirmations. Answer them automatically.
  window.prompt = (msg) => (/Type ERASE/i.test(msg) ? 'ERASE' : /accept, counter or escalate/i.test(msg) ? 'escalate' : /Buyer email/i.test(msg) ? 'buyer@example.com' : /counterparty acceptable/i.test(msg) ? 'Preview: checked the registry, this is a different person.' : /resolved/i.test(msg) ? 'Resolved in the preview' : /feedback|wrong with this draft/i.test(msg) ? 'Sample feedback entered automatically in the preview' : 'Preview answer');
  window.confirm = () => true;
  // The viewer also blocks file downloads (CSV template, data export): say so instead of doing nothing.
  // The notice is delayed so it replaces the app's own "Exported" message instead of being overwritten by it.
  const anchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { if (this.hasAttribute('download')) { setTimeout(() => { if (typeof toast === 'function') toast('File downloads work in the real app, not in this preview'); }, 80); return; } return anchorClick.call(this); };
})();
