const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => '$' + Math.round(n).toLocaleString('en-US');
let S = null, selectedDeal = null, ME = null, PERMS = [];
const can = (p) => PERMS.includes('*') || PERMS.includes(p);

async function call(method, path, body) {
  const r = await fetch('/api/' + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (r.status === 401 && ME) { ME = null; render(); throw new Error('Session ended'); }
  if (!r.ok) { toast(j.error || 'Error'); throw new Error(j.error); }
  return j;
}
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.remove('hidden'); setTimeout(() => t.classList.add('hidden'), 3000); }
async function refresh() { S = await call('GET', 'state'); $('#llmStatus').textContent = !can('view.full') ? '' : S.llm.enabled ? 'Model: ' + S.llm.provider + ' / ' + S.llm.model : 'Model: off (templates)'; }
const aircraft = (id) => S.inventory.find((a) => a.id === id);
const priceOf = (a, mode) => (mode === 'lease' ? fmt(a.leaseMonthly) + '/mo' : fmt(a.listPrice));
const form = (el) => Object.fromEntries(new FormData(el));

const pages = {
  dashboard() {
    const pending = S.deals.flatMap((d) => d.messages.filter((m) => m.status === 'draft').map(() => d)).length;
    return `<h1>Dashboard</h1>
    <div class="stats">
      <div class="stat"><b>${S.inventory.length}</b>Aircraft listed</div>
      <div class="stat"><b>${S.leads.filter((l) => l.status === 'qualified').length}</b>Qualified leads</div>
      <div class="stat"><b>${S.deals.filter((d) => d.stage === 'negotiating').length}</b>Active deals</div>
      <div class="stat"><b>${pending}</b>Drafts awaiting approval</div>
      <div class="stat"><b>${S.deals.filter((d) => d.stage === 'escalated').length}</b>Escalated</div>
      <div class="stat"><b>${S.deals.filter((d) => d.stage === 'LOI').length}</b>At LOI</div>
    </div>
    <div class="card"><h2>Recent activity</h2>${S.activity.length ? '<table>' + S.activity.slice(0, 12).map((a) => `<tr><td class="muted small" style="width:150px">${new Date(a.at).toLocaleString()}</td><td>${esc(a.msg)}</td></tr>`).join('') + '</table>' : '<p class="muted">Nothing yet. Add a lead to get started.</p>'}</div>`;
  },

  inventory() {
    return `<h1>Inventory</h1>
    <div class="card"><table><tr><th>ID</th><th>Aircraft</th><th>Year / hrs</th><th>Seats / range</th><th>Location</th><th>List</th><th>Lease/mo</th>${can('view.full') ? '<th>Broker-only limits</th>' : ''}<th></th></tr>
    ${S.inventory.map((a) => `<tr><td>${esc(a.id)}</td><td><b>${esc(a.model)}</b><br><span class="tag">${esc(a.type)}</span></td><td>${a.year}<br>${a.hours.toLocaleString()}</td><td>${a.seats}<br>${a.rangeNm} nm</td><td>${esc(a.location)}</td><td>${fmt(a.listPrice)}</td><td>${fmt(a.leaseMonthly)}</td>
      ${can('view.full') ? `<td class="small warn">floor ${fmt(a.floor)}<br>max disc ${a.maxDiscountPct}%<br>min lease ${fmt(a.minLeaseMonthly)} / ${a.minTermMonths} mo</td>` : ''}
      <td>${can('inventory.write') ? `<button class="small secondary" data-edit="${esc(a.id)}">Edit</button>` : ''} ${can('inventory.delete') ? `<button class="small danger" data-del="${esc(a.id)}">Delete</button>` : ''}</td></tr>`).join('')}</table></div>
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
    if ($('#invForm')) $('#invForm').onsubmit = async (e) => { e.preventDefault(); await call('POST', 'inventory', form(e.target)); toast('Saved'); await render(); };
    document.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => { if (confirm('Delete ' + b.dataset.del + '?')) { await call('DELETE', 'inventory/' + b.dataset.del); await render(); } });
    document.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => {
      const a = aircraft(b.dataset.edit), f = $('#invForm'); for (const k in a) if (f.elements[k]) f.elements[k].value = a[k];
      $('#invTitle').textContent = 'Edit ' + a.id; f.scrollIntoView();
    });
  },

  leads() {
    return `<h1>Leads</h1>
    ${can('leads.write') ? `<div class="card"><h2>New inquiry</h2><form id="leadForm"><div class="grid">
      <label>Name<input name="name" required></label><label>Company<input name="company"></label><label>Country<input name="country" required></label>
      <label>Buy or lease<select name="mode"><option value="buy">Buy</option><option value="lease">Lease</option></select></label>
      <label>Type<select name="type"><option value="any">Any</option><option>turboprop</option><option>light jet</option><option>regional jet</option><option>narrowbody</option></select></label>
      <label>Min seats<input name="seats" type="number"></label><label>Min range (nm)<input name="rangeNm" type="number"></label>
      <label>Max age (yrs)<input name="maxAge" type="number"></label><label>Budget (per month if lease)<input name="budget" type="number"></label>
    </div><button>Screen and match</button></form></div>` : ''}
    ${S.leads.map((l) => `<div class="card"><b>${esc(l.name)}</b> ${esc(l.company || '')} <span class="muted">· ${esc(l.country)} · ${l.request.mode}</span>
      <span class="tag ${l.screening.ok ? 'ok' : 'bad'}">${l.screening.ok ? 'screening passed (demo)' : 'compliance hold: ' + esc(l.screening.reason)}</span>
      ${l.matches.map((m) => { const a = aircraft(m.aircraftId); return a ? `<div style="margin-top:8px">${esc(a.model)} <span class="tag">${a.id}</span> <span class="tag">match ${m.score}</span> ${priceOf(a, l.request.mode)} <span class="warn small">${esc(m.reasons.join(', '))}</span> ${can('deals.write') ? `<button class="small secondary" data-open="${l.id}|${a.id}">Open deal</button>` : ''}</div>` : ''; }).join('')}
      ${l.screening.ok && !l.matches.length ? '<p class="muted small">No matching aircraft. Source inventory.</p>' : ''}</div>`).join('')}`;
  },
  leadsInit() {
    if ($('#leadForm')) $('#leadForm').onsubmit = async (e) => { e.preventDefault(); await call('POST', 'leads', form(e.target)); await render(); };
    document.querySelectorAll('[data-open]').forEach((b) => b.onclick = async () => { const [leadId, aircraftId] = b.dataset.open.split('|'); const d = await call('POST', 'deals', { leadId, aircraftId }); selectedDeal = d.id; location.hash = '#/deals'; });
  },

  deals() {
    const d = S.deals.find((x) => x.id === selectedDeal) || S.deals[0];
    if (d) selectedDeal = d.id;
    const list = S.deals.map((x) => `<div class="deal-item ${x.id === selectedDeal ? 'active' : ''}" data-deal="${x.id}"><b>${esc(x.buyer)}</b><br><span class="small">${esc(aircraft(x.aircraftId)?.model || x.aircraftId)}</span><br><span class="tag ${x.stage === 'LOI' ? 'ok' : x.stage === 'escalated' ? 'bad' : ''}">${x.stage}</span></div>`).join('') || '<p class="muted">No deals yet. Open one from a lead.</p>';
    let detail = '<div class="card muted">Select a deal.</div>';
    if (d) {
      const a = aircraft(d.aircraftId) || {}; const pending = d.messages.find((m) => m.status === 'draft');
      detail = `<div class="card"><h2>${esc(d.buyer)} · ${esc(a.model)} <span class="tag">${d.mode}</span></h2>
        ${can('view.full') ? `<div class="limits">Broker-only: ${d.mode === 'lease' ? `min ${fmt(a.minLeaseMonthly)}/mo, min term ${a.minTermMonths} mo` : `floor ${fmt(a.floor)}, max discount ${a.maxDiscountPct}%`}. Asking ${priceOf(a, d.mode)}.</div>` : `<div class="muted small">Asking ${priceOf(a, d.mode)}.</div>`}
        <div>${d.messages.filter((m) => m.status !== 'rejected').map((m) => m.role === 'buyer' ? `<div class="msg buyer">${esc(m.text)}</div>` :
          m.status === 'draft' ? `<div class="msg assistant draft"><b>Draft (${m.action})</b> <span class="tag">${esc(m.source)}</span>
            ${m.flags.map((f) => `<div class="warn small">⚠ ${esc(f)}</div>`).join('')}<textarea id="draftText" rows="5">${esc(m.text)}</textarea><div class="muted small">${esc(m.note)}</div>
            <button data-approve="${m.id}">Approve and send</button><button class="secondary" data-reject="${m.id}">Reject</button></div>`
          : `<div class="msg assistant">${esc(m.text)}</div>`).join('')}</div>
        ${['LOI', 'escalated'].includes(d.stage) ? `<p class="${d.stage === 'LOI' ? 'ok' : 'bad'}">${d.stage === 'LOI' ? 'Ready for letter of intent (human step).' : 'Escalated to the human broker.'}</p>` : ''}
        ${!pending && d.stage === 'negotiating' && can('deals.write') ? `<div class="grid"><label>Buyer's offer (${d.mode === 'lease' ? 'per month' : 'USD'})<input id="offer" type="number"></label>${d.mode === 'lease' ? '<label>Term (months)<input id="term" type="number" value="36"></label>' : ''}</div><button id="sendOffer">Submit buyer's offer</button>` : ''}</div>`;
    }
    return `<h1>Deals</h1><div class="split"><div>${list}</div><div>${detail}</div></div>`;
  },
  dealsInit() {
    document.querySelectorAll('[data-deal]').forEach((el) => el.onclick = () => { selectedDeal = el.dataset.deal; render(); });
    const send = $('#sendOffer'); if (send) send.onclick = async () => { const offer = $('#offer').value; if (!offer) return; send.disabled = true; await call('POST', `deals/${selectedDeal}/offer`, { offer, termMonths: $('#term')?.value }); await render(); };
    const ap = $('[data-approve]'); if (ap) ap.onclick = async () => { await call('POST', `deals/${selectedDeal}/messages/${ap.dataset.approve}/approve`, { text: $('#draftText').value }); await render(); };
    const rj = $('[data-reject]'); if (rj) rj.onclick = async () => { await call('POST', `deals/${selectedDeal}/messages/${rj.dataset.reject}/reject`); await render(); };
  },

  training() {
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
      <table><tr><th>Scenario</th><th>Aircraft</th><th>Offer</th><th>Round</th><th>Expect</th><th></th></tr>${p.scenarios.map((s, i) => `<tr><td>${esc(s.name)}</td><td>${s.aircraftId} ${s.mode}</td><td>${fmt(s.offer)}</td><td>${s.round}</td><td>${s.expect}</td><td><button class="small secondary" data-delsc="${i}">Remove</button></td></tr>`).join('')}</table>
      <h3>Add scenario</h3><form id="scForm" class="grid"><label>Name<input name="name" required></label><label>Aircraft<select name="aircraftId">${S.inventory.map((a) => `<option>${esc(a.id)}</option>`).join('')}</select></label>
        <label>Mode<select name="mode"><option>buy</option><option>lease</option></select></label><label>Offer<input name="offer" type="number" required></label><label>Round<input name="round" type="number" value="1"></label>
        <label>Term (lease)<input name="termMonths" type="number"></label><label>Expect<select name="expect"><option>accept</option><option>counter</option><option>escalate</option></select></label><div><button>Add</button></div></form></div>
    <div class="card"><h2>Fine-tune an open-source model</h2><p class="muted small">Download broker-approved replies as chat-format JSONL, ready for LoRA fine-tuning (for example with Axolotl, Unsloth or llama-factory). Edited replies are the most valuable rows. Aim for hundreds of reviewed examples before fine-tuning.</p><a href="/api/export"><button class="secondary">Download finetune.jsonl</button></a></div>
    <div class="card"><h2>Reset</h2><button class="danger" id="reset">Reset all demo data</button></div>`;
  },
  trainingInit() {
    const put = (b) => call('PUT', 'playbook', b).then(render);
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
    $('#reset').onclick = async () => { if (confirm('Reset everything?')) { await call('POST', 'reset'); await render(); } };
  },
};

