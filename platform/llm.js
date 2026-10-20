// Optional Claude wording layer. The rules in logic.js decide WHAT to say; the model only decides
// HOW to say it. Anything that breaks the guardrails falls back to the rule-based template.
const Logic = require('./logic.js');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const enabled = () => !!process.env.ANTHROPIC_API_KEY;

function buildSystem(playbook, learned) {
  const ex = [...playbook.examples, ...learned].slice(-12)
    .map((e, i) => `Example ${i + 1} (${e.situation}):\n${e.reply}`).join('\n\n');
  return `${playbook.systemPrompt}\n\nCompany: ${playbook.company}. Broker: ${playbook.broker}. Tone: ${playbook.tone}.\n\n` +
    `You are given a DECISION already made by the rules engine. Express it; do not change it. ` +
    `Use only the dollar amounts provided in the decision. Reply with the email body only.\n\n` +
    `Approved examples of our style:\n${ex}`;
}

async function wordDraft({ decision, aircraft, buyer, offer, mode, playbook, learned }) {
  if (!enabled()) return { text: decision.message, source: 'template' };
  const allowed = [offer, decision.price].filter(Boolean);
  const secrets = [aircraft.floor, aircraft.minLeaseMonthly, aircraft.listPrice * (1 - aircraft.maxDiscountPct / 100)];
  const facts = {
    decision: { action: decision.action, price: decision.price ? Logic.fmt(decision.price) : null, flags: decision.flags },
    buyer: buyer.name, buyersOffer: Logic.fmt(offer), mode,
    aircraft: { id: aircraft.id, model: aircraft.model, year: aircraft.year, seats: aircraft.seats, rangeNm: aircraft.rangeNm, location: aircraft.location },
    mustInclude: playbook.rules.disclaimer,
  };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 500, system: buildSystem(playbook, learned), messages: [{ role: 'user', content: JSON.stringify(facts) }] }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error('API ' + res.status);
    const data = await res.json();
    const text = (data.content || []).map((c) => c.text || '').join('').trim();
    const v = Logic.validateMessage(text, { allowed, secrets });
    if (!text || !v.ok) return { text: decision.message, source: 'template (model output rejected: ' + (v.reason || 'empty') + ')' };
    return { text, source: 'claude' };
  } catch (e) {
    return { text: decision.message, source: 'template (model unavailable: ' + e.message + ')' };
  }
}

module.exports = { wordDraft, enabled, MODEL };
