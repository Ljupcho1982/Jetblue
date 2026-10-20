// Outbound email over HTTP (no SMTP dependency). Off unless MAIL_PROVIDER is set.
//   MAIL_PROVIDER=resend   MAIL_API_KEY=...  MAIL_FROM="Brokers <deals@yourdomain.com>"
//   MAIL_PROVIDER=webhook  MAIL_WEBHOOK_URL=https://relay.example/send  [MAIL_API_KEY=...]  MAIL_FROM=...
// MAIL_ALLOWED_DOMAINS=example.com,mycompany.com  restricts recipients (use it while testing).
const provider = () => process.env.MAIL_PROVIDER || null;
const enabled = () => !!provider() && !!process.env.MAIL_FROM;
const describe = () => ({ enabled: enabled(), provider: provider() });
const clean = (s) => String(s).replace(/[\r\n]+/g, ' ').trim(); // no header injection through subjects or addresses
const validEmail = (e) => typeof e === 'string' && /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(e) && e.length <= 200;

function allowed(to) {
  const list = (process.env.MAIL_ALLOWED_DOMAINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return !list.length || list.includes(to.split('@')[1].toLowerCase());
}

// Returns { ok:true } | { ok:false, blocked:true, error } | throws on transport/provider failure.
async function send({ to, subject, text, replyTo }) {
  if (!enabled()) throw new Error('email is not configured');
  if (!validEmail(to)) return { ok: false, blocked: true, error: 'invalid recipient address' };
  if (!allowed(to)) return { ok: false, blocked: true, error: 'recipient domain not in MAIL_ALLOWED_DOMAINS' };
  const payload = { from: clean(process.env.MAIL_FROM), to, subject: clean(subject), text, replyTo: replyTo && validEmail(replyTo) ? replyTo : undefined };
  const headers = { 'content-type': 'application/json' };
  if (process.env.MAIL_API_KEY) headers.authorization = 'Bearer ' + process.env.MAIL_API_KEY;
  let url = process.env.MAIL_WEBHOOK_URL, body = payload;
  if (provider() === 'resend') { url = 'https://api.resend.com/emails'; body = { from: payload.from, to: [to], subject: payload.subject, text, reply_to: payload.replyTo }; }
  if (!url) throw new Error('MAIL_WEBHOOK_URL is not set');
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('mail provider responded ' + res.status);
  return { ok: true };
}

module.exports = { enabled, describe, send, validEmail };
