// Zero-dependency platform server: static UI + JSON API + optional model wording. Data lives in SQLite (store.js).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Logic = require('./logic.js');
const store = require('./store.js');
const llm = require('./llm.js');
const auth = require('./auth.js');
const mailer = require('./mailer.js');
const { parseCsv } = require('./csv.js');
const screening = require('./screening.js');

const PUBLIC = path.join(__dirname, 'public');
// TRUST_PROXY=<number of reverse proxies in front>. With 0 the socket address is used. Behind a proxy, take the
// address the nearest trusted proxy appended to X-Forwarded-For, so login lockouts are per user, not per proxy.
const TRUST_PROXY = Math.max(0, parseInt(process.env.TRUST_PROXY || '0', 10) || 0);
function clientIp(req) {
  const sock = req.socket.remoteAddress || '';
  if (!TRUST_PROXY) return sock;
  const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return hops[hops.length - TRUST_PROXY] || sock;
}
const PRIVATE_AIRCRAFT = ['floor', 'maxDiscountPct', 'minLeaseMonthly'];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const id = () => crypto.randomUUID().slice(0, 8);
const DEMO = () => process.env.SEED_DEMO !== '0';
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const str = (x, max) => String(x ?? '').trim().slice(0, max);
function numIn(x, min, max, label) {
  const n = Number(x);
  if (x === '' || x == null || !Number.isFinite(n) || n < min || n > max) throw httpErr(400, `${label} must be a number between ${min} and ${max}`);
  return n;
}
const optNum = (x, min, max, label) => (x === '' || x == null ? undefined : numIn(x, min, max, label));
const AUTH_EVENT = /^(Login|Failed|Recovery|Two-factor|Password|User |Admin account|Demo data)/; // visible to admins only
const num = (v) => (v === '' || v == null ? undefined : Number(v));

function body(req) {
  return new Promise((resolve, reject) => {
    let d = '', tooBig = false;
    req.on('data', (c) => { if (tooBig) return; d += c; if (d.length > 1e6) { tooBig = true; d = ''; reject(httpErr(413, 'Request too large')); } }); // keep draining so the response can be delivered
    req.on('end', () => { if (tooBig) return; try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(httpErr(400, 'Invalid JSON')); } });
  });
}

const httpErr = (status, message) => Object.assign(new Error(message), { status });

// Validates one aircraft record (API form or CSV row). Throws a 400 describing the first problem.
function parseAircraft(b) {
  if (b.id && !ID_RE.test(String(b.id))) throw httpErr(400, 'id may contain only letters, digits, - and _ (max 40)');
  const listPrice = numIn(b.listPrice, 1, 1e10, 'listPrice'), leaseMonthly = numIn(b.leaseMonthly, 0, 1e8, 'leaseMonthly');
  const a = { id: b.id ? String(b.id) : 'AC-' + id(), model: str(b.model, 100), type: str(b.type, 40), year: numIn(b.year, 1950, 2100, 'year'), hours: numIn(b.hours, 0, 1e6, 'hours'),
    seats: numIn(b.seats, 0, 1000, 'seats'), rangeNm: numIn(b.rangeNm, 0, 20000, 'rangeNm'), location: str(b.location, 100), listPrice, floor: numIn(b.floor, 0, listPrice, 'floor (must not exceed listPrice)'),
    maxDiscountPct: numIn(b.maxDiscountPct, 0, 100, 'maxDiscountPct'), leaseMonthly, minLeaseMonthly: numIn(b.minLeaseMonthly, 0, leaseMonthly, 'minLeaseMonthly (must not exceed leaseMonthly)'), minTermMonths: numIn(b.minTermMonths, 0, 600, 'minTermMonths') };
  if (!a.model) throw httpErr(400, 'model required');
  return a;
}

