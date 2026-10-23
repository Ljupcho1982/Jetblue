// Upgrade and restore paths: a database created by any older schema version must open, migrate and keep its data.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert'), { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deal-upgrade-'));
const { MIGRATIONS } = (() => { process.env.DB_FILE = ':memory:'; return require('./store.js'); })();
assert.ok(MIGRATIONS.length >= 4);

// Rows valid for the schema as it was at each version (columns added later are absent on purpose)
function seed(db, version) {
  db.prepare("INSERT INTO users (id,email,name,role,salt,hash,disabled,created_at) VALUES ('u1','old@x.com','Old Admin','admin','aa','bb',0,'2026-01-01')").run();
  db.prepare("INSERT INTO sessions (id,user_id,created_at,last_seen) VALUES ('s1','u1',?,?)").run(Date.now(), Date.now());
  db.prepare("INSERT INTO aircraft (id,model,type,year,hours,seats,range_nm,location,list_price,floor,max_discount_pct,lease_monthly,min_lease_monthly,min_term_months) VALUES ('X-1','ATR','turboprop',2008,1,70,825,'Madrid',9500000,8600000,8,95000,86000,36)").run();
  if (version >= 2) db.prepare("INSERT INTO leads (id,created_at,name,company,email,country,status,request,screening,matches) VALUES ('l1','2026-01-02','Alex','Co','alex@x.com','Spain','qualified','{\"mode\":\"buy\"}','{\"ok\":true}','[]')").run();
  else db.prepare("INSERT INTO leads (id,created_at,name,company,country,status,request,screening,matches) VALUES ('l1','2026-01-02','Alex','Co','Spain','qualified','{\"mode\":\"buy\"}','{\"ok\":true}','[]')").run();
  db.prepare("INSERT INTO deals (id,created_at,lead_id,aircraft_id,buyer,company,mode,stage,round) VALUES ('d1','2026-01-03','l1','X-1','Alex','Co','buy','negotiating',1)").run();
  db.prepare("INSERT INTO messages (id,deal_id,role,text,at) VALUES ('m1','d1','buyer','Offer: $8,000,000','2026-01-03')").run();
  db.prepare("INSERT INTO messages (id,deal_id,role,status,action,price,flags,note,text,source,original,approved_by,at,sent_at) VALUES ('m2','d1','assistant','sent','counter',9040000,'[]','n','We can propose $9,040,000.','template','We can propose $9,040,000.','old@x.com','2026-01-03','2026-01-03')").run();
  db.prepare("INSERT INTO learned (situation,reply,created_at) VALUES ('counter','Hello','2026-01-03')").run();
  db.prepare("INSERT INTO activity (at,msg,who) VALUES ('2026-01-03','Login','old@x.com')").run();
  db.prepare("INSERT INTO settings (key,value) VALUES ('seeded','1')").run();
  db.prepare("INSERT INTO settings (key,value) VALUES ('playbook',?)").run(JSON.stringify({ company: 'Old Co', rules: { stepBase: 0.4, stepPerRound: 0.2, escalateBelowPct: 85, maxRounds: 4, disclaimer: 'x' }, examples: [], scenarios: [], systemPrompt: 'p', broker: 'b', tone: 't' }));
}

const probe = `
  const s = require('./store.js');
  const u = s.users.byEmail('old@x.com'), d = s.deals.get('d1'), l = s.leads.get('l1');
  console.log(JSON.stringify({ version: s.db.prepare('PRAGMA user_version').get().user_version, fk: s.db.prepare('PRAGMA foreign_keys').get().foreign_keys,
    user: u && { role: u.role, totp: u.totpEnabled, codes: u.recoveryCodes, step: u.lastTotpStep }, session: !!s.sessions.get('s1'),
    lead: l && { name: l.name, email: l.email }, deal: d && { stage: d.stage, round: d.round, msgs: d.messages.map((m) => [m.role, m.status || null, m.deliveryStatus || null, m.price || null]) },
    aircraft: s.aircraft.get('X-1').floor, learned: s.learned.list().length, activity: s.activity.recent().length, company: s.playbook.get().company, feedback: s.feedback.list().length }));`;

for (let version = 1; version <= MIGRATIONS.length; version++) {
  const file = path.join(dir, `v${version}.db`), db = new DatabaseSync(file);
  for (let i = 0; i < version; i++) db.exec(MIGRATIONS[i]);
  db.exec(`PRAGMA user_version = ${version}`); seed(db, version); db.close();
  const run = () => JSON.parse(execFileSync('node', ['--disable-warning=ExperimentalWarning', '-e', probe], { cwd: __dirname, env: { ...process.env, DB_FILE: file } }).toString());
  const r = run();
  const at = `upgrading from v${version}`;
  assert.equal(r.version, MIGRATIONS.length, at); assert.equal(r.fk, 1, at);
  assert.deepEqual(r.user, { role: 'admin', totp: false, codes: [], step: 0 }, at + ': existing users must not suddenly have 2FA');
  assert.equal(r.session, true, at + ': sessions survive an upgrade'); assert.equal(r.lead.name, 'Alex'); assert.equal(r.lead.email, version >= 2 ? 'alex@x.com' : null, at);
  assert.deepEqual(r.deal, { stage: 'negotiating', round: 1, msgs: [['buyer', null, null, null], ['assistant', 'sent', null, 9040000]] }, at);
  assert.equal(r.aircraft, 8600000); assert.equal(r.learned, 1); assert.equal(r.activity, 1); assert.equal(r.company, 'Old Co'); assert.equal(r.feedback, 0);
  assert.deepEqual(run(), r, at + ': second start must change nothing (migrations are idempotent)');
}

// Restore: a backup is a complete database at the current version; copying it over the live file (DEPLOY.md steps) works
{
  const main = path.join(dir, 'main.db'), backup = path.join(dir, 'backup.db');
  const prep = `const s = require('./store.js'); s.users.insert({ id: 'u1', email: 'a@x.com', name: 'A', role: 'admin', salt: 's', hash: 'h', createdAt: 'x' });
    s.leads.insert({ id: 'l1', createdAt: 'x', name: 'Before', status: 'qualified', request: {}, screening: { ok: true }, matches: [] }); s.backup(process.env.BACKUP);
    s.leads.insert({ id: 'l2', createdAt: 'x', name: 'After', status: 'qualified', request: {}, screening: { ok: true }, matches: [] });`;
  execFileSync('node', ['--disable-warning=ExperimentalWarning', '-e', prep], { cwd: __dirname, env: { ...process.env, DB_FILE: main, BACKUP: backup } });
  assert.equal(new DatabaseSync(backup).prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length, 'backup must carry its schema version');
  fs.copyFileSync(backup, main); for (const x of ['-wal', '-shm']) fs.rmSync(main + x, { force: true });
  const names = JSON.parse(execFileSync('node', ['--disable-warning=ExperimentalWarning', '-e', "const s=require('./store.js');console.log(JSON.stringify(s.leads.list().map(l=>l.name)))"], { cwd: __dirname, env: { ...process.env, DB_FILE: main } }).toString());
  assert.deepEqual(names, ['Before'], 'restore must bring back the state at backup time');
}
console.log('upgrade and restore tests passed');
