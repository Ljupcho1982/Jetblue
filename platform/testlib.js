// Test helper: bootstraps an admin and returns an authenticated fetch wrapper.
const PASSWORD = 'correct horse battery staple';
async function raw(base, method, p, body, cookie) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  const r = await fetch(base + '/api/' + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  const sc = r.headers.get('set-cookie');
  return { status: r.status, body: ct.startsWith('application/json') ? await r.json() : await r.text(), cookie: sc ? sc.split(';')[0] : null, headers: r.headers };
}
async function adminClient(base) {
  const r = await raw(base, 'POST', 'setup', { email: 'admin@example.com', name: 'Admin', password: PASSWORD });
  if (r.status !== 200) throw new Error('setup failed: ' + JSON.stringify(r.body));
  return r.cookie;
}
module.exports = { raw, adminClient, PASSWORD };
