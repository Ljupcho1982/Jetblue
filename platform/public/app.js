const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let CURRENCY = 'USD';
const fmt = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: CURRENCY, minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(Math.round(n));
let LEAD_Q = '', DEAL_Q = '', CUR_DEALS = [], TODO = [], S = null, selectedDeal = null, ME = null, PERMS = [], MUST_ENROLL = false, MUST_POLICY = false;
const can = (p) => PERMS.includes('*') || PERMS.includes(p);

async function call(method, path, body) {
  const r = await fetch('/api/' + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (r.status === 401 && ME) { ME = null; render(); throw new Error('Session ended'); }
  if (!r.ok) { toast(j.error || 'Error'); throw new Error(j.error); }
  return j;
}
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.remove('hidden'); setTimeout(() => t.classList.add('hidden'), 3000); }
async function refresh() { S = await call('GET', 'state'); CURRENCY = S.currency || 'USD'; $('#llmStatus').textContent = !can('view.full') ? '' : S.llm.enabled ? 'Model: ' + S.llm.provider + ' / ' + S.llm.model : 'Model: off (templates)'; }
const aircraft = (id) => S.inventory.find((a) => a.id === id);
const priceOf = (a, mode) => (mode === 'lease' ? fmt(a.leaseMonthly) + '/mo' : fmt(a.listPrice));
const form = (el) => Object.fromEntries(new FormData(el));

function screeningHtml(l) {
  const s = l.screening, st = s.status || (s.ok ? 'clear' : 'hit');
  const tag = s.override ? '<span class="tag ok">cleared by reviewer</span>' : { clear: '<span class="tag ok">screening clear</span>', review: '<span class="tag warn">needs review</span>', error: '<span class="tag warn">screening error</span>', hit: '<span class="tag bad">list match: on hold</span>' }[st];
  const reasons = (s.reasons || (s.reason ? [s.reason] : [])).map((r) => `<div class="small warn">• ${esc(r)}</div>`).join('');
  const ov = s.override ? `<div class="small muted">Cleared by ${esc(s.override.by)} (was ${esc(s.override.previous)}): ${esc(s.override.note)}</div>` : '';
  const acts = []; if (!s.ok && st !== 'hit' && can('leads.write')) acts.push(`<button class="small secondary" data-rescreen="${esc(l.id)}">Re-run screening</button>`);
  if (!s.ok && st !== 'hit' && can('compliance.review')) acts.push(`<button class="small secondary" data-clear="${esc(l.id)}">Clear after review</button>`);
  if (!s.ok && st === 'hit') acts.push('<span class="small muted">Cannot be cleared here. Escalate to compliance.</span>');
  return `${tag}${reasons}${ov}${acts.length ? '<div style="margin-top:4px">' + acts.join(' ') + '</div>' : ''}`;
}

function deliveryHtml(m) {
  const w = can('deals.write'), st = m.deliveryStatus;
  if (st === 'sent') return `<div class="small ok">✓ Emailed to buyer ${m.deliveredAt ? new Date(m.deliveredAt).toLocaleString() : ''}</div>`;
  if (st === 'sending') return '<div class="small muted">Sending…</div>';
  if (!st && !S.mail.enabled) return '<div class="small muted">Not emailed (email is not configured)</div>';
  const label = { failed: 'Email failed', blocked: 'Email blocked', skipped: 'Not emailed' }[st] || 'Not emailed yet';
  return `<div class="small warn">${label}${m.deliveryError ? ': ' + esc(m.deliveryError) : ''}</div>` + (w ? `<div>${st === 'skipped' ? `<button class="small secondary" data-addemail="${esc(m.id)}">Add buyer email</button> ` : ''}<button class="small secondary" data-send="${esc(m.id)}">${st ? 'Retry email' : 'Send email'}</button></div>` : '');
}

