// CSV parser, inventory import, and the SEED_DEMO switch.
const os = require('os'), path = require('path'), assert = require('assert'), { execFileSync } = require('child_process');
process.env.DB_FILE = path.join(os.tmpdir(), 'deal-import-' + Date.now() + '.db');
delete process.env.LLM_PROVIDER; delete process.env.ANTHROPIC_API_KEY; delete process.env.MAIL_PROVIDER;
const { parseCsv } = require('./csv.js');

// --- parser ---
assert.deepEqual(parseCsv('a,b\r\n1,2\r\n').map((r) => r.cells), [['a', 'b'], ['1', '2']]);
assert.deepEqual(parseCsv('﻿a,b\n"x, y","he said ""hi"""').map((r) => r.cells), [['a', 'b'], ['x, y', 'he said "hi"']]);
assert.deepEqual(parseCsv('a,b\n\n  ,\n1,2').map((r) => r.cells), [['a', 'b'], ['1', '2']], 'blank lines skipped');
const multi = parseCsv('a,b\n"line1\nline2",x\nnext,y'); assert.equal(multi[1].cells[0], 'line1\nline2'); assert.equal(multi[2].line, 4, 'line numbers count newlines inside quotes');
assert.throws(() => parseCsv('a,b\n"oops,1'), /Unterminated/);
assert.deepEqual(parseCsv('a,b\n1,').map((r) => r.cells)[1], ['1', ''], 'trailing empty field');

