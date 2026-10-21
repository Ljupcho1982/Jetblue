process.env.DB_FILE = require('path').join(require('os').tmpdir(), 'deal-2fa-' + Date.now() + '.db');
process.env.APP_SECRET = 'test-app-secret-value';
delete process.env.LLM_PROVIDER; delete process.env.ANTHROPIC_API_KEY; delete process.env.MAIL_PROVIDER;
const assert = require('assert');
const auth = require('./auth.js');
const server = require('./server.js');
const { raw, adminClient, PASSWORD } = require('./testlib.js');

// RFC 6238 Appendix B (SHA-1, secret "12345678901234567890", 6-digit truncation of the published 8-digit codes)
const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', rfcSecret = (() => { let bits = '', o = ''; for (const x of Buffer.from('12345678901234567890')) bits += x.toString(2).padStart(8, '0'); for (let i = 0; i < bits.length; i += 5) o += A[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return o; })();
assert.equal(auth.totpAt(rfcSecret, 59e3), '287082');
assert.equal(auth.totpAt(rfcSecret, 1111111109e3), '081804');
assert.equal(auth.totpAt(rfcSecret, 2000000000e3), '279037');
// sealing: encrypted with APP_SECRET, round-trips, tamper-evident
const sealed = auth.sealSecret('JBSWY3DPEHPK3PXP'); assert.ok(sealed.startsWith('enc1:') && !sealed.includes('JBSWY3DP'));
assert.equal(auth.openSecret(sealed), 'JBSWY3DPEHPK3PXP');
assert.throws(() => auth.openSecret(sealed.slice(0, -2) + '00'));

