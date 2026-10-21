// Minimal RFC 4180 CSV parser: quoted fields, "" escapes, commas/newlines inside quotes, CRLF, UTF-8 BOM.
function parseCsv(text) {
  text = String(text).replace(/^﻿/, '');
  const rows = []; let row = [], field = '', q = false, line = 1, rowLine = 1, any = false;
  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); if (row.some((c) => c.trim() !== '')) rows.push({ line: rowLine, cells: row }); row = []; any = false; rowLine = line + 1; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else { if (c === '\n') line++; field += c; }
    } else if (c === '"' && field === '') { q = true; any = true; }
    else if (c === ',') { endField(); any = true; }
    else if (c === '\r') { /* handled with \n */ }
    else if (c === '\n') { endRow(); line++; rowLine = line; }
    else { field += c; any = true; }
  }
  if (q) throw new Error('Unterminated quote in CSV');
  if (any || field !== '' || row.length) endRow();
  return rows;
}
module.exports = { parseCsv };
