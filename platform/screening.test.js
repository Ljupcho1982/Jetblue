process.env.DB_FILE = require('path').join(require('os').tmpdir(), 'deal-screen-' + Date.now() + '.db');
delete process.env.LLM_PROVIDER; delete process.env.ANTHROPIC_API_KEY; delete process.env.MAIL_PROVIDER;
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), assert = require('assert');
const S = require('./screening.js');

// --- name matching ---
assert.deepEqual(S.normalize('Müller & Söhne GmbH'), ['muller', 'sohne']);
assert.equal(S.compareNames(S.normalize('Ivan Petrov'), S.normalize('PETROV, Ivan')), 'hit', 'word order and punctuation');
assert.equal(S.compareNames(S.normalize('Acme Aviation Ltd'), S.normalize('Acme Aviation Limited')), 'hit', 'suffixes ignored');
assert.equal(S.compareNames(S.normalize('Ivan Petrovv'), S.normalize('Ivan Petrov')), 'review', 'one typo');
assert.equal(S.compareNames(S.normalize('Alex Morgan'), S.normalize('Ivan Petrov')), null);
assert.equal(S.compareNames(S.normalize('Li'), S.normalize('Li Wu')), null, 'very short names are not fuzzy matched');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-'));
fs.writeFileSync(path.join(dir, 'list.csv'), 'id,name,aliases\n1,"Petrov, Ivan",I. Petrov;Ivan P Petrov\n2,Sky Bridge Trading LLC,\n');
process.env.SANCTIONS_FILE = path.join(dir, 'list.csv');

// webhook provider mock: behaviour chosen per request through the name
let mode = 'clear', calls = 0;
const prov = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
    calls++; const body = JSON.parse(b);
    if (body.name.startsWith('prov-error')) { res.writeHead(500); return res.end(); }
    if (body.name.startsWith('prov-garbage')) { res.writeHead(200); return res.end('{"status":"maybe"}'); }
    if (body.name.startsWith('prov-slow')) return; // never answers
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: body.name.startsWith('prov-review') ? 'review' : body.name.startsWith('prov-hit') ? 'hit' : 'clear', reason: 'provider says so' }));
  });
});

