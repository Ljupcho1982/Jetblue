// End-to-end API test against a throwaway database file.
process.env.DB_FILE = require('path').join(require('os').tmpdir(), 'deal-test-' + Date.now() + '.json');
delete process.env.ANTHROPIC_API_KEY;
const assert = require('assert');
const server = require('./server.js');
server.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (m, p, b) => { const r = await fetch(base + '/api/' + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, j: await r.json() }; };
  try {
    const lead = (await call('POST', 'leads', { name: 'Alex', country: 'Spain', mode: 'buy', seats: 60, rangeNm: 700, budget: 9000000 })).j;
    assert.equal(lead.status, 'qualified'); assert.ok(lead.matches.length);
    const bad = (await call('POST', 'leads', { name: 'X', country: 'Iran', mode: 'buy' })).j;
    assert.equal(bad.status, 'compliance-hold'); assert.equal(bad.matches.length, 0);
    assert.equal((await call('POST', 'deals', { leadId: bad.id, aircraftId: 'TP-01' })).s, 400);
    let deal = (await call('POST', 'deals', { leadId: lead.id, aircraftId: 'TP-01' })).j;
    deal = (await call('POST', `deals/${deal.id}/offer`, { offer: 8000000 })).j;
    const draft = deal.messages.find((m) => m.status === 'draft');
    assert.equal(draft.action, 'counter'); assert.equal(draft.source, 'template');
    assert.equal((await call('POST', `deals/${deal.id}/offer`, { offer: 8100000 })).s, 409);
    deal = (await call('POST', `deals/${deal.id}/messages/${draft.id}/approve`, { text: draft.text + ' Happy to talk by phone.' })).j;
    let st = (await call('GET', 'state')).j;
    assert.equal(st.learned.length, 1, 'edit should be learned');
    deal = (await call('POST', `deals/${deal.id}/offer`, { offer: 9400000 })).j;
    const d2 = deal.messages.find((m) => m.status === 'draft');
    assert.equal(d2.action, 'accept');
    deal = (await call('POST', `deals/${deal.id}/messages/${d2.id}/approve`, {})).j;
    assert.equal(deal.stage, 'LOI');
    const ev = (await call('POST', 'eval')).j;
    assert.equal(ev.passed, ev.total, JSON.stringify(ev.rows.filter((r) => !r.pass)));
    assert.equal((await call('POST', 'inventory', { model: 'X', listPrice: 100, floor: 200 })).s, 400);
    console.log('api tests passed (' + ev.total + ' scenarios)');
    process.exit(0);
  } catch (e) { console.error(e); process.exit(1); }
});
