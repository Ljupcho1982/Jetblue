// Zero-dependency platform server: static UI + JSON API + optional model wording. Data lives in SQLite (store.js).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Logic = require('./logic.js');
const store = require('./store.js');
const llm = require('./llm.js');
const auth = require('./auth.js');

const PUBLIC = path.join(__dirname, 'public');
const PRIVATE_AIRCRAFT = ['floor', 'maxDiscountPct', 'minLeaseMonthly'];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const id = () => crypto.randomUUID().slice(0, 8);
const num = (v) => (v === '' || v == null ? undefined : Number(v));

function body(req) {
  return new Promise((resolve, reject) => {
    let d = ''; req.on('data', (c) => { d += c; if (d.length > 1e6) reject(httpErr(413, 'Request too large')); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(httpErr(400, 'Invalid JSON')); } });
  });
}

const httpErr = (status, message) => Object.assign(new Error(message), { status });

// Viewers see no private limits, draft internals, playbook or learned data.
function redactedState(st) {
  return {
    inventory: st.inventory.map((a) => Object.fromEntries(Object.entries(a).filter(([k]) => !PRIVATE_AIRCRAFT.includes(k)))),
    leads: st.leads,
    deals: st.deals.map((d) => ({ ...d, messages: d.messages.filter((x) => x.role === 'buyer' || x.status === 'sent').map(({ facts, original, note, flags, source, ...x }) => x) })),
    activity: st.activity, playbook: null, learned: [], llm: { enabled: st.llm.enabled },
  };
}

