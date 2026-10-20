const assert = require('assert');
const L = require('./logic.js');
const [atr, , phenom] = L.INVENTORY;

assert.equal(L.screen({ country: 'Iran' }).ok, false);
assert.equal(L.screen({ country: 'Spain' }).ok, true);

let m = L.matchAircraft({ seats: 60, rangeNm: 700, budget: 10000000, mode: 'buy' });
assert.ok(m.length >= 1 && m.every((x) => x.aircraft.seats >= 60));
assert.equal(L.matchAircraft({ seats: 500, mode: 'buy' }).length, 0);

// Accept: at or above the lowest allowed price
assert.equal(L.negotiate({ aircraft: atr, mode: 'buy', offer: 9000000, round: 1 }).action, 'accept');
// Counter: below limit but not absurd, and never below the floor
for (let r = 1; r <= 3; r++) {
  const d = L.negotiate({ aircraft: atr, mode: 'buy', offer: 8000000, round: r });
  assert.equal(d.action, 'counter');
  assert.ok(d.price >= atr.floor, 'counter below floor');
  assert.ok(!d.message.includes(String(atr.floor)), 'floor leaked');
}
// Escalate: far too low or stalled
assert.equal(L.negotiate({ aircraft: atr, mode: 'buy', offer: 5000000, round: 1 }).action, 'escalate');
assert.equal(L.negotiate({ aircraft: atr, mode: 'buy', offer: 8000000, round: 4 }).action, 'escalate');
// Lease: short term flagged and never auto-accepted
const ls = L.negotiate({ aircraft: phenom, mode: 'lease', offer: 62000, round: 1, termMonths: 12 });
assert.notEqual(ls.action, 'accept');
assert.ok(ls.flags.length > 0);
// Every output is a draft
assert.equal(ls.status, 'DRAFT');
console.log('all tests passed');
