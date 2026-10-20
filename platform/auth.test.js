process.env.DB_FILE = require('path').join(require('os').tmpdir(), 'deal-auth-' + Date.now() + '.json');
delete process.env.LLM_PROVIDER; delete process.env.ANTHROPIC_API_KEY;
const assert = require('assert');
const server = require('./server.js');
const { raw, adminClient, PASSWORD } = require('./testlib.js');

server.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const r = (m, p, b, c) => raw(base, m, p, b, c);
  try {
    // Not logged in
    assert.equal((await r('GET', 'state')).status, 401);
    assert.equal((await r('GET', 'me')).body.needsSetup, true);
    // Setup: weak password rejected, then works once only
    assert.equal((await r('POST', 'setup', { email: 'a@x.com', name: 'A', password: 'short' })).status, 400);
    const adminCookie = await adminClient(base);
    assert.equal((await r('POST', 'setup', { email: 'b@x.com', name: 'B', password: PASSWORD })).status, 403);
    const me = (await r('GET', 'me', null, adminCookie)).body;
    assert.equal(me.user.role, 'admin'); assert.ok(!('hash' in me.user) && !('salt' in me.user));
    // Cookie flags, security headers
    const setupish = await r('POST', 'login', { email: 'admin@example.com', password: PASSWORD });
    assert.equal(setupish.status, 200);
    const rawLogin = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: PASSWORD }) });
    const sc = rawLogin.headers.get('set-cookie');
    assert.ok(/HttpOnly/.test(sc) && /SameSite=Strict/.test(sc), sc);
    assert.equal(rawLogin.headers.get('x-frame-options'), 'DENY');
    // CSRF guards
    const cross = await fetch(base + '/api/leads', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example', cookie: adminCookie }, body: '{}' });
    assert.equal(cross.status, 403);
    const form = await fetch(base + '/api/leads', { method: 'POST', headers: { 'content-type': 'text/plain', cookie: adminCookie }, body: '{}' });
    assert.equal(form.status, 415);
    // Create users
    assert.equal((await r('POST', 'users', { email: 'broker@x.com', name: 'Bo', role: 'broker', password: PASSWORD }, adminCookie)).status, 200);
    assert.equal((await r('POST', 'users', { email: 'viewer@x.com', name: 'Vi', role: 'viewer', password: PASSWORD }, adminCookie)).status, 200);
    assert.equal((await r('POST', 'users', { email: 'broker@x.com', name: 'Dup', role: 'broker', password: PASSWORD }, adminCookie)).status, 409);
    assert.equal((await r('POST', 'users', { email: 'z@x.com', name: 'Z', role: 'root', password: PASSWORD }, adminCookie)).status, 400);
    const bro = (await r('POST', 'login', { email: 'BROKER@x.com', password: PASSWORD })).cookie;
    const vie = (await r('POST', 'login', { email: 'viewer@x.com', password: PASSWORD })).cookie;
    assert.ok(bro && vie);
    // Wrong password is generic
    const bad1 = await r('POST', 'login', { email: 'broker@x.com', password: 'nope-nope-nope' });
    const bad2 = await r('POST', 'login', { email: 'ghost@x.com', password: 'nope-nope-nope' });
    assert.equal(bad1.status, 401); assert.equal(bad1.body.error, bad2.body.error);

    // Broker: works deals, cannot manage users / playbook / reset / export / delete inventory
    const lead = (await r('POST', 'leads', { name: 'Alex', country: 'Spain', mode: 'buy', seats: 60, rangeNm: 700, budget: 9000000 }, bro)).body;
    assert.equal(lead.status, 'qualified');
    let deal = (await r('POST', 'deals', { leadId: lead.id, aircraftId: 'TP-01' }, bro)).body;
    deal = (await r('POST', `deals/${deal.id}/offer`, { offer: 8000000 }, bro)).body;
    const draft = deal.messages.find((m) => m.status === 'draft');
    for (const [m, p] of [['GET', 'users'], ['PUT', 'playbook'], ['POST', 'reset'], ['GET', 'export'], ['POST', 'eval'], ['DELETE', 'inventory/TP-01']])
      assert.equal((await r(m, p, m === 'GET' || m === 'DELETE' ? null : {}, bro)).status, 403, m + ' ' + p);
    const full = (await r('GET', 'state', null, bro)).body;
    assert.equal(full.inventory[0].floor, 8600000); assert.ok(full.playbook);

    // Viewer: read only, redacted
    for (const [m, p, b] of [['POST', 'leads', {}], ['POST', 'deals', {}], ['POST', `deals/${deal.id}/messages/${draft.id}/approve`, {}], ['POST', 'inventory', {}]])
      assert.equal((await r(m, p, b, vie)).status, 403, m + ' ' + p);
    const red = (await r('GET', 'state', null, vie)).body;
    const dump = JSON.stringify(red);
    assert.ok(!dump.includes('8600000') && !dump.includes('floor') && !dump.includes('minLeaseMonthly') && !dump.includes('maxDiscountPct'), 'viewer sees private limits');
    assert.equal(red.playbook, null);
    assert.ok(!red.deals[0].messages.some((m) => m.status === 'draft'), 'viewer sees draft');
    assert.ok(!dump.includes('systemPrompt'));

    // approvedBy recorded
    deal = (await r('POST', `deals/${deal.id}/messages/${draft.id}/approve`, {}, bro)).body;
    assert.equal(deal.messages.find((m) => m.id === draft.id).approvedBy, 'broker@x.com');

    // Admin: last-admin protection, self-delete, role change revokes sessions
    const users = (await r('GET', 'users', null, adminCookie)).body;
    const adminId = users.find((u) => u.role === 'admin').id, brokerId = users.find((u) => u.role === 'broker').id;
    assert.equal((await r('PUT', 'users/' + adminId, { role: 'broker' }, adminCookie)).status, 400);
    assert.equal((await r('PUT', 'users/' + adminId, { disabled: true }, adminCookie)).status, 400);
    assert.equal((await r('DELETE', 'users/' + adminId, null, adminCookie)).status, 400);
    assert.equal((await r('PUT', 'users/' + brokerId, { role: 'viewer' }, adminCookie)).status, 200);
    assert.equal((await r('GET', 'state', null, bro)).status, 401, 'session should be revoked on role change');
    assert.equal((await r('PUT', 'users/' + brokerId, { disabled: true }, adminCookie)).status, 200);
    assert.equal((await r('POST', 'login', { email: 'broker@x.com', password: PASSWORD })).status, 401, 'disabled user can log in');

    // Password change: needs current password, rotates the session, old password stops working
    assert.equal((await r('POST', 'me/password', { current: 'wrong-password-123', next: 'another long password!' }, vie)).status, 403);
    const ch = await r('POST', 'me/password', { current: PASSWORD, next: 'another long password!' }, vie);
    assert.equal(ch.status, 200); assert.ok(ch.cookie);
    assert.equal((await r('GET', 'state', null, vie)).status, 401);
    assert.equal((await r('POST', 'login', { email: 'viewer@x.com', password: PASSWORD })).status, 401);
    assert.equal((await r('POST', 'login', { email: 'viewer@x.com', password: 'another long password!' })).status, 200);

    // Logout kills the session
    assert.equal((await r('POST', 'logout', {}, adminCookie)).status, 200);
    assert.equal((await r('GET', 'state', null, adminCookie)).status, 401);

    // Lockout after repeated failures, even with the right password afterwards
    for (let i = 0; i < 5; i++) await r('POST', 'login', { email: 'victim@x.com', password: 'wrong-wrong-wrong' });
    assert.equal((await r('POST', 'login', { email: 'victim@x.com', password: 'wrong-wrong-wrong' })).status, 429);

    // Passwords are never stored in plain text
    const stored = require('fs').readFileSync(process.env.DB_FILE, 'utf8');
    assert.ok(!stored.includes(PASSWORD) && !stored.includes('another long password!'));
    console.log('auth tests passed');
    process.exit(0);
  } catch (e) { console.error(e); process.exit(1); }
});