async function api(req, url, ctx) {
  const user = ctx.user;
  const m = req.method, p = url.pathname.replace(/^\/api\//, '').split('/');
  const b = ['POST', 'PUT'].includes(m) ? await body(req) : {};
  const need = (perm) => { if (!auth.can(user, perm)) throw httpErr(403, 'Not allowed for your role'); };
  const act = (msg) => store.activity.add(msg, user && user.email);
  const session = (u) => ({ user: auth.publicUser(u), perms: auth.permsOf(u), needsSetup: false, __cookie: auth.cookie(auth.createSession(u.id), auth.ABSOLUTE_MS / 1000) });

  if (p[0] === 'me' && m === 'GET') return { user: user ? auth.publicUser(user) : null, perms: auth.permsOf(user), needsSetup: store.users.count() === 0 };
  if (p[0] === 'setup' && m === 'POST') { // first-run only: creates the initial admin
    if (store.users.count()) throw httpErr(403, 'Setup already completed');
    if (!auth.validEmail(b.email) || !b.name) throw httpErr(400, 'Valid email and name required');
    const bad = auth.checkPassword(b.password, b.email); if (bad) throw httpErr(400, bad);
    const u = { id: id(), email: b.email.toLowerCase(), name: String(b.name).slice(0, 100), role: 'admin', ...(await auth.hashPassword(b.password)), createdAt: new Date().toISOString() };
    store.tx(() => { if (store.users.count()) throw httpErr(403, 'Setup already completed'); store.users.insert(u); store.activity.add('Admin account created', u.email); });
    return session(u);
  }
  if (p[0] === 'login' && m === 'POST') {
    const email = String(b.email || '').toLowerCase(), key = ctx.ip + '|' + email;
    const wait = auth.lockedFor(key); if (wait) throw httpErr(429, `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`);
    const found = store.users.byEmail(email), u = found && !found.disabled ? found : undefined;
    if (!(await auth.verifyPassword(String(b.password || ''), u))) { auth.recordFail(key); store.activity.add('Failed login', email); throw httpErr(401, 'Invalid email or password'); }
    auth.clearFails(key); store.activity.add('Login', u.email); return session(u);
  }
  if (p[0] === 'logout' && m === 'POST') { auth.endSession(ctx.token); return { ok: true, __cookie: auth.cookie('', 0) }; }
  if (!user) throw httpErr(401, 'Login required');

  if (p[0] === 'me' && p[1] === 'password' && m === 'POST') {
    if (!(await auth.verifyPassword(String(b.current || ''), user))) throw httpErr(403, 'Current password is wrong');
    const bad = auth.checkPassword(b.next, user.email); if (bad) throw httpErr(400, bad);
    const pw = await auth.hashPassword(b.next);
    store.tx(() => { store.users.update(user.id, pw); auth.endUserSessions(user.id); act('Password changed'); });
    return session(store.users.byId(user.id));
  }

  if (p[0] === 'users') {
    need('users.manage');
    if (m === 'GET' && !p[1]) return store.users.list().map(auth.publicUser);
    if (m === 'POST' && !p[1]) {
      if (!auth.validEmail(b.email) || !b.name || !auth.ROLES[b.role]) throw httpErr(400, 'Valid email, name and role required');
      const bad = auth.checkPassword(b.password, b.email); if (bad) throw httpErr(400, bad);
      const u = { id: id(), email: b.email.toLowerCase(), name: String(b.name).slice(0, 100), role: b.role, ...(await auth.hashPassword(b.password)), createdAt: new Date().toISOString() };
      store.tx(() => { if (store.users.byEmail(u.email)) throw httpErr(409, 'Email already in use'); store.users.insert(u); act(`User created: ${u.email} (${u.role})`); });
      return auth.publicUser(u);
    }
    if (!store.users.byId(p[1])) throw httpErr(404, 'user not found');
    if (m === 'PUT') {
      if (b.role !== undefined && !auth.ROLES[b.role]) throw httpErr(400, 'bad role');
      let pw = null;
      if (b.password) { const bad = auth.checkPassword(b.password, store.users.byId(p[1]).email); if (bad) throw httpErr(400, bad); pw = await auth.hashPassword(b.password); }
      return store.tx(() => { // re-read inside the transaction so the last-admin check cannot race
        const t = store.users.byId(p[1]); if (!t) throw httpErr(404, 'user not found');
        const losesAdmin = t.role === 'admin' && !t.disabled && store.users.activeAdmins() === 1;
        if (losesAdmin && ((b.role && b.role !== 'admin') || b.disabled === true)) throw httpErr(400, 'Cannot remove the last active admin');
        const f = {}; let revoke = false;
        if (b.role && b.role !== t.role) { f.role = b.role; revoke = true; }
        if (typeof b.disabled === 'boolean' && b.disabled !== t.disabled) { f.disabled = b.disabled; revoke = true; }
        if (b.name) f.name = String(b.name).slice(0, 100);
        if (pw) { Object.assign(f, pw); revoke = true; }
        store.users.update(t.id, f); if (revoke) auth.endUserSessions(t.id);
        act('User updated: ' + t.email); return auth.publicUser(store.users.byId(t.id));
      });
    }
    if (m === 'DELETE') {
      return store.tx(() => {
        const t = store.users.byId(p[1]); if (!t) throw httpErr(404, 'user not found');
        if (t.id === user.id) throw httpErr(400, 'You cannot delete yourself');
        if (t.role === 'admin' && !t.disabled && store.users.activeAdmins() === 1) throw httpErr(400, 'Cannot remove the last active admin');
        store.users.delete(t.id); act('User deleted: ' + t.email); return { ok: true };
      });
    }
  }

  if (p[0] === 'state' && m === 'GET') {
    const st = { inventory: store.aircraft.list(), leads: store.leads.list(), deals: store.deals.list(), playbook: store.playbook.get(), learned: store.learned.list(), activity: store.activity.recent(), llm: llm.describe() };
    return auth.can(user, 'view.full') ? st : redactedState(st);
  }

  if (p[0] === 'inventory') {
    if (m === 'POST') {
      need('inventory.write');
      const a = { id: b.id || 'AC-' + id(), model: b.model, type: b.type, year: +b.year, hours: +b.hours, seats: +b.seats, rangeNm: +b.rangeNm, location: b.location, listPrice: +b.listPrice, floor: +b.floor, maxDiscountPct: +b.maxDiscountPct, leaseMonthly: +b.leaseMonthly, minLeaseMonthly: +b.minLeaseMonthly, minTermMonths: +b.minTermMonths };
      if (!a.model || !a.listPrice || a.floor > a.listPrice) throw httpErr(400, 'model and listPrice required; floor must not exceed listPrice');
      store.aircraft.upsert(a); act('Inventory saved: ' + a.id); return a;
    }
    if (m === 'DELETE') {
      need('inventory.delete');
      try { store.aircraft.delete(p[1]); } catch (e) { if (/FOREIGN KEY/i.test(e.message)) throw httpErr(409, 'Aircraft has deals and cannot be deleted'); throw e; }
      act('Inventory deleted: ' + p[1]); return { ok: true };
    }
  }

  if (p[0] === 'leads' && m === 'POST') {
    need('leads.write');
    const request = { mode: b.mode, type: b.type, seats: num(b.seats), rangeNm: num(b.rangeNm), maxAge: num(b.maxAge), budget: num(b.budget) };
    const screening = Logic.screen({ country: b.country });
    const lead = { id: id(), createdAt: new Date().toISOString(), name: b.name, company: b.company, country: b.country, request, screening, status: screening.ok ? 'qualified' : 'compliance-hold',
      matches: screening.ok ? Logic.matchAircraft(request, store.aircraft.list()).map((x) => ({ aircraftId: x.aircraft.id, score: x.score, reasons: x.reasons })) : [] };
    if (!lead.name) throw httpErr(400, 'name required');
    store.tx(() => { store.leads.insert(lead); act(`Lead ${lead.name}: ${lead.status}, ${lead.matches.length} match(es)`); });
    return lead;
  }

  if (p[0] === 'deals') {
    need('deals.write');
    if (m === 'POST' && !p[1]) {
      const lead = store.leads.get(b.leadId), a = store.aircraft.get(b.aircraftId);
      if (!lead || !a || !lead.screening.ok) throw httpErr(400, 'invalid lead/aircraft or lead on compliance hold');
      const d = { id: id(), leadId: lead.id, buyer: lead.name, company: lead.company, aircraftId: a.id, mode: lead.request.mode, stage: 'negotiating' };
      store.tx(() => { store.deals.insert(d); act(`Deal opened: ${lead.name} / ${a.id}`); });
      return store.deals.get(d.id);
    }
    const d = store.deals.get(p[1]); if (!d) throw httpErr(404, 'deal not found');
    const a = store.aircraft.get(d.aircraftId);
    if (p[2] === 'offer' && m === 'POST') {
      if (d.stage !== 'negotiating') throw httpErr(409, 'This deal is no longer negotiating');
      if (d.messages.some((x) => x.status === 'draft')) throw httpErr(409, 'resolve the pending draft first');
      const offer = +b.offer; if (!offer) throw httpErr(400, 'offer required');
      const round = d.round + 1, playbook = store.playbook.get();
      const decision = Logic.negotiate({ aircraft: a, mode: d.mode, offer, round, termMonths: num(b.termMonths), rules: playbook.rules });
      const w = await llm.wordDraft({ decision, aircraft: a, buyer: { name: d.buyer }, offer, mode: d.mode, playbook, learned: store.learned.list() });
      try {
        store.tx(() => { // the model call above can take seconds; only commit if the deal did not move meanwhile
          if (!store.deals.advanceRound(d.id, d.round)) throw httpErr(409, 'Deal changed while drafting, try again');
          store.deals.addBuyerMessage(d.id, id(), `Offer: ${Logic.fmt(offer)}${d.mode === 'lease' ? '/month' : ''}`);
          store.deals.addDraft(d.id, { id: id(), action: decision.action, price: decision.price, flags: decision.flags, note: decision.internalNote, text: w.text, source: w.source, facts: w.facts, original: w.text });
          act(`Draft (${decision.action}) for deal ${d.id}`);
        });
      } catch (e) { if (/UNIQUE/i.test(e.message)) throw httpErr(409, 'resolve the pending draft first'); throw e; }
      return store.deals.get(d.id);
    }
    const msg = p[2] === 'messages' ? store.deals.message(d.id, p[3]) : null;
    if (msg && p[4] === 'approve' && m === 'POST') {
      if (msg.status !== 'draft') throw httpErr(409, 'Message is not a pending draft');
      const text = String(b.text || msg.text);
      store.tx(() => {
        store.deals.approve(msg.id, text, user.email);
        if (msg.action === 'accept') store.deals.setStage(d.id, 'LOI'); else if (msg.action === 'escalate') store.deals.setStage(d.id, 'escalated');
        const edited = text.trim() !== msg.original.trim();
        if (edited) store.learned.add({ situation: msg.action + ' (broker-edited)', reply: text }); // learn from broker edits
        act(`Approved message on deal ${d.id}` + (edited ? ' (edited, saved as example)' : ''));
      });
      return store.deals.get(d.id);
    }
    if (msg && p[4] === 'reject' && m === 'POST') {
      if (msg.status !== 'draft') throw httpErr(409, 'Message is not a pending draft');
      store.tx(() => { store.deals.reject(msg.id); store.deals.rewindRound(d.id); act('Rejected draft on deal ' + d.id); });
      return store.deals.get(d.id);
    }
  }

  if (p[0] === 'playbook') {
    if (m === 'PUT') {
      need('playbook.write');
      const pb = store.playbook.get(), r = b.rules || {};
      for (const k of ['company', 'broker', 'tone', 'systemPrompt']) if (typeof b[k] === 'string') pb[k] = b[k];
      for (const k of Object.keys(Logic.DEFAULT_RULES)) if (r[k] !== undefined) pb.rules[k] = typeof Logic.DEFAULT_RULES[k] === 'number' ? +r[k] : String(r[k]);
      if (Array.isArray(b.examples)) pb.examples = b.examples; if (Array.isArray(b.scenarios)) pb.scenarios = b.scenarios;
      store.tx(() => { store.playbook.set(pb); act('Playbook updated'); });
      return pb;
    }
    if (p[1] === 'promote' && m === 'POST') { // turn a learned example into a permanent one
      need('playbook.write');
      return store.tx(() => { const pb = store.playbook.get(), ex = store.learned.takeAt(+b.index); if (ex) { pb.examples.push(ex); store.playbook.set(pb); } return pb; });
    }
  }

  if (p[0] === 'eval' && m === 'POST') {
    need('eval.run');
    const pb = store.playbook.get();
    const rows = pb.scenarios.map((s) => {
      const a = store.aircraft.get(s.aircraftId);
      if (!a) return { name: s.name, pass: false, problems: ['aircraft not found'] };
      const d = Logic.negotiate({ aircraft: a, mode: s.mode, offer: s.offer, round: s.round, termMonths: s.termMonths, rules: pb.rules });
      const problems = [];
      if (d.action !== s.expect) problems.push(`expected ${s.expect}, got ${d.action}`);
      const floor = s.mode === 'lease' ? a.minLeaseMonthly : a.floor;
      if (d.price != null && d.price < floor) problems.push('price below floor');
      if (d.action === 'accept' && d.flags.length) problems.push('accepted despite flags');
      const v = Logic.validateMessage(d.message, { allowed: [s.offer, d.price].filter(Boolean), secrets: [a.floor, a.minLeaseMonthly] });
      if (!v.ok) problems.push('message: ' + v.reason);
      return { name: s.name, action: d.action, price: d.price, pass: !problems.length, problems };
    });
    return { passed: rows.filter((r) => r.pass).length, total: rows.length, rows };
  }

  if (p[0] === 'export' && m === 'GET') { // fine-tuning data (chat JSONL) from broker-approved messages
    need('data.export');
    const sys = store.playbook.get().systemPrompt, rows = [];
    for (const d of store.deals.list()) for (const x of d.messages) if (x.role === 'assistant' && x.status === 'sent' && x.facts)
      rows.push({ messages: [{ role: 'system', content: sys }, { role: 'user', content: JSON.stringify(x.facts) }, { role: 'assistant', content: x.text }] });
    return { __raw: rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), count: rows.length };
  }
  if (p[0] === 'reset' && m === 'POST') { need('data.reset'); store.reset(); store.activity.add('Demo data reset', user.email); return { ok: true }; }
  throw httpErr(404, 'not found');
}

