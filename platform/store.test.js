// Database-level tests: migrations, constraints, concurrency, legacy import, backup.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert'), http = require('http'), { execFileSync } = require('child_process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deal-store-'));
process.env.DB_FILE = path.join(dir, 'main.db');
delete process.env.LLM_PROVIDER; delete process.env.ANTHROPIC_API_KEY;
const store = require('./store.js');
const Logic = require('./logic.js');

// --- schema, seed, constraints ---
assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 3);
assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
assert.equal(store.aircraft.list().length, Logic.INVENTORY.length);
assert.equal(store.playbook.get().scenarios.length, 6);
assert.throws(() => store.aircraft.upsert({ ...Logic.INVENTORY[0], id: 'BAD', floor: 99e9 }), /CHECK/, 'floor above list must be rejected by the database');
assert.throws(() => store.users.insert({ id: 'u1', email: 'a@x.com', name: 'A', role: 'root', salt: 's', hash: 'h', createdAt: 'x' }), /CHECK/);
store.users.insert({ id: 'u1', email: 'a@x.com', name: 'A', role: 'admin', salt: 's', hash: 'h', createdAt: 'x' });
assert.throws(() => store.users.insert({ id: 'u2', email: 'a@x.com', name: 'B', role: 'admin', salt: 's', hash: 'h', createdAt: 'x' }), /UNIQUE/);
// rollback leaves nothing behind
assert.throws(() => store.tx(() => { store.activity.add('inside tx'); throw new Error('boom'); }), /boom/);
assert.ok(!store.activity.recent().some((a) => a.msg === 'inside tx'));
// at most one draft per deal, enforced by the database
store.leads.insert({ id: 'l1', createdAt: 'x', name: 'N', status: 'qualified', request: {}, screening: { ok: true }, matches: [] });
store.deals.insert({ id: 'd1', leadId: 'l1', aircraftId: 'TP-01', buyer: 'N', mode: 'buy', stage: 'negotiating' });
const draft = (id) => ({ id, action: 'counter', price: 1, flags: [], note: 'n', text: 't', source: 's', facts: null, original: 't' });
store.deals.addDraft('d1', draft('m1'));
assert.throws(() => store.deals.addDraft('d1', draft('m2')), /UNIQUE/);
// aircraft with deals cannot be deleted
assert.throws(() => store.aircraft.delete('TP-01'), /FOREIGN KEY/);
// optimistic round advance
assert.equal(store.deals.advanceRound('d1', 0), true);
assert.equal(store.deals.advanceRound('d1', 0), false);
// sessions are removed with their user
store.sessions.insert('s1', 'u1'); store.users.delete('u1');
assert.equal(store.sessions.get('s1'), undefined);
// learned examples capped at 50, takeAt removes the right one
for (let i = 0; i < 55; i++) store.learned.add({ situation: 'x', reply: 'r' + i });
assert.equal(store.learned.list().length, 50); assert.equal(store.learned.takeAt(0).reply, 'r5'); assert.equal(store.learned.list().length, 49);

// --- backup is a usable, consistent copy ---
const bk = path.join(dir, 'backup.db');
store.backup(bk);
const { DatabaseSync } = require('node:sqlite');
assert.equal(new DatabaseSync(bk).prepare('SELECT COUNT(*) n FROM aircraft').get().n, Logic.INVENTORY.length);
assert.throws(() => store.backup(bk), /already exists/);

