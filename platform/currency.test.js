// One currency per deployment: formatting, guardrail, drafts, edit confirmation and CSV import all follow CURRENCY.
const os = require('os'), path = require('path'), assert = require('assert');
process.env.DB_FILE = path.join(os.tmpdir(), 'deal-currency-' + Date.now() + '.db');
delete process.env.LLM_PROVIDER; delete process.env.ANTHROPIC_API_KEY; delete process.env.MAIL_PROVIDER; delete process.env.CURRENCY;
const L = require('./logic.js');
const atr = L.INVENTORY[0];

// --- formatting and guardrail, per currency ---
const SYMBOL = { USD: '$', EUR: '€', GBP: '£', CHF: 'CHF', JPY: '¥', AED: 'AED', CAD: 'CA$', SEK: 'SEK' };
for (const code of Object.keys(SYMBOL)) {
  process.env.CURRENCY = code;
  const price = L.fmt(9310000), offer = L.fmt(8000000), floor = L.fmt(atr.floor);
  assert.ok(price.includes(SYMBOL[code]) && /9,310,000/.test(price), `${code}: ${price}`);
  const ctx = { allowed: [8000000, 9310000, 2008, 70, 825], secrets: [atr.floor] };
  assert.equal(L.validateMessage(`Thank you for your offer of ${offer}. We can propose ${price}, about 9.31 million.`, ctx).ok, true, code + ' legitimate message rejected');
  for (const leak of [`Our floor is ${floor}.`, `We could go to ${SYMBOL[code]}8.6M.`, `Lowest is 8.6 million ${code}.`, `How about ${L.fmt(8700000)}?`, `Perhaps ${code} 8 600 000.`])
    assert.equal(L.validateMessage(leak, ctx).ok, false, `${code} guardrail missed: ${leak}`);
  const d = L.negotiate({ aircraft: atr, mode: 'buy', offer: 8000000, round: 1 });
  assert.ok(d.message.includes(price) && d.message.includes(offer), `${code} template: ${d.message}`);
  assert.equal(L.validateMessage(d.message, ctx).ok, true, code + ' template must pass its own guardrail');
}
process.env.CURRENCY = 'XXX1'; assert.equal(L.currency(), 'USD'); assert.equal(L.fmt(1000), '$1,000'); process.env.CURRENCY = 'eur'; assert.equal(L.currency(), 'EUR', 'case-insensitive');
delete process.env.CURRENCY;

// --- through the API, in euros ---
process.env.CURRENCY = 'EUR';
const server = require('./server.js'), { raw, adminClient } = require('./testlib.js');
server.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port, admin = await adminClient(base), r = (m, p, b) => raw(base, m, p, b, admin);
  try {
    assert.equal((await r('GET', 'state')).body.currency, 'EUR');
    const lead = (await r('POST', 'leads', { name: 'Alex', country: 'Spain', mode: 'buy', seats: 60, rangeNm: 700, budget: 9e6 })).body;
    const deal = (await r('POST', 'deals', { leadId: lead.id, aircraftId: 'TP-01' })).body;
    const d = (await r('POST', `deals/${deal.id}/offer`, { offer: 8e6 })).body, draft = d.messages.find((m) => m.status === 'draft');
    assert.ok(draft.text.includes('€9,310,000') && draft.text.includes('€8,000,000') && !draft.text.includes('$'), draft.text);
    assert.equal(d.messages.find((m) => m.role === 'buyer').text, 'Offer: €8,000,000');
    assert.equal((await r('POST', `deals/${deal.id}/messages/${draft.id}/approve`, { text: draft.text.replace('€9,310,000', '€8,300,000') })).status, 409, 'edited price must need confirmation in any currency');
    assert.equal((await r('POST', `deals/${deal.id}/messages/${draft.id}/approve`, { text: draft.text + ' Call me.' })).status, 200);

    // CSV: money cells may carry symbols, codes and thousands separators; text cells are left alone
    const HEAD = 'id,model,type,year,hours,seats,rangeNm,location,listPrice,floor,maxDiscountPct,leaseMonthly,minLeaseMonthly,minTermMonths';
    const csv = [HEAD, 'C-1,ATR 72-600,turboprop,2015,18000,70,825,"Zürich, Switzerland","€12,500,000","€11 500 000",8,"EUR 115,000",CHF 105000,36', 'C-2,EUROFIGHTER Trainer,light jet,2016,3000,2,1971,Dallas,£6200000,GBP 5700000,7,£62000,£56000,24'].join('\n');
    const imp = await r('POST', 'inventory/import', { csv, dryRun: false }); assert.equal(imp.status, 200, JSON.stringify(imp.body)); assert.equal(imp.body.created, 2);
    const inv = (await r('GET', 'state')).body.inventory, c1 = inv.find((a) => a.id === 'C-1'), c2 = inv.find((a) => a.id === 'C-2');
    assert.deepEqual([c1.listPrice, c1.floor, c1.leaseMonthly, c1.minLeaseMonthly, c1.location], [12500000, 11500000, 115000, 105000, 'Zürich, Switzerland']);
    assert.deepEqual([c2.listPrice, c2.floor, c2.model], [6200000, 5700000, 'EUROFIGHTER Trainer'], 'a model name starting with letters must not be mangled');
    console.log('currency tests passed'); process.exit(0);
  } catch (e) { console.error(e); process.exit(1); }
});
