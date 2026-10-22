// Subject access (export) and erasure of a buyer's personal data.
process.env.DB_FILE = require('path').join(require('os').tmpdir(), 'deal-privacy-' + Date.now() + '.db');
delete process.env.LLM_PROVIDER; delete process.env.ANTHROPIC_API_KEY; delete process.env.MAIL_PROVIDER;
const assert = require('assert'), server = require('./server.js'), store = require('./store.js'), { raw, adminClient, PASSWORD } = require('./testlib.js');
server.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port, admin = await adminClient(base), r = (m, p, b, c) => raw(base, m, p, b, c || admin);
  try {
    const mk = async (name, email, company) => {
      const lead = (await r('POST', 'leads', { name, email, company, country: 'Spain', mode: 'buy', seats: 60, rangeNm: 700, budget: 9e6 })).body;
      let d = (await r('POST', 'deals', { leadId: lead.id, aircraftId: 'TP-01' })).body; d = (await r('POST', `deals/${d.id}/offer`, { offer: 8e6 })).body;
      const m = d.messages.find((x) => x.status === 'draft');
      await r('POST', `deals/${d.id}/messages/${m.id}/approve`, { text: `Dear ${name} (${email}), ${m.text}` }); // an edit that puts personal data into learned examples
      return lead;
    };
    const target = await mk('Zephyr Quill', 'zephyr@quill.example', 'Quill Aviation'), other = await mk('Marcus Hale', 'marcus@hale.example', 'Hale Air');
    // legacy log lines from before activity used ids
    store.activity.add('Lead Zephyr Quill: qualified, 5 match(es)', 'admin@example.com'); store.activity.add('Emailed zephyr@quill.example', null);
    // new activity lines never contain buyer names
    const before = (await r('GET', 'state')).body.activity.map((a) => a.msg).join('\n');
    assert.ok(!before.includes('Marcus Hale') && /Lead [0-9a-f]{8}:/.test(before) && /Deal opened [0-9a-f]{8} for lead/.test(before), before);

    // permissions
    await r('POST', 'users', { email: 'b@x.com', name: 'B', role: 'broker', password: PASSWORD });
    const bro = (await raw(base, 'POST', 'login', { email: 'b@x.com', password: PASSWORD })).cookie;
    assert.equal((await r('GET', `leads/${target.id}/export`, null, bro)).status, 403);
    assert.equal((await r('DELETE', `leads/${target.id}`, null, bro)).status, 403);

    // export has everything about the person, and is itself audited
    const ex = (await r('GET', `leads/${target.id}/export`)).body;
    assert.equal(ex.lead.email, 'zephyr@quill.example'); assert.equal(ex.deals.length, 1); assert.ok(ex.deals[0].messages.length >= 2);
    assert.ok((await r('GET', 'state')).body.activity.some((a) => a.msg === 'Lead data exported: ' + target.id));
    assert.equal((await r('GET', 'leads/nope/export')).status, 404);

    // erase
    const out = (await r('DELETE', `leads/${target.id}`)).body;
    assert.equal(out.ok, true); assert.equal(out.deals, 1); assert.ok(out.messages >= 2); assert.ok(out.scrubbed >= 3, JSON.stringify(out));
    const db = store.db, count = (sql, ...a) => db.prepare(sql).get(...a).n;
    assert.equal(count('SELECT COUNT(*) n FROM leads WHERE id=?', target.id), 0);
    assert.equal(count('SELECT COUNT(*) n FROM deals WHERE lead_id=?', target.id), 0);
    assert.equal(count('SELECT COUNT(*) n FROM messages WHERE deal_id=?', ex.deals[0].id), 0);
    const everything = JSON.stringify([db.prepare('SELECT * FROM activity').all(), db.prepare('SELECT * FROM learned').all(), db.prepare('SELECT * FROM leads').all(), db.prepare('SELECT * FROM messages').all(), db.prepare('SELECT * FROM deals').all()]);
    for (const pii of ['Zephyr', 'zephyr@quill.example', 'Quill Aviation']) assert.ok(!everything.includes(pii), 'still stored: ' + pii);
    assert.ok(everything.includes('[erased]'), 'scrub marker missing');
    assert.ok((await r('GET', 'state')).body.activity.some((a) => a.msg.startsWith('Lead erased: ' + target.id)));
    // the other buyer is untouched
    assert.ok(everything.includes('Marcus Hale') && everything.includes('marcus@hale.example'));
    assert.equal(count('SELECT COUNT(*) n FROM deals WHERE lead_id=?', other.id), 1);
    // gone is gone
    assert.equal((await r('DELETE', `leads/${target.id}`)).status, 404);
    assert.ok(!(await r('GET', 'state')).body.leads.some((l) => l.id === target.id));
    console.log('privacy tests passed'); process.exit(0);
  } catch (e) { console.error(e); process.exit(1); }
});