pages.users = async function () {
  const users = await call('GET', 'users');
  return `<h1>Users</h1>
  <div class="card"><table><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr>
  ${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td>
    <td><select data-role="${u.id}">${['admin', 'broker', 'viewer'].map((r) => `<option ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
    <td>${u.disabled ? '<span class="tag bad">disabled</span>' : '<span class="tag ok">active</span>'}</td>
    <td><button class="small secondary" data-toggle="${u.id}|${u.disabled ? 0 : 1}">${u.disabled ? 'Enable' : 'Disable'}</button>
      <button class="small secondary" data-reset="${u.id}">Reset password</button>
      ${u.id !== ME.id ? `<button class="small danger" data-rm="${u.id}">Delete</button>` : ''}</td></tr>`).join('')}</table>
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
  document.querySelectorAll('[data-rm]').forEach((b) => b.onclick = async () => { if (confirm('Delete this user?')) { await call('DELETE', 'users/' + b.dataset.rm).catch(() => {}); render(); } });
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
    location.hash = '#/dashboard'; render();
  };
}

async function render() {
  const info = await (await fetch('/api/me')).json();
  if (!info.user) { ME = null; PERMS = []; return authView(info.needsSetup); }
  ME = info.user; PERMS = info.perms; document.body.classList.remove('authed-out');
  $('#userBox').innerHTML = `${esc(ME.name)}<br><span class="muted">${esc(ME.role)}</span><br><button id="logout">Sign out</button>`;
  $('#logout').onclick = async () => { await call('POST', 'logout'); ME = null; render(); };
  document.querySelectorAll('#nav a[data-perm]').forEach((l) => l.classList.toggle('hidden', !can(l.dataset.perm)));
  await refresh();
  const name = (location.hash.replace('#/', '') || 'dashboard');
  const allowed = { training: 'playbook.write', users: 'users.manage' };
  const page = pages[name] && (!allowed[name] || can(allowed[name])) ? name : 'dashboard';
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#/' + page));
  $('#view').innerHTML = await pages[page]();
  if (pages[page + 'Init']) pages[page + 'Init']();
}
window.addEventListener('hashchange', render);
render();
