#!/usr/bin/env node
// Consistent online backup (safe while the server is running): node backup.js backups/platform-2026-10-20.db
const dest = process.argv[2];
if (!dest) { console.error('usage: node backup.js <new-file.db>'); process.exit(2); }
const fs = require('fs'), path = require('path');
fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
const store = require('./store.js');
try { store.backup(path.resolve(dest)); fs.chmodSync(dest, 0o600); console.log('backup written to', dest); } catch (e) { console.error(e.message); process.exit(1); }