const pages = {
  dashboard() {
    const name = (id) => aircraft(id)?.model || id, todo = [];
    for (const d of S.deals) {
      for (const m of d.messages) {
        if (m.status === 'draft') todo.push({ kind: 'Draft to approve', tone: 'warn', text: `${d.buyer}, ${name(d.aircraftId)}`, deal: d.id });
        if (m.status === 'sent' && ['failed', 'blocked', 'skipped'].includes(m.deliveryStatus)) todo.push({ kind: 'Email not delivered', tone: 'warn', text: `${d.buyer}, ${name(d.aircraftId)}`, deal: d.id });
      }
      if (d.stage === 'escalated') todo.push({ kind: 'Escalated to broker', tone: 'bad', text: `${d.buyer}, ${name(d.aircraftId)}`, deal: d.id });
      if (d.stage === 'LOI') todo.push({ kind: 'Ready for letter of intent', tone: 'ok', text: `${d.buyer}, ${name(d.aircraftId)}`, deal: d.id });
    }
    for (const l of S.leads) if (!l.screening.ok && ['review', 'error'].includes(l.screening.status)) todo.push({ kind: 'Screening needs review', tone: 'warn', text: `${l.name}${l.company ? ', ' + l.company : ''}`, lead: true });
    TODO = todo;
    const C = S.counts || {}, pending = C.draftsPending ?? S.deals.reduce((n, d) => n + d.messages.filter((m) => m.status === 'draft').length, 0);
    const fresh = !(C.leads || S.leads.length) && !(C.deals || S.deals.length);
    return `<h1>Dashboard</h1>
    <div class="stats">
      <div class="stat"><b>${C.aircraft ?? S.inventory.length}</b>Aircraft listed</div>
      <div class="stat"><b>${C.leadsQualified ?? 0}</b>Qualified leads</div>
      <div class="stat"><b>${C.dealsNegotiating ?? 0}</b>Active deals</div>
      <div class="stat"><b>${pending}</b>Drafts awaiting approval</div>
      <div class="stat"><b>${C.dealsEscalated ?? 0}</b>Escalated</div>
      <div class="stat"><b>${C.dealsLOI ?? 0}</b>At LOI</div>
    </div>
    ${fresh && can('leads.write') ? `<div class="card"><h2>Getting started</h2><ol class="steps">
      <li>${S.inventory.length ? `<span class="ok">Done</span>` : ''} <a href="#/inventory">Load your aircraft</a> (import a CSV or add them one by one) and set each aircraft's private floor price and limits.</li>
      <li><a href="#/leads">Add a buyer or lessee enquiry.</a> It is screened, then matched to your aircraft.</li>
      <li>Open a deal, enter the buyer's offer, and review the drafted reply. Nothing is sent until a broker approves it.</li>
      ${can('users.manage') ? '<li><a href="#/users">Invite your brokers</a> and set up two-factor sign-in under <a href="#/account">Account</a>.</li>' : ''}</ol></div>` : ''}
    <div class="card"><h2>Needs attention ${todo.length ? `<span class="tag warn">${todo.length}</span>` : ''}</h2>
      ${todo.length ? `<table>${todo.map((t, i) => `<tr><td style="width:210px"><span class="tag ${t.tone}">${esc(t.kind)}</span></td><td>${esc(t.text)}</td><td style="width:90px"><button class="small secondary" data-goto="${i}">Open</button></td></tr>`).join('')}</table>` : '<p class="muted">Nothing needs your attention right now.</p>'}</div>
    ${can('deals.write') ? '<div class="card"><h2>Pilot feedback</h2><p class="muted small">Something wrong, confusing or missing? Tell us. Flag a specific draft with the button on the Deals page.</p><button class="secondary" id="sendFeedback">Send feedback</button></div>' : ''}
    <div class="card"><h2>Recent activity</h2>${S.activity.length ? '<table>' + S.activity.slice(0, 12).map((a) => `<tr><td class="muted small" style="width:170px">${new Date(a.at).toLocaleString()}</td><td>${esc(a.msg)}</td><td class="muted small">${esc(a.who || '')}</td></tr>`).join('') + '</table>' : '<p class="muted">No activity yet.</p>'}</div>`;
  },
  dashboardInit() {
    if ($('#sendFeedback')) $('#sendFeedback').onclick = async () => { const comment = prompt('Your feedback'); if (comment) { await call('POST', 'feedback', { kind: 'other', comment }); toast('Thanks, recorded'); } };
    document.querySelectorAll('[data-goto]').forEach((b) => b.onclick = () => { const t = TODO[+b.dataset.goto]; if (t.deal) { selectedDeal = t.deal; location.hash = '#/deals'; } else location.hash = '#/leads'; });
  },

  inventory() {
    return `<h1>Inventory</h1>
    <div class="card"><table><tr><th>ID</th><th>Aircraft</th><th>Year / hrs</th><th>Seats / range</th><th>Location</th><th>List</th><th>Lease/mo</th>${can('view.full') ? '<th>Broker-only limits</th>' : ''}<th><span class="sr-only">Actions</span></th></tr>
    ${S.inventory.map((a) => `<tr><td>${esc(a.id)}</td><td><b>${esc(a.model)}</b><br><span class="tag">${esc(a.type)}</span></td><td>${a.year}<br>${a.hours.toLocaleString()}</td><td>${a.seats}<br>${a.rangeNm} nm</td><td>${esc(a.location)}</td><td>${fmt(a.listPrice)}</td><td>${fmt(a.leaseMonthly)}</td>
      ${can('view.full') ? `<td class="small warn">floor ${fmt(a.floor)}<br>max disc ${a.maxDiscountPct}%<br>min lease ${fmt(a.minLeaseMonthly)} / ${a.minTermMonths} mo</td>` : ''}
      <td>${can('inventory.write') ? `<button class="small secondary" data-edit="${esc(a.id)}">Edit</button>` : ''} ${can('inventory.delete') ? `<button class="small danger" data-del="${esc(a.id)}">Delete</button>` : ''}</td></tr>`).join('')}</table></div>
    ${can('inventory.write') ? `<div class="card"><h2>Import from CSV</h2>
      <p class="muted small">One row per aircraft. Required columns: ${['model', 'type', 'year', 'hours', 'seats', 'rangeNm', 'location', 'listPrice', 'floor', 'maxDiscountPct', 'leaseMonthly', 'minLeaseMonthly', 'minTermMonths'].join(', ')}. Optional: id (rows with an existing id are updated). Up to 500 rows. You see a preview first and nothing is saved if any row has an error.</p>
      <input type="file" id="csvFile" accept=".csv,text/csv" aria-label="CSV file"><textarea id="csvText" rows="4" placeholder="…or paste CSV here" aria-label="CSV text" style="margin-top:8px"></textarea>
      <button id="csvPreview">Preview</button><button class="secondary" id="csvTemplate">Download template</button><button id="csvImport" class="hidden">Import</button>
      <div id="csvOut"></div></div>` : ''}
    ${can('inventory.write') ? `<div class="card"><h2 id="invTitle">Add aircraft</h2><form id="invForm"><input type="hidden" name="id">
      <div class="grid">
        <label>Model<input name="model" required></label><label>Type<select name="type"><option>turboprop</option><option>light jet</option><option>regional jet</option><option>narrowbody</option></select></label>
        <label>Year<input name="year" type="number" required></label><label>Hours<input name="hours" type="number" required></label>
        <label>Seats<input name="seats" type="number" required></label><label>Range (nm)<input name="rangeNm" type="number" required></label>
        <label>Location<input name="location" required></label><label>List price<input name="listPrice" type="number" required></label>
        <label>Floor price (private)<input name="floor" type="number" required></label><label>Max discount %<input name="maxDiscountPct" type="number" value="8" required></label>
        <label>Lease / month<input name="leaseMonthly" type="number" required></label><label>Min lease / month (private)<input name="minLeaseMonthly" type="number" required></label>
        <label>Min term (months)<input name="minTermMonths" type="number" value="36" required></label>
      </div><button>Save aircraft</button></form></div>` : ''}`;
  },
  inventoryInit() {
    if ($('#csvPreview')) {
      const COLS = ['id', 'model', 'type', 'year', 'hours', 'seats', 'rangeNm', 'location', 'listPrice', 'floor', 'maxDiscountPct', 'leaseMonthly', 'minLeaseMonthly', 'minTermMonths'];
      $('#csvFile').onchange = async (e) => { const f = e.target.files[0]; if (f) { if (f.size > 900000) return toast('File too large (max 900 KB)'); $('#csvText').value = await f.text(); } };
      $('#csvTemplate').onclick = () => {
        const sample = [COLS.join(','), ',ATR 72-600,turboprop,2015,18000,70,825,Madrid,"12,500,000",11500000,8,115000,105000,36'].join('\n');
        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([sample], { type: 'text/csv' })); a.download = 'inventory-template.csv'; a.click();
      };
      const run = async (dryRun) => {
        const csv = $('#csvText').value; if (!csv.trim()) return toast('Choose a file or paste CSV first');
        let res; try { res = await fetch('/api/inventory/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ csv, dryRun }) }).then(async (r) => ({ ok: r.ok, j: await r.json() })); } catch { return toast('Network error'); }
        const j = res.ok ? res.j : (res.j.details || { rows: [], errors: 1 });
        const head = res.ok ? '' : `<p class="bad">${esc(res.j.error)}</p>`;
        $('#csvOut').innerHTML = head + (j.rows.length ? `<p><b>${j.created ?? 0}</b> new, <b>${j.updated ?? 0}</b> updates, <b class="${j.errors ? 'bad' : ''}">${j.errors}</b> error(s)</p><table><tr><th>Line</th><th>Action</th><th>Aircraft</th><th><span class="sr-only">Actions</span></th></tr>${j.rows.map((r) => `<tr><td>${r.line}</td><td>${esc(r.status)}</td><td>${esc(r.id || '')} ${esc(r.model || '')}</td><td class="bad small">${esc(r.error || '')}</td></tr>`).join('')}</table>` : '');
        $('#csvImport').classList.toggle('hidden', !(dryRun && res.ok && j.errors === 0 && j.total > 0));
        if (!dryRun && res.ok) { toast(`Imported ${j.created} new, ${j.updated} updated`); render(); }
      };
      $('#csvPreview').onclick = () => run(true);
      $('#csvImport').onclick = () => run(false);
      $('#csvText').oninput = () => $('#csvImport').classList.add('hidden'); // edited since the preview
    }
    if ($('#invForm')) $('#invForm').onsubmit = async (e) => { e.preventDefault(); await call('POST', 'inventory', form(e.target)); toast('Saved'); await render(); };
    document.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => { if (confirm('Delete ' + b.dataset.del + '?')) { await call('DELETE', 'inventory/' + b.dataset.del); await render(); } });
    document.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => {
      const a = aircraft(b.dataset.edit), f = $('#invForm'); for (const k in a) if (f.elements[k]) f.elements[k].value = a[k];
      $('#invTitle').textContent = 'Edit ' + a.id; f.scrollIntoView();
    });
  },

  async leads() {
    const C = S.counts || {}, shown = LEAD_Q ? await call('GET', 'leads/search?q=' + encodeURIComponent(LEAD_Q)) : S.leads;
    return `<h1>Leads</h1>
    ${can('leads.write') ? `<div class="card"><h2>New inquiry</h2><form id="leadForm"><div class="grid">
      <label>Name<input name="name" required></label><label>Company<input name="company"></label><label>Buyer email<input name="email" type="email" autocomplete="off"></label><label>Country<input name="country" required></label>
      <label>Buy or lease<select name="mode"><option value="buy">Buy</option><option value="lease">Lease</option></select></label>
      <label>Type<select name="type"><option value="any">Any</option><option>turboprop</option><option>light jet</option><option>regional jet</option><option>narrowbody</option></select></label>
      <label>Min seats<input name="seats" type="number"></label><label>Min range (nm)<input name="rangeNm" type="number"></label>
      <label>Max age (yrs)<input name="maxAge" type="number"></label><label>Budget (per month if lease)<input name="budget" type="number"></label>
    </div><button>Screen and match</button></form></div>` : ''}
    ${can('leads.write') ? `<div class="card"><form id="leadSearch" style="display:flex;gap:8px"><input name="q" placeholder="Find a lead by name, company, email or id" value="${esc(LEAD_Q)}" aria-label="Search leads"><button class="secondary" style="margin:0">Search</button>${LEAD_Q ? '<button type="button" class="secondary" id="leadSearchClear" style="margin:0">Clear</button>' : ''}</form>
      ${LEAD_Q ? `<p class="small muted">${shown.length} result(s) for "${esc(LEAD_Q)}"</p>` : (C.leads > S.leads.length ? `<p class="small muted">Showing the newest ${S.leads.length} of ${C.leads} leads (plus any waiting for a compliance decision). Use search to find older ones.</p>` : '')}</div>` : ''}
    ${shown.map((l) => `<div class="card"><b>${esc(l.name)}</b> ${esc(l.company || '')} <span class="muted">· ${esc(l.country)} · ${esc(l.request.mode)}${l.email ? ' · ' + esc(l.email) : ''}</span>
      ${screeningHtml(l)}
      ${l.matches.map((m) => { const a = aircraft(m.aircraftId); return a ? `<div style="margin-top:8px">${esc(a.model)} <span class="tag">${esc(a.id)}</span> <span class="tag">match ${m.score}</span> ${priceOf(a, l.request.mode)} <span class="warn small">${esc(m.reasons.join(', '))}</span> ${can('deals.write') ? `<button class="small secondary" data-open="${esc(l.id)}|${esc(a.id)}">Open deal</button>` : ''}</div>` : ''; }).join('')}
      ${l.screening.ok && !l.matches.length ? '<p class="muted small">No aircraft meet these requirements within the budget. Adjust the requirements or source matching inventory.</p>' : ''}
      ${can('data.erase') ? `<div class="small" style="margin-top:8px;border-top:1px solid var(--line);padding-top:6px"><span class="muted">Personal data:</span> <button class="small secondary" data-export="${esc(l.id)}">Export</button> <button class="small danger" data-erase="${esc(l.id)}">Erase</button></div>` : ''}</div>`).join('')}`;
  },
  leadsInit() {
    if ($('#leadSearch')) { $('#leadSearch').onsubmit = (e) => { e.preventDefault(); LEAD_Q = (form(e.target).q || '').trim(); if (LEAD_Q.length === 1) { LEAD_Q = ''; return toast('Type at least 2 characters'); } render(); }; if ($('#leadSearchClear')) $('#leadSearchClear').onclick = () => { LEAD_Q = ''; render(); }; }
    if ($('#leadForm')) $('#leadForm').onsubmit = async (e) => { e.preventDefault(); await call('POST', 'leads', form(e.target)); await render(); };
    document.querySelectorAll('[data-export]').forEach((b) => b.onclick = async () => {
      const data = await call('GET', `leads/${b.dataset.export}/export`);
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); a.download = `lead-${b.dataset.export}.json`; a.click(); toast('Exported (recorded in the activity log)');
    });
    document.querySelectorAll('[data-erase]').forEach((b) => b.onclick = async () => {
      if (prompt('This permanently deletes this person, their deals and every message, and blanks their name and email in logs. Emails already sent cannot be recalled. Type ERASE to continue.') !== 'ERASE') return;
      const r = await call('DELETE', `leads/${b.dataset.erase}`); toast(`Erased: ${r.deals} deal(s), ${r.messages} message(s), ${r.scrubbed} text field(s) scrubbed`); render();
    });
    document.querySelectorAll('[data-rescreen]').forEach((b) => b.onclick = async () => { b.disabled = true; await call('POST', `leads/${b.dataset.rescreen}/rescreen`).catch(() => {}); render(); });
    document.querySelectorAll('[data-clear]').forEach((b) => b.onclick = async () => { const note = prompt('Why is this counterparty acceptable? (recorded, at least 10 characters)'); if (note) { await call('POST', `leads/${b.dataset.clear}/clear`, { note }).catch(() => {}); render(); } });
    document.querySelectorAll('[data-open]').forEach((b) => b.onclick = async () => { const [leadId, aircraftId] = b.dataset.open.split('|'); const d = await call('POST', 'deals', { leadId, aircraftId }); selectedDeal = d.id; location.hash = '#/deals'; });
  },

  async deals() {
    const C = S.counts || {}, all = DEAL_Q ? await call('GET', 'deals/search?q=' + encodeURIComponent(DEAL_Q)) : S.deals;
    CUR_DEALS = all;
    const d = all.find((x) => x.id === selectedDeal) || all[0];
    if (d) selectedDeal = d.id;
    const list = all.map((x) => `<div class="deal-item ${x.id === selectedDeal ? 'active' : ''}" data-deal="${esc(x.id)}"><b>${esc(x.buyer)}</b><br><span class="small">${esc(aircraft(x.aircraftId)?.model || x.aircraftId)}</span><br><span class="tag ${x.stage === 'LOI' ? 'ok' : x.stage === 'escalated' ? 'bad' : ''}">${esc(x.stage)}</span></div>`).join('') || '<p class="muted">No deals yet. Open one from a lead.</p>';
    let detail = '<div class="card muted">Select a deal.</div>';
    if (d) {
      const a = aircraft(d.aircraftId) || {}; const pending = d.messages.find((m) => m.status === 'draft');
      detail = `<div class="card"><h2>${esc(d.buyer)} · ${esc(a.model)} <span class="tag">${esc(d.mode)}</span></h2>
        ${can('view.full') ? `<div class="limits">Broker-only: ${d.mode === 'lease' ? `min ${fmt(a.minLeaseMonthly)}/mo, min term ${a.minTermMonths} mo` : `floor ${fmt(a.floor)}, max discount ${a.maxDiscountPct}%`}. Asking ${priceOf(a, d.mode)}.</div>` : `<div class="muted small">Asking ${priceOf(a, d.mode)}.</div>`}
        <div>${d.messages.filter((m) => m.status !== 'rejected').map((m) => m.role === 'buyer' ? `<div class="msg buyer">${esc(m.text)}</div>` :
          m.status === 'draft' ? `<div class="msg assistant draft"><b>Draft (${esc(m.action)})</b> <span class="tag">${esc(m.source)}</span>
            ${m.flags.map((f) => `<div class="warn small">⚠ ${esc(f)}</div>`).join('')}<textarea id="draftText" rows="5" aria-label="Draft reply, editable">${esc(m.text)}</textarea><div class="muted small">${esc(m.note)}</div>
            <button data-approve="${esc(m.id)}">Approve and send</button><button class="secondary" data-reject="${esc(m.id)}">Reject</button><button class="secondary" data-flag="${esc(m.id)}" title="Tell us what is wrong with this draft">Flag a problem</button></div>`
          : `<div class="msg assistant">${esc(m.text)}${deliveryHtml(m)}</div>`).join('')}</div>
        ${['LOI', 'escalated'].includes(d.stage) ? `<p class="${d.stage === 'LOI' ? 'ok' : 'bad'}">${d.stage === 'LOI' ? 'Ready for letter of intent (human step).' : 'Escalated to the human broker.'}</p>` : ''}
        ${!pending && d.stage === 'negotiating' && can('deals.write') ? `<div class="grid"><label>Buyer's offer (${CURRENCY}${d.mode === 'lease' ? ' per month' : ''})<input id="offer" type="number"></label>${d.mode === 'lease' ? '<label>Term (months)<input id="term" type="number" value="36"></label>' : ''}</div><button id="sendOffer">Submit buyer's offer</button>` : ''}</div>`;
    }
    const search = can('deals.write') ? `<form id="dealSearch" style="display:flex;gap:6px;margin-bottom:8px"><input name="q" placeholder="Find a deal" value="${esc(DEAL_Q)}" aria-label="Search deals"><button class="secondary" style="margin:0">Go</button>${DEAL_Q ? '<button type="button" class="secondary" id="dealSearchClear" style="margin:0">×</button>' : ''}</form>
      ${DEAL_Q ? `<p class="small muted">${all.length} result(s)</p>` : (C.deals > S.deals.length ? `<p class="small muted">Open deals and the newest others (${S.deals.length} of ${C.deals}). Search for older ones.</p>` : '')}` : '';
    return `<h1>Deals</h1><div class="split"><div>${search}${list}</div><div>${detail}</div></div>`;
  },
  dealsInit() {
    if ($('#dealSearch')) { $('#dealSearch').onsubmit = (e) => { e.preventDefault(); DEAL_Q = (form(e.target).q || '').trim(); if (DEAL_Q.length === 1) { DEAL_Q = ''; return toast('Type at least 2 characters'); } render(); }; if ($('#dealSearchClear')) $('#dealSearchClear').onclick = () => { DEAL_Q = ''; render(); }; }
    document.querySelectorAll('[data-deal]').forEach((el) => el.onclick = () => { selectedDeal = el.dataset.deal; render(); });
    const send = $('#sendOffer'); if (send) send.onclick = async () => { const offer = $('#offer').value; if (!offer) return; send.disabled = true; await call('POST', `deals/${selectedDeal}/offer`, { offer, termMonths: $('#term')?.value }); await render(); };
    const ap = $('[data-approve]'); if (ap) ap.onclick = async () => {
      const url = `/api/deals/${selectedDeal}/messages/${ap.dataset.approve}/approve`, send = (extra) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: $('#draftText').value, ...extra }) });
      ap.disabled = true; let r = await send({}), j = await r.json();
      if (r.status === 409 && j.needsConfirm) { // an edit changed money or wording: make the broker say so explicitly
        if (!confirm(`${j.error}\n\nSend it anyway?`)) { ap.disabled = false; return; }
        r = await send({ confirmPriceChange: true }); j = await r.json();
      }
      if (!r.ok) { toast(j.error || 'Error'); ap.disabled = false; return; }
      await render();
    };
    document.querySelectorAll('[data-send]').forEach((b) => b.onclick = async () => { b.disabled = true; await call('POST', `deals/${selectedDeal}/messages/${b.dataset.send}/send`).catch(() => {}); await render(); });
    document.querySelectorAll('[data-addemail]').forEach((b) => b.onclick = async () => {
      const email = prompt('Buyer email address'); if (!email) return;
      const d = CUR_DEALS.find((x) => x.id === selectedDeal);
      await call('PUT', 'leads/' + d.leadId, { email }).catch(() => {}); await call('POST', `deals/${selectedDeal}/messages/${b.dataset.addemail}/send`).catch(() => {}); await render();
    });
    const fl = $('[data-flag]'); if (fl) fl.onclick = async () => {
      const comment = prompt('What is wrong with this draft or decision? (what you expected instead helps most)'); if (!comment) return;
      await call('POST', 'feedback', { kind: 'draft', dealId: selectedDeal, messageId: fl.dataset.flag, comment }); toast('Thanks, recorded');
    };
    const rj = $('[data-reject]'); if (rj) rj.onclick = async () => { await call('POST', `deals/${selectedDeal}/messages/${rj.dataset.reject}/reject`); await render(); };
  },

  async training() {
    const FB = await call('GET', 'feedback'), openFb = FB.filter((f) => f.status === 'open');
    const p = S.playbook, r = p.rules;
    return `<h1>Training</h1>
    <p class="muted">The model is trained through its playbook: instructions, tone, negotiation rules and approved examples. Broker edits to drafts are saved as new examples automatically. Run the test scenarios after any change.</p>
    <div class="card"><h2>Playbook</h2><form id="pbForm"><div class="grid"><label>Company<input name="company" value="${esc(p.company)}"></label><label>Broker name<input name="broker" value="${esc(p.broker)}"></label><label>Tone<input name="tone" value="${esc(p.tone)}"></label></div>
      <label>Instructions (system prompt)<textarea name="systemPrompt" rows="10">${esc(p.systemPrompt)}</textarea></label>
      <h3>Negotiation rules</h3><div class="grid">
        <label>First-round concession (0-1)<input name="stepBase" type="number" step="0.05" value="${r.stepBase}"></label>
        <label>Extra concession per round<input name="stepPerRound" type="number" step="0.05" value="${r.stepPerRound}"></label>
        <label>Escalate below % of limit<input name="escalateBelowPct" type="number" value="${r.escalateBelowPct}"></label>
        <label>Max rounds before escalation<input name="maxRounds" type="number" value="${r.maxRounds}"></label></div>
      <label>Required disclaimer<input name="disclaimer" value="${esc(r.disclaimer)}"></label><button>Save playbook</button></form></div>
    <div class="card"><h2>Style examples (${p.examples.length})</h2>
      ${p.examples.map((e, i) => `<div class="small"><b>${esc(e.situation)}</b> <button class="small secondary" data-delex="${i}">Remove</button><br>${esc(e.reply)}</div><hr>`).join('')}
      <h3>Learned from broker edits (${S.learned.length})</h3>${S.learned.length ? S.learned.map((e, i) => `<div class="small"><b>${esc(e.situation)}</b> <button class="small secondary" data-promote="${i}">Promote to example</button><br>${esc(e.reply)}</div><hr>`).join('') : '<p class="muted small">None yet. Edit a draft in Deals before approving it.</p>'}
      <form id="exForm" class="grid"><label>Situation<input name="situation" required></label><label>Reply text<input name="reply" required></label><div><button>Add example</button></div></form></div>
    <div class="card"><h2>Test scenarios</h2><p class="muted small">Checks decisions, that prices never fall below the floor, and that no private limit appears in a message.</p>
      <button id="runEval">Run all scenarios</button><div id="evalOut"></div>
      <table><tr><th>Scenario</th><th>Aircraft</th><th>Offer</th><th>Round</th><th>Expect</th><th><span class="sr-only">Actions</span></th></tr>${p.scenarios.map((s, i) => `<tr><td>${esc(s.name)}</td><td>${esc(s.aircraftId)} ${esc(s.mode)}</td><td>${fmt(s.offer)}</td><td>${s.round}</td><td>${esc(s.expect)}</td><td><button class="small secondary" data-delsc="${i}">Remove</button></td></tr>`).join('')}</table>
      <h3>Add scenario</h3><form id="scForm" class="grid"><label>Name<input name="name" required></label><label>Aircraft<select name="aircraftId">${S.inventory.map((a) => `<option>${esc(a.id)}</option>`).join('')}</select></label>
        <label>Mode<select name="mode"><option>buy</option><option>lease</option></select></label><label>Offer<input name="offer" type="number" required></label><label>Round<input name="round" type="number" value="1"></label>
        <label>Term (lease)<input name="termMonths" type="number"></label><label>Expect<select name="expect"><option>accept</option><option>counter</option><option>escalate</option></select></label><div><button>Add</button></div></form></div>
    <div class="card"><h2>Pilot feedback ${openFb.length ? `<span class="tag warn">${openFb.length} open</span>` : ''}</h2>
      <p class="muted small">Problems flagged by brokers. For a flagged draft, <b>Make test</b> records what the correct decision should have been as a permanent test scenario (it will fail until the rules or playbook are fixed).</p>
      ${FB.length ? `<table><tr><th>When / who</th><th>Feedback</th><th><span class="sr-only">Actions</span></th></tr>${FB.map((f) => `<tr><td class="small muted">${new Date(f.createdAt).toLocaleString()}<br>${esc(f.userEmail)}</td>
        <td>${esc(f.comment)}${f.snapshot ? `<div class="small muted">${esc(f.snapshot.aircraftId)} ${esc(f.snapshot.mode)}, buyer offered ${f.snapshot.offer != null ? fmt(f.snapshot.offer) : '?'}${f.snapshot.termMonths ? ' / ' + esc(f.snapshot.termMonths) + ' mo' : ''}, round ${esc(f.snapshot.round)} → <b>${esc(f.snapshot.action)}</b>${f.snapshot.price ? ' ' + fmt(f.snapshot.price) : ''}</div><div class="small" style="white-space:pre-wrap">${esc(f.snapshot.text)}</div>` : ''}
          ${f.status === 'resolved' ? `<div class="small ok">Resolved by ${esc(f.resolvedBy)}: ${esc(f.resolution || '')}</div>` : ''}</td>
        <td>${f.status === 'open' ? `${f.snapshot ? `<button class="small secondary" data-mktest="${esc(f.id)}">Make test</button> ` : ''}<button class="small secondary" data-fbresolve="${esc(f.id)}">Resolve</button>` : ''}</td></tr>`).join('')}</table>` : '<p class="muted small">No feedback yet.</p>'}</div>
    <div class="card"><h2>Fine-tune an open-source model</h2><p class="muted small">Download broker-approved replies as chat-format JSONL, ready for LoRA fine-tuning (for example with Axolotl, Unsloth or llama-factory). Edited replies are the most valuable rows. Aim for hundreds of reviewed examples before fine-tuning.</p><a href="/api/export"><button class="secondary">Download finetune.jsonl</button></a></div>
    ${S.demo ? '<div class="card"><h2>Reset</h2><p class="muted small">Demo mode only: wipes aircraft, leads, deals and learned examples back to the demo data.</p><button class="danger" id="reset">Reset all demo data</button></div>' : ''}`;
  },
  trainingInit() {
    const put = (b) => call('PUT', 'playbook', b).then(render);
    document.querySelectorAll('[data-mktest]').forEach((b) => b.onclick = async () => {
      const expect = (prompt('What SHOULD the decision have been? Type accept, counter or escalate') || '').trim().toLowerCase(); if (!expect) return;
      await call('POST', `feedback/${b.dataset.mktest}/scenario`, { expect }); toast('Added as a test scenario'); render();
    });
    document.querySelectorAll('[data-fbresolve]').forEach((b) => b.onclick = async () => { const resolution = prompt('How was this resolved? (optional)'); if (resolution === null) return; await call('POST', `feedback/${b.dataset.fbresolve}/resolve`, { resolution }); render(); });
    $('#pbForm').onsubmit = (e) => { e.preventDefault(); const f = form(e.target); put({ company: f.company, broker: f.broker, tone: f.tone, systemPrompt: f.systemPrompt, rules: { stepBase: f.stepBase, stepPerRound: f.stepPerRound, escalateBelowPct: f.escalateBelowPct, maxRounds: f.maxRounds, disclaimer: f.disclaimer } }).then(() => toast('Playbook saved')); };
    $('#exForm').onsubmit = (e) => { e.preventDefault(); put({ examples: [...S.playbook.examples, form(e.target)] }); };
    document.querySelectorAll('[data-delex]').forEach((b) => b.onclick = () => put({ examples: S.playbook.examples.filter((_, i) => i !== +b.dataset.delex) }));
    document.querySelectorAll('[data-promote]').forEach((b) => b.onclick = () => call('POST', 'playbook/promote', { index: b.dataset.promote }).then(render));
    $('#scForm').onsubmit = (e) => { e.preventDefault(); const f = form(e.target); put({ scenarios: [...S.playbook.scenarios, { ...f, offer: +f.offer, round: +f.round, termMonths: f.termMonths ? +f.termMonths : undefined }] }); };
    document.querySelectorAll('[data-delsc]').forEach((b) => b.onclick = () => put({ scenarios: S.playbook.scenarios.filter((_, i) => i !== +b.dataset.delsc) }));
    $('#runEval').onclick = async () => {
      const r = await call('POST', 'eval');
      $('#evalOut').innerHTML = `<p><b class="${r.passed === r.total ? 'ok' : 'bad'}">${r.passed}/${r.total} passed</b></p><table>${r.rows.map((x) => `<tr><td>${x.pass ? '<span class="ok">PASS</span>' : '<span class="bad">FAIL</span>'}</td><td>${esc(x.name)}</td><td>${esc(x.action || '')} ${x.price ? fmt(x.price) : ''}</td><td class="bad small">${esc(x.problems.join('; '))}</td></tr>`).join('')}</table>`;
    };
    if ($('#reset')) $('#reset').onclick = async () => { if (confirm('Reset everything?')) { await call('POST', 'reset'); await render(); } };
  },
};

