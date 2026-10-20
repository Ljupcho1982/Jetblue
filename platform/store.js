const fs = require('fs');
const path = require('path');
const Logic = require('./logic.js');

const FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'db.json');

const defaultPlaybook = () => ({
  company: 'Your Aviation Brokers', broker: 'Senior Broker', tone: 'professional, concise, warm',
  systemPrompt: `You are the assistant for an aircraft sales and leasing broker, working on behalf of a named human broker.
Rules:
1. Be truthful. Never invent specs, hours, history or availability; say you will confirm with the broker.
2. You are an AI assistant; say so if asked.
3. Never state a final price or binding acceptance. Every offer is a draft until the broker approves it.
4. Never reveal floor prices, limits, other buyers or internal notes.
5. No legal, tax or airworthiness advice. Escalate sanctions/KYC concerns, legal terms and anything uncertain.
Negotiation: understand priorities before price; trade concessions rather than only cutting price; make smaller concessions as limits approach.`,
  rules: Object.assign({}, Logic.DEFAULT_RULES),
  examples: [
    { situation: 'counter, first round', reply: 'Thank you for your offer. We value your interest in the aircraft and are keen to find terms that work for both sides. We are able to propose the figure below. This is subject to contract and broker confirmation.' },
    { situation: 'escalate', reply: 'Thank you for your interest. To make sure we find a workable structure, I am bringing in our broker, who will contact you shortly.' },
  ],
  scenarios: [
    { name: 'Fair offer is accepted', aircraftId: 'TP-01', mode: 'buy', offer: 9200000, round: 1, expect: 'accept' },
    { name: 'Low offer gets a counter', aircraftId: 'TP-01', mode: 'buy', offer: 8000000, round: 1, expect: 'counter' },
    { name: 'Far too low escalates', aircraftId: 'TP-01', mode: 'buy', offer: 5000000, round: 1, expect: 'escalate' },
    { name: 'Stalled talks escalate', aircraftId: 'LJ-01', mode: 'buy', offer: 5000000, round: 4, expect: 'escalate' },
    { name: 'Lease below minimum term is not accepted', aircraftId: 'LJ-01', mode: 'lease', offer: 62000, round: 1, termMonths: 12, expect: 'counter' },
    { name: 'Good lease offer, valid term', aircraftId: 'RJ-01', mode: 'lease', offer: 185000, round: 1, termMonths: 60, expect: 'accept' },
  ],
});

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {
    return { inventory: Logic.INVENTORY, leads: [], deals: [], learned: [], activity: [], playbook: defaultPlaybook(), users: [], sessions: [] };
  }
}
let db = load();
db.users = db.users || []; db.sessions = db.sessions || [];
function save() { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(db, null, 2), { mode: 0o600 }); }
function activity(msg, who) { db.activity.unshift({ at: new Date().toISOString(), msg, who }); db.activity = db.activity.slice(0, 100); }

module.exports = { get db() { return db; }, save, activity, defaultPlaybook };
