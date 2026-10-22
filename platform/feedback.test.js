// Pilot feedback: flag drafts, turn them into test scenarios.
process.env.DB_FILE = require('path').join(require('os').tmpdir(), 'deal-feedback-' + Date.now() + '.db');
delete process.env.LLM_PROVIDER; delete process.env.ANTHROPIC_API_KEY; delete process.env.MAIL_PROVIDER;
const assert = require('assert'), server = require('./server.js'), { raw, adminClient, PASSWORD } = require('./testlib.js');
server.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port, admin = await adminClient(base), r = (m, p, b, c) => raw(base, m, p, b, c || admin);
  try {
    await r('POST', 'users', { email: 'b@x.com', name: 'B', role: 'broker', password: PASSWORD }); await r('POST', 'users', { email: 'v@x.com', name: 'V', role: 'viewer', password: PASSWORD });
    const bro = (await raw(base, 'POST', 'login', { email: 'b@x.com', password: PASSWORD })).cookie, vie = (await raw(base, 'POST', 'login', { email: 'v@x.com', password: PASSWORD })).cookie;
    const lead = (await r('POST', 'leads', { name: 'Alex', country: 'Spain', mode: 'buy', seats: 60, rangeNm: 700, budget: 9e6 })).body;
    const lease = (await r('POST', 'leads', { name: 'Lena', country: 'Germany', mode: 'lease', seats: 6, budget: 45000 })).body;
    const deal = (await r('POST', 'deals', { leadId: lead.id, aircraftId: 'TP-01' })).body;
    // round 1 rejected, then round 2 offer becomes round 1 again
    let d = (await r('POST', `deals/${deal.id}/offer`, { offer: 8e6 })).body; const first = d.messages.find((m) => m.status === 'draft');
    await r('POST', `deals/${deal.id}/messages/${first.id}/reject`, {});
    d = (await r('POST', `deals/${deal.id}/offer`, { offer: 8.2e6 })).body; const draft = d.messages.filter((m) => m.status === 'draft')[0];

    // flagging: brokers can, viewers cannot; input is validated; the snapshot is built by the server
    assert.equal((await r('POST', 'feedback', { kind: 'draft', dealId: deal.id, messageId: draft.id, comment: 'too short' }, vie)).status, 403);
    assert.equal((await r('POST', 'feedback', { kind: 'draft', dealId: deal.id, messageId: draft.id, comment: 'x' }, bro)).status, 400);
    assert.equal((await r('POST', 'feedback', { kind: 'nope', comment: 'long enough comment' }, bro)).status, 400);
    assert.equal((await r('POST', 'feedback', { kind: 'draft', dealId: 'zzz', messageId: draft.id, comment: 'long enough comment' }, bro)).status, 404);
    const buyerMsg = d.messages.find((m) => m.role === 'buyer');
    assert.equal((await r('POST', 'feedback', { kind: 'draft', dealId: deal.id, messageId: buyerMsg.id, comment: 'long enough comment' }, bro)).status, 404, 'only assistant drafts can be flagged');
    const ok = await r('POST', 'feedback', { kind: 'draft', dealId: deal.id, messageId: draft.id, comment: 'Counter is too generous <img src=x onerror=alert(1)>', snapshot: { offer: 1, action: 'accept' } }, bro);
    assert.equal(ok.status, 200);
    assert.equal((await r('POST', 'feedback', { kind: 'other', comment: 'The matches page is confusing' }, bro)).status, 200);

    // only admins read feedback
    assert.equal((await r('GET', 'feedback', null, bro)).status, 403); assert.equal((await r('GET', 'feedback', null, vie)).status, 403);
    const list = (await r('GET', 'feedback')).body, fb = list.find((f) => f.id === ok.body.id);
    assert.equal(list.length, 2); assert.equal(fb.status, 'open'); assert.equal(fb.userEmail, 'b@x.com');
    assert.equal(fb.snapshot.offer, 8200000, 'snapshot comes from the server, not the client'); assert.equal(fb.snapshot.action, draft.action);
    assert.equal(fb.snapshot.round, 1, 'rejected draft rewinds the round'); assert.equal(fb.snapshot.aircraftId, 'TP-01'); assert.equal(fb.snapshot.mode, 'buy');
    assert.ok(fb.comment.includes('<img'), 'stored as plain text (the UI escapes it)');

    // scenario from feedback: validation, creation, regression check, one-shot
    const other = list.find((f) => f.kind === 'other');
    assert.equal((await r('POST', `feedback/${other.id}/scenario`, { expect: 'accept' })).status, 400, 'general notes cannot become scenarios');
    assert.equal((await r('POST', `feedback/${fb.id}/scenario`, { expect: 'maybe' })).status, 400);
    assert.equal((await r('POST', `feedback/${fb.id}/scenario`, { expect: 'escalate' }, bro)).status, 403);
    const before = (await r('GET', 'state')).body.playbook.scenarios.length;
    const made = await r('POST', `feedback/${fb.id}/scenario`, { expect: 'escalate' }); assert.equal(made.status, 200); assert.equal(made.body.scenarios, before + 1);
    const sc = (await r('GET', 'state')).body.playbook.scenarios.at(-1);
    assert.deepEqual([sc.aircraftId, sc.mode, sc.offer, sc.round, sc.expect], ['TP-01', 'buy', 8200000, 1, 'escalate']); assert.ok(sc.name.startsWith('Feedback: '));
    const ev = (await r('POST', 'eval')).body; const row = ev.rows.at(-1);
    assert.equal(row.pass, false, 'the engine counters this offer, so a scenario expecting escalate must fail: the regression is now visible'); assert.match(row.problems[0], /expected escalate, got counter/);
    assert.equal((await r('POST', `feedback/${fb.id}/scenario`, { expect: 'counter' })).status, 409); assert.equal((await r('POST', `feedback/${fb.id}/resolve`, {})).status, 409);
    assert.equal((await r('GET', 'feedback')).body.find((f) => f.id === fb.id).status, 'resolved');
    assert.equal((await r('POST', `feedback/${other.id}/resolve`, { resolution: 'Noted, will reword' })).status, 200);
    assert.equal((await r('GET', 'feedback')).body.find((f) => f.id === other.id).resolution, 'Noted, will reword');
    assert.equal((await r('POST', 'feedback/nope/resolve', {})).status, 404);

    // lease term is captured, so a term-related complaint becomes a faithful scenario
    const ld = (await r('POST', 'deals', { leadId: lease.id, aircraftId: 'LJ-03' })).body;
    const lx = (await r('POST', `deals/${ld.id}/offer`, { offer: 44000, termMonths: 12 })).body, ldraft = lx.messages.find((m) => m.status === 'draft');
    await r('POST', 'feedback', { kind: 'draft', dealId: ld.id, messageId: ldraft.id, comment: 'Should also mention the deposit' }, bro);
    const lf = (await r('GET', 'feedback')).body.find((f) => f.dealId === ld.id); assert.equal(lf.snapshot.termMonths, 12); assert.equal(lf.snapshot.mode, 'lease');
    assert.equal((await r('POST', `feedback/${lf.id}/scenario`, { expect: 'counter' })).status, 200);
    assert.deepEqual((await r('GET', 'state')).body.playbook.scenarios.at(-1).termMonths, 12);
    assert.equal((await r('POST', 'eval')).body.rows.at(-1).pass, true);

    // erasing the buyer removes feedback that quoted their draft
    assert.ok((await r('GET', 'feedback')).body.some((f) => f.dealId === deal.id));
    await r('DELETE', `leads/${lead.id}`); assert.ok(!(await r('GET', 'feedback')).body.some((f) => f.dealId === deal.id), 'feedback about an erased lead must go too');
    console.log('feedback tests passed'); process.exit(0);
  } catch (e) { console.error(e); process.exit(1); }
});
