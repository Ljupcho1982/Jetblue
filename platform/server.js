// Zero-dependency platform server: static UI + JSON API + optional Claude wording.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Logic = require('./logic.js');
const store = require('./store.js');
const llm = require('./llm.js');

const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const id = () => crypto.randomUUID().slice(0, 8);
const num = (v) => (v === '' || v == null ? undefined : Number(v));

function body(req) {
  return new Promise((resolve, reject) => {
    let d = ''; req.on('data', (c) => { d += c; if (d.length > 1e6) reject(new Error('too large')); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
  });
}

async function api(req, url) {
  const { db } = store;
  const m = req.method, p = url.pathname.replace(/^\/api\//, '').split('/');
  const b = ['POST', 'PUT'].includes(m) ? await body(req) : {};

  if (p[0] === 'state' && m === 'GET') return { inventory: db.inventory, leads: db.leads, deals: db.deals, playbook: db.playbook, learned: db.learned, activity: db.activity, llm: { enabled: llm.enabled(), model: llm.MODEL } };

  if (p[0] === 'inventory') {
    if (m === 'POST') {
      const a = { id: b.id || 'AC-' + id(), model: b.model, type: b.type, year: +b.year, hours: +b.hours, seats: +b.seats, rangeNm: +b.rangeNm, location: b.location, listPrice: +b.listPrice, floor: +b.floor, maxDiscountPct: +b.maxDiscountPct, leaseMonthly: +b.leaseMonthly, minLeaseMonthly: +b.minLeaseMonthly, minTermMonths: +b.minTermMonths };
      if (!a.model || !a.listPrice || a.floor > a.listPrice) throw Object.assign(new Error('model and listPrice required; floor must not exceed listPrice'), { status: 400 });
      const i = db.inventory.findIndex((x) => x.id === a.id);
      if (i >= 0) db.inventory[i] = a; else db.inventory.push(a);
      store.activity('Inventory saved: ' + a.id); store.save(); return a;
    }
    if (m === 'DELETE') { db.inventory = db.inventory.filter((x) => x.id !== p[1]); store.save(); return { ok: true }; }
  }

  if (p[0] === 'leads' && m === 'POST') {
    const req_ = { mode: b.mode, type: b.type, seats: num(b.seats), rangeNm: num(b.rangeNm), maxAge: num(b.maxAge), budget: num(b.budget) };
    const s = Logic.screen({ country: b.country });
    const lead = { id: id(), createdAt: new Date().toISOString(), name: b.name, company: b.company, country: b.country, request: req_, screening: s, status: s.ok ? 'qualified' : 'compliance-hold',
      matches: s.ok ? Logic.matchAircraft(req_, db.inventory).map((x) => ({ aircraftId: x.aircraft.id, score: x.score, reasons: x.reasons })) : [] };
    db.leads.unshift(lead); store.activity(`Lead ${lead.name}: ${lead.status}, ${lead.matches.length} match(es)`); store.save(); return lead;
  }

  if (p[0] === 'deals') {
    if (m === 'POST' && !p[1]) {
      const lead = db.leads.find((l) => l.id === b.leadId); const a = db.inventory.find((x) => x.id === b.aircraftId);
      if (!lead || !a || !lead.screening.ok) throw Object.assign(new Error('invalid lead/aircraft or lead on compliance hold'), { status: 400 });
      const d = { id: id(), leadId: lead.id, buyer: lead.name, company: lead.company, aircraftId: a.id, mode: lead.request.mode, stage: 'negotiating', round: 0, messages: [] };
      db.deals.unshift(d); store.activity(`Deal opened: ${lead.name} / ${a.id}`); store.save(); return d;
    }
    const d = db.deals.find((x) => x.id === p[1]); if (!d) throw Object.assign(new Error('deal not found'), { status: 404 });
    const a = db.inventory.find((x) => x.id === d.aircraftId);
    if (p[2] === 'offer' && m === 'POST') {
      if (d.messages.some((x) => x.status === 'draft')) throw Object.assign(new Error('resolve the pending draft first'), { status: 409 });
      const offer = +b.offer; if (!offer) throw Object.assign(new Error('offer required'), { status: 400 });
      d.round++;
      const decision = Logic.negotiate({ aircraft: a, mode: d.mode, offer, round: d.round, termMonths: num(b.termMonths), rules: db.playbook.rules });
      const w = await llm.wordDraft({ decision, aircraft: a, buyer: { name: d.buyer }, offer, mode: d.mode, playbook: db.playbook, learned: db.learned });
      d.messages.push({ id: id(), role: 'buyer', text: `Offer: ${Logic.fmt(offer)}${d.mode === 'lease' ? '/month' : ''}`, at: new Date().toISOString() });
      d.messages.push({ id: id(), role: 'assistant', status: 'draft', action: decision.action, price: decision.price, flags: decision.flags, note: decision.internalNote, text: w.text, source: w.source, original: w.text, at: new Date().toISOString() });
      store.activity(`Draft (${decision.action}) for deal ${d.id}`); store.save(); return d;
    }
    const msg = d.messages.find((x) => x.id === p[3]);
    if (p[2] === 'messages' && msg && p[4] === 'approve' && m === 'POST') {
      msg.text = b.text || msg.text; msg.status = 'sent'; msg.sentAt = new Date().toISOString();
      if (msg.action === 'accept') d.stage = 'LOI'; else if (msg.action === 'escalate') d.stage = 'escalated';
      if (msg.text.trim() !== msg.original.trim()) { // learn from broker edits
        db.learned.push({ situation: msg.action + ' (broker-edited)', reply: msg.text }); db.learned = db.learned.slice(-50);
      }
      store.activity(`Approved message on deal ${d.id}` + (msg.text !== msg.original ? ' (edited, saved as example)' : '')); store.save(); return d;
    }
    if (p[2] === 'messages' && msg && p[4] === 'reject' && m === 'POST') { msg.status = 'rejected'; d.round = Math.max(0, d.round - 1); store.activity('Rejected draft on deal ' + d.id); store.save(); return d; }
  }

  if (p[0] === 'playbook') {
    if (m === 'PUT') {
      const pb = db.playbook, r = b.rules || {};
      for (const k of ['company', 'broker', 'tone', 'systemPrompt']) if (typeof b[k] === 'string') pb[k] = b[k];
      for (const k of Object.keys(Logic.DEFAULT_RULES)) if (r[k] !== undefined) pb.rules[k] = typeof Logic.DEFAULT_RULES[k] === 'number' ? +r[k] : String(r[k]);
      if (Array.isArray(b.examples)) pb.examples = b.examples; if (Array.isArray(b.scenarios)) pb.scenarios = b.scenarios;
      store.activity('Playbook updated'); store.save(); return pb;
    }
    if (p[1] === 'promote' && m === 'POST') { // turn a learned example into a permanent one
      const ex = db.learned[+b.index]; if (ex) { db.playbook.examples.push(ex); db.learned.splice(+b.index, 1); store.save(); } return db.playbook;
    }
  }

  if (p[0] === 'eval' && m === 'POST') {
    const rows = db.playbook.scenarios.map((s) => {
      const a = db.inventory.find((x) => x.id === s.aircraftId);
      if (!a) return { name: s.name, pass: false, problems: ['aircraft not found'] };
      const d = Logic.negotiate({ aircraft: a, mode: s.mode, offer: s.offer, round: s.round, termMonths: s.termMonths, rules: db.playbook.rules });
      const problems = [];
      if (d.action !== s.expect) problems.push(`expected ${s.expect}, got ${d.action}`);
      const floor = s.mode === 'lease' ? a.minLeaseMonthly : a.floor;
      if (d.price != null && d.price < floor) problems.push('price below floor');
      if (d.action === 'accept' && d.flags.length) problems.push('accepted despite flags');
      const v = Logic.validateMessage(d.message, { allowed: [s.offer, d.price].filter(Boolean), secrets: [a.floor, a.minLeaseMonthly] });
      if (!v.ok) problems.push('message: ' + v.reason);
      return { name: s.name, action: d.action, price: d.price, pass: !problems.length, problems };
    });
    return { passed: rows.filter((r) => r.pass).length, total: rows.length, rows };
  }
  if (p[0] === 'reset' && m === 'POST') { Object.assign(store.db, { inventory: Logic.INVENTORY, leads: [], deals: [], learned: [], activity: [], playbook: store.defaultPlaybook() }); store.save(); return { ok: true }; }
  throw Object.assign(new Error('not found'), { status: 404 });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) {
      const out = await api(req, url);
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(out));
    }
    if (url.pathname === '/logic.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(fs.readFileSync(path.join(__dirname, 'logic.js'))); }
    const f = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
  } catch (e) {
    res.writeHead(e.status || 500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message }));
  }
});

if (require.main === module) {
  const port = process.env.PORT || 3000;
  server.listen(port, '127.0.0.1', () => console.log(`Platform on http://127.0.0.1:${port}  (Claude wording: ${llm.enabled() ? 'ON' : 'off, set ANTHROPIC_API_KEY'})`));
}
module.exports = server;
