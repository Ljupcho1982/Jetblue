// Optional Claude wording layer. The rules in logic.js decide WHAT to say; the model only decides
// HOW to say it. Anything that breaks the guardrails falls back to the rule-based template.
const Logic = require('./logic.js');

// Providers: 'ollama' (default for open-source), 'openai' (any OpenAI-compatible server such as
// vLLM, llama.cpp, LM Studio), or 'anthropic'. Unset and no key means templates only.
const provider = () => process.env.LLM_PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : null);
const MODEL = () => process.env.LLM_MODEL || process.env.ANTHROPIC_MODEL || (provider() === 'anthropic' ? 'claude-sonnet-5-5' : 'llama3.1:8b');
const BASE = () => (process.env.LLM_BASE_URL || (provider() === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'http://127.0.0.1:8000/v1')).replace(/\/$/, '');
const enabled = () => !!provider();
const describe = () => ({ enabled: enabled(), provider: provider(), model: MODEL() });

async function complete(system, user) {
  const signal = AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS) || 60000);
  if (provider() === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL(), max_tokens: 500, system, messages: [{ role: 'user', content: user }] }) });
    if (!res.ok) throw new Error('API ' + res.status);
    return ((await res.json()).content || []).map((c) => c.text || '').join('');
  }
  const headers = { 'content-type': 'application/json' };
  if (process.env.LLM_API_KEY) headers.authorization = 'Bearer ' + process.env.LLM_API_KEY;
  const res = await fetch(BASE() + '/chat/completions', { method: 'POST', signal, headers,
    body: JSON.stringify({ model: MODEL(), temperature: 0.3, max_tokens: 500, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }) });
  if (!res.ok) throw new Error('model server ' + res.status);
  return (await res.json()).choices?.[0]?.message?.content || '';
}
const clean = (t) => t.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

function buildSystem(playbook, learned) {
  const ex = [...playbook.examples, ...learned].slice(-12)
    .map((e, i) => `Example ${i + 1} (${e.situation}):\n${e.reply}`).join('\n\n');
  return `${playbook.systemPrompt}\n\nCompany: ${playbook.company}. Broker: ${playbook.broker}. Tone: ${playbook.tone}.\n\n` +
    `You are given a DECISION already made by the rules engine. Express it; do not change it. ` +
    `Use only the dollar amounts provided in the decision. Reply with the email body only.\n\n` +
    `Approved examples of our style:\n${ex}`;
}

async function wordDraft({ decision, aircraft, buyer, offer, mode, playbook, learned }) {
  if (!enabled()) return { text: decision.message, source: 'template', facts: null };
  const allowed = [offer, decision.price].filter(Boolean);
  const secrets = [aircraft.floor, aircraft.minLeaseMonthly, aircraft.listPrice * (1 - aircraft.maxDiscountPct / 100)];
  const facts = {
    decision: { action: decision.action, price: decision.price ? Logic.fmt(decision.price) : null, flags: decision.flags },
    buyer: buyer.name, buyersOffer: Logic.fmt(offer), mode,
    aircraft: { id: aircraft.id, model: aircraft.model, year: aircraft.year, seats: aircraft.seats, rangeNm: aircraft.rangeNm, location: aircraft.location },
    mustInclude: playbook.rules.disclaimer,
  };
  try {
    const text = clean(await complete(buildSystem(playbook, learned), JSON.stringify(facts)));
    const v = Logic.validateMessage(text, { allowed, secrets });
    if (!text || !v.ok) return { text: decision.message, source: 'template (model output rejected: ' + (v.reason || 'empty') + ')', facts };
    return { text, source: provider() + ':' + MODEL(), facts };
  } catch (e) {
    return { text: decision.message, source: 'template (model unavailable: ' + e.message + ')', facts };
  }
}

module.exports = { wordDraft, enabled, describe };