pages.users = async function () {
  const users = await call('GET', 'users');
  return `<h1>Users</h1>
  <div class="card"><table><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>2FA</th><th><span class="sr-only">Actions</span></th></tr>
  ${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td>
    <td><select data-role="${esc(u.id)}" aria-label="Role for ${esc(u.email)}">${['admin', 'broker', 'viewer'].map((r) => `<option ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
    <td>${u.disabled ? '<span class="tag bad">disabled</span>' : '<span class="tag ok">active</span>'}</td>
    <td>${u.twoFactor ? `<span class="tag ok">on</span> <button class="small secondary" data-reset2fa="${esc(u.id)}">Reset</button>` : '<span class="tag">off</span>'}</td>
    <td><button class="small secondary" data-toggle="${esc(u.id)}|${u.disabled ? 0 : 1}">${u.disabled ? 'Enable' : 'Disable'}</button>
      <button class="small secondary" data-reset="${esc(u.id)}">Reset password</button>
      ${u.id !== ME.id ? `<button class="small danger" data-rm="${esc(u.id)}">Delete</button>` : ''}</td></tr>`).join('')}</table>
  <p class="muted small">Admin: everything. Broker: leads, deals, inventory, sees private limits. Viewer: read-only, no private limits or drafts.</p></div>
  <div class="card"><h2>Add user</h2><form id="userForm"><div class="grid">
    <label>Name<input name="name" required></label><label>Email<input name="email" type="email" required></label>
    <label>Role<select name="role"><option>broker</option><option>viewer</option><option>admin</option></select></label>
    <label>Temporary password (12+ chars)<input name="password" type="password" minlength="12" required autocomplete="new-password"></label></div><button>Create user</button></form></div>`;
};
pages.usersInit = function () {
  $('#userForm').onsubmit = async (e) => { e.preventDefault(); await call('POST', 'users', form(e.target)); toast('User created'); render(); };
  document.querySelectorAll('[data-role]').forEach((s) => s.onchange = async () => { await call('PUT', 'users/' + s.dataset.role, { role: s.value }).catch(() => {}); render(); });
  document.querySelectorAll('[data-toggle]').forEach((b) => b.onclick = async () => { const [id, dis] = b.dataset.toggle.split('|'); await call('PUT', 'users/' + id, { disabled: dis === '1' }).catch(() => {}); render(); });
  document.querySelectorAll('[data-reset]').forEach((b) => b.onclick = async () => { const pw = prompt('New password for this user (12+ chars). They will be signed out.'); if (pw) { await call('PUT', 'users/' + b.dataset.reset, { password: pw }); toast('Password reset'); } });
  document.querySelectorAll('[data-reset2fa]').forEach((b) => b.onclick = async () => { if (confirm('Remove two-factor for this user? They will be signed out and can set it up again.')) { await call('PUT', 'users/' + b.dataset.reset2fa, { resetTwoFactor: true }); toast('Two-factor reset'); render(); } });
  document.querySelectorAll('[data-rm]').forEach((b) => b.onclick = async () => { if (confirm('Delete this user?')) { await call('DELETE', 'users/' + b.dataset.rm).catch(() => {}); render(); } });
};

