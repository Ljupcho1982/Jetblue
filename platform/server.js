// Zero-dependency platform server: static UI + JSON API + optional Claude wording.
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
  const { db } = store;
  const user = ctx.user;
  const m = req.method, p = url.pathname.replace(/^\/api\//, '').split('/');
  const b = ['POST', 'PUT'].includes(m) ? await body(req) : {};
  const need = (perm) => { if (!auth.can(user, perm)) throw httpErr(403, 'Not allowed for your role'); };
  const act = (msg) => store.activity(msg, user && user.email);
  const meInfo = () => ({ user: user ? auth.publicUser(user) : null, perms: auth.permsOf(user), needsSetup: db.users.length === 0 });
  const login = (u) => { const t = auth.createSession(db, u.id); store.save(); return { ...{ user: auth.publicUser(u), perms: auth.permsOf(u), needsSetup: false }, __cookie: auth.cookie(t, auth.ABSOLUTE_MS / 1000) }; };

  if (p[0] === 'me' && m === 'GET') return meInfo();
  if (p[0] === 'setup' && m === 'POST') { // first-run only: creates the initial admin
    if (db.users.length) throw httpErr(403, 'Setup already completed');
    if (!auth.validEmail(b.email) || !b.name) throw httpErr(400, 'Valid email and name required');
    const bad = auth.checkPassword(b.password, b.email); if (bad) throw httpErr(400, bad);
    const u = { id: id(), email: b.email.toLowerCase(), name: String(b.name).slice(0, 100), role: 'admin', ...(await auth.hashPassword(b.password)), createdAt: new Date().toISOString() };
    db.users.push(u); store.activity('Admin account created', u.email); return login(u);
  }
  if (p[0] === 'login' && m === 'POST') {
    const email = String(b.email || '').toLowerCase(), key = ctx.ip + '|' + email;
    const wait = auth.lockedFor(key); if (wait) throw httpErr(429, `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`);
    const u = db.users.find((x) => x.email === email && !x.disabled);
    if (!(await auth.verifyPassword(String(b.password || ''), u))) { auth.recordFail(key); store.activity('Failed login', email); store.save(); throw httpErr(401, 'Invalid email or password'); }
    auth.clearFails(key); store.activity('Login', u.email); return login(u);
  }
  if (p[0] === 'logout' && m === 'POST') { auth.endSession(db, ctx.token); store.save(); return { ok: true, __cookie: auth.cookie('', 0) }; }
  if (!user) throw httpErr(401, 'Login required');

  if (p[0] === 'me' && p[1] === 'password' && m === 'POST') {
    if (!(await auth.verifyPassword(String(b.current || ''), user))) throw httpErr(403, 'Current password is wrong');
    const bad = auth.checkPassword(b.next, user.email); if (bad) throw httpErr(400, bad);
    Object.assign(user, await auth.hashPassword(b.next));
    auth.endUserSessions(db, user.id); act('Password changed'); const t = auth.createSession(db, user.id); store.save();
    return { ok: true, __cookie: auth.cookie(t, auth.ABSOLUTE_MS / 1000) };
  }

  if (p[0] === 'users') {
    need('users.manage');
    const admins = () => db.users.filter((x) => x.role === 'admin' && !x.disabled).length;
    if (m === 'GET') return db.users.map(auth.publicUser);
    if (m === 'POST') {
      if (!auth.validEmail(b.email) || !b.name || !auth.ROLES[b.role]) throw httpErr(400, 'Valid email, name and role required');
      if (db.users.some((x) => x.email === b.email.toLowerCase())) throw httpErr(409, 'Email already in use');
      const bad = auth.checkPassword(b.password, b.email); if (bad) throw httpErr(400, bad);
      const u = { id: id(), email: b.email.toLowerCase(), name: String(b.name).slice(0, 100), role: b.role, ...(await auth.hashPassword(b.password)), createdAt: new Date().toISOString() };
      db.users.push(u); act(`User created: ${u.email} (${u.role})`); store.save(); return auth.publicUser(u);
    }
    const t = db.users.find((x) => x.id === p[1]); if (!t) throw httpErr(404, 'user not found');
    const losesAdmin = t.role === 'admin' && !t.disabled && admins() === 1;
    if (m === 'PUT') {
      if (b.role !== undefined && !auth.ROLES[b.role]) throw httpErr(400, 'bad role');
      if (losesAdmin && ((b.role && b.role !== 'admin') || b.disabled === true)) throw httpErr(400, 'Cannot remove the last active admin');
      let revoke = false;
      if (b.role && b.role !== t.role) { t.role = b.role; revoke = true; }
      if (typeof b.disabled === 'boolean' && b.disabled !== !!t.disabled) { t.disabled = b.disabled; revoke = true; }
      if (b.name) t.name = String(b.name).slice(0, 100);
      if (b.password) { const bad = auth.checkPassword(b.password, t.email); if (bad) throw httpErr(400, bad); Object.assign(t, await auth.hashPassword(b.password)); revoke = true; }
      if (revoke) auth.endUserSessions(db, t.id);
      act('User updated: ' + t.email); store.save(); return auth.publicUser(t);
    }
    if (m === 'DELETE') {
      if (t.id === user.id) throw httpErr(400, 'You cannot delete yourself');
      if (losesAdmin) throw httpErr(400, 'Cannot remove the last active admin');
      db.users = db.users.filter((x) => x.id !== t.id); auth.endUserSessions(db, t.id); act('User deleted: ' + t.email); store.save(); return { ok: true };
    }
  }

  if (p[0] === 'state' && m === 'GET') { const st = { inventory: db.inventory, leads: db.leads, deals: db.deals, playbook: db.playbook, learned: db.learned, activity: db.activity, llm: llm.describe() }; return auth.can(user, 'view.full') ? st : redactedState(st); }

  if (p[0] === 'inventory') {
    if (m === 'POST') {
      need('inventory.write');
      const a = { id: b.id || 'AC-' + id(), model: b.model, type: b.type, year: +b.year, hours: +b.hours, seats: +b.seats, rangeNm: +b.rangeNm, location: b.location, listPrice: +b.listPrice, floor: +b.floor, maxDiscountPct: +b.maxDiscountPct, leaseMonthly: +b.leaseMonthly, minLeaseMonthly: +b.minLeaseMonthly, minTermMonths: +b.minTermMonths };
      if (!a.model || !a.listPrice || a.floor > a.listPrice) throw Object.assign(new Error('model and listPrice required; floor must not exceed listPrice'), { status: 400 });
      const i = db.inventory.findIndex((x) => x.id === a.id);
      if (i >= 0) db.inventory[i] = a; else db.inventory.push(a);
      act('Inventory saved: ' + a.id); store.save(); return a;
    }
    if (m === 'DELETE') { need('inventory.delete'); db.inventory = db.inventory.filter((x) => x.id !== p[1]); store.save(); return { ok: true }; }
  }

  if (p[0] === 'leads' && m === 'POST') {
    need('leads.write');
    const req_ = { mode: b.mode, type: b.type, seats: num(b.seats), rangeNm: num(b.rangeNm), maxAge: num(b.maxAge), budget: num(b.budget) };
    const s = Logic.screen({ country: b.country });
    const lead = { id: id(), createdAt: new Date().toISOString(), name: b.name, company: b.company, country: b.country, request: req_, screening: s, status: s.ok ? 'qualified' : 'compliance-hold',
      matches: s.ok ? Logic.matchAircraft(req_, db.inventory).map((x) => ({ aircraftId: x.aircraft.id, score: x.score, reasons: x.reasons })) : [] };
    db.leads.unshift(lead); act(`Lead ${lead.name}: ${lead.status}, ${lead.matches.length} match(es)`); store.save(); return lead;
  }

  if (p[0] === 'deals') {
    need('deals.write');
    if (m === 'POST' && !p[1]) {
      const lead = db.leads.find((l) => l.id === b.leadId); const a = db.inventory.find((x) => x.id === b.aircraftId);
      if (!lead || !a || !lead.screening.ok) throw Object.assign(new Error('invalid lead/aircraft or lead on compliance hold'), { status: 400 });
      const d = { id: id(), leadId: lead.id, buyer: lead.name, company: lead.company, aircraftId: a.id, mode: lead.request.mode, stage: 'negotiating', round: 0, messages: [] };
      db.deals.unshift(d); act(`Deal opened: ${lead.name} / ${a.id}`); store.save(); return d;
    }
    const d = db.deals.find((x) => x.id === p[1]); if (!d) throw Object.assign(new Error('deal not found'), { status: 404 });
    const a = db.inventory.find((x) => x.id === d.aircraftId);
    if (p[2] === 'offer' && m === 'POST') {
      if (d.messages.some((x) => x.status === 'draft')) throw Object.assign(new Error('resolve the pending draft first'), { status: 409 });
      const offer = +b.offer; if (!offer) throw Object.assign(new Error('offer required'), { status: 400 });
      d.round++;
      const decision = Logic.negotiate({ aircraft: a, mode: d.mode, offer, round: d.round, termMonths: num(b.termMonths), rules: db.playbook.rules });
      const w = await llm.wordDraft({ decision, aircraft: a, buyer: { name: d.buyer }, offer, mode: d.mode, playbook: db.playbook, learned: db.learned });
      d.messages.push({ id: id(), role: 'buyer', text: `Offer: ${Logic.fmt(offer)}${d.mode === 'lease' ? '/month' : ''}`, at: new Date().toISOString() });
      d.messages.push({ id: id(), role: 'assistant', status: 'draft', action: decision.action, price: decision.price, flags: decision.flags, note: decision.internalNote, text: w.text, source: w.source, facts: w.facts, original: w.text, at: new Date().toISOString() });
      act(`Draft (${decision.action}) for deal ${d.id}`); store.save(); return d;
    }
    const msg = d.messages.find((x) => x.id === p[3]);
    if (p[2] === 'messages' && msg && p[4] === 'approve' && m === 'POST') {
      msg.text = b.text || msg.text; msg.status = 'sent'; msg.sentAt = new Date().toISOString(); msg.approvedBy = user.email;
      if (msg.action === 'accept') d.stage = 'LOI'; else if (msg.action === 'escalate') d.stage = 'escalated';
      if (msg.text.trim() !== msg.original.trim()) { // learn from broker edits
        db.learned.push({ situation: msg.action + ' (broker-edited)', reply: msg.text }); db.learned = db.learned.slice(-50);
      }
      act(`Approved message on deal ${d.id}` + (msg.text !== msg.original ? ' (edited, saved as example)' : '')); store.save(); return d;
    }
    if (p[2] === 'messages' && msg && p[4] === 'reject' && m === 'POST') { msg.status = 'rejected'; d.round = Math.max(0, d.round - 1); act('Rejected draft on deal ' + d.id); store.save(); return d; }
  }

  if (p[0] === 'playbook') {
    if (m === 'PUT') {
      need('playbook.write');
      const pb = db.playbook, r = b.rules || {};
      for (const k of ['company', 'broker', 'tone', 'systemPrompt']) if (typeof b[k] === 'string') pb[k] = b[k];
      for (const k of Object.keys(Logic.DEFAULT_RULES)) if (r[k] !== undefined) pb.rules[k] = typeof Logic.DEFAULT_RULES[k] === 'number' ? +r[k] : String(r[k]);
      if (Array.isArray(b.examples)) pb.examples = b.examples; if (Array.isArray(b.scenarios)) pb.scenarios = b.scenarios;
      act('Playbook updated'); store.save(); return pb;
    }
    if (p[1] === 'promote' && m === 'POST') {
      need('playbook.write'); // turn a learned example into a permanent one
      const ex = db.learned[+b.index]; if (ex) { db.playbook.examples.push(ex); db.learned.splice(+b.index, 1); store.save(); } return db.playbook;
    }
  }

  if (p[0] === 'eval' && m === 'POST') {
    need('eval.run');
    const rows = db.playbook.scenarios.map((s) => {
      const a = db.inventory.find((x) => x.id === s.aircraftId);
      if (!a) return { name: s.name, pass: false, problems: ['aircraft not found'] };
      const d = Logic.negotiate({ aircraft: a, mode: s.mode, offer: s.offer, round: s.round, termMonths: s.termMonths, rules: db.playbook.rules });
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
  if (p[0] === 'export' && m === 'GET') {
    need('data.export'); // fine-tuning data (chat JSONL) from broker-approved messages
    const sys = db.playbook.systemPrompt, rows = [];
    for (const d of db.deals) for (const x of d.messages) if (x.role === 'assistant' && x.status === 'sent' && x.facts)
      rows.push({ messages: [{ role: 'system', content: sys }, { role: 'user', content: JSON.stringify(x.facts) }, { role: 'assistant', content: x.text }] });
    return { __raw: rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), count: rows.length };
  }
  if (p[0] === 'reset' && m === 'POST') { need('data.reset'); Object.assign(store.db, { inventory: Logic.INVENTORY, leads: [], deals: [], learned: [], activity: [], playbook: store.defaultPlaybook() }); store.save(); return { ok: true }; }
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
      const ctx = { token, user: auth.sessionUser(store.db, token), ip: req.socket.remoteAddress || '' };
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
    send(e.status || 500, { 'content-type': 'application/json' }, JSON.stringify({ error: e.status ? e.message : 'Server error' }));
  }
});

if (require.main === module) {
  const port = process.env.PORT || 3000;
  server.listen(port, '127.0.0.1', () => console.log(`Platform on http://127.0.0.1:${port}  (wording: ${llm.enabled() ? JSON.stringify(llm.describe()) : 'templates (set LLM_PROVIDER=ollama to use an open-source model)'})`));
}
module.exports = server;
