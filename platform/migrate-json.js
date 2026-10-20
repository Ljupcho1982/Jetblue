#!/usr/bin/env node
// One-time import of the old JSON store into SQLite.
//   node migrate-json.js data/db.json            (uses DB_FILE or data/platform.db)
// Refuses to run if the database already has users or leads. Sessions are not imported: everyone signs in again.
const fs = require('fs');
const file = process.argv[2];
if (!file) { console.error('usage: node migrate-json.js path/to/db.json'); process.exit(2); }
const store = require('./store.js');
try {
  const n = store.importLegacy(JSON.parse(fs.readFileSync(file, 'utf8')));
  console.log('imported into', store.FILE, n);
} catch (e) { console.error('migration failed, nothing was changed:', e.message); process.exit(1); }
