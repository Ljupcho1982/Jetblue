// Tests the open-source (OpenAI-compatible) path against a mock model server.
process.env.DB_FILE = require('path').join(require('os').tmpdir(), 'deal-llm-' + Date.now() + '.json');
const assert = require('assert'), http = require('http');
let reply = '';
let seen;
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => b += c); req.on('end', () => { seen = { url: req.url, body: JSON.parse(b) }; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: reply } }] })); });
});
mock.listen(0, '127.0.0.1', () => {
  process.env.LLM_PROVIDER = 'ollama'; process.env.LLM_BASE_URL = 'http://127.0.0.1:' + mock.address().port + '/v1'; process.env.LLM_MODEL = 'test-model';
  const server = require('./server.js');
  const { raw, adminClient } = require('./testlib.js');
  server.listen(0, '127.0.0.1', async () => {
    const base = 'http://127.0.0.1:' + server.address().port;
    try {
      const cookie = await adminClient(base);
      const call = async (m, p, b) => (await raw(base, m, p, b, cookie)).body;
      const lead = await call('POST', 'leads', { name: 'Alex', country: 'Spain', mode: 'buy', seats: 60, rangeNm: 700, budget: 9000000 });
      const draftFor = async (offer, text) => { reply = text; let d = await call('POST', 'deals', { leadId: lead.id, aircraftId: 'TP-01' }); d = await call('POST', `deals/${d.id}/offer`, { offer }); return [d, d.messages.find((m) => m.status === 'draft')]; };
      // good output is used, and the request carries no private limits
      let [d, m] = await draftFor(8000000, '<think>hmm</think>Hi Alex, we can propose $9,310,000 for the ATR. Subject to contract and broker confirmation.');
      assert.equal(m.source, 'ollama:test-model'); assert.ok(m.text.startsWith('Hi Alex')); assert.ok(!m.text.includes('think'));
      assert.equal(seen.url, '/v1/chat/completions');
      assert.ok(!JSON.stringify(seen.body).includes('8600000'), 'private limit sent to model');
      // leaking output is rejected
      [d, m] = await draftFor(8000000, 'Our floor is $8,600,000, how about $8,700,000?');
      assert.ok(m.source.startsWith('template (model output rejected'), m.source); assert.ok(m.text.includes('$9,310,000'));
      // the same leak written other ways is rejected end to end, not just the "$8,600,000" form
      for (const sneaky of ['We could stretch to 8.6 million.', 'Lowest is 8.6M.', 'We can offer eight point six million.']) {
        const [, mm] = await draftFor(8000000, sneaky); assert.ok(mm.source.startsWith('template (model output rejected'), sneaky + ' -> ' + mm.source); assert.ok(!mm.text.includes('8.6'));
      }
      // approved message appears in fine-tune export
      await call('POST', `deals/${d.id}/messages/${m.id}/approve`, {});
      const jsonl = (await call('GET', 'export')).trim().split('\n').map(JSON.parse);
      assert.equal(jsonl.length, 1); assert.equal(jsonl[0].messages.length, 3); assert.ok(!JSON.stringify(jsonl).includes('8600000'));
      // server down falls back
      mock.close(); process.env.LLM_BASE_URL = 'http://127.0.0.1:9/v1';
      [d, m] = await draftFor(8000000, '');
      assert.ok(m.source.startsWith('template (model unavailable'), m.source);
      console.log('open-source model tests passed'); process.exit(0);
    } catch (e) { console.error(e); process.exit(1); }
  });
});
