// Zero-dependency auth: scrypt password hashes, server-side sessions in an HttpOnly cookie,
// role permissions, and login throttling.
const crypto = require('crypto');
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

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions.push({ id: sha(token), userId, createdAt: Date.now(), lastSeen: Date.now() });
  return token;
}
function sessionUser(db, token) {
  if (!token) return null;
  const now = Date.now(), id = sha(token);
  db.sessions = db.sessions.filter((s) => now - s.createdAt < ABSOLUTE_MS && now - s.lastSeen < IDLE_MS);
  const s = db.sessions.find((x) => x.id === id);
  if (!s) return null;
  const u = db.users.find((x) => x.id === s.userId);
  if (!u || u.disabled) return null;
  s.lastSeen = now;
  return u;
}
const endSession = (db, token) => { if (token) db.sessions = db.sessions.filter((s) => s.id !== sha(token)); };
const endUserSessions = (db, userId) => { db.sessions = db.sessions.filter((s) => s.userId !== userId); };

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
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, disabled: !!u.disabled, createdAt: u.createdAt });

module.exports = { ROLES, can, permsOf, hashPassword, verifyPassword, checkPassword, validEmail, createSession, sessionUser, endSession, endUserSessions, lockedFor, recordFail, clearFails, parseCookies, cookie, publicUser, ABSOLUTE_MS };