// CSV import. Header names are matched ignoring case, spaces and underscores ("range_nm" = "rangeNm").
const CSV_COLUMNS = ['id', 'model', 'type', 'year', 'hours', 'seats', 'rangeNm', 'location', 'listPrice', 'floor', 'maxDiscountPct', 'leaseMonthly', 'minLeaseMonthly', 'minTermMonths'];
const CSV_OPTIONAL = new Set(['id']);
function importInventory(csv, dryRun) {
  if (typeof csv !== 'string' || !csv.trim()) throw httpErr(400, 'csv text required');
  let parsed; try { parsed = parseCsv(csv); } catch (e) { throw httpErr(400, e.message); }
  if (parsed.length < 2) throw httpErr(400, 'CSV needs a header row and at least one aircraft row');
  if (parsed.length - 1 > 500) throw httpErr(400, 'At most 500 aircraft per import');
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, ''), byNorm = Object.fromEntries(CSV_COLUMNS.map((c) => [norm(c), c]));
  const cols = parsed[0].cells.map((h) => byNorm[norm(h)] || null);
  const missing = CSV_COLUMNS.filter((c) => !CSV_OPTIONAL.has(c) && !cols.includes(c));
  if (missing.length) throw httpErr(400, 'Missing columns: ' + missing.join(', '));
  const seen = new Set(), rows = [];
  for (const { line, cells } of parsed.slice(1)) {
    const rec = {}; cols.forEach((c, i) => { if (c) rec[c] = (cells[i] ?? '').trim().replace(/^\$/, '').replace(/(?<=\d),(?=\d{3}(\D|$))/g, ''); });
    try {
      const a = parseAircraft(rec);
      if (seen.has(a.id) && rec.id) throw httpErr(400, 'duplicate id ' + a.id + ' in this file');
      seen.add(a.id);
      rows.push({ line, status: store.aircraft.get(a.id) ? 'update' : 'create', id: a.id, model: a.model, aircraft: a });
    } catch (e) { if (!e.status) throw e; rows.push({ line, status: 'error', error: e.message, model: rec.model || '' }); }
  }
  const errors = rows.filter((r) => r.status === 'error').length;
  const result = { dryRun: !!dryRun, total: rows.length, created: rows.filter((r) => r.status === 'create').length, updated: rows.filter((r) => r.status === 'update').length, errors, rows: rows.map(({ aircraft, ...r }) => r) };
  if (dryRun) return result;
  if (errors) throw Object.assign(httpErr(400, `${errors} row(s) have errors; nothing was imported`), { details: result });
  return { rows, result };
}

// Viewers see no private limits, draft internals, playbook or learned data.
function redactedState(st) {
  return {
    inventory: st.inventory.map((a) => Object.fromEntries(Object.entries(a).filter(([k]) => !PRIVATE_AIRCRAFT.includes(k)))),
    leads: st.leads.map(({ email, screening: s, ...l }) => ({ ...l, screening: { ok: s.ok, status: s.status } })),
    deals: st.deals.map((d) => ({ ...d, messages: d.messages.filter((x) => x.role === 'buyer' || x.status === 'sent').map(({ facts, original, note, flags, source, deliveryError, ...x }) => x) })),
    activity: st.activity, playbook: null, learned: [], llm: { enabled: st.llm.enabled }, mail: { enabled: st.mail.enabled },
  };
}

// Sends an approved message to the buyer. Never throws: the outcome is recorded on the message.
async function deliver(deal, messageId, approver) {
  if (!mailer.enabled()) return; // delivery_status stays empty: nothing was attempted
  const msg = store.deals.message(deal.id, messageId);
  if (!msg || msg.status !== 'sent') return;
  const lead = store.leads.get(deal.leadId), a = store.aircraft.get(deal.aircraftId);
  if (!lead.email) { if (!store.deals.claimDelivery(messageId)) return; store.deals.setDelivery(messageId, 'skipped', 'No buyer email on this lead'); return; }
  if (!store.deals.claimDelivery(messageId)) return; // someone else is sending, or it already went out
  const company = store.playbook.get().company;
  const text = `${msg.text}\n\n--\n${company}. This message was drafted with AI assistance and approved by ${approver.name}.`;
  try {
    const r = await mailer.send({ to: lead.email, subject: `Re: ${a ? a.model + ' (' + a.id + ')' : 'your enquiry'}`, text, replyTo: approver.email });
    if (r.ok) { store.deals.setDelivery(messageId, 'sent'); store.activity.add(`Emailed buyer on deal ${deal.id}`, approver.email); }
    else { store.deals.setDelivery(messageId, 'blocked', r.error); store.activity.add(`Email blocked on deal ${deal.id}: ${r.error}`, approver.email); }
  } catch (e) { store.deals.setDelivery(messageId, 'failed', e.message); store.activity.add(`Email failed on deal ${deal.id}`, approver.email); }
}

