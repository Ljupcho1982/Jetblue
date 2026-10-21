// Counterparty screening. NOT a legal compliance programme by itself: it narrows what reaches a deal,
// fails closed, and records decisions. Statuses: clear | review | hit | error.
//   Built in : country list (Logic.screen) + fuzzy name match against SANCTIONS_FILE (one name per line, or a CSV with a name/alias column,
//              e.g. an export of the OFAC SDN or EU consolidated list that you download and refresh yourself).
//   Provider : SCREENING_WEBHOOK_URL receives POST {name, company, country} and must answer {"status":"clear"|"review"|"hit"} (optional "reason").
//              Any failure, timeout or unexpected answer is status "error" (the lead is held), never "clear".
const fs = require('fs');
const Logic = require('./logic.js');
const { parseCsv } = require('./csv.js');

const RANK = { clear: 0, review: 1, error: 2, hit: 3 };
const worst = (a, b) => (RANK[b.status] > RANK[a.status] ? b : a);
const SUFFIX = new Set(['ltd', 'llc', 'inc', 'co', 'corp', 'corporation', 'company', 'limited', 'sa', 'ag', 'gmbh', 'bv', 'nv', 'plc', 'jsc', 'ooo', 'ao', 'pjsc', 'llp', 'lp', 'the', 'of']);

function normalize(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t && !SUFFIX.has(t));
}
function lev(a, b) {
  if (a === b) return 0; if (!a.length) return b.length; if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
// exact (same tokens in any order) => hit; close => review.
function compareNames(queryTokens, listTokens) {
  if (!queryTokens.length || !listTokens.length) return null;
  const q = [...queryTokens].sort().join(' '), l = [...listTokens].sort().join(' ');
  if (q === l) return 'hit';
  if (q.length < 5 || l.length < 5) return null; // too short to fuzzy-match without drowning in noise
  const inter = queryTokens.filter((t) => listTokens.includes(t)).length, jac = inter / new Set([...queryTokens, ...listTokens]).size;
  const sim = 1 - lev(q, l) / Math.max(q.length, l.length);
  return jac >= 0.75 || sim >= 0.88 ? 'review' : null;
}

let cache = { file: null, mtime: 0, entries: [] };
function loadList() {
  const file = process.env.SANCTIONS_FILE; if (!file) return [];
  const mtime = fs.statSync(file).mtimeMs;
  if (cache.file === file && cache.mtime === mtime) return cache.entries;
  const text = fs.readFileSync(file, 'utf8'), names = [];
  const rows = text.includes(',') ? parseCsv(text) : text.split(/\r?\n/).map((l, i) => ({ line: i + 1, cells: [l] }));
  let idx = [0];
  if (rows.length && text.includes(',')) { // header with a name or alias column
    const hdr = rows[0].cells.map((c) => c.trim().toLowerCase()), cols = hdr.map((h, i) => (/^(name|alias|aliases|aka|entity)/.test(h) ? i : -1)).filter((i) => i >= 0);
    if (cols.length) { idx = cols; rows.shift(); }
  }
  for (const r of rows) for (const i of idx) for (const n of String(r.cells[i] || '').split(/[;|]/)) { const t = normalize(n); if (t.length) names.push({ raw: n.trim(), tokens: t }); }
  cache = { file, mtime, entries: names };
  return names;
}

function builtin({ name, company, country }) {
  let out = { status: 'clear', reasons: [] };
  if (!Logic.screen({ country }).ok) out = worst(out, { status: 'hit', reasons: ['Country on the restricted list'] });
  let list;
  try { list = loadList(); } catch (e) { return worst(out, { status: 'error', reasons: ['Sanctions list could not be read'] }); }
  for (const [label, value] of [['name', name], ['company', company]]) {
    const tokens = normalize(value); if (!tokens.length) continue;
    for (const e of list) {
      const m = compareNames(tokens, e.tokens);
      if (m) out = worst(out, { status: m, reasons: [`${label} ${m === 'hit' ? 'matches' : 'is similar to'} list entry "${e.raw.slice(0, 80)}"`] });
    }
  }
  return out;
}

async function provider(input) {
  const url = process.env.SCREENING_WEBHOOK_URL; if (!url) return null;
  try {
    const headers = { 'content-type': 'application/json' };
    if (process.env.SCREENING_API_KEY) headers.authorization = 'Bearer ' + process.env.SCREENING_API_KEY;
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(input), signal: AbortSignal.timeout(Number(process.env.SCREENING_TIMEOUT_MS) || 10000) });
    if (!res.ok) throw new Error('provider responded ' + res.status);
    const j = await res.json();
    if (!['clear', 'review', 'hit'].includes(j && j.status)) throw new Error('unexpected provider answer');
    return { status: j.status, reasons: j.status === 'clear' ? [] : [String(j.reason || 'Provider flagged this counterparty').slice(0, 200)] };
  } catch (e) { return { status: 'error', reasons: ['Screening provider unavailable: ' + e.message] }; }
}

async function screen(input) {
  let result = builtin(input);
  const p = await provider(input);
  if (p) { const w = worst(result, p); result = { status: w.status, reasons: [...new Set([...result.reasons, ...p.reasons])] }; }
  return { ...result, ok: result.status === 'clear', provider: process.env.SCREENING_WEBHOOK_URL ? 'webhook+builtin' : 'builtin', at: new Date().toISOString() };
}
const describe = () => ({ provider: process.env.SCREENING_WEBHOOK_URL ? 'webhook+builtin' : 'builtin', list: !!process.env.SANCTIONS_FILE });

module.exports = { screen, describe, normalize, compareNames };
