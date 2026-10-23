// The UI state stays bounded as data grows, totals stay exact, old open work is never hidden, and search finds old records.
process.env.DB_FILE = require('path').join(require('os').tmpdir(), 'deal-scale-' + Date.now() + '.db');
delete process.env.LLM_PROVIDER; delete process.env.ANTHROPIC_API_KEY; delete process.env.MAIL_PROVIDER;
const assert = require('assert'), store = require('./store.js'), server = require('./server.js'), { raw, adminClient, PASSWORD } = require('./testlib.js');
const N = 3000;
store.tx(() => {
  for (let i = 0; i < N; i++) {
    const at = new Date(Date.UTC(2025, 0, 1) + i * 60000).toISOString(), hold = i === 5; // lead 5 is old and waiting for review
    store.leads.insert({ id: 'l' + i, createdAt: at, name: i === 7 ? 'Zephyr Quill' : 'Buyer ' + i, company: i === 7 ? 'Quill 100% Aviation' : 'Co ' + i, email: `b${i}@x.com`, country: 'Spain', status: hold ? 'compliance-hold' : 'qualified', request: { mode: 'buy' },
      screening: hold ? { ok: false, status: 'review', reasons: ['x'] } : { ok: true, status: 'clear' }, matches: [] });
    // deal 0-9 are the oldest: 3 still negotiating, 1 escalated, rest closed; later deals are mostly LOI
    store.deals.insert({ id: 'd' + i, leadId: 'l' + i, aircraftId: 'TP-01', buyer: i === 7 ? 'Zephyr Quill' : 'Buyer ' + i, company: 'Co ' + i, mode: 'buy', stage: i < 3 ? 'negotiating' : i === 3 ? 'escalated' : 'LOI' });
    store.deals.addBuyerMessage('d' + i, 'b' + i, 'Offer: $8,000,000');
    store.db.prepare("INSERT INTO messages (id,deal_id,role,status,action,price,flags,note,text,source,original,at,sent_at,delivery_status) VALUES (?,?,'assistant','sent','counter',9310000,'[]','n','We can propose $9,310,000.','template','x',?,?,?)").run('a' + i, 'd' + i, at, at, i === 4 ? 'failed' : 'sent');
  }
  store.db.prepare("INSERT INTO messages (id,deal_id,role,status,action,price,flags,note,text,source,original,at) VALUES ('draft0','d1','assistant','draft','counter',9310000,'[]','n','Draft','template','Draft','2025-01-01')").run();
});

server.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port, admin = await adminClient(base), r = (m, p, b, c) => raw(base, m, p, b, c || admin);
  try {
    const t0 = Date.now(), res = await fetch(base + '/api/state', { headers: { cookie: admin } }), body = await res.text(), ms = Date.now() - t0, st = JSON.parse(body);
    assert.ok(body.length < 400000, `state is ${(body.length / 1e6).toFixed(2)} MB for ${N} deals; it must stay bounded`); assert.ok(ms < 500, ms + ' ms');
    // exact totals regardless of what the lists carry
    assert.deepEqual([st.counts.leads, st.counts.deals, st.counts.dealsNegotiating, st.counts.dealsEscalated, st.counts.dealsLOI, st.counts.draftsPending], [N, N, 3, 1, N - 4, 1]);
    assert.equal(st.counts.leadsQualified, N - 1);
    assert.ok(st.leads.length <= 201 && st.deals.length <= 110, `${st.leads.length} leads, ${st.deals.length} deals`);
    // old work that still needs attention is always present, even though it is far outside the newest-N window
    const ids = new Set(st.deals.map((d) => d.id));
    for (const id of ['d0', 'd1', 'd2', 'd3', 'd4']) assert.ok(ids.has(id), id + ' (open, escalated or undelivered email) must be listed');
    assert.ok(st.leads.some((l) => l.id === 'l5'), 'old lead waiting for compliance must be listed');
    assert.ok(st.deals.find((d) => d.id === 'd1').messages.some((m) => m.status === 'draft'), 'pending draft visible');
    assert.ok(!ids.has('d10') && ids.has('d' + (N - 1)), 'closed old deals drop out, the newest stay');
    assert.ok(Object.keys(st.counts).length >= 8);

    // search: finds old records, case-insensitive, wildcards are literal, validated, permissioned
    const s1 = (await r('GET', 'leads/search?q=zephyr')).body; assert.deepEqual(s1.map((l) => l.id), ['l7']);
    assert.deepEqual((await r('GET', 'leads/search?q=' + encodeURIComponent('b7@x.com'))).body.map((l) => l.id), ['l7']);
    assert.deepEqual((await r('GET', 'leads/search?q=' + encodeURIComponent('100%'))).body.map((l) => l.id), ['l7'], '% must match a literal percent sign');
    assert.equal((await r('GET', 'leads/search?q=' + encodeURIComponent('%%'))).body.length, 0, 'wildcards must not match everything');
    assert.equal((await r('GET', 'leads/search?q=' + encodeURIComponent('_'.repeat(3)))).body.length, 0);
    assert.equal((await r('GET', 'leads/search?q=l2999')).body[0].id, 'l2999', 'search by id');
    assert.ok((await r('GET', 'leads/search?q=Buyer')).body.length <= 50, 'result limit');
    assert.equal((await r('GET', 'leads/search?q=a')).status, 400); assert.equal((await r('GET', 'leads/search')).status, 400);
    const ds = (await r('GET', 'deals/search?q=zephyr')).body; assert.equal(ds.length, 1); assert.equal(ds[0].id, 'd7'); assert.equal(ds[0].messages.length, 2);
    assert.ok((await r('GET', 'deals/search?q=Buyer')).body.length <= 20);
    await r('POST', 'users', { email: 'v@x.com', name: 'V', role: 'viewer', password: PASSWORD }); await r('POST', 'users', { email: 'b@x.com', name: 'B', role: 'broker', password: PASSWORD });
    const vie = (await raw(base, 'POST', 'login', { email: 'v@x.com', password: PASSWORD })).cookie, bro = (await raw(base, 'POST', 'login', { email: 'b@x.com', password: PASSWORD })).cookie;
    assert.equal((await r('GET', 'leads/search?q=zephyr', null, vie)).status, 403); assert.equal((await r('GET', 'deals/search?q=zephyr', null, vie)).status, 403);
    assert.equal((await r('GET', 'leads/search?q=zephyr', null, bro)).status, 200);
    const vs = (await r('GET', 'state', null, vie)).body; assert.equal(vs.counts.deals, N); assert.ok(!JSON.stringify(vs).includes('b7@x.com'), 'viewer must not see buyer emails');

    // the privacy flow works on an old lead that the lists no longer carry
    const old = (await r('GET', 'leads/search?q=zephyr')).body[0];
    assert.ok(!(await r('GET', 'state')).body.leads.some((l) => l.id === old.id), 'precondition: lead is outside the newest window');
    assert.equal((await r('GET', `leads/${old.id}/export`)).status, 200); assert.equal((await r('DELETE', `leads/${old.id}`)).status, 200);
    assert.equal((await r('GET', 'leads/search?q=zephyr')).body.length, 0); assert.equal((await r('GET', 'state')).body.counts.leads, N - 1);
    console.log(`scale tests passed (${N} deals, state ${(body.length / 1e3).toFixed(0)} KB in ${ms} ms)`); process.exit(0);
  } catch (e) { console.error(e); process.exit(1); }
});