async function api(req, url, ctx) {
  const user = ctx.user;
  const m = req.method, p = url.pathname.replace(/^\/api\//, '').split('/');
  const b = ['POST', 'PUT'].includes(m) ? await body(req) : {};
  const need = (perm) => { if (!auth.can(user, perm)) throw httpErr(403, 'Not allowed for your role'); };
  const act = (msg) => store.activity.add(msg, user && user.email);
  const session = (u) => ({ user: auth.publicUser(u), perms: auth.permsOf(u), needsSetup: false, __cookie: auth.cookie(auth.createSession(u.id), auth.ABSOLUTE_MS / 1000) });

  // Verifies a TOTP or recovery code for u and consumes it (TOTP steps cannot be replayed, recovery codes are single use).
  const secondFactor = (u, code) => {
    code = String(code || '').trim();
    if (auth.isRecoveryFormat(code)) {
      const h = auth.hashCode(code); if (!u.recoveryCodes.includes(h)) return false;
      store.users.update(u.id, { recoveryCodes: u.recoveryCodes.filter((x) => x !== h) }); store.activity.add('Recovery code used', u.email); return true;
    }
    const step = auth.verifyTotp(auth.openSecret(u.totpSecret), code, u.lastTotpStep);
    if (!step) return false; store.users.update(u.id, { lastTotpStep: step }); return true;
  };

  if (p[0] === 'me' && m === 'GET') return { user: user ? auth.publicUser(user) : null, perms: auth.permsOf(user), needsSetup: store.users.count() === 0, mustEnroll: auth.mustEnroll(user), twoFactorPolicy: auth.requirement() };
  if (p[0] === 'setup' && m === 'POST') { // first-run only: creates the initial admin
    if (store.users.count()) throw httpErr(403, 'Setup already completed');
    if (!auth.validEmail(b.email) || !b.name) throw httpErr(400, 'Valid email and name required');
    const bad = auth.checkPassword(b.password, b.email); if (bad) throw httpErr(400, bad);
    const u = { id: id(), email: b.email.toLowerCase(), name: String(b.name).slice(0, 100), role: 'admin', ...(await auth.hashPassword(b.password)), createdAt: new Date().toISOString() };
    store.tx(() => { if (store.users.count()) throw httpErr(403, 'Setup already completed'); store.users.insert(u); store.activity.add('Admin account created', u.email); });
    return session(u);
  }
  if (p[0] === 'login' && p[1] === '2fa' && m === 'POST') {
    const t = auth.ticketFor(b.ticket); if (!t) throw httpErr(401, 'Sign-in expired. Please start again.');
    const wait = auth.lockedFor(t.key); if (wait) throw httpErr(429, `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`);
    const u = store.users.byId(t.userId); if (!u || u.disabled || !u.totpEnabled) throw httpErr(401, 'Sign-in expired. Please start again.');
    if (!secondFactor(u, b.code)) { auth.failTicket(t.id); auth.recordFail(t.key); store.activity.add('Failed two-factor code', u.email); throw httpErr(401, 'Invalid code'); }
    auth.dropTicket(t.id); auth.clearFails(t.key); store.activity.add('Login (2FA)', u.email); return session(u);
  }
  if (p[0] === 'login' && m === 'POST') {
    const email = String(b.email || '').toLowerCase(), key = ctx.ip + '|' + email;
    const wait = auth.lockedFor(key); if (wait) throw httpErr(429, `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`);
    const found = store.users.byEmail(email), u = found && !found.disabled ? found : undefined;
    if (!(await auth.verifyPassword(String(b.password || ''), u))) { auth.recordFail(key); if (found) store.activity.add('Failed login', email); throw httpErr(401, 'Invalid email or password'); }
    if (u.totpEnabled) return { needs2fa: true, ticket: auth.createTicket(u.id, key) }; // lockout counter is cleared only after the second factor
    auth.clearFails(key); store.activity.add('Login', u.email); return session(u);
  }
  if (p[0] === 'logout' && m === 'POST') { auth.endSession(ctx.token); return { ok: true, __cookie: auth.cookie('', 0) }; }
  if (!user) throw httpErr(401, 'Login required');
  if (auth.mustEnroll(user) && p[0] !== 'me') throw httpErr(403, 'Two-factor setup is required before you can continue');

  if (p[0] === 'me' && p[1] === '2fa' && m === 'POST') {
    if (p[2] === 'setup') {
      if (user.totpEnabled) throw httpErr(409, 'Two-factor is already on');
      const secret = auth.newSecret(); store.users.update(user.id, { totpSecret: auth.sealSecret(secret) });
      return { secret, uri: auth.otpauthUri(secret, user.email) };
    }
    if (p[2] === 'enable') {
      if (user.totpEnabled) throw httpErr(409, 'Two-factor is already on');
      if (!user.totpSecret) throw httpErr(400, 'Start setup first');
      const step = auth.verifyTotp(auth.openSecret(user.totpSecret), String(b.code || '').trim(), 0);
      if (!step) throw httpErr(400, 'That code is not valid. Check the time on your phone and try the next code.');
      const codes = auth.newRecoveryCodes();
      store.tx(() => { store.users.update(user.id, { totpEnabled: true, lastTotpStep: step, recoveryCodes: codes.map(auth.hashCode) }); act('Two-factor enabled'); });
      return { ok: true, recoveryCodes: codes };
    }
    if (p[2] === 'disable' || p[2] === 'recovery') { // both need the password and a current second factor
      if (!user.totpEnabled) throw httpErr(409, 'Two-factor is not on');
      if (p[2] === 'disable' && (auth.requirement() === 'all' || (auth.requirement() === 'admin' && user.role === 'admin'))) throw httpErr(400, 'Two-factor is required for your role');
      if (!(await auth.verifyPassword(String(b.password || ''), user))) throw httpErr(403, 'Password is wrong');
      if (!secondFactor(user, b.code)) throw httpErr(403, 'Invalid code');
      if (p[2] === 'disable') { store.tx(() => { store.users.update(user.id, { totpEnabled: false, totpSecret: null, recoveryCodes: [], lastTotpStep: 0 }); act('Two-factor disabled'); }); return { ok: true }; }
      const codes = auth.newRecoveryCodes(); store.users.update(user.id, { recoveryCodes: codes.map(auth.hashCode) }); act('Recovery codes regenerated'); return { ok: true, recoveryCodes: codes };
    }
  }
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
        if (b.resetTwoFactor === true) { Object.assign(f, { totpEnabled: false, totpSecret: null, recoveryCodes: [], lastTotpStep: 0 }); revoke = true; }
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
    const st = { inventory: store.aircraft.list(), leads: store.leads.list(), deals: store.deals.list(), playbook: store.playbook.get(), learned: store.learned.list(), activity: store.activity.recent(), llm: llm.describe(), mail: mailer.describe(), demo: DEMO(), screening: screening.describe() };
    if (!auth.can(user, 'users.manage')) st.activity = st.activity.filter((x) => !AUTH_EVENT.test(x.msg));
    return auth.can(user, 'view.full') ? st : redactedState(st);
  }

  if (p[0] === 'inventory' && p[1] === 'import' && m === 'POST') {
    need('inventory.write');
    const out = importInventory(b.csv, b.dryRun !== false); // preview unless dryRun is explicitly false
    if (out.dryRun) return out;
    store.tx(() => { for (const r of out.rows) store.aircraft.upsert(r.aircraft); act(`Inventory imported: ${out.result.created} new, ${out.result.updated} updated`); });
    return out.result;
  }
  if (p[0] === 'inventory') {
    if (m === 'POST') {
      need('inventory.write');
      const a = parseAircraft(b);
      store.aircraft.upsert(a); act('Inventory saved: ' + a.id); return a;
    }
    if (m === 'DELETE') {
      need('inventory.delete');
      try { store.aircraft.delete(p[1]); } catch (e) { if (/FOREIGN KEY/i.test(e.message)) throw httpErr(409, 'Aircraft has deals and cannot be deleted'); throw e; }
      act('Inventory deleted: ' + p[1]); return { ok: true };
    }
  }

  if (p[0] === 'leads' && p[2] === 'rescreen' && m === 'POST') { // re-run after an error or after the list/provider changed
    need('leads.write');
    const lead = store.leads.get(p[1]); if (!lead) throw httpErr(404, 'lead not found');
    if (lead.screening.override) throw httpErr(409, 'This lead was already cleared by a reviewer');
    const screen = await screening.screen({ name: lead.name, company: lead.company, country: lead.country });
    const request = lead.request, matches = screen.ok ? Logic.matchAircraft(request, store.aircraft.list()).map((x) => ({ aircraftId: x.aircraft.id, score: x.score, reasons: x.reasons })) : [];
    store.tx(() => { store.leads.setScreening(lead.id, screen, screen.ok ? 'qualified' : 'compliance-hold', matches); act(`Screening re-run on lead ${lead.id}: ${screen.status}`); });
    return store.leads.get(lead.id);
  }
  if (p[0] === 'leads' && p[2] === 'clear' && m === 'POST') { // human compliance decision, recorded with a reason
    need('compliance.review');
    const lead = store.leads.get(p[1]); if (!lead) throw httpErr(404, 'lead not found');
    if (lead.screening.ok) throw httpErr(409, 'Lead is not on hold');
    const st = lead.screening.status || 'hit'; // legacy records without a status were country-list holds
    if (st === 'hit') throw httpErr(409, 'A confirmed list match cannot be cleared in this app. Escalate to your compliance officer.');
    const note = str(b.note, 1000); if (note.length < 10) throw httpErr(400, 'A review note of at least 10 characters is required');
    const screen = { ...lead.screening, ok: true, override: { by: user.email, note, at: new Date().toISOString(), previous: lead.screening.status } };
    const matches = Logic.matchAircraft(lead.request, store.aircraft.list()).map((x) => ({ aircraftId: x.aircraft.id, score: x.score, reasons: x.reasons }));
    store.tx(() => { store.leads.setScreening(lead.id, screen, 'qualified', matches); act(`Compliance cleared lead ${lead.id} (was ${st})`); });
    return store.leads.get(lead.id);
  }
  if (p[0] === 'leads' && m === 'PUT' && p[1]) {
    need('leads.write');
    if (!store.leads.get(p[1])) throw httpErr(404, 'lead not found');
    if (!mailer.validEmail(b.email)) throw httpErr(400, 'Invalid buyer email');
    store.leads.setEmail(p[1], b.email.toLowerCase()); act('Buyer email updated on lead ' + p[1]); return store.leads.get(p[1]);
  }
  if (p[0] === 'leads' && m === 'POST') {
    need('leads.write');
    if (!['buy', 'lease'].includes(b.mode)) throw httpErr(400, 'mode must be buy or lease');
    const request = { mode: b.mode, type: str(b.type || 'any', 40), seats: optNum(b.seats, 0, 1000, 'seats'), rangeNm: optNum(b.rangeNm, 0, 20000, 'rangeNm'), maxAge: optNum(b.maxAge, 0, 100, 'maxAge'), budget: optNum(b.budget, 0, 1e10, 'budget') };
    const screen = await screening.screen({ name: str(b.name, 100), company: str(b.company, 100), country: str(b.country, 60) });
    const lead = { id: id(), createdAt: new Date().toISOString(), name: str(b.name, 100), company: str(b.company, 100) || null, country: str(b.country, 60), request, screening: screen, status: screen.ok ? 'qualified' : 'compliance-hold',
      matches: screen.ok ? Logic.matchAircraft(request, store.aircraft.list()).map((x) => ({ aircraftId: x.aircraft.id, score: x.score, reasons: x.reasons })) : [] };
    if (!lead.name) throw httpErr(400, 'name required');
    if (b.email) { if (!mailer.validEmail(b.email)) throw httpErr(400, 'Invalid buyer email'); lead.email = b.email.toLowerCase(); }
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
      const offer = numIn(b.offer, 1, 1e10, 'offer'), termMonths = optNum(b.termMonths, 1, 600, 'termMonths');
      const round = d.round + 1, playbook = store.playbook.get();
      const decision = Logic.negotiate({ aircraft: a, mode: d.mode, offer, round, termMonths, rules: playbook.rules });
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
      if (b.text !== undefined && (typeof b.text !== 'string' || !b.text.trim() || b.text.length > 5000)) throw httpErr(400, 'text must be 1-5000 characters');
      const text = b.text || msg.text;
      store.tx(() => {
        store.deals.approve(msg.id, text, user.email);
        if (msg.action === 'accept') store.deals.setStage(d.id, 'LOI'); else if (msg.action === 'escalate') store.deals.setStage(d.id, 'escalated');
        const edited = text.trim() !== msg.original.trim();
        if (edited) store.learned.add({ situation: msg.action + ' (broker-edited)', reply: text }); // learn from broker edits
        act(`Approved message on deal ${d.id}` + (edited ? ' (edited, saved as example)' : ''));
      });
      await deliver(d, msg.id, user);
      return store.deals.get(d.id);
    }
    if (msg && p[4] === 'send' && m === 'POST') { // retry a failed, blocked or skipped delivery
      if (!mailer.enabled()) throw httpErr(409, 'Email is not configured');
      if (msg.status !== 'sent') throw httpErr(409, 'Only approved messages can be emailed');
      if (msg.deliveryStatus === 'sent' || msg.deliveryStatus === 'sending') throw httpErr(409, 'Already ' + msg.deliveryStatus);
      await deliver(d, msg.id, user);
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
      for (const [k, max] of [['company', 200], ['broker', 200], ['tone', 200], ['systemPrompt', 10000]]) if (b[k] !== undefined) { if (typeof b[k] !== 'string') throw httpErr(400, k + ' must be text'); pb[k] = b[k].slice(0, max); }
      const R = { stepBase: [0, 1], stepPerRound: [0, 1], escalateBelowPct: [0, 100], maxRounds: [1, 20] };
      for (const k of Object.keys(Logic.DEFAULT_RULES)) if (r[k] !== undefined) pb.rules[k] = R[k] ? numIn(r[k], R[k][0], R[k][1], k) : str(r[k], 500);
      if (b.examples !== undefined) {
        if (!Array.isArray(b.examples) || b.examples.length > 50 || b.examples.some((e) => !e || typeof e.situation !== 'string' || typeof e.reply !== 'string')) throw httpErr(400, 'examples: up to 50 items with situation and reply text');
        pb.examples = b.examples.map((e) => ({ situation: e.situation.slice(0, 100), reply: e.reply.slice(0, 2000) }));
      }
      if (b.scenarios !== undefined) {
        if (!Array.isArray(b.scenarios) || b.scenarios.length > 100) throw httpErr(400, 'scenarios: up to 100 items');
        pb.scenarios = b.scenarios.map((s) => {
          if (!s || !ID_RE.test(String(s.aircraftId)) || !['buy', 'lease'].includes(s.mode) || !['accept', 'counter', 'escalate'].includes(s.expect)) throw httpErr(400, 'scenario needs aircraftId, mode (buy/lease) and expect (accept/counter/escalate)');
          return { name: str(s.name, 100) || 'Scenario', aircraftId: String(s.aircraftId), mode: s.mode, offer: numIn(s.offer, 1, 1e10, 'offer'), round: numIn(s.round ?? 1, 1, 20, 'round'), termMonths: optNum(s.termMonths, 1, 600, 'termMonths'), expect: s.expect };
        });
      }
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
  if (p[0] === 'reset' && m === 'POST') { need('data.reset'); if (!DEMO()) throw httpErr(409, 'Reset is disabled when SEED_DEMO=0 (it would delete real inventory, leads and deals)'); store.reset(); store.activity.add('Demo data reset', user.email); return { ok: true }; }
  throw httpErr(404, 'not found');
}

// Fixed-window request limit per client IP for /api (RATE_LIMIT_PER_MIN, default 600, 0 = off).
const hits = new Map();
function rateLimited(ip) {
  const max = process.env.RATE_LIMIT_PER_MIN === undefined ? 600 : Number(process.env.RATE_LIMIT_PER_MIN); if (!max) return false;
  const win = Math.floor(Date.now() / 60000), h = hits.get(ip);
  if (!h || h.win !== win) { if (hits.size > 10000) hits.clear(); hits.set(ip, { win, n: 1 }); return false; }
  return ++h.n > max;
}
const LOG = () => process.env.LOG_REQUESTS === '1'; // one line per API call: method, path, status, ms, user id. Never bodies, cookies or query strings.

const SECURITY = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const t0 = Date.now(); let uid = '-';
  const hsts = process.env.COOKIE_SECURE === '1' ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {};
  const send = (status, headers, data) => {
    res.writeHead(status, { ...SECURITY, ...hsts, ...headers }); res.end(data);
    if (LOG() && url.pathname.startsWith('/api/')) console.log(`${new Date().toISOString()} ${req.method} ${url.pathname} ${status} ${Date.now() - t0}ms user=${uid}`);
  };
  try {
    if (url.pathname === '/healthz') { // liveness + database check for load balancers; exposes no data
      store.db.prepare('SELECT 1').get();
      return send(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }, '{"ok":true}');
    }
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET') { // CSRF defence in depth on top of SameSite=Strict
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw httpErr(403, 'Cross-origin request blocked');
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw httpErr(415, 'JSON required');
      }
      const token = auth.parseCookies(req.headers.cookie).sid;
      const ctx = { token, user: auth.sessionUser(token), ip: clientIp(req) };
      uid = ctx.user ? ctx.user.id : '-';
      if (rateLimited(ctx.ip)) { res.setHeader('retry-after', '60'); throw httpErr(429, 'Too many requests. Slow down and try again in a minute.'); }
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
    send(e.status || 500, { 'content-type': 'application/json' }, JSON.stringify({ error: e.status ? e.message : 'Server error', ...(e.details ? { details: e.details } : {}) }));
  }
});