pages.account = function () {
  return `<h1>Account</h1>
  ${MUST_ENROLL ? '<div class="banner" style="border-color:var(--bad)">Your role requires two-factor sign-in. Set it up below to continue.</div>' : ''}
  <div class="card"><h2>Two-factor sign-in</h2>
    ${ME.twoFactor ? `<p>Status: <span class="tag ok">on</span></p>
      <form id="tfManage"><div class="grid"><label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <label>Current code or recovery code<input name="code" required autocomplete="one-time-code"></label></div>
      <button value="recovery">Generate new recovery codes</button>${MUST_POLICY ? '' : '<button value="disable" class="danger">Turn off</button>'}</form>`
    : `<p class="muted small">Use an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy).</p>
      <button id="tfStart">Set up two-factor</button><div id="tfSetup"></div>`}
    <div id="tfCodes"></div></div>
  <div class="card"><h2>Change password</h2><form id="pwForm"><div class="grid">
    <label>Current password<input name="current" type="password" autocomplete="current-password" required></label>
    <label>New password (12+ characters)<input name="next" type="password" minlength="12" autocomplete="new-password" required></label></div><button>Change password</button></form></div>`;
};
function showCodes(codes) {
  $('#tfCodes').innerHTML = `<div class="limits" style="border-color:var(--ok)"><b>Save these recovery codes now.</b> Each works once if you lose your phone. They will not be shown again.<pre style="margin-top:8px;font-family:monospace">${codes.map(esc).join('\n')}</pre><button id="tfDone">I have saved them</button></div>`;
  $('#tfDone').onclick = () => { MUST_ENROLL = false; render(); };
}
pages.accountInit = function () {
  $('#pwForm').onsubmit = async (e) => { e.preventDefault(); await call('POST', 'me/password', form(e.target)); toast('Password changed'); e.target.reset(); };
  const start = $('#tfStart');
  if (start) start.onclick = async () => {
    const s = await call('POST', 'me/2fa/setup'); start.classList.add('hidden');
    $('#tfSetup').innerHTML = `<p class="small">1. In your authenticator app choose <b>add account → enter a setup key</b>, and enter:</p>
      <pre style="font-family:monospace;user-select:all">${esc(s.secret)}</pre>
      <p class="small muted">Account: ${esc(ME.email)}, type: time-based. (Apps that read links can use: <span style="word-break:break-all;user-select:all">${esc(s.uri)}</span>)</p>
      <form id="tfEnable"><label>2. Enter the 6-digit code the app shows<input name="code" inputmode="numeric" maxlength="6" pattern="\\d{6}" required autocomplete="one-time-code"></label><button>Turn on</button></form>`;
    $('#tfEnable').onsubmit = async (e) => { e.preventDefault(); const r = await call('POST', 'me/2fa/enable', form(e.target)); ME.twoFactor = true; $('#tfSetup').innerHTML = '<p class="ok">Two-factor is on.</p>'; showCodes(r.recoveryCodes); };
  };
  const mg = $('#tfManage');
  if (mg) mg.onsubmit = async (e) => {
    e.preventDefault(); const action = e.submitter && e.submitter.value, f = form(e.target);
    if (action === 'disable') { if (!confirm('Turn off two-factor?')) return; await call('POST', 'me/2fa/disable', f); toast('Two-factor turned off'); render(); }
    else { const r = await call('POST', 'me/2fa/recovery', f); showCodes(r.recoveryCodes); e.target.reset(); }
  };
};

