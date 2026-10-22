// SQLite data layer (node:sqlite, no dependencies). All SQL lives here; server.js only calls these functions.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const Logic = require('./logic.js');

const FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'platform.db');
if (FILE !== ':memory:') fs.mkdirSync(path.dirname(FILE), { recursive: true });
const db = new DatabaseSync(FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
if (FILE !== ':memory:') { try { fs.chmodSync(FILE, 0o600); } catch {} }

// Append new migrations; never edit an applied one. PRAGMA user_version records how many have run.
const MIGRATIONS = [`
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','broker','viewer')),
    salt TEXT NOT NULL, hash TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE aircraft (
    id TEXT PRIMARY KEY, model TEXT NOT NULL, type TEXT, year INTEGER, hours INTEGER, seats INTEGER, range_nm INTEGER,
    location TEXT, list_price REAL NOT NULL, floor REAL NOT NULL, max_discount_pct REAL, lease_monthly REAL,
    min_lease_monthly REAL, min_term_months INTEGER, CHECK (floor <= list_price));
  CREATE TABLE leads (
    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, name TEXT NOT NULL, company TEXT, country TEXT,
    status TEXT NOT NULL, request TEXT NOT NULL, screening TEXT NOT NULL, matches TEXT NOT NULL);
  CREATE TABLE deals (
    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, lead_id TEXT NOT NULL REFERENCES leads(id),
    aircraft_id TEXT NOT NULL REFERENCES aircraft(id) ON DELETE RESTRICT,
    buyer TEXT NOT NULL, company TEXT, mode TEXT NOT NULL CHECK (mode IN ('buy','lease')),
    stage TEXT NOT NULL, round INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    deal_id TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('buyer','assistant')), status TEXT, action TEXT, price REAL,
    flags TEXT, note TEXT, text TEXT NOT NULL, source TEXT, facts TEXT, original TEXT,
    approved_by TEXT, at TEXT NOT NULL, sent_at TEXT);
  CREATE INDEX messages_deal ON messages(deal_id, seq);
  CREATE UNIQUE INDEX one_draft_per_deal ON messages(deal_id) WHERE status = 'draft';
  CREATE TABLE learned (id INTEGER PRIMARY KEY AUTOINCREMENT, situation TEXT NOT NULL, reply TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE activity (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, msg TEXT NOT NULL, who TEXT);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`, `
  ALTER TABLE leads ADD COLUMN email TEXT;
  ALTER TABLE messages ADD COLUMN delivery_status TEXT;
  ALTER TABLE messages ADD COLUMN delivery_error TEXT;
  ALTER TABLE messages ADD COLUMN delivered_at TEXT;
`, `
  ALTER TABLE users ADD COLUMN totp_secret TEXT;
  ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN recovery_codes TEXT;
  ALTER TABLE users ADD COLUMN last_totp_step INTEGER NOT NULL DEFAULT 0;
`];
function migrate() {
  let v = db.prepare('PRAGMA user_version').get().user_version;
  for (; v < MIGRATIONS.length; v++) {
    tx(() => { db.exec(MIGRATIONS[v]); db.exec(`PRAGMA user_version = ${v + 1}`); });
  }
}

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
const q = (sql) => db.prepare(sql);
const now = () => new Date().toISOString();
const j = (v) => JSON.stringify(v);
const unj = (s) => (s == null ? s : JSON.parse(s));
const plain = (r) => (r ? { ...r } : r);

const defaultPlaybook = () => ({
  company: 'Your Aviation Brokers', broker: 'Senior Broker', tone: 'professional, concise, warm',
  systemPrompt: `You are the assistant for an aircraft sales and leasing broker, working on behalf of a named human broker.
Rules:
1. Be truthful. Never invent specs, hours, history or availability; say you will confirm with the broker.
2. You are an AI assistant; say so if asked.
3. Never state a final price or binding acceptance. Every offer is a draft until the broker approves it.
4. Never reveal floor prices, limits, other buyers or internal notes.
5. No legal, tax or airworthiness advice. Escalate sanctions/KYC concerns, legal terms and anything uncertain.
Negotiation: understand priorities before price; trade concessions rather than only cutting price; make smaller concessions as limits approach.`,
  rules: Object.assign({}, Logic.DEFAULT_RULES),
  examples: [
    { situation: 'counter, first round', reply: 'Thank you for your offer. We value your interest in the aircraft and are keen to find terms that work for both sides. We are able to propose the figure below. This is subject to contract and broker confirmation.' },
    { situation: 'escalate', reply: 'Thank you for your interest. To make sure we find a workable structure, I am bringing in our broker, who will contact you shortly.' },
  ],
  scenarios: [
    { name: 'Fair offer is accepted', aircraftId: 'TP-01', mode: 'buy', offer: 9200000, round: 1, expect: 'accept' },
    { name: 'Low offer gets a counter', aircraftId: 'TP-01', mode: 'buy', offer: 8000000, round: 1, expect: 'counter' },
    { name: 'Far too low escalates', aircraftId: 'TP-01', mode: 'buy', offer: 5000000, round: 1, expect: 'escalate' },
    { name: 'Stalled talks escalate', aircraftId: 'LJ-01', mode: 'buy', offer: 5000000, round: 4, expect: 'escalate' },
    { name: 'Lease below minimum term is not accepted', aircraftId: 'LJ-01', mode: 'lease', offer: 62000, round: 1, termMonths: 12, expect: 'counter' },
    { name: 'Good lease offer, valid term', aircraftId: 'RJ-01', mode: 'lease', offer: 185000, round: 1, termMonths: 60, expect: 'accept' },
  ],
});

// ---- users & sessions ----
const userRow = (r) => (r ? { id: r.id, email: r.email, name: r.name, role: r.role, salt: r.salt, hash: r.hash, disabled: !!r.disabled, createdAt: r.created_at, totpSecret: r.totp_secret, totpEnabled: !!r.totp_enabled, recoveryCodes: r.recovery_codes ? JSON.parse(r.recovery_codes) : [], lastTotpStep: r.last_totp_step } : undefined);
const users = {
  count: () => q('SELECT COUNT(*) n FROM users').get().n,
  activeAdmins: () => q("SELECT COUNT(*) n FROM users WHERE role='admin' AND disabled=0").get().n,
  list: () => q('SELECT * FROM users ORDER BY created_at, rowid').all().map(userRow),
  byId: (id) => userRow(q('SELECT * FROM users WHERE id=?').get(id)),
  byEmail: (email) => userRow(q('SELECT * FROM users WHERE email=?').get(email)),
  insert: (u) => { q('INSERT INTO users (id,email,name,role,salt,hash,disabled,created_at) VALUES (?,?,?,?,?,?,0,?)').run(u.id, u.email, u.name, u.role, u.salt, u.hash, u.createdAt); },
  update: (id, f) => {
    const map = { name: 'name', role: 'role', salt: 'salt', hash: 'hash', disabled: 'disabled', totpSecret: 'totp_secret', totpEnabled: 'totp_enabled', recoveryCodes: 'recovery_codes', lastTotpStep: 'last_totp_step' }, cols = [], vals = [];
    for (const [k, c] of Object.entries(map)) if (f[k] !== undefined) { cols.push(c + '=?'); vals.push(k === 'disabled' || k === 'totpEnabled' ? +f[k] : k === 'recoveryCodes' ? JSON.stringify(f[k]) : f[k]); }
    if (cols.length) q(`UPDATE users SET ${cols.join(',')} WHERE id=?`).run(...vals, id);
  },
  delete: (id) => { q('DELETE FROM users WHERE id=?').run(id); },
};
const sessions = {
  insert: (id, userId) => { const t = Date.now(); q('INSERT INTO sessions (id,user_id,created_at,last_seen) VALUES (?,?,?,?)').run(id, userId, t, t); },
  get: (id) => { const r = q('SELECT * FROM sessions WHERE id=?').get(id); return r && { id: r.id, userId: r.user_id, createdAt: r.created_at, lastSeen: r.last_seen }; },
  touch: (id) => { q('UPDATE sessions SET last_seen=? WHERE id=?').run(Date.now(), id); },
  delete: (id) => { q('DELETE FROM sessions WHERE id=?').run(id); },
  deleteForUser: (userId) => { q('DELETE FROM sessions WHERE user_id=?').run(userId); },
  prune: (absoluteMs, idleMs) => { const t = Date.now(); q('DELETE FROM sessions WHERE created_at < ? OR last_seen < ?').run(t - absoluteMs, t - idleMs); },
};

// ---- inventory ----
const acRow = (r) => r && ({ id: r.id, model: r.model, type: r.type, year: r.year, hours: r.hours, seats: r.seats, rangeNm: r.range_nm, location: r.location, listPrice: r.list_price, floor: r.floor, maxDiscountPct: r.max_discount_pct, leaseMonthly: r.lease_monthly, minLeaseMonthly: r.min_lease_monthly, minTermMonths: r.min_term_months });
const aircraft = {
  list: () => q('SELECT * FROM aircraft ORDER BY rowid').all().map(acRow),
  get: (id) => acRow(q('SELECT * FROM aircraft WHERE id=?').get(id)),
  upsert: (a) => {
    q(`INSERT INTO aircraft (id,model,type,year,hours,seats,range_nm,location,list_price,floor,max_discount_pct,lease_monthly,min_lease_monthly,min_term_months)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET model=excluded.model,type=excluded.type,year=excluded.year,hours=excluded.hours,seats=excluded.seats,range_nm=excluded.range_nm,
         location=excluded.location,list_price=excluded.list_price,floor=excluded.floor,max_discount_pct=excluded.max_discount_pct,lease_monthly=excluded.lease_monthly,
         min_lease_monthly=excluded.min_lease_monthly,min_term_months=excluded.min_term_months`)
      .run(a.id, a.model, a.type, a.year, a.hours, a.seats, a.rangeNm, a.location, a.listPrice, a.floor, a.maxDiscountPct, a.leaseMonthly, a.minLeaseMonthly, a.minTermMonths);
  },
  delete: (id) => { q('DELETE FROM aircraft WHERE id=?').run(id); },
};

// ---- leads ----
const leadRow = (r) => r && ({ id: r.id, createdAt: r.created_at, name: r.name, company: r.company, email: r.email, country: r.country, status: r.status, request: unj(r.request), screening: unj(r.screening), matches: unj(r.matches) });
const leads = {
  list: () => q('SELECT * FROM leads ORDER BY created_at DESC, rowid DESC').all().map(leadRow),
  get: (id) => leadRow(q('SELECT * FROM leads WHERE id=?').get(id)),
  insert: (l) => { q('INSERT INTO leads (id,created_at,name,company,email,country,status,request,screening,matches) VALUES (?,?,?,?,?,?,?,?,?,?)').run(l.id, l.createdAt, l.name, l.company ?? null, l.email ?? null, l.country ?? null, l.status, j(l.request), j(l.screening), j(l.matches)); },
  setScreening: (id, screening, status, matches) => { q('UPDATE leads SET screening=?, status=?, matches=? WHERE id=?').run(j(screening), status, j(matches), id); },
  // Right to erasure: removes the lead, its deals and messages, and blanks the person's name/email wherever it was
  // written into free text (activity log, learned replies). Returns what was touched.
  erase: (id) => tx(() => {
    const l = leadRow(q('SELECT * FROM leads WHERE id=?').get(id)); if (!l) return null;
    const dealIds = q('SELECT id FROM deals WHERE lead_id=?').all(id).map((d) => d.id);
    const messages = dealIds.reduce((n, d) => n + q('SELECT COUNT(*) n FROM messages WHERE deal_id=?').get(d).n, 0);
    q('DELETE FROM deals WHERE lead_id=?').run(id); q('DELETE FROM leads WHERE id=?').run(id);
    let scrubbed = 0;
    for (const term of [l.name, l.email, l.company].filter((t) => t && t.trim().length >= 3)) {
      scrubbed += q('UPDATE activity SET msg=REPLACE(msg, ?, ?) WHERE instr(msg, ?) > 0').run(term, '[erased]', term).changes;
      scrubbed += q('UPDATE learned SET reply=REPLACE(reply, ?, ?), situation=REPLACE(situation, ?, ?) WHERE instr(reply, ?) > 0 OR instr(situation, ?) > 0').run(term, '[erased]', term, '[erased]', term, term).changes;
    }
    return { deals: dealIds.length, messages, scrubbed };
  }),
  setEmail: (id, email) => { q('UPDATE leads SET email=? WHERE id=?').run(email, id); },
};

// ---- deals & messages ----
const msgRow = (r) => {
  const m = { id: r.id, role: r.role, text: r.text, at: r.at };
  if (r.role === 'assistant') Object.assign(m, { status: r.status, action: r.action, price: r.price, flags: unj(r.flags) || [], note: r.note, source: r.source, facts: unj(r.facts), original: r.original });
  if (r.approved_by) m.approvedBy = r.approved_by;
  if (r.delivery_status) m.deliveryStatus = r.delivery_status;
  if (r.delivery_error) m.deliveryError = r.delivery_error;
  if (r.delivered_at) m.deliveredAt = r.delivered_at;
  if (r.sent_at) m.sentAt = r.sent_at;
  return m;
};
const dealRow = (r, messages) => r && ({ id: r.id, leadId: r.lead_id, buyer: r.buyer, company: r.company, aircraftId: r.aircraft_id, mode: r.mode, stage: r.stage, round: r.round, messages });
const deals = {
  list: () => {
    const all = q('SELECT * FROM messages ORDER BY seq').all(), by = {};
    for (const m of all) (by[m.deal_id] ||= []).push(msgRow(m));
    return q('SELECT * FROM deals ORDER BY created_at DESC, rowid DESC').all().map((d) => dealRow(d, by[d.id] || []));
  },
  get: (id) => { const d = q('SELECT * FROM deals WHERE id=?').get(id); return d && dealRow(d, q('SELECT * FROM messages WHERE deal_id=? ORDER BY seq').all(id).map(msgRow)); },
  insert: (d) => { q('INSERT INTO deals (id,created_at,lead_id,aircraft_id,buyer,company,mode,stage,round) VALUES (?,?,?,?,?,?,?,?,0)').run(d.id, now(), d.leadId, d.aircraftId, d.buyer, d.company ?? null, d.mode, d.stage); },
  setStage: (id, stage) => { q('UPDATE deals SET stage=? WHERE id=?').run(stage, id); },
  // Optimistic concurrency: only advances if nobody else moved the round since it was read.
  advanceRound: (id, from) => q('UPDATE deals SET round=round+1 WHERE id=? AND round=?').run(id, from).changes === 1,
  rewindRound: (id) => { q('UPDATE deals SET round=MAX(0, round-1) WHERE id=?').run(id); },
  addBuyerMessage: (dealId, id, text) => { q("INSERT INTO messages (id,deal_id,role,text,at) VALUES (?,?,'buyer',?,?)").run(id, dealId, text, now()); },
  addDraft: (dealId, m) => { q("INSERT INTO messages (id,deal_id,role,status,action,price,flags,note,text,source,facts,original,at) VALUES (?,?,'assistant','draft',?,?,?,?,?,?,?,?,?)").run(m.id, dealId, m.action, m.price ?? null, j(m.flags || []), m.note, m.text, m.source, m.facts ? j(m.facts) : null, m.original, now()); },
  message: (dealId, id) => { const r = q('SELECT * FROM messages WHERE deal_id=? AND id=?').get(dealId, id); return r && msgRow(r); },
  approve: (id, text, by) => { q("UPDATE messages SET status='sent', text=?, approved_by=?, sent_at=? WHERE id=? AND status='draft'").run(text, by, now(), id); },
  // Compare-and-set so two requests can never both send the same message.
  claimDelivery: (id) => q("UPDATE messages SET delivery_status='sending', delivery_error=NULL WHERE id=? AND status='sent' AND (delivery_status IS NULL OR delivery_status IN ('failed','skipped','blocked'))").run(id).changes === 1,
  setDelivery: (id, status, error) => { q('UPDATE messages SET delivery_status=?, delivery_error=?, delivered_at=? WHERE id=?').run(status, error ? String(error).slice(0, 300) : null, status === 'sent' ? now() : null, id); },
  reject: (id) => { q("UPDATE messages SET status='rejected' WHERE id=? AND status='draft'").run(id); },
};

// ---- learning, audit, settings ----
const learned = {
  list: () => q('SELECT situation, reply FROM learned ORDER BY id').all().map(plain),
  add: (e) => { q('INSERT INTO learned (situation,reply,created_at) VALUES (?,?,?)').run(e.situation, e.reply, now()); q('DELETE FROM learned WHERE id NOT IN (SELECT id FROM learned ORDER BY id DESC LIMIT 50)').run(); },
  takeAt: (index) => { const row = q('SELECT id, situation, reply FROM learned ORDER BY id LIMIT 1 OFFSET ?').get(index); if (!row) return null; q('DELETE FROM learned WHERE id=?').run(row.id); return { situation: row.situation, reply: row.reply }; },
};
const activityLog = {
  add: (msg, who) => { q('INSERT INTO activity (at,msg,who) VALUES (?,?,?)').run(now(), msg, who ?? null); q('DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY id DESC LIMIT 200)').run(); },
  recent: (n = 100) => q('SELECT at, msg, who FROM activity ORDER BY id DESC LIMIT ?').all(n).map(plain),
};
const playbook = {
  get: () => unj(q("SELECT value FROM settings WHERE key='playbook'").get().value),
  set: (pb) => { q("INSERT INTO settings (key,value) VALUES ('playbook',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(j(pb)); },
};

function seed() {
  tx(() => {
    if (!q("SELECT 1 FROM settings WHERE key='seeded'").get()) {
      const demo = process.env.SEED_DEMO !== '0'; // SEED_DEMO=0: start with no aircraft and no demo test scenarios
      if (demo) for (const a of Logic.INVENTORY) aircraft.upsert(a);
      const pb = defaultPlaybook(); if (!demo) pb.scenarios = [];
      playbook.set(pb);
      q("INSERT INTO settings (key,value) VALUES ('seeded','1')").run();
    }
  });
}

// Wipes demo business data, keeps user accounts.
function reset() {
  tx(() => {
    for (const t of ['messages', 'deals', 'leads', 'learned', 'activity', 'aircraft']) db.exec(`DELETE FROM ${t}`);
    const demo = process.env.SEED_DEMO !== '0';
    if (demo) for (const a of Logic.INVENTORY) aircraft.upsert(a);
    const pb = defaultPlaybook(); if (!demo) pb.scenarios = [];
    playbook.set(pb);
  });
}

// One-way import of the old data/db.json format (see migrate-json.js). Refuses to touch a non-empty database.
function importLegacy(old) {
  return tx(() => {
    if (users.count() || leads.list().length) throw new Error('database is not empty');
    const n = { users: 0, aircraft: 0, leads: 0, deals: 0, messages: 0 };
    for (const u of old.users || []) { users.insert({ ...u, createdAt: u.createdAt || now() }); if (u.disabled) users.update(u.id, { disabled: true }); n.users++; }
    db.exec('DELETE FROM aircraft');
    for (const a of old.inventory || []) { aircraft.upsert(a); n.aircraft++; }
    for (const l of [...(old.leads || [])].reverse()) { leads.insert({ ...l, status: l.status || 'qualified' }); n.leads++; }
    for (const d of [...(old.deals || [])].reverse()) {
      deals.insert(d);
      if (d.round) q('UPDATE deals SET round=? WHERE id=?').run(d.round, d.id);
      for (const m of d.messages || []) {
        if (m.role === 'buyer') deals.addBuyerMessage(d.id, m.id, m.text);
        else {
          q("INSERT INTO messages (id,deal_id,role,status,action,price,flags,note,text,source,facts,original,approved_by,at,sent_at) VALUES (?,?,'assistant',?,?,?,?,?,?,?,?,?,?,?,?)")
            .run(m.id, d.id, m.status === 'draft' ? 'draft' : m.status || 'sent', m.action ?? null, m.price ?? null, j(m.flags || []), m.note ?? null, m.text, m.source ?? null, m.facts ? j(m.facts) : null, m.original ?? m.text, m.approvedBy ?? null, m.at || now(), m.sentAt ?? null);
        }
        n.messages++;
      }
      n.deals++;
    }
    for (const e of old.learned || []) learned.add(e);
    for (const a of [...(old.activity || [])].reverse()) q('INSERT INTO activity (at,msg,who) VALUES (?,?,?)').run(a.at, a.msg, a.who ?? null);
    if (old.playbook) playbook.set(old.playbook);
    q("INSERT INTO settings (key,value) VALUES ('seeded','1') ON CONFLICT(key) DO NOTHING").run();
    return n;
  });
}

function backup(dest) { if (fs.existsSync(dest)) throw new Error(dest + ' already exists'); db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`); }

migrate();
seed();

module.exports = { db, tx, users, sessions, aircraft, leads, deals, learned, activity: activityLog, playbook, defaultPlaybook, reset, importLegacy, backup, FILE };
