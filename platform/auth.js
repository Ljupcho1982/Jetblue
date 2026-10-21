// Zero-dependency auth: scrypt password hashes, server-side sessions in an HttpOnly cookie,
// role permissions, and login throttling.
const crypto = require('crypto');
const store = require('./store.js');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const ROLES = {
  admin: ['*'],
  broker: ['view.full', 'leads.write', 'deals.write', 'inventory.write'],
  viewer: [],
};
const IDLE_MS = 8 * 3600e3, ABSOLUTE_MS = 24 * 3600e3;
const MAX_FAILS = 5, LOCK_MS = 15 * 60e3;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const can = (user, perm) => !!user && !!ROLES[user.role] && (ROLES[user.role].includes('*') || ROLES[user.role].includes(perm));
const permsOf = (user) => (user ? ROLES[user.role] || [] : []);

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: (await scrypt(password, salt, 64)).toString('hex') };
}
const DUMMY = hashPassword('dummy-password-for-timing');
async function verifyPassword(password, user) {
  const { salt, hash } = user || (await DUMMY);
  const got = await scrypt(password, salt, 64);
  const ok = crypto.timingSafeEqual(got, Buffer.from(hash, 'hex'));
  return !!user && ok;
}

function checkPassword(password, email) {
  if (typeof password !== 'string' || password.length < 12) return 'Password must be at least 12 characters.';
  if (password.length > 200) return 'Password too long.';
  if (email && password.toLowerCase() === email.toLowerCase()) return 'Password must not be your email.';
  return null;
}
const validEmail = (e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  store.sessions.insert(sha(token), userId);
  return token;
}
function sessionUser(token) {
  if (!token) return null;
  store.sessions.prune(ABSOLUTE_MS, IDLE_MS);
  const id = sha(token), s = store.sessions.get(id);
  if (!s) return null;
  const u = store.users.byId(s.userId);
  if (!u || u.disabled) return null;
  if (Date.now() - s.lastSeen > 60e3) store.sessions.touch(id); // avoid a write on every request
  return u;
}
const endSession = (token) => { if (token) store.sessions.delete(sha(token)); };
const endUserSessions = (userId) => store.sessions.deleteForUser(userId);

const fails = new Map(); // "ip|email" -> { n, until }
function lockedFor(key) { const f = fails.get(key); return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0; }
function recordFail(key) {
  const f = fails.get(key) || { n: 0, until: 0 };
  if (f.until && f.until <= Date.now()) { f.n = 0; f.until = 0; }
  f.n++; if (f.n >= MAX_FAILS) f.until = Date.now() + LOCK_MS;
  fails.set(key, f);
}
const clearFails = (key) => fails.delete(key);

function parseCookies(h) {
  const out = {};
  for (const part of (h || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
function cookie(token, maxAgeSec) {
  return `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}` + (process.env.COOKIE_SECURE === '1' ? '; Secure' : '');
}
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, disabled: !!u.disabled, createdAt: u.createdAt, twoFactor: !!u.totpEnabled });

// ---- two-factor (TOTP, RFC 6238: SHA-1, 6 digits, 30 s) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32encode(buf) { let bits = '', out = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0'); for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return out; }
function b32decode(s) { let bits = ''; for (const c of s.replace(/=+$/, '').toUpperCase()) { const v = B32.indexOf(c); if (v < 0) throw new Error('bad base32'); bits += v.toString(2).padStart(5, '0'); } const bytes = []; for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(bytes); }
function hotp(secretB32, counter, digits = 6) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', b32decode(secretB32)).update(msg).digest(), o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
}
const stepAt = (ms) => Math.floor(ms / 30000);
const totpAt = (secretB32, ms = Date.now()) => hotp(secretB32, stepAt(ms));
// Returns the matched step (> lastStep, within +/-1 step of now) or null. Rejecting steps <= lastStep stops code replay.
function verifyTotp(secretB32, code, lastStep = 0) {
  if (!/^\d{6}$/.test(String(code))) return null;
  const cur = stepAt(Date.now());
  for (const s of [cur - 1, cur, cur + 1]) {
    if (s > lastStep && crypto.timingSafeEqual(Buffer.from(hotp(secretB32, s)), Buffer.from(String(code)))) return s;
  }
  return null;
}
const newSecret = () => b32encode(crypto.randomBytes(20));
const otpauthUri = (secret, email) => `otpauth://totp/${encodeURIComponent('Deal Platform')}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent('Deal Platform')}&algorithm=SHA1&digits=6&period=30`;

// Secrets are encrypted at rest when APP_SECRET is set (AES-256-GCM); otherwise stored with a 'raw:' marker.
const appKey = () => (process.env.APP_SECRET ? crypto.scryptSync(process.env.APP_SECRET, 'deal-platform-totp', 32) : null);
function sealSecret(secret) {
  const key = appKey(); if (!key) return 'raw:' + secret;
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv), ct = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return ['enc1', iv.toString('hex'), c.getAuthTag().toString('hex'), ct.toString('hex')].join(':');
}
function openSecret(stored) {
  if (stored.startsWith('raw:')) return stored.slice(4);
  const key = appKey(); if (!key) throw new Error('APP_SECRET is required to read two-factor secrets');
  const [, iv, tag, ct] = stored.split(':'), d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  d.setAuthTag(Buffer.from(tag, 'hex')); return Buffer.concat([d.update(Buffer.from(ct, 'hex')), d.final()]).toString('utf8');
}

const newRecoveryCodes = () => Array.from({ length: 10 }, () => { const h = crypto.randomBytes(5).toString('hex'); return h.slice(0, 5) + '-' + h.slice(5); });
const hashCode = (c) => sha(String(c).trim().toLowerCase());
const isRecoveryFormat = (c) => /^[0-9a-f]{5}-[0-9a-f]{5}$/i.test(String(c).trim());

// REQUIRE_2FA=admin|all|off (default off): users who must enrol are blocked from everything except enrolment.
const requirement = () => process.env.REQUIRE_2FA || 'off';
const mustEnroll = (u) => !!u && !u.totpEnabled && (requirement() === 'all' || (requirement() === 'admin' && u.role === 'admin'));

// Short-lived tickets between a correct password and a correct second factor (in memory, single process).
const tickets = new Map(); const TICKET_MS = 5 * 60e3, TICKET_TRIES = 5;
function createTicket(userId, key) { const t = crypto.randomBytes(24).toString('hex'); tickets.set(sha(t), { userId, key, exp: Date.now() + TICKET_MS, tries: 0 }); return t; }
function ticketFor(t) { const k = sha(String(t || '')), v = tickets.get(k); if (!v || v.exp < Date.now()) { tickets.delete(k); return null; } return { ...v, id: k }; }
const dropTicket = (id) => tickets.delete(id);
function failTicket(id) { const v = tickets.get(id); if (v && ++v.tries >= TICKET_TRIES) tickets.delete(id); }

module.exports = { totpAt, verifyTotp, newSecret, otpauthUri, sealSecret, openSecret, newRecoveryCodes, hashCode, isRecoveryFormat, mustEnroll, requirement, createTicket, ticketFor, dropTicket, failTicket, b32decode, hotp, ROLES, can, permsOf, hashPassword, verifyPassword, checkPassword, validEmail, createSession, sessionUser, endSession, endUserSessions, lockedFor, recordFail, clearFails, parseCookies, cookie, publicUser, ABSOLUTE_MS };
