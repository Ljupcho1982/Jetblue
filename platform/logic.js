// Core rules for the aircraft negotiator prototype. Works in the browser and in Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Logic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Mock inventory. floor and maxDiscountPct are internal and must never be shown to buyers.
  const INVENTORY = [
    { id: 'TP-01', model: 'ATR 72-500', type: 'turboprop', year: 2008, hours: 38000, seats: 70, rangeNm: 825, location: 'Madrid', listPrice: 9500000, floor: 8600000, maxDiscountPct: 8, leaseMonthly: 95000, minLeaseMonthly: 86000, minTermMonths: 36 },
    { id: 'TP-02', model: 'Dash 8-400', type: 'turboprop', year: 2012, hours: 22000, seats: 74, rangeNm: 1100, location: 'Toronto', listPrice: 14000000, floor: 12800000, maxDiscountPct: 8, leaseMonthly: 130000, minLeaseMonthly: 118000, minTermMonths: 48 },
    { id: 'LJ-01', model: 'Embraer Phenom 300', type: 'light jet', year: 2015, hours: 4200, seats: 8, rangeNm: 1971, location: 'Frankfurt', listPrice: 6200000, floor: 5700000, maxDiscountPct: 7, leaseMonthly: 62000, minLeaseMonthly: 56000, minTermMonths: 24 },
    { id: 'RJ-01', model: 'Embraer E175', type: 'regional jet', year: 2014, hours: 31000, seats: 78, rangeNm: 2200, location: 'Dublin', listPrice: 21000000, floor: 19000000, maxDiscountPct: 9, leaseMonthly: 190000, minLeaseMonthly: 172000, minTermMonths: 60 },
    // Sample listings for the demo. Specifications are indicative only and the prices are invented.
    { id: 'TP-03', model: 'ATR 42-600', type: 'turboprop', year: 2016, hours: 14200, seats: 48, rangeNm: 726, location: 'Toulouse', listPrice: 11800000, floor: 10900000, maxDiscountPct: 8, leaseMonthly: 108000, minLeaseMonthly: 98000, minTermMonths: 36 },
    { id: 'TP-04', model: 'Saab 340B+', type: 'turboprop', year: 2001, hours: 52000, seats: 34, rangeNm: 810, location: 'Stockholm', listPrice: 2400000, floor: 2100000, maxDiscountPct: 10, leaseMonthly: 28000, minLeaseMonthly: 24000, minTermMonths: 24 },
    { id: 'TP-05', model: 'Dash 8-300', type: 'turboprop', year: 2002, hours: 41000, seats: 50, rangeNm: 800, location: 'Vancouver', listPrice: 4600000, floor: 4100000, maxDiscountPct: 9, leaseMonthly: 52000, minLeaseMonthly: 46000, minTermMonths: 24 },
    { id: 'LJ-02', model: 'Cessna Citation CJ3+', type: 'light jet', year: 2014, hours: 3800, seats: 7, rangeNm: 1875, location: 'Dallas', listPrice: 4900000, floor: 4400000, maxDiscountPct: 7, leaseMonthly: 48000, minLeaseMonthly: 43000, minTermMonths: 24 },
    { id: 'LJ-03', model: 'Embraer Phenom 100E', type: 'light jet', year: 2018, hours: 1900, seats: 6, rangeNm: 1178, location: 'London', listPrice: 3900000, floor: 3600000, maxDiscountPct: 6, leaseMonthly: 39000, minLeaseMonthly: 35000, minTermMonths: 24 },
    { id: 'RJ-02', model: 'Bombardier CRJ-900', type: 'regional jet', year: 2010, hours: 36000, seats: 76, rangeNm: 1550, location: 'Atlanta', listPrice: 15500000, floor: 13900000, maxDiscountPct: 9, leaseMonthly: 150000, minLeaseMonthly: 135000, minTermMonths: 48 },
    { id: 'RJ-03', model: 'Embraer E190', type: 'regional jet', year: 2011, hours: 38000, seats: 100, rangeNm: 2400, location: 'Amsterdam', listPrice: 19500000, floor: 17600000, maxDiscountPct: 9, leaseMonthly: 175000, minLeaseMonthly: 158000, minTermMonths: 60 },
  ];

  // Placeholder only. Real screening must use a proper sanctions/KYC provider.
  const SANCTIONED = ['north korea', 'iran', 'syria', 'cuba'];

  function screen(buyer) {
    const c = (buyer.country || '').trim().toLowerCase();
    return SANCTIONED.includes(c) ? { ok: false, reason: 'Country on screening list' } : { ok: true };
  }

  // Score 0..100: hard requirements must pass, then closeness on budget and age.
  function matchAircraft(req, inventory = INVENTORY) {
    const price = (a) => (req.mode === 'lease' ? a.leaseMonthly : a.listPrice);
    return inventory
      .map((a) => {
        const reasons = [];
        if (req.seats && a.seats < req.seats) reasons.push('too few seats');
        if (req.rangeNm && a.rangeNm < req.rangeNm) reasons.push('range too short');
        if (req.maxAge && new Date().getFullYear() - a.year > req.maxAge) reasons.push('older than requested');
        if (req.type && req.type !== 'any' && a.type !== req.type) reasons.push('different type');
        if (reasons.length) return { aircraft: a, score: 0, reasons };
        let score = 70;
        if (req.budget) {
          const over = (price(a) - req.budget) / req.budget;
          if (over <= 0) score += 30;
          else if (over <= 0.15) score += 30 - over * 150; // within reach through negotiation
          else reasons.push('over budget');
        } else score += 15;
        return { aircraft: a, score: Math.max(0, Math.round(score)), reasons };
      })
      .filter((m) => m.score > 0)
      .sort((x, y) => y.score - x.score);
  }

  const fmt = (n) => '$' + Math.round(n).toLocaleString('en-US');

  // Decide how to respond to a buyer's offer. Returns a DRAFT; a human must approve it.
  // Sale: offer is the price. Lease: offer is the monthly rate.
  const DEFAULT_RULES = { stepBase: 0.4, stepPerRound: 0.2, escalateBelowPct: 85, maxRounds: 4, disclaimer: 'This is subject to contract and broker confirmation.' };

  function negotiate({ aircraft: a, mode, offer, round, termMonths, rules }) {
    const R = Object.assign({}, DEFAULT_RULES, rules || {});
    const lease = mode === 'lease';
    const list = lease ? a.leaseMonthly : a.listPrice;
    const floor = lease ? a.minLeaseMonthly : a.floor;
    const discountFloor = list * (1 - a.maxDiscountPct / 100);
    const limit = Math.max(floor, lease ? 0 : discountFloor);
    const unit = lease ? ' per month' : '';
    const flags = [];

    if (lease && termMonths && termMonths < a.minTermMonths)
      flags.push('Requested term ' + termMonths + ' months is below the minimum term.');

    if (offer >= limit && !flags.length) {
      return draft('accept', offer, `Thank you for your offer of ${fmt(offer)}${unit} on the ${a.model} (${a.id}). We are able to proceed on those terms, subject to contract, inspection and broker confirmation. Next step: a letter of intent.`, [], 'Within limits. Recommend LOI.');
    }
    if (offer < limit * (R.escalateBelowPct / 100) || round >= R.maxRounds) {
      return draft('escalate', null, `Thank you for your interest in the ${a.model}. Let me bring in our broker to discuss how we can find a workable structure.`, ['Offer far below limits or negotiation stalled after ' + round + ' rounds.', ...flags], 'Escalate to human broker.');
    }
    // Counter: move from list toward the limit by round, never below the limit.
    const step = Math.min(1, R.stepBase + R.stepPerRound * round);
    let counter = Math.max(limit, list - (list - limit) * step);
    counter = Math.max(counter, offer);
    counter = Math.round(counter / (lease ? 500 : 10000)) * (lease ? 500 : 10000);
    counter = Math.max(counter, limit);
    const concession = round >= 2 ? ' We can also offer a flexible inspection window.' : '';
    const termNote = flags.length ? ` We would need a minimum term of ${a.minTermMonths} months.` : '';
    return draft('counter', counter, `Thank you for your offer of ${fmt(offer)}${unit} on the ${a.model} (${a.id}). We cannot accept it, but we can propose ${fmt(counter)}${unit}.${concession}${termNote} ${R.disclaimer}`, flags, 'Counter inside limits. Review before sending.');
  }

  function draft(action, price, message, flags, note) {
    return { action, price, message, flags, internalNote: note, status: 'DRAFT' };
  }

  // ---- Guardrail for model-written text ----
  // Reads amounts the way a person would: "$9,040,000", "9.04 million", "9.04M", "USD 9 040 000", "9,04 million".
  // Spelled-out amounts ("nine million") are rejected outright because they cannot be checked reliably.
  const MULT = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };
  const AMOUNT_RE = /(\$|€|£|¥|\b(?:usd|eur|gbp|chf)\b)?\s?(\d{1,3}(?:[,   ]\d{3})+(?:\.\d+)?|\d+(?:[.,]\d+)?)(?:\s?(thousand|million|billion)\b|(k|mm|bn|m|b)(?![a-z0-9]))?(?:\s?(?:usd|eur|gbp|chf|dollars?|euros?)\b)?/gi;
  const SPELLED_RE = /\b(?:(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|a|half a)[\s-]+(?:\w+[\s-]+){0,4}?(?:thousand|million|billion)|(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+hundred)\b/i;

  function extractAmounts(text) {
    const out = [];
    for (const m of text.matchAll(AMOUNT_RE)) {
      const [raw, cur, num, word, suffix] = m, mag = (word || suffix || '').toLowerCase();
      let digits = num.replace(/[   ]/g, '');
      digits = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(digits) ? digits.replace(/,/g, '') : digits.replace(',', '.');
      const value = Number(digits) * (MULT[mag] || 1);
      const currency = !!cur || /(usd|eur|gbp|chf|dollars?|euros?)\s*$/i.test(raw);
      if (Number.isFinite(value)) out.push({ raw: raw.trim(), value, currency, magnitude: !!mag });
    }
    return out;
  }
  const close = (a, b, rel) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * rel);

  // allowed: numbers the message may state (decided price, buyer's offer, and facts such as year/seats/range/hours).
  // secrets: private limits that must never appear in any form.
  function validateMessage(text, { allowed = [], secrets = [] }) {
    if (SPELLED_RE.test(text)) return { ok: false, reason: 'spelled-out amount' };
    for (const t of extractAmounts(text)) {
      for (const sec of secrets) if (sec && close(t.value, sec, 0.005)) return { ok: false, reason: 'leaks an internal limit' };
      const relevant = t.currency || t.magnitude || t.value >= 10000; // years, seats, "36 months" and similar stay free
      if (relevant && !allowed.some((n) => close(t.value, n, 1e-6))) return { ok: false, reason: 'unapproved amount ' + t.raw };
    }
    if (/guarantee|legally binding|we accept your offer and/i.test(text)) return { ok: false, reason: 'binding language' };
    return { ok: true };
  }

  return { INVENTORY, DEFAULT_RULES, screen, matchAircraft, negotiate, validateMessage, extractAmounts, fmt };
});
