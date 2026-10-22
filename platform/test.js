const assert = require('assert');
const L = require('./logic.js');
const [atr, , phenom] = L.INVENTORY;

assert.equal(L.screen({ country: 'Iran' }).ok, false);
assert.equal(L.screen({ country: 'Spain' }).ok, true);
assert.ok(L.matchAircraft({ seats: 60, rangeNm: 700, budget: 10000000, mode: 'buy' }).every((x) => x.aircraft.seats >= 60));
assert.equal(L.matchAircraft({ seats: 500, mode: 'buy' }).length, 0);

assert.equal(L.negotiate({ aircraft: atr, mode: 'buy', offer: 9000000, round: 1 }).action, 'accept');
for (let r = 1; r <= 3; r++) {
  const d = L.negotiate({ aircraft: atr, mode: 'buy', offer: 8000000, round: r });
  assert.equal(d.action, 'counter');
  assert.ok(d.price >= atr.floor, 'counter below floor');
  assert.ok(!d.message.includes(String(atr.floor)), 'floor leaked');
}
assert.equal(L.negotiate({ aircraft: atr, mode: 'buy', offer: 5000000, round: 1 }).action, 'escalate');
assert.equal(L.negotiate({ aircraft: atr, mode: 'buy', offer: 8000000, round: 4 }).action, 'escalate');
const ls = L.negotiate({ aircraft: phenom, mode: 'lease', offer: 62000, round: 1, termMonths: 12 });
assert.notEqual(ls.action, 'accept'); assert.ok(ls.flags.length > 0); assert.equal(ls.status, 'DRAFT');

// Configurable rules: stricter escalation threshold and round limit
assert.equal(L.negotiate({ aircraft: atr, mode: 'buy', offer: 8000000, round: 2, rules: { maxRounds: 2 } }).action, 'escalate');
const soft = L.negotiate({ aircraft: atr, mode: 'buy', offer: 8000000, round: 1, rules: { stepBase: 0, stepPerRound: 0.1 } });
assert.ok(soft.price > L.negotiate({ aircraft: atr, mode: 'buy', offer: 8000000, round: 1, rules: { stepBase: 0.9 } }).price);

// Guardrail on model-written text
const ok = { allowed: [8000000, 9040000], secrets: [atr.floor] };
assert.ok(L.validateMessage('We can propose $9,040,000 for the ATR.', ok).ok);
assert.ok(!L.validateMessage('Our floor is $8,600,000.', ok).ok);
assert.ok(!L.validateMessage('How about $8,700,000?', ok).ok);
assert.ok(!L.validateMessage('This is a legally binding offer at $9,040,000.', ok).ok);

// Guardrail: private limits must not leak in ANY written form; legitimate wording must still pass
const lim = { allowed: [8000000, 9040000, 2008, 70, 825], secrets: [8600000] };
for (const leak of ['Our floor is 8.6 million.', 'We could go to 8.6M.', 'USD 8,600,000 works.', 'EUR 8.6m is the lowest.', 'We can do eight point six million.', 'Offer 8 600 000 and we agree.',
  'Our best is 8,6 million.', '8.6 mio is fine.'.replace('mio', 'million'), 'How about $8.7 million?', 'Around nine million dollars.', 'About half a million less.', 'It would be $500 cheaper.', 'We have 31,000 hours on the airframe.'])
  assert.equal(L.validateMessage(leak, lim).ok, false, 'guardrail missed: ' + leak);
for (const fine of ['We can propose $9,040,000 for the ATR 72-500 (TP-01).', 'We can propose 9.04 million.', 'We can propose $9.04M, thanks for $8,000,000.', 'USD 9 040 000 all in.',
  'Built in 2008 with 70 seats, range 825 nm, 36 months minimum, 5% fee.', 'Call us on 14 March; ref TP-01, 2026-10-22.'])
  assert.equal(L.validateMessage(fine, lim).ok, true, 'guardrail wrongly rejected: ' + fine);
assert.deepEqual(L.extractAmounts('$9.04M and 1,971 nm').map((a) => a.value), [9040000, 1971]);

