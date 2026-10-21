process.env.DB_FILE = require('path').join(require('os').tmpdir(), 'deal-rate-' + Date.now() + '.db');
process.env.RATE_LIMIT_PER_MIN = '5';
const assert = require('assert'), server = require('./server.js');
server.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const codes = []; let last;
    for (let i = 0; i < 8; i++) { last = await fetch(base + '/api/me'); codes.push(last.status); }
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429, 429]);
    assert.equal(last.headers.get('retry-after'), '60'); assert.match((await last.json()).error, /Too many requests/);
    assert.equal((await fetch(base + '/healthz')).status, 200, 'health check is exempt');
    assert.equal((await fetch(base + '/')).status, 200, 'static UI is exempt');
    process.env.RATE_LIMIT_PER_MIN = '0'; assert.equal((await fetch(base + '/api/me')).status, 200, '0 disables the limit');
    console.log('rate limit tests passed'); process.exit(0);
  } catch (e) { console.error(e); process.exit(1); }
});
