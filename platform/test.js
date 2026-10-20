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
console.log('logic tests passed');