function authView(needsSetup) {
  document.body.classList.add('authed-out');
  $('#view').innerHTML = `<div class="auth"><div class="card"><h1>${needsSetup ? 'Create the admin account' : 'Sign in'}</h1>
    ${needsSetup ? '<p class="muted small">First run: this account will manage users and settings.</p>' : ''}
    <form id="authForm">${needsSetup ? '<label>Name<input name="name" required autocomplete="name"></label>' : ''}
    <label>Email<input name="email" type="email" required autocomplete="username"></label>
    <label>Password${needsSetup ? ' (12+ characters)' : ''}<input name="password" type="password" required ${needsSetup ? 'minlength="12"' : ''} autocomplete="${needsSetup ? 'new-password' : 'current-password'}"></label>
    <button>${needsSetup ? 'Create account' : 'Sign in'}</button><div class="err" id="authErr"></div></form></div></div>`;
  $('#authForm').onsubmit = async (e) => {
    e.preventDefault();
    const r = await fetch('/api/' + (needsSetup ? 'setup' : 'login'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form(e.target)) });
    const j = await r.json();
    if (!r.ok) { $('#authErr').textContent = j.error || 'Failed'; return; }
    if (j.needs2fa) return codeView(j.ticket);
    location.hash = '#/dashboard'; render();
  };
}

