// Prints the app secret, creating it on first use. It encrypts 2FA secrets, so it must stay the same between runs.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dir = path.join(__dirname, '..', 'data');
const file = path.join(dir, '.app-secret');
fs.mkdirSync(dir, { recursive: true });
if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
console.log(fs.readFileSync(file, 'utf8').trim());
