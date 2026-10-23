// International names: screening and search must work in every script, ignoring case and accents.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
process.env.DB_FILE = path.join(os.tmpdir(), 'deal-unicode-' + Date.now() + '.db');
delete process.env.LLM_PROVIDER; delete process.env.ANTHROPIC_API_KEY; delete process.env.MAIL_PROVIDER; delete process.env.SCREENING_WEBHOOK_URL;
const L = require('./logic.js'), S = require('./screening.js'), store = require('./store.js');

// --- fold ---
for (const [a, b] of [['MÜLLER', 'muller'], ['José García', 'jose garcia'], ['ИВАН', 'иван'], ['Straße', 'strasse'], ['İbrahim', 'ibrahim'], ['Łukasz Øvergård', 'lukasz overgard'], ['ＡＢＣ', 'abc'], ['Ελένη', 'ελενη'], ['', ''], [null, '']])
  assert.equal(L.fold(a), b, JSON.stringify(a));

// --- screening in every script ---
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uni-'));
fs.writeFileSync(path.join(dir, 'list.csv'), 'name,aliases\n"Петров, Иван",Иван П. Петров\n张伟,\nمحمد علي,\nΕλένη Παπαδοπούλου,\nMüller Aviation GmbH,\n');
process.env.SANCTIONS_FILE = path.join(dir, 'list.csv');
(async () => {
  const sc = (name, company = '', country = 'Spain') => S.screen({ name, company, country });
  for (const [name, want] of [['ПЕТРОВ Иван', 'hit'], ['иван петров', 'hit'], ['Иван Петрова', 'review'], ['Сергей Иванов', 'clear'], ['张伟', 'hit'], ['张强', 'clear'], ['محمد علي', 'hit'], ['مُحَمَّد عَلِيّ', 'hit'], ['ΕΛΕΝΗ ΠΑΠΑΔΟΠΟΥΛΟΥ', 'hit'], ['Eleni Papadopoulou', 'clear'],
    ['MULLER Aviation', 'hit'], ['Alex Morgan', 'clear'], ['Иван', 'clear']]) {
    const r = await sc(name); assert.equal(r.status, want, `${name} -> ${r.status} (${r.reasons[0] || ''})`);
  }
  assert.equal((await sc('Alex', 'Müller Aviation GmbH')).status, 'hit', 'company in the list');

  // --- search in every script, through the real API ---
  const server = require('./server.js'), { raw, adminClient } = require('./testlib.js');
  server.listen(0, '127.0.0.1', async () => {
    const base = 'http://127.0.0.1:' + server.address().port, admin = await adminClient(base), r = (m, p, b) => raw(base, m, p, b, admin);
    try {
      const mk = async (name, company) => (await r('POST', 'leads', { name, company, country: 'Spain', mode: 'buy', seats: 60, budget: 9e6 })).body;
      const held = await mk('Иван Петров', ''); assert.equal(held.status, 'compliance-hold'); assert.equal(held.screening.status, 'hit', 'Cyrillic sanctions-list name must be held through the API');
      assert.equal((await mk('张伟', '')).status, 'compliance-hold');
      const ok = await mk('Алексей Смирнов', 'Север Авиа'); assert.equal(ok.status, 'qualified');
      for (const n of ['Hans Müller', 'José García', 'Straße Trading', 'İbrahim Öz', 'Łukasz Øvergård']) await mk(n, '');
      const find = async (qy) => (await r('GET', 'leads/search?q=' + encodeURIComponent(qy))).body.map((l) => l.name);
      assert.deepEqual(await find('смирнов'), ['Алексей Смирнов']); assert.deepEqual(await find('СЕВЕР'), ['Алексей Смирнов']);
      assert.deepEqual(await find('MÜLLER'), ['Hans Müller']); assert.deepEqual(await find('muller'), ['Hans Müller']); assert.deepEqual(await find('garcia'), ['José García']);
      assert.deepEqual(await find('strasse'), ['Straße Trading']); assert.deepEqual(await find('ibrahim'), ['İbrahim Öz']); assert.deepEqual(await find('lukasz'), ['Łukasz Øvergård']);
      assert.deepEqual(await find('张伟'), ['张伟']);
      assert.equal((await find('%%')).length, 0, 'wildcards are literal'); assert.equal((await r('GET', 'leads/search?q=%20%20')).status, 400);
      // deals search and the privacy flow work for non-Latin names too
      const d = (await r('POST', 'deals', { leadId: ok.id, aircraftId: 'TP-01' })).body; assert.ok(d.id);
      assert.deepEqual((await r('GET', 'deals/search?q=' + encodeURIComponent('СМИРНОВ'))).body.map((x) => x.id), [d.id]);
      assert.equal((await r('GET', `leads/${ok.id}/export`)).body.lead.name, 'Алексей Смирнов');
      assert.equal((await r('DELETE', `leads/${ok.id}`)).status, 200); assert.deepEqual(await find('смирнов'), []);
      assert.ok(!JSON.stringify([store.db.prepare('SELECT * FROM activity').all(), store.db.prepare('SELECT * FROM leads').all()]).includes('Смирнов'), 'erased Cyrillic name must be gone everywhere');

      // search stays fast on a big table
      store.tx(() => { for (let i = 0; i < 50000; i++) store.leads.insert({ id: 'bulk' + i, createdAt: new Date(Date.UTC(2020, 0, 1) + i * 1000).toISOString(), name: 'Покупатель ' + i, company: 'Компания ' + i, email: `b${i}@example.com`, country: 'Spain', status: 'qualified', request: {}, screening: { ok: true }, matches: [] }); });
      const t0 = Date.now(); const big = (await r('GET', 'leads/search?q=' + encodeURIComponent('ПОКУПАТЕЛЬ 49999'))).body; const ms = Date.now() - t0;
      assert.deepEqual(big.map((l) => l.id), ['bulk49999']); assert.ok(ms < 1500, `search over 50,000 leads took ${ms} ms`);
      console.log(`unicode tests passed (search over 50,000 leads: ${ms} ms)`); process.exit(0);
    } catch (e) { console.error(e); process.exit(1); }
  });
})().catch((e) => { console.error(e); process.exit(1); });