// Scheduled backups inside the app process: BACKUP_DIR=/backups BACKUP_EVERY_HOURS=24 BACKUP_KEEP=14
function startBackups() {
  const dir = process.env.BACKUP_DIR; if (!dir) return null;
  const every = (Number(process.env.BACKUP_EVERY_HOURS) || 24) * 3600e3, keep = Number(process.env.BACKUP_KEEP) || 14;
  const run = () => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, 'platform-' + new Date().toISOString().replace(/[:.]/g, '-') + '.db');
      store.backup(dest); fs.chmodSync(dest, 0o600);
      const files = fs.readdirSync(dir).filter((f) => /^platform-.*\.db$/.test(f)).sort();
      for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.unlinkSync(path.join(dir, f));
      console.log('backup written:', dest);
    } catch (e) { console.error('backup failed:', e.message); }
  };
  setTimeout(run, 5000).unref();
  return setInterval(run, every).unref();
}

if (require.main === module) {
  const port = process.env.PORT || 3000, host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => console.log(`Platform on http://${host}:${port}  (wording: ${llm.enabled() ? JSON.stringify(llm.describe()) : 'templates (set LLM_PROVIDER=ollama to use an open-source model)'}; email: ${mailer.enabled() ? mailer.describe().provider : 'off'})`));
  if (host !== '127.0.0.1' && host !== 'localhost' && process.env.COOKIE_SECURE !== '1') console.warn('warning: listening beyond localhost without COOKIE_SECURE=1; serve it over HTTPS and set COOKIE_SECURE=1');
  startBackups();
  let closing = false;
  const shutdown = (sig) => { // finish in-flight requests, checkpoint the WAL, then exit
    if (closing) return; closing = true; console.log(sig + ' received, shutting down');
    const force = setTimeout(() => process.exit(1), 10000); force.unref();
    server.close(() => { try { store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); store.db.close(); } catch (e) { console.error(e.message); } process.exit(0); });
    server.closeIdleConnections();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM')); process.on('SIGINT', () => shutdown('SIGINT'));
}
module.exports = server;
