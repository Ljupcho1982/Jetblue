// Operations: health check, proxy-aware lockout, scheduled backups, graceful shutdown.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert'), { spawn } = require('child_process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deal-ops-'));
const env = { ...process.env, DB_FILE: path.join(dir, 'ops.db'), PORT: '3457', HOST: '127.0.0.1', TRUST_PROXY: '1', BACKUP_DIR: path.join(dir, 'bk'), BACKUP_KEEP: '2', NODE_OPTIONS: '--disable-warning=ExperimentalWarning' };
delete env.LLM_PROVIDER; delete env.ANTHROPIC_API_KEY; delete env.MAIL_PROVIDER;
const base = 'http://127.0.0.1:3457';
fs.mkdirSync(env.BACKUP_DIR); for (const f of ['platform-2020-01-01.db', 'platform-2020-01-02.db']) fs.writeFileSync(path.join(env.BACKUP_DIR, f), 'old');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body, ip) => fetch(base + '/api/' + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) });

(async () => {
  const child = spawn('node', [path.join(__dirname, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (d) => log += d); child.stderr.on('data', (d) => log += d);
  const exited = new Promise((r) => child.on('exit', (code, sig) => r({ code, sig })));
  try {
    for (let i = 0; i < 50 && !(await fetch(base + '/healthz').then((r) => r.ok, () => false)); i++) await sleep(100);
    const h = await fetch(base + '/healthz'); assert.equal(h.status, 200); assert.deepEqual(await h.json(), { ok: true });
    assert.equal(h.headers.get('x-frame-options'), 'DENY');

    // Behind one proxy, lockout is per client address taken from X-Forwarded-For (spoofed left entries are ignored)
    await post('setup', { email: 'a@x.com', name: 'A', password: 'correct horse battery staple' }, '1.1.1.1');
    for (let i = 0; i < 5; i++) await post('login', { email: 'a@x.com', password: 'wrong-wrong-wrong' }, 'spoof, 9.9.9.9');
    assert.equal((await post('login', { email: 'a@x.com', password: 'wrong-wrong-wrong' }, 'other-spoof, 9.9.9.9')).status, 429, 'same real client must stay locked');
    assert.equal((await post('login', { email: 'a@x.com', password: 'correct horse battery staple' }, 'x, 8.8.8.8')).status, 200, 'a different client must not be locked out');

    // Backups ran on start, are usable, and old ones are pruned
    for (let i = 0; i < 80 && !log.includes('backup written'); i++) await sleep(100);
    const files = fs.readdirSync(env.BACKUP_DIR).sort(); assert.equal(files.length, 2, files.join());
    assert.equal(files[0], 'platform-2020-01-02.db', 'oldest backup should be pruned');
    const { DatabaseSync } = require('node:sqlite');
    assert.equal(new DatabaseSync(path.join(env.BACKUP_DIR, files[1])).prepare('SELECT COUNT(*) n FROM users').get().n, 1);
    assert.equal(fs.statSync(path.join(env.BACKUP_DIR, files[1])).mode & 0o077, 0, 'backup must not be group/world readable');

    // Graceful shutdown: exits 0 and checkpoints the WAL
    child.kill('SIGTERM');
    const res = await Promise.race([exited, sleep(8000).then(() => 'timeout')]);
    assert.deepEqual(res, { code: 0, sig: null }, log);
    assert.ok(log.includes('SIGTERM received'));
    const wal = env.DB_FILE + '-wal'; assert.ok(!fs.existsSync(wal) || fs.statSync(wal).size === 0, 'WAL not checkpointed');
    console.log('ops tests passed'); process.exit(0);
  } catch (e) { console.error(e, '\n--- server log ---\n' + log); child.kill('SIGKILL'); process.exit(1); }
})();
