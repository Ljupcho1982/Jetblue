// First-run experience: clear messages instead of silent failures, free-port fallback, safe browser opening, script line endings.
const os = require('os'), path = require('path'), fs = require('fs'), net = require('net'), assert = require('assert'), { spawn, spawnSync } = require('child_process');
const root = path.join(__dirname, '..'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deal-startup-'));
const NODE = [process.execPath, '--disable-warning=ExperimentalWarning'];
const baseEnv = (extra = {}) => { const e = { ...process.env, DB_FILE: path.join(tmp, 'db-' + Math.random().toString(16).slice(2) + '.db'), ...extra }; for (const k of ['PORT', 'OPEN_BROWSER', 'SEED_DEMO', 'BACKUP_DIR']) if (!(k in extra)) delete e[k]; return e; };
const run = (args, env, opts = {}) => spawnSync(NODE[0], [NODE[1], ...args], { env, encoding: 'utf8', timeout: 20000, ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(child, re, ms = 8000) { let out = ''; child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d)); for (let i = 0; i < ms / 100; i++) { if (re.test(out)) return out; await sleep(100); } throw new Error('never saw ' + re + ' in: ' + out); }
const stop = (c) => new Promise((r) => { c.once('exit', r); c.kill('SIGTERM'); setTimeout(() => c.kill('SIGKILL'), 3000); });

(async () => {
  // 1. Too-old Node: a plain explanation, not a stack trace (simulated by switching the sqlite module off)
  let r = run(['--no-experimental-sqlite', path.join(__dirname, 'server.js')], baseEnv());
  assert.equal(r.status, 1); assert.match(r.stderr, /needs Node\.js 22\.13 or newer/); assert.match(r.stderr, /nodejs\.org/); assert.ok(!/at Module|node:internal/.test(r.stderr), 'stack trace shown');

  // 2. Explicit busy port: exits with a message that says what to do
  const blocker = net.createServer().listen(0, '127.0.0.1'); await new Promise((res) => blocker.once('listening', res));
  const busy = blocker.address().port;
  r = run([path.join(__dirname, 'server.js')], baseEnv({ PORT: String(busy) }));
  assert.equal(r.status, 1); assert.match(r.stderr, /already in use/); assert.match(r.stderr, new RegExp('PORT=' + (busy + 1)));
  blocker.close();

  // 3. No PORT given: two copies started together both work, on different ports
  const a = spawn(NODE[0], [NODE[1], path.join(__dirname, 'server.js')], { env: baseEnv() }), outA = await waitFor(a, /Platform on http:\/\/127\.0\.0\.1:(\d+)/);
  const b = spawn(NODE[0], [NODE[1], path.join(__dirname, 'server.js')], { env: baseEnv() }), outB = await waitFor(b, /Platform on http:\/\/127\.0\.0\.1:(\d+)/);
  const pa = +/:(\d+)/.exec(outA.match(/Platform on http:\/\/127\.0\.0\.1:\d+/)[0])[1], pb = +/:(\d+)/.exec(outB.match(/Platform on http:\/\/127\.0\.0\.1:\d+/)[0])[1];
  assert.notEqual(pa, pb, 'second copy must pick another port'); assert.ok(pa >= 3000 && pb >= 3000 && pa < 3100 && pb < 3100);
  for (const p of [pa, pb]) assert.equal((await fetch(`http://127.0.0.1:${p}/healthz`).then((x) => x.json())).ok, true);
  await stop(a); await stop(b);

  // 4. OPEN_BROWSER=1 with no browser program available must not crash the server
  const c = spawn(NODE[0], [NODE[1], path.join(__dirname, 'server.js')], { env: baseEnv({ OPEN_BROWSER: '1', PORT: '3487', PATH: path.dirname(process.execPath) }) });
  await waitFor(c, /Platform on/); assert.equal((await fetch('http://127.0.0.1:3487/healthz').then((x) => x.json())).ok, true); await stop(c);

  // 5. start.sh outside an extracted folder explains itself (and its success path is covered by the run in the release checklist)
  const lone = path.join(tmp, 'lone'); fs.mkdirSync(lone); fs.copyFileSync(path.join(root, 'start.sh'), path.join(lone, 'start.sh'));
  r = spawnSync('bash', [path.join(lone, 'start.sh')], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stdout, /Cannot find the 'platform' folder/); assert.match(r.stdout, /Extract the zip/);

  // 6. Windows script: CRLF line endings, no multi-line blocks, a pause so the window never vanishes, and the same helpful stops
  const bat = fs.readFileSync(path.join(root, 'start.bat')), text = bat.toString('latin1'), lines = text.split('\r\n');
  assert.ok(!/[^\r]\n/.test(text), 'start.bat has bare LF line endings');
  assert.ok(lines.every((l) => !/\($/.test(l.trim()) && l.trim() !== ')'), 'multi-line ( ) blocks are fragile in cmd.exe');
  for (const needle of [':notextracted', ':nonode', ':oldnode', 'pause', 'OPEN_BROWSER=1', 'extract']) assert.ok(text.toLowerCase().includes(needle.toLowerCase()), 'missing ' + needle);
  assert.ok(!/[^\x00-\x7f]/.test(text), 'non-ASCII characters can break batch files');
  assert.match(fs.readFileSync(path.join(root, '.gitattributes'), 'utf8'), /\*\.bat text eol=crlf/);
  console.log('startup tests passed'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