// Negotiation invariants, swept over every aircraft, mode, offer level, lease term and round
{
  let checked = 0;
  for (const a of L.INVENTORY) for (const mode of ['buy', 'lease']) {
    const list = mode === 'lease' ? a.leaseMonthly : a.listPrice, floor = mode === 'lease' ? a.minLeaseMonthly : a.floor;
    const limit = Math.max(floor, mode === 'lease' ? 0 : list * (1 - a.maxDiscountPct / 100));
    for (let f = 0.5; f <= 1.3; f += 0.01) for (const term of [undefined, 6, a.minTermMonths, 120]) {
      let prev = Infinity;
      for (let round = 1; round <= 6; round++) {
        const offer = Math.round(list * f), d = L.negotiate({ aircraft: a, mode, offer, round, termMonths: mode === 'lease' ? term : undefined }), at = `${a.id} ${mode} offer=${offer} r${round} term=${term}`;
        checked++;
        if (d.price != null) assert.ok(d.price >= floor && Number.isFinite(d.price) && d.price > 0, 'price below floor: ' + at);
        if (d.action === 'accept') { assert.ok(offer >= limit && !d.flags.length, 'bad accept: ' + at); assert.equal(d.price, offer); }
        if (d.action === 'counter') {
          assert.ok(d.price <= Math.max(list, offer), 'counter above asking: ' + at);
          assert.ok(d.price >= offer, 'counter below the buyer\'s own offer: ' + at);
          assert.ok(d.price <= prev, 'counter got worse for the buyer in a later round: ' + at);
          if (offer >= limit) assert.equal(d.price, offer, 'only the term is wrong, price must stay at the offer: ' + at);
          prev = d.price;
        }
        if (offer < limit * 0.85 || (round >= 4 && offer < limit)) assert.equal(d.action, 'escalate', 'should escalate: ' + at);
      }
    }
  }
  assert.ok(checked > 10000);
  const t1 = L.negotiate({ aircraft: L.INVENTORY[0], mode: 'lease', offer: 86450, round: 1, termMonths: 6 });
  assert.equal(t1.action, 'counter'); assert.equal(t1.price, 86450); assert.match(t1.message, /price works for us/); assert.match(t1.message, /minimum term of 36 months/);
}

// Matching: every result meets the hard requirements and is reachable within budget; results are ordered best first
{
  let n = 0;
  for (const mode of ['buy', 'lease']) for (const budget of [undefined, 0, 30000, 60000, 150000, 3e6, 9e6, 25e6]) for (const seats of [0, 6, 50, 60, 90]) for (const type of ['any', 'turboprop', 'light jet']) for (const rangeNm of [0, 800, 2000]) {
    const req = { mode, budget, seats, type, rangeNm, maxAge: 15 }, res = L.matchAircraft(req);
    for (const m of res) {
      const a = m.aircraft, list = mode === 'lease' ? a.leaseMonthly : a.listPrice, lowest = mode === 'lease' ? a.minLeaseMonthly : Math.max(a.floor, list * (1 - a.maxDiscountPct / 100)), at = JSON.stringify(req) + ' ' + a.id;
      assert.ok(a.seats >= seats && a.rangeNm >= rangeNm && (type === 'any' || a.type === type) && new Date().getFullYear() - a.year <= 15, 'hard requirement broken: ' + at);
      if (budget) assert.ok(lowest <= budget * 1.05, 'unreachable aircraft returned: ' + at);
      assert.ok(m.score > 0 && m.score <= 100, 'score out of range: ' + at);
    }
    for (let i = 1; i < res.length; i++) assert.ok(res[i - 1].score >= res[i].score, 'not sorted');
    n++;
  }
  assert.ok(n > 500);
  const by = (b) => L.matchAircraft({ mode: 'buy', budget: b, seats: 60 }).map((m) => m.aircraft.id);
  assert.deepEqual(by(9e6), ['TP-01'], 'a 9M / 60-seat buyer should see only the ATR 72-500');
  assert.ok(by(3e6).length === 0, 'nothing with 60 seats is within a 3M budget');
  const top = L.matchAircraft({ mode: 'buy', seats: 60 })[0].aircraft; assert.ok(top.seats / 60 <= 1.25, 'best fit should be near the seat requirement');
  assert.match(L.matchAircraft({ mode: 'buy', budget: 9e6, seats: 60 })[0].reasons[0], /within reach/);
}
console.log('logic tests passed');
