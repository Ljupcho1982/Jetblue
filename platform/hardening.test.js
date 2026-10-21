// Input validation, XSS-relevant data, path traversal, malformed requests, activity-log privacy.
process.env.DB_FILE = require('path').join(require('os').tmpdir(), 'deal-hard-' + Date.now() + '.db');
delete process.env.LLM_PROVIDER; delete process.env.ANTHROPIC_API_KEY; delete process.env.MAIL_PROVIDER;
const assert = require('assert'), http = require('http');
const server = require('./server.js');
const { raw, adminClient, PASSWORD } = require('./testlib.js');
const good = { model: 'Test 1', type: 'turboprop', year: 2010, hours: 1000, seats: 50, rangeNm: 800, location: 'X', listPrice: 1000000, floor: 900000, maxDiscountPct: 5, leaseMonthly: 10000, minLeaseMonthly: 9000, minTermMonths: 12 };

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port, base = 'http://127.0.0.1:' + port;
  const r = (m, p, b, c) => raw(base, m, p, b, c);
  try {
    const admin = await adminClient(base);
    // Inventory validation: HTML in ids, NaN, negative, absurd, floor above list
    for (const bad of [{ id: 'X"><img src=x id=pwn>' }, { id: 'a b' }, { id: 'x'.repeat(41) }, { year: 'abc' }, { listPrice: -5 }, { listPrice: 1e12 }, { seats: -1 }, { floor: 2000000 }, { maxDiscountPct: 150 }, { minLeaseMonthly: 20000 }, { model: '   ' }])
      assert.equal((await r('POST', 'inventory', { ...good, ...bad }, admin)).status, 400, JSON.stringify(bad));
    assert.equal((await r('POST', 'inventory', { ...good, id: 'OK-1', model: '<b>bold</b>' }, admin)).status, 200);
    // Lead validation
    const lead = { name: 'Alex', country: 'Spain', mode: 'buy', seats: 60, rangeNm: 700, budget: 9e6 };
    for (const bad of [{ mode: '"><img src=x>' }, { mode: undefined }, { seats: 'many' }, { budget: -1 }, { rangeNm: 1e9 }])
      assert.equal((await r('POST', 'leads', { ...lead, ...bad }, admin)).status, 400, JSON.stringify(bad));
    const L = (await r('POST', 'leads', { ...lead, name: 'N'.repeat(500) }, admin)).body; assert.equal(L.name.length, 100);
    // Offer validation and a lease deal still works end to end
    const deal = (await r('POST', 'deals', { leadId: L.id, aircraftId: 'TP-01' }, admin)).body;
    for (const bad of [-5, 0, 'abc', 1e12, null]) assert.equal((await r('POST', `deals/${deal.id}/offer`, { offer: bad }, admin)).status, 400, String(bad));
    assert.equal((await r('POST', `deals/${deal.id}/offer`, { offer: 8e6, termMonths: 99999 }, admin)).status, 400);
    const d = (await r('POST', `deals/${deal.id}/offer`, { offer: 8e6 }, admin)).body, m = d.messages.find((x) => x.status === 'draft');
    assert.equal((await r('POST', `deals/${deal.id}/messages/${m.id}/approve`, { text: 'x'.repeat(5001) }, admin)).status, 400);
    assert.equal((await r('POST', `deals/${deal.id}/messages/${m.id}/approve`, { text: { a: 1 } }, admin)).status, 400);
    assert.equal((await r('POST', `deals/${deal.id}/messages/${m.id}/approve`, {}, admin)).status, 200);
    // Playbook validation
    for (const bad of [{ rules: { maxRounds: 0 } }, { rules: { stepBase: 5 } }, { rules: { escalateBelowPct: 'x' } }, { examples: 'nope' }, { examples: [{ situation: 1, reply: 2 }] },
      { scenarios: [{ name: 'x', aircraftId: '"><b>', mode: 'buy', offer: 1, expect: 'accept' }] }, { scenarios: [{ name: 'x', aircraftId: 'TP-01', mode: 'sell', offer: 1, expect: 'accept' }] }, { systemPrompt: 5 }])
      assert.equal((await r('PUT', 'playbook', bad, admin)).status, 400, JSON.stringify(bad));
    assert.equal((await r('PUT', 'playbook', { rules: { maxRounds: 3 } }, admin)).status, 200);

    // Malformed cookie must not crash anything
    for (const c of ['sid=%E0%A4%A', 'sid=%', '=;;;', 'sid']) assert.equal((await r('GET', 'state', null, c)).status, 401, c);
    // Oversized body: 413 and the server keeps serving
    const big = await fetch(base + '/api/leads', { method: 'POST', headers: { 'content-type': 'application/json', cookie: admin }, body: JSON.stringify({ name: 'x'.repeat(2e6) }) });
    assert.equal(big.status, 413);
    assert.equal((await r('GET', 'me', null, admin)).status, 200);
    assert.equal((await r('POST', 'leads', null, admin)).status, 400); // empty JSON object body: invalid mode
    // Invalid JSON
    const badJson = await fetch(base + '/api/leads', { method: 'POST', headers: { 'content-type': 'application/json', cookie: admin }, body: '{nope' }); assert.equal(badJson.status, 400);

    // Path traversal and private files are never served
    const get = (p) => new Promise((res) => http.get({ host: '127.0.0.1', port, path: p }, (x) => { let b = ''; x.on('data', (c) => b += c); x.on('end', () => res({ status: x.statusCode, body: b })); }));
    for (const p of ['/../server.js', '/%2e%2e/server.js', '/..%2fserver.js', '/public/../store.js', '/%2e%2e%2fstore.js', '/logic.js', '/store.js', '/data/platform.db', '/.env', '/public', '/..\\server.js']) {
      const x = await get(p); assert.ok(x.status === 404 || x.status === 400, p + ' -> ' + x.status); assert.ok(!/require\('node:sqlite'\)|scrypt|DatabaseSync/.test(x.body), p + ' leaked source');
    }
    assert.equal((await get('/app.js')).status, 200);
    assert.equal((await get('/healthz')).status, 200);

    // Activity log privacy: failed logins for unknown emails are not logged; auth events visible to admins only
    await r('POST', 'login', { email: 'my-typed-password-123@oops', password: 'x' });
    await r('POST', 'users', { email: 'bro@x.com', name: 'Bro', role: 'broker', password: PASSWORD }, admin);
    await r('POST', 'users', { email: 'vie@x.com', name: 'Vie', role: 'viewer', password: PASSWORD }, admin);
    await r('POST', 'login', { email: 'bro@x.com', password: 'wrong-wrong-wrong' });
    const adminAct = JSON.stringify((await r('GET', 'state', null, admin)).body.activity);
    assert.ok(adminAct.includes('Failed login') && adminAct.includes('bro@x.com'), 'admin should see failed logins for real accounts');
    assert.ok(!adminAct.includes('my-typed-password'), 'unknown-email attempts must not be logged');
    for (const email of ['bro@x.com', 'vie@x.com']) {
      const c = (await r('POST', 'login', { email, password: PASSWORD })).cookie;
      const act = (await r('GET', 'state', null, c)).body.activity;
      assert.ok(act.length > 0 && !act.some((x) => /^(Login|Failed|User |Password|Two-factor|Admin account)/.test(x.msg)), email + ' sees auth events: ' + JSON.stringify(act.map((x) => x.msg)));
      assert.ok(act.some((x) => /^Deal opened|^Lead /.test(x.msg)), 'business activity should stay visible');
    }

    // Login lockout map stays bounded under a flood of random emails
    for (let i = 0; i < 30; i++) await r('POST', 'login', { email: `flood${i}@x.com`, password: 'nope-nope-nope' });
    console.log('hardening tests passed'); process.exit(0);
  } catch (e) { console.error(e); process.exit(1); }
});