prov.listen(0, '127.0.0.1', async () => {
  try {
    const sc = (name, company, country) => S.screen({ name, company, country });
    // built-in only
    assert.equal((await sc('Alex Morgan', 'Northwind Air', 'Spain')).status, 'clear');
    assert.equal((await sc('Alex', '', 'Iran')).status, 'hit');
    let x = await sc('Ivan Petrov', '', 'Spain'); assert.equal(x.status, 'hit'); assert.match(x.reasons[0], /name matches list entry/);
    assert.equal((await sc('I Petrov', '', 'Spain')).status, 'hit', 'alias match');
    assert.equal((await sc('Ivan Petrovv', '', 'Spain')).status, 'review');
    assert.equal((await sc('Alex', 'Sky Bridge Trading', 'Spain')).status, 'hit', 'company matched ignoring LLC');
    // unreadable list fails closed
    process.env.SANCTIONS_FILE = path.join(dir, 'missing.csv'); assert.equal((await sc('Alex', '', 'Spain')).status, 'error');
    process.env.SANCTIONS_FILE = path.join(dir, 'list.csv');
    // list edits are picked up without restart
    fs.writeFileSync(path.join(dir, 'list.csv'), 'name\nAlex Morgan\n'); const t = Date.now() / 1000 + 5; fs.utimesSync(path.join(dir, 'list.csv'), t, t);
    assert.equal((await sc('Alex Morgan', '', 'Spain')).status, 'hit');
    fs.writeFileSync(path.join(dir, 'list.csv'), 'id,name,aliases\n1,"Petrov, Ivan",I. Petrov\n'); fs.utimesSync(path.join(dir, 'list.csv'), t + 5, t + 5);

    // provider: worst of both wins; every failure mode is error, never clear
    process.env.SCREENING_WEBHOOK_URL = 'http://127.0.0.1:' + prov.address().port + '/'; process.env.SCREENING_TIMEOUT_MS = '400';
    assert.equal((await sc('Alex Morgan', '', 'Spain')).status, 'clear');
    assert.equal((await sc('prov-review Bob', '', 'Spain')).status, 'review');
    assert.equal((await sc('prov-hit Bob', '', 'Spain')).status, 'hit');
    assert.equal((await sc('prov-review Bob', '', 'Iran')).status, 'hit', 'country hit beats provider review');
    for (const n of ['prov-error', 'prov-garbage', 'prov-slow']) { x = await sc(n, '', 'Spain'); assert.equal(x.status, 'error', n); assert.equal(x.ok, false); }
    process.env.SCREENING_WEBHOOK_URL = 'http://127.0.0.1:9/'; assert.equal((await sc('Alex', '', 'Spain')).status, 'error', 'unreachable provider');
    process.env.SCREENING_WEBHOOK_URL = 'http://127.0.0.1:' + prov.address().port + '/';

    // --- through the API ---
    const server = require('./server.js'), { raw, adminClient, PASSWORD } = require('./testlib.js');
    server.listen(0, '127.0.0.1', async () => {
      const base = 'http://127.0.0.1:' + server.address().port, admin = await adminClient(base), r = (m, p, b, c) => raw(base, m, p, b, c || admin);
      try {
        const lead = (b) => r('POST', 'leads', { country: 'Spain', mode: 'buy', seats: 60, rangeNm: 700, budget: 9e6, ...b });
        const ok = (await lead({ name: 'Alex Morgan' })).body; assert.equal(ok.status, 'qualified'); assert.equal(ok.screening.status, 'clear');
        const rev = (await lead({ name: 'prov-review Bob' })).body; assert.equal(rev.status, 'compliance-hold'); assert.equal(rev.matches.length, 0);
        const hit = (await lead({ name: 'Ivan Petrov' })).body; assert.equal(hit.screening.status, 'hit');
        const err = (await lead({ name: 'prov-error Carl' })).body; assert.equal(err.screening.status, 'error');
        // held leads cannot open deals
        for (const l of [rev, hit, err]) assert.equal((await r('POST', 'deals', { leadId: l.id, aircraftId: 'TP-01' })).status, 400);
        assert.equal((await r('POST', 'deals', { leadId: ok.id, aircraftId: 'TP-01' })).status, 200);
        // roles
        await r('POST', 'users', { email: 'b@x.com', name: 'B', role: 'broker', password: PASSWORD }); await r('POST', 'users', { email: 'v@x.com', name: 'V', role: 'viewer', password: PASSWORD });
        const bro = (await raw(base, 'POST', 'login', { email: 'b@x.com', password: PASSWORD })).cookie, vie = (await raw(base, 'POST', 'login', { email: 'v@x.com', password: PASSWORD })).cookie;
        assert.equal((await r('POST', `leads/${rev.id}/clear`, { note: 'looked into it, fine' }, bro)).status, 403, 'brokers cannot clear');
        // clearing: note required, confirmed hits cannot be cleared, errors/reviews can
        assert.equal((await r('POST', `leads/${rev.id}/clear`, { note: 'short' })).status, 400);
        assert.equal((await r('POST', `leads/${hit.id}/clear`, { note: 'this is a long enough note' })).status, 409);
        const cleared = (await r('POST', `leads/${rev.id}/clear`, { note: 'Checked registry: different person, DOB differs' })).body;
        assert.equal(cleared.status, 'qualified'); assert.equal(cleared.screening.override.by, 'admin@example.com'); assert.equal(cleared.screening.override.previous, 'review'); assert.ok(cleared.matches.length);
        assert.equal((await r('POST', `deals/`.replace(/\/$/, ''), { leadId: rev.id, aircraftId: 'TP-01' })).status, 200, 'cleared lead can open a deal');
        assert.equal((await r('POST', `leads/${rev.id}/clear`, { note: 'already cleared, again' })).status, 409);
        assert.equal((await r('POST', `leads/${rev.id}/rescreen`, {})).status, 409, 'rescreen must not undo a reviewer decision');
        // error leads: a broker can re-run once the provider works again
        assert.equal((await r('POST', `leads/${err.id}/rescreen`, {}, bro)).body.screening.status, 'error');
        const savedErr = err.name; // provider answers by name, so change the provider behaviour instead: point at a working one
        process.env.SCREENING_WEBHOOK_URL = ''; delete process.env.SCREENING_WEBHOOK_URL;
        const re = (await r('POST', `leads/${err.id}/rescreen`, {}, bro)).body; assert.equal(re.status, 'qualified', savedErr);
        // viewers see status only, never reasons or reviewer notes
        const vl = (await r('GET', 'state', null, vie)).body.leads, vs = JSON.stringify(vl);
        assert.ok(vl.every((l) => Object.keys(l.screening).every((k) => ['ok', 'status'].includes(k))), 'viewer sees more than ok/status');
        assert.ok(!vs.includes('list entry') && !vs.includes('Checked registry') && vs.includes('compliance-hold'));
        // decisions are in the audit log
        const act = (await r('GET', 'state')).body.activity.map((a) => a.msg).join('\n');
        assert.match(act, /Compliance cleared lead/); assert.match(act, /Screening re-run on lead/);
        // legacy hold (pre-status format) cannot be cleared
        require('./store.js').db.prepare("UPDATE leads SET screening=?, status='compliance-hold' WHERE id=?").run(JSON.stringify({ ok: false, reason: 'Country on screening list' }), hit.id);
        assert.equal((await r('POST', `leads/${hit.id}/clear`, { note: 'legacy record, long note' })).status, 409);
        console.log('screening tests passed'); process.exit(0);
      } catch (e) { console.error(e); process.exit(1); }
    });
  } catch (e) { console.error(e); process.exit(1); }
});