const HEAD = 'id,model,type,year,hours,seats,rangeNm,location,listPrice,floor,maxDiscountPct,leaseMonthly,minLeaseMonthly,minTermMonths';
const row = (o = {}) => { const d = { id: '', model: 'ATR 72-600', type: 'turboprop', year: 2015, hours: 18000, seats: 70, rangeNm: 825, location: 'Madrid', listPrice: 12500000, floor: 11500000, maxDiscountPct: 8, leaseMonthly: 115000, minLeaseMonthly: 105000, minTermMonths: 36, ...o }; return Object.values(d).map((v) => (/[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v)).join(','); };

const server = require('./server.js');
const { raw, adminClient, PASSWORD } = require('./testlib.js');
server.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const admin = await adminClient(base), r = (m, p, b, c) => raw(base, m, p, b || undefined, c || admin);
  const count = async () => (await r('GET', 'state')).body.inventory.length;
  try {
    const before = await count();
    // Preview is the default and writes nothing
    let x = await r('POST', 'inventory/import', { csv: [HEAD, row({ id: 'NEW-1' }), row({ id: 'NEW-2', model: 'Dash 8' })].join('\n') });
    assert.equal(x.status, 200); assert.equal(x.body.dryRun, true); assert.equal(x.body.created, 2); assert.equal(x.body.errors, 0);
    assert.equal(await count(), before, 'preview must not write');
    // Real import: creates and updates; money formats and header aliases accepted
    const alias = 'Id, Model, TYPE, Year, Hours, Seats, range_nm, Location, List Price, Floor, max discount pct, lease_monthly, Min Lease Monthly, min term months';
    x = await r('POST', 'inventory/import', { dryRun: false, csv: [alias, '"AL-1",Phenom 300,light jet,2016,3000,8,1971,Frankfurt,"$6,200,000","5,700,000",7,"62,000",56000,24', 'NEW-1,Changed Model,turboprop,2015,18000,70,825,Madrid,12500000,11500000,8,115000,105000,36'].join('\r\n') });
    assert.equal(x.status, 200, JSON.stringify(x.body)); assert.equal(x.body.created, 2); assert.equal(x.body.updated, 0, 'NEW-1 was only previewed, so it is new');
    const inv = (await r('GET', 'state')).body.inventory, al = inv.find((a) => a.id === 'AL-1');
    assert.equal(al.listPrice, 6200000); assert.equal(al.floor, 5700000); assert.equal(al.leaseMonthly, 62000); assert.equal(al.rangeNm, 1971);
    x = await r('POST', 'inventory/import', { dryRun: false, csv: [HEAD, row({ id: 'NEW-1', model: 'Updated', listPrice: 13000000 }), row({ model: 'No id given' })].join('\n') });
    assert.equal(x.body.updated, 1); assert.equal(x.body.created, 1);
    const inv2 = (await r('GET', 'state')).body.inventory;
    assert.equal(inv2.find((a) => a.id === 'NEW-1').model, 'Updated'); assert.ok(inv2.some((a) => a.model === 'No id given' && /^AC-/.test(a.id)));

    // All-or-nothing: errors reported per line (including after a multi-line quoted field), nothing written
    const n0 = await count();
    const bad = [HEAD, row({ id: 'OK-1' }), row({ id: 'BAD 1' }), row({ id: 'OK-2', floor: 99999999999 }), row({ id: 'OK-1' }), row({ id: 'OK-3', model: 'line1\nline2' }), row({ id: 'OK-4', year: 'abc' }), row({ id: 'X"><img src=x>' })].join('\n');
    x = await r('POST', 'inventory/import', { dryRun: false, csv: bad });
    assert.equal(x.status, 400); assert.match(x.body.error, /nothing was imported/);
    const rows = x.body.details.rows, byId = Object.fromEntries(rows.map((q) => [q.line, q]));
    assert.equal(rows.filter((q) => q.status === 'error').length, 5);
    assert.equal(rows[0].status, 'create'); assert.match(rows[1].error, /id may contain only/); assert.match(rows[2].error, /floor|listPrice/); assert.match(rows[3].error, /duplicate id OK-1/);
    assert.equal(rows[4].status, 'create'); assert.equal(rows[4].line, 6, 'line number after multi-line quoted field'); assert.match(rows[5].error, /year/);
    assert.equal(await count(), n0, 'a file with errors must write nothing');
    // Structural errors
    for (const [csv, re] of [['', /csv text required/], [HEAD, /at least one/], ['model,type\nX,y', /Missing columns/], ['a,b\n"unterminated', /Unterminated|Missing/], [[HEAD, ...Array(501).fill(row())].join('\n'), /At most 500/]]) {
      x = await r('POST', 'inventory/import', { csv }); assert.equal(x.status, 400, csv.slice(0, 20)); assert.match(x.body.error, re);
    }
    assert.equal((await r('POST', 'inventory/import', { csv: 5 })).status, 400);
    // Permissions: viewer refused, broker allowed
    await r('POST', 'users', { email: 'v@x.com', name: 'V', role: 'viewer', password: PASSWORD }); await r('POST', 'users', { email: 'b@x.com', name: 'B', role: 'broker', password: PASSWORD });
    const vie = (await raw(base, 'POST', 'login', { email: 'v@x.com', password: PASSWORD })).cookie, bro = (await raw(base, 'POST', 'login', { email: 'b@x.com', password: PASSWORD })).cookie;
    assert.equal((await r('POST', 'inventory/import', { csv: [HEAD, row()].join('\n') }, vie)).status, 403);
    assert.equal((await r('POST', 'inventory/import', { csv: [HEAD, row()].join('\n') }, bro)).status, 200);
    // Imported aircraft take part in matching straight away
    const lead = (await r('POST', 'leads', { name: 'M', country: 'Spain', mode: 'buy', seats: 70, rangeNm: 800, budget: 14e6 })).body;
    assert.ok(lead.matches.some((m) => m.aircraftId === 'NEW-1'));

    // Reset is a demo-only action
    process.env.SEED_DEMO = '0';
    assert.equal((await r('POST', 'reset', {})).status, 409); assert.equal((await r('GET', 'state')).body.demo, false);
    delete process.env.SEED_DEMO; assert.equal((await r('GET', 'state')).body.demo, true);
    // A fresh production-style database starts empty with no demo scenarios
    const out = execFileSync('node', ['--disable-warning=ExperimentalWarning', '-e', "const s=require('./store.js');console.log(JSON.stringify([s.aircraft.list().length,s.playbook.get().scenarios.length]))"], { cwd: __dirname, env: { ...process.env, DB_FILE: path.join(os.tmpdir(), 'deal-import-fresh-' + Date.now() + '.db'), SEED_DEMO: '0' } }).toString().trim();
    assert.equal(out, '[0,0]');
    console.log('import tests passed'); process.exit(0);
  } catch (e) { console.error(e); process.exit(1); }
});