function codeView(ticket) {
  $('#view').innerHTML = `<div class="auth"><div class="card"><h1>Two-factor code</h1>
    <p class="muted small">Enter the 6-digit code from your authenticator app, or one of your recovery codes.</p>
    <form id="codeForm"><label>Code<input name="code" required autocomplete="one-time-code" autofocus></label><button>Verify</button> <button type="button" class="secondary" id="codeBack">Back</button><div class="err" id="authErr"></div></form></div></div>`;
  $('#codeBack').onclick = () => authView(false);
  $('#codeForm').onsubmit = async (e) => {
    e.preventDefault();
    const r = await fetch('/api/login/2fa', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket, code: form(e.target).code }) });
    const j = await r.json();
    if (!r.ok) { $('#authErr').textContent = j.error || 'Failed'; if (r.status === 401 && /expired/i.test(j.error || '')) setTimeout(() => authView(false), 1500); return; }
    location.hash = '#/dashboard'; render();
  };
}

async function render() {
  const info = await (await fetch('/api/me')).json();
  if (!info.user) { ME = null; PERMS = []; return authView(info.needsSetup); }
  ME = info.user; PERMS = info.perms; MUST_ENROLL = info.mustEnroll; MUST_POLICY = info.twoFactorPolicy === 'all' || (info.twoFactorPolicy === 'admin' && ME.role === 'admin'); document.body.classList.remove('authed-out');
  $('#userBox').innerHTML = `${esc(ME.name)}<br><span class="muted">${esc(ME.role)}</span><br><button id="logout">Sign out</button>`;
  $('#logout').onclick = async () => { await call('POST', 'logout'); ME = null; render(); };
  if (MUST_ENROLL) { // blocked server-side until enrolled; show only the Account page
    S = { inventory: [], leads: [], deals: [], activity: [], llm: {}, mail: {} };
    document.querySelectorAll('#nav a').forEach((l) => l.classList.toggle('hidden', l.id !== 'accountLink'));
    $('#llmStatus').textContent = ''; location.hash = '#/account';
  } else { document.querySelectorAll('#nav a').forEach((l) => l.classList.toggle('hidden', !!l.dataset.perm && !can(l.dataset.perm))); await refresh(); }
  const name = (location.hash.replace('#/', '') || 'dashboard');
  const allowed = { training: 'playbook.write', users: 'users.manage' };
  if (MUST_ENROLL) { $('#view').innerHTML = pages.account(); pages.accountInit(); return; }
  const page = pages[name] && (!allowed[name] || can(allowed[name])) ? name : 'dashboard';
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#/' + page));
  $('#view').innerHTML = (S.demo && can('view.full') ? '<div class="banner"><b>Demo mode.</b> The aircraft are sample listings with invented prices. Start the server with SEED_DEMO=0 for real use.</div>' : '') + await pages[page]();
  if (pages[page + 'Init']) pages[page + 'Init']();
}
window.addEventListener('hashchange', render);
render();