// --- legacy JSON import (old data/db.json format), in a fresh database via the CLI ---
const legacy = {
  inventory: [{ ...Logic.INVENTORY[0] }],
  users: [{ id: 'old1', email: 'old@x.com', name: 'Old Admin', role: 'admin', salt: 'aa', hash: 'bb', createdAt: '2026-01-01T00:00:00Z' }],
  sessions: [{ id: 'zz', userId: 'old1', createdAt: 1, lastSeen: 1 }],
  leads: [{ id: 'lead1', createdAt: '2026-01-02T00:00:00Z', name: 'Alex', company: 'Co', country: 'Spain', status: 'qualified', request: { mode: 'buy' }, screening: { ok: true }, matches: [] }],
  deals: [{ id: 'deal1', leadId: 'lead1', buyer: 'Alex', company: 'Co', aircraftId: 'TP-01', mode: 'buy', stage: 'LOI', round: 2, messages: [
    { id: 'b1', role: 'buyer', text: 'Offer: $8,000,000', at: '2026-01-03T00:00:00Z' },
    { id: 'a1', role: 'assistant', status: 'sent', action: 'accept', price: 9000000, flags: [], note: 'n', text: 'Agreed.', source: 'template', original: 'Agreed.', approvedBy: 'old@x.com', at: '2026-01-03T00:00:01Z', sentAt: '2026-01-03T00:00:02Z' }] }],
  learned: [{ situation: 'counter (broker-edited)', reply: 'Hello' }],
  activity: [{ at: '2026-01-03T00:00:00Z', msg: 'Login', who: 'old@x.com' }],
  playbook: { ...store.defaultPlaybook(), company: 'Imported Co' },
};
const jsonFile = path.join(dir, 'old.json'); fs.writeFileSync(jsonFile, JSON.stringify(legacy));
const env = { ...process.env, DB_FILE: path.join(dir, 'imported.db') };
const out = execFileSync('node', ['--disable-warning=ExperimentalWarning', path.join(__dirname, 'migrate-json.js'), jsonFile], { env }).toString();
assert.ok(out.includes('"deals": 1') || out.includes('deals: 1'), out);
const imp = new DatabaseSync(env.DB_FILE);
assert.equal(imp.prepare('SELECT email FROM users').get().email, 'old@x.com');
assert.equal(imp.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
assert.equal(imp.prepare('SELECT stage, round FROM deals').get().stage, 'LOI');
assert.equal(imp.prepare('SELECT approved_by FROM messages WHERE id=?').get('a1').approved_by, 'old@x.com');
assert.equal(JSON.parse(imp.prepare("SELECT value FROM settings WHERE key='playbook'").get().value).company, 'Imported Co');
assert.equal(imp.prepare('SELECT COUNT(*) n FROM aircraft').get().n, 1);
// second import refuses and changes nothing
assert.throws(() => execFileSync('node', ['--disable-warning=ExperimentalWarning', path.join(__dirname, 'migrate-json.js'), jsonFile], { env, stdio: 'pipe' }), /not empty/);
assert.equal(imp.prepare('SELECT COUNT(*) n FROM users').get().n, 1);

// --- concurrent offers: a slow model must not let two drafts through ---
const server = require('./server.js');
const { raw, adminClient } = require('./testlib.js');
const slow = http.createServer((req, res) => { setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'We can propose $9,040,000.' } }] })); }, 300); });
slow.listen(0, '127.0.0.1', () => {
  process.env.LLM_PROVIDER = 'ollama'; process.env.LLM_BASE_URL = 'http://127.0.0.1:' + slow.address().port + '/v1';
  server.listen(0, '127.0.0.1', async () => {
    const base = 'http://127.0.0.1:' + server.address().port;
    try {
      const cookie = await adminClient(base), r = (m, p, b) => raw(base, m, p, b, cookie);
      store.db.exec('DELETE FROM messages; DELETE FROM deals;');
      const lead = (await r('POST', 'leads', { name: 'Alex', country: 'Spain', mode: 'buy', seats: 60, rangeNm: 700, budget: 9000000 })).body;
      const deal = (await r('POST', 'deals', { leadId: lead.id, aircraftId: 'TP-01' })).body;
      const [x, y] = await Promise.all([r('POST', `deals/${deal.id}/offer`, { offer: 8000000 }), r('POST', `deals/${deal.id}/offer`, { offer: 8100000 })]);
      assert.deepEqual([x.status, y.status].sort(), [200, 409], 'exactly one concurrent offer may win: ' + [x.status, y.status]);
      const d = (await r('GET', 'state')).body.deals[0];
      assert.equal(d.round, 1); assert.equal(d.messages.filter((m) => m.status === 'draft').length, 1);
      // approving twice is refused
      const m = d.messages.find((q) => q.status === 'draft');
      assert.equal((await r('POST', `deals/${deal.id}/messages/${m.id}/approve`, {})).status, 200);
      assert.equal((await r('POST', `deals/${deal.id}/messages/${m.id}/approve`, {})).status, 409);
      // deleting an aircraft that has deals is a clear 409, not a crash
      assert.equal((await r('DELETE', 'inventory/TP-01')).status, 409);
      console.log('store tests passed'); process.exit(0);
    } catch (e) { console.error(e); process.exit(1); }
  });
});
