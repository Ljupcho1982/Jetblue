#!/usr/bin/env node
// Accessibility audit (axe-core, WCAG 2.1 A/AA + best practices) of every screen in light and dark mode.
// Not part of `npm test` because it needs a browser: the platform itself has no dependencies.
//   cd platform && npm i --no-save playwright axe-core && npx playwright install chromium && node tools/a11y-check.js
// Starts its own throwaway server and database. Exits 1 if any violation is found.
const { spawn } = require('child_process'), os = require('os'), path = require('path'), fs = require('fs');
const { chromium } = require('playwright');
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const PORT = 3900 + Math.floor(Math.random() * 90), base = `http://127.0.0.1:${PORT}`, PW = 'correct horse battery staple';
const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-')), 'a.db');
const server = spawn('node', ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, DB_FILE: db, PORT: String(PORT), RATE_LIMIT_PER_MIN: '0' }, stdio: 'ignore' });
const found = {};
(async () => {
  for (let i = 0; i < 50; i++) { if (await fetch(base + '/healthz').then((r) => r.ok, () => false)) break; await new Promise((r) => setTimeout(r, 200)); }
  const browser = await chromium.launch();
  for (const scheme of ['light', 'dark']) {
    const page = await (await browser.newContext({ viewport: { width: 1150, height: 950 }, colorScheme: scheme })).newPage(); page.on('dialog', (d) => d.accept('a note that is long enough'));
    const audit = async (name) => {
      await page.evaluate(AXE);
      const r = await page.evaluate(() => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } }));
      for (const v of r.violations) (found[`[${v.impact}] ${v.id} (${scheme}, ${name})`] ||= { help: v.help, nodes: 0, example: v.nodes[0].target.join(' ') }).nodes += v.nodes.length;
      console.log(`${scheme.padEnd(5)} ${name.padEnd(22)} ${r.violations.length ? r.violations.length + ' violation(s)' : 'ok'}`);
    };
    await page.goto(base); await page.waitForSelector('#authForm'); await audit('sign-in / setup');
    if (scheme === 'light') await page.fill('[name=name]', 'Audit Admin');
    await page.fill('[name=email]', 'admin@example.com'); await page.fill('[name=password]', PW); await page.click('#authForm button'); await page.waitForSelector('#logout');
    const api = (m, p, b) => page.evaluate(async ([m, p, b]) => (await fetch('/api/' + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).json(), [m, p, b]);
    if (scheme === 'light') { // enough data for every screen to show its populated state
      const lead = await api('POST', 'leads', { name: 'Alex Morgan', company: 'Co', email: 'a@x.com', country: 'Spain', mode: 'buy', seats: 60, budget: 9e6 });
      const deal = await api('POST', 'deals', { leadId: lead.id, aircraftId: 'TP-01' }), d = await api('POST', `deals/${deal.id}/offer`, { offer: 8e6 });
      await api('POST', 'feedback', { kind: 'draft', dealId: deal.id, messageId: d.messages.find((m) => m.status === 'draft').id, comment: 'Counter looks too generous' });
      await api('POST', 'leads', { name: 'Dana Lee', country: 'Iran', mode: 'buy' });
    }
    for (const pg of ['dashboard', 'inventory', 'leads', 'deals', 'training', 'users', 'account']) { await page.goto(`${base}/#/${pg}`); await page.reload(); await page.waitForTimeout(600); await audit(pg); }
  }
  await browser.close(); server.kill('SIGTERM');
  const n = Object.keys(found).length; console.log(n ? '\nVIOLATIONS:\n' + JSON.stringify(found, null, 2) : '\nNo accessibility violations found.'); process.exit(n ? 1 : 0);
})().catch((e) => { console.error(e); server.kill('SIGTERM'); process.exit(2); });