const SECURITY = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (status, headers, data) => { res.writeHead(status, { ...SECURITY, ...headers }); res.end(data); };
  try {
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET') { // CSRF defence in depth on top of SameSite=Strict
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw httpErr(403, 'Cross-origin request blocked');
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw httpErr(415, 'JSON required');
      }
      const token = auth.parseCookies(req.headers.cookie).sid;
      const ctx = { token, user: auth.sessionUser(token), ip: req.socket.remoteAddress || '' };
      const out = await api(req, url, ctx);
      if (out && out.__raw !== undefined) return send(200, { 'content-type': 'application/x-ndjson', 'content-disposition': 'attachment; filename=finetune.jsonl', 'x-example-count': String(out.count), 'cache-control': 'no-store' }, out.__raw);
      const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
      if (out && out.__cookie !== undefined) { headers['set-cookie'] = out.__cookie; delete out.__cookie; }
      return send(200, headers, JSON.stringify(out));
    }
    const f = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return send(404, {}, 'not found');
    send(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }, fs.readFileSync(f));
  } catch (e) {
    if (!e.status) console.error(e);
    send(e.status || 500, { 'content-type': 'application/json' }, JSON.stringify({ error: e.status ? e.message : 'Server error' }));
  }
});

if (require.main === module) {
  const port = process.env.PORT || 3000;
  server.listen(port, '127.0.0.1', () => console.log(`Platform on http://127.0.0.1:${port}  (wording: ${llm.enabled() ? JSON.stringify(llm.describe()) : 'templates (set LLM_PROVIDER=ollama to use an open-source model)'})`));
}
module.exports = server;
