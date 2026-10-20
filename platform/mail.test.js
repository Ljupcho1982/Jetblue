process.env.DB_FILE = require('path').join(require('os').tmpdir(), 'deal-mail-' + Date.now() + '.db');
delete process.env.LLM_PROVIDER; delete process.env.ANTHROPIC_API_KEY;
const assert = require('assert'), http = require('http');
const sent = []; let failNext = false, delayMs = 0;
const relay = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => b += c); req.on('end', () => setTimeout(() => {
    if (failNext) { failNext = false; res.writeHead(500); return res.end('nope'); }
    sent.push({ auth: req.headers.authorization, body: JSON.parse(b) }); res.writeHead(200); res.end('{}');
  }, delayMs));
});
relay.listen(0, '127.0.0.1', () => {
  const server = require('./server.js');
  const { raw, adminClient, PASSWORD } = require('./testlib.js');
  server.listen(0, '127.0.0.1', async () => {
    const base = 'http://127.0.0.1:' + server.address().port;
    try {
      const cookie = await adminClient(base), r = (m, p, b, c) => raw(base, m, p, b, c || cookie);
      const newDraft = async (email, offer = 8000000) => {
        const lead = (await r('POST', 'leads', { name: 'Alex', email, country: 'Spain', mode: 'buy', seats: 60, rangeNm: 700, budget: 9000000 })).body;
        const deal = (await r('POST', 'deals', { leadId: lead.id, aircraftId: 'TP-01' })).body;
        const d = (await r('POST', `deals/${deal.id}/offer`, { offer })).body;
        return { lead, deal: d, msg: d.messages.find((m) => m.status === 'draft') };
      };
      const approve = async (x, text) => (await r('POST', `deals/${x.deal.id}/messages/${x.msg.id}/approve`, text ? { text } : {})).body.messages.find((m) => m.id === x.msg.id);

      // Email not configured: approval works, nothing is attempted
      let x = await newDraft('buyer@example.com');
      let m = await approve(x);
      assert.equal(m.status, 'sent'); assert.equal(m.deliveryStatus, undefined); assert.equal(sent.length, 0);

      // Configure (the mailer reads env at call time)
      Object.assign(process.env, { MAIL_PROVIDER: 'webhook', MAIL_WEBHOOK_URL: 'http://127.0.0.1:' + relay.address().port + '/send', MAIL_API_KEY: 'k123', MAIL_FROM: 'Deals <deals@mycompany.com>', MAIL_ALLOWED_DOMAINS: 'example.com' });
      assert.equal((await r('GET', 'state')).body.mail.enabled, true);

      // Invalid buyer email is rejected up front
      assert.equal((await r('POST', 'leads', { name: 'X', email: 'a@b.com\nBcc: evil@x.com', country: 'Spain', mode: 'buy' })).status, 400);

      // Happy path: one email, right content, AI disclosure, reply-to the approver, no private limits
      x = await newDraft('Buyer@Example.com');
      m = await approve(x, x.msg.text + ' Call me any time.');
      assert.equal(m.deliveryStatus, 'sent'); assert.ok(m.deliveredAt);
      assert.equal(sent.length, 1);
      const e = sent[0];
      assert.equal(e.auth, 'Bearer k123'); assert.equal(e.body.to, 'buyer@example.com'); assert.equal(e.body.replyTo, 'admin@example.com');
      assert.ok(e.body.text.includes('Call me any time.') && e.body.text.includes('drafted with AI assistance and approved by Admin'));
      assert.ok(!JSON.stringify(e.body).includes('8600000') && !/floor/i.test(JSON.stringify(e.body)));
      assert.equal(e.body.subject, 'Re: ATR 72-500 (TP-01)');

      // Cannot double send, via retry endpoint or a second approve
      assert.equal((await r('POST', `deals/${x.deal.id}/messages/${x.msg.id}/send`, {})).status, 409);
      assert.equal((await r('POST', `deals/${x.deal.id}/messages/${x.msg.id}/approve`, {})).status, 409);
      assert.equal(sent.length, 1);

      // Provider failure is recorded, then a retry succeeds exactly once (even if clicked twice at once)
      x = await newDraft('buyer@example.com'); failNext = true;
      m = await approve(x);
      assert.equal(m.deliveryStatus, 'failed'); assert.ok(m.deliveryError.includes('500'));
      assert.equal(sent.length, 1);
      delayMs = 200;
      const [a, b] = await Promise.all([r('POST', `deals/${x.deal.id}/messages/${x.msg.id}/send`, {}), r('POST', `deals/${x.deal.id}/messages/${x.msg.id}/send`, {})]);
      delayMs = 0;
      assert.deepEqual([a.status, b.status].sort(), [200, 409]);
      assert.equal(sent.length, 2, 'retry sent twice');
      assert.equal((await r('GET', 'state')).body.deals.find((d) => d.id === x.deal.id).messages.find((q) => q.id === x.msg.id).deliveryStatus, 'sent');

      // Recipient outside the allowlist is blocked, not sent
      x = await newDraft('someone@gmail.com'); m = await approve(x);
      assert.equal(m.deliveryStatus, 'blocked'); assert.equal(sent.length, 2);

      // No email on the lead: skipped; adding one then retrying works
      x = await newDraft(undefined); m = await approve(x);
      assert.equal(m.deliveryStatus, 'skipped');
      assert.equal((await r('PUT', 'leads/' + x.lead.id, { email: 'late@example.com' })).status, 200);
      assert.equal((await r('POST', `deals/${x.deal.id}/messages/${x.msg.id}/send`, {})).status, 200);
      assert.equal(sent.length, 3); assert.equal(sent[2].body.to, 'late@example.com');

      // Viewers never see buyer emails or delivery errors; brokers cannot be bypassed for sending
      await r('POST', 'users', { email: 'viewer@x.com', name: 'Vi', role: 'viewer', password: PASSWORD });
      const vie = (await raw(base, 'POST', 'login', { email: 'viewer@x.com', password: PASSWORD })).cookie;
      const vs = JSON.stringify((await r('GET', 'state', null, vie)).body);
      assert.ok(!vs.includes('buyer@example.com') && !vs.includes('someone@gmail.com') && !vs.includes('late@') && !vs.includes('deliveryError'));
      assert.equal((await r('POST', `deals/${x.deal.id}/messages/${x.msg.id}/send`, {}, vie)).status, 403);
      assert.equal((await r('PUT', 'leads/' + x.lead.id, { email: 'z@example.com' }, vie)).status, 403);

      // Header injection through address or subject is neutralised
      const mailer = require('./mailer.js');
      assert.equal(mailer.validEmail('a@b.com\r\nBcc: x@y.com'), false);
      console.log('mail tests passed'); process.exit(0);
    } catch (e) { console.error(e); process.exit(1); }
  });
});
