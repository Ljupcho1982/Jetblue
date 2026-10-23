// Broker edits that change money or wording must be confirmed.
process.env.DB_FILE = require('path').join(require('os').tmpdir(), 'deal-approve-' + Date.now() + '.db');
delete process.env.LLM_PROVIDER; delete process.env.ANTHROPIC_API_KEY; delete process.env.MAIL_PROVIDER;
const assert = require('assert'), server = require('./server.js'), { raw, adminClient } = require('./testlib.js');
server.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port, ck = await adminClient(base), r = (m, p, b) => raw(base, m, p, b, ck);
  try {
    const lead = (await r('POST', 'leads', { name: 'Alex', country: 'Spain', mode: 'buy', seats: 60, rangeNm: 700, budget: 9e6 })).body;
    const draft = async (offer = 8000000) => { const d = (await r('POST', 'deals', { leadId: lead.id, aircraftId: 'TP-01' })).body; const x = (await r('POST', `deals/${d.id}/offer`, { offer })).body; return { deal: d, msg: x.messages.find((m) => m.status === 'draft') }; };
    const approve = (x, text, extra) => r('POST', `deals/${x.deal.id}/messages/${x.msg.id}/approve`, { text, ...extra });
    // drafted price is $9,310,000 for an $8,000,000 offer on TP-01 (floor $8,600,000)
    let x = await draft();
    assert.equal(x.msg.price, 9310000);
    // unchanged text and wording-only edits go through without a prompt
    { const res = await approve(x, x.msg.text + ' Happy to talk by phone, ext 12.'); assert.equal(res.status, 200, JSON.stringify(res.body)); }
    // other amounts: typo, round-down, below floor, spelled out, binding wording -> 409 needsConfirm, nothing is sent
    for (const [edit, re] of [[(t) => t.replace('$9,310,000', '$8,040,000'), /not the drafted price|below/], [(t) => t.replace('$9,310,000', '$9.0 million'), /not the drafted price/],
      [(t) => t + ' We could even do $8,300,000.', /below this aircraft's floor price/], [(t) => t.replace('$9,310,000', 'nine million'), /not the drafted price|spelled/], [(t) => t + ' We guarantee delivery.', /binding wording/]]) {
      x = await draft(); const text = edit(x.msg.text), res = await approve(x, text);
      assert.equal(res.status, 409, text); assert.equal(res.body.needsConfirm, true); assert.match(res.body.error, re, res.body.error);
      const still = (await r('GET', 'state')).body.deals.find((d) => d.id === x.deal.id).messages.find((m) => m.id === x.msg.id);
      assert.equal(still.status, 'draft', 'must remain a draft until confirmed');
    }
    // confirming sends it and leaves an audit trail; the edit is still learned from
    x = await draft(); const typo = x.msg.text.replace('$9,310,000', '$8,300,000');
    const ok = await approve(x, typo, { confirmPriceChange: true }); assert.equal(ok.status, 200);
    assert.equal(ok.body.messages.find((m) => m.id === x.msg.id).status, 'sent');
    const st = (await r('GET', 'state')).body; assert.ok(st.activity.some((a) => /Broker confirmed an edited amount/.test(a.msg)));
    assert.ok(st.learned.some((e) => e.reply === typo));
    // confirmPriceChange must be exactly true, and a lease uses the lease floor
    x = await draft(); assert.equal((await approve(x, x.msg.text.replace('$9,310,000', '$8,300,000'), { confirmPriceChange: 'yes' })).status, 409);
    console.log('approve tests passed'); process.exit(0);
  } catch (e) { console.error(e); process.exit(1); }
});