server.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const r = (m, p, b, c) => raw(base, m, p, b, c);
  const at = (secret, offsetSteps) => auth.totpAt(secret, Date.now() + offsetSteps * 30000);
  try {
    const admin = await adminClient(base);
    assert.equal((await r('GET', 'me', null, admin)).body.mustEnroll, false);

    // Enrol: setup -> wrong code rejected -> right code enables and returns 10 one-time recovery codes
    const setup = (await r('POST', 'me/2fa/setup', {}, admin)).body;
    assert.ok(/^[A-Z2-7]{32}$/.test(setup.secret) && setup.uri.startsWith('otpauth://totp/'));
    assert.equal((await r('POST', 'me/2fa/enable', { code: '000000' }, admin)).status, 400);
    const en = await r('POST', 'me/2fa/enable', { code: at(setup.secret, 0) }, admin);
    assert.equal(en.status, 200); assert.equal(en.body.recoveryCodes.length, 10);
    const recovery = en.body.recoveryCodes; assert.ok(auth.isRecoveryFormat(recovery[0]));
    assert.equal((await r('POST', 'me/2fa/enable', { code: at(setup.secret, 1) }, admin)).status, 409);
    // secret and recovery codes are not stored in the clear
    const { DatabaseSync } = require('node:sqlite');
    const row = JSON.stringify(new DatabaseSync(process.env.DB_FILE).prepare('SELECT totp_secret, recovery_codes FROM users').get());
    assert.ok(!row.includes(setup.secret) && !recovery.some((c) => row.includes(c)));

    // Login now needs the second factor; the password alone gives no session
    const l1 = await r('POST', 'login', { email: 'admin@example.com', password: PASSWORD });
    assert.equal(l1.status, 200); assert.equal(l1.body.needs2fa, true); assert.ok(l1.body.ticket); assert.equal(l1.cookie, null);
    assert.equal((await r('GET', 'state', null, 'sid=' + l1.body.ticket)).status, 401, 'ticket is not a session');
    assert.equal((await r('POST', 'login/2fa', { ticket: l1.body.ticket, code: '123456' })).status, 401);
    // code from the current step was used at enrolment: replaying it is refused, next step's code works once
    assert.equal((await r('POST', 'login/2fa', { ticket: l1.body.ticket, code: at(setup.secret, 0) })).status, 401, 'enrolment code replayed');
    const good = at(setup.secret, 1);
    const ok = await r('POST', 'login/2fa', { ticket: l1.body.ticket, code: good });
    assert.equal(ok.status, 200); assert.ok(ok.cookie);
    assert.equal((await r('GET', 'state', null, ok.cookie)).status, 200);
    const l2 = await r('POST', 'login', { email: 'admin@example.com', password: PASSWORD });
    assert.equal((await r('POST', 'login/2fa', { ticket: l2.body.ticket, code: good })).status, 401, 'same code reused');
    assert.equal((await r('POST', 'login/2fa', { ticket: 'garbage', code: '123456' })).status, 401);

    // Recovery code logs in once only
    const l4 = await r('POST', 'login', { email: 'admin@example.com', password: PASSWORD });
    const rc = await r('POST', 'login/2fa', { ticket: l4.body.ticket, code: recovery[1].toUpperCase() });
    assert.equal(rc.status, 200); const sess = rc.cookie;
    const l5 = await r('POST', 'login', { email: 'admin@example.com', password: PASSWORD });
    assert.equal((await r('POST', 'login/2fa', { ticket: l5.body.ticket, code: recovery[1] })).status, 401, 'recovery code reused');

    // Disable / regenerate need password + a valid code
    assert.equal((await r('POST', 'me/2fa/recovery', { password: 'wrong-password-xx', code: recovery[2] }, sess)).status, 403);
    const regen = await r('POST', 'me/2fa/recovery', { password: PASSWORD, code: recovery[2] }, sess);
    assert.equal(regen.status, 200); assert.equal(regen.body.recoveryCodes.length, 10);
    const l6 = await r('POST', 'login', { email: 'admin@example.com', password: PASSWORD });
    assert.equal((await r('POST', 'login/2fa', { ticket: l6.body.ticket, code: recovery[3] })).status, 401, 'old recovery code still valid after regeneration');

    // Admin resets another user's 2FA (lost phone), which also signs that user out
    await r('POST', 'users', { email: 'bo@x.com', name: 'Bo', role: 'broker', password: PASSWORD }, sess);
    let bo = (await r('POST', 'login', { email: 'bo@x.com', password: PASSWORD })).cookie;
    const bs = (await r('POST', 'me/2fa/setup', {}, bo)).body;
    assert.equal((await r('POST', 'me/2fa/enable', { code: at(bs.secret, 0) }, bo)).status, 200);
    const boId = (await r('GET', 'users', null, sess)).body.find((u) => u.email === 'bo@x.com');
    assert.equal(boId.twoFactor, true);
    assert.equal((await r('PUT', 'users/' + boId.id, { resetTwoFactor: true }, sess)).body.twoFactor, false);
    assert.equal((await r('GET', 'state', null, bo)).status, 401);
    assert.ok((await r('POST', 'login', { email: 'bo@x.com', password: PASSWORD })).cookie, 'broker should log in with password only after reset');

    // Policy: REQUIRE_2FA=admin blocks an un-enrolled admin from everything except enrolment, and forbids turning it off
    process.env.REQUIRE_2FA = 'admin';
    const adminB = (await r('POST', 'users', { email: 'ad2@x.com', name: 'Ad2', role: 'admin', password: PASSWORD }, sess)).body;
    const ad2 = (await r('POST', 'login', { email: 'ad2@x.com', password: PASSWORD })).cookie;
    const me = (await r('GET', 'me', null, ad2)).body; assert.equal(me.mustEnroll, true);
    assert.equal((await r('GET', 'state', null, ad2)).status, 403);
    assert.equal((await r('GET', 'users', null, ad2)).status, 403);
    const s2 = (await r('POST', 'me/2fa/setup', {}, ad2)).body;
    assert.equal((await r('POST', 'me/2fa/enable', { code: at(s2.secret, 0) }, ad2)).status, 200);
    assert.equal((await r('GET', 'state', null, ad2)).status, 200);
    assert.equal((await r('POST', 'me/2fa/disable', { password: PASSWORD, code: at(s2.secret, 1) }, ad2)).status, 400, 'policy must forbid disabling');
    // brokers are not affected by the admin-only policy
    assert.equal((await r('GET', 'state', null, (await r('POST', 'login', { email: 'bo@x.com', password: PASSWORD })).cookie)).status, 200);
    delete process.env.REQUIRE_2FA;
    // voluntary disable works
    const s3 = (await r('POST', 'me/2fa/setup', {}, bo = (await r('POST', 'login', { email: 'bo@x.com', password: PASSWORD })).cookie)).body;
    await r('POST', 'me/2fa/enable', { code: at(s3.secret, 0) }, bo);
    assert.equal((await r('POST', 'me/2fa/disable', { password: PASSWORD, code: at(s3.secret, 1) }, bo)).status, 200);
    assert.equal((await r('GET', 'me', null, bo)).body.user.twoFactor, false);
    // Brute force: 5 wrong codes kill the ticket and lock the account/IP pair, so even the right code is refused afterwards
    await r('POST', 'users', { email: 'lock@x.com', name: 'Lo', role: 'broker', password: PASSWORD }, sess);
    const lk = (await r('POST', 'login', { email: 'lock@x.com', password: PASSWORD })).cookie;
    const ls = (await r('POST', 'me/2fa/setup', {}, lk)).body; await r('POST', 'me/2fa/enable', { code: at(ls.secret, 0) }, lk);
    const lt = (await r('POST', 'login', { email: 'lock@x.com', password: PASSWORD })).body.ticket;
    for (let i = 0; i < 5; i++) assert.equal((await r('POST', 'login/2fa', { ticket: lt, code: '111111' })).status, i < 4 ? 401 : 401);
    const after = await r('POST', 'login/2fa', { ticket: lt, code: at(ls.secret, 1) });
    assert.ok([401, 429].includes(after.status) && !after.cookie, 'right code accepted after brute force');
    assert.equal((await r('POST', 'login', { email: 'lock@x.com', password: PASSWORD })).status, 429);
    console.log('two-factor tests passed'); process.exit(0);
  } catch (e) { console.error(e); process.exit(1); }
});
