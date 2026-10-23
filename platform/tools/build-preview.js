#!/usr/bin/env node
// Builds a single-file, browser-only interactive preview of the app from the REAL screens (public/), the real rules
// (logic.js) and an in-page stand-in for the server (tools/preview-shim.js). Nothing is saved or sent; a refresh resets it.
//   node tools/build-preview.js [output.html]      (default: dist/preview.html, which is git-ignored)
// The output is an HTML fragment (title, style, markup, scripts) as Claude artifacts expect; add --document to wrap it in a full page.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), pub = path.join(root, 'public'), read = (f) => fs.readFileSync(f, 'utf8');
const args = process.argv.slice(2), wrap = args.includes('--document'), out = args.find((a) => !a.startsWith('--')) || path.join(root, 'dist', 'preview.html');

let css = read(path.join(pub, 'style.css'));
const dark = /@media \(prefers-color-scheme: dark\) \{ :root \{([^}]*)\} \}/;
if (!dark.test(css)) throw new Error('style.css dark block not found; update build-preview.js');
css = css.replace(dark, (m, t) => `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${t} color-scheme: dark; } }\n:root[data-theme="dark"] { ${t} color-scheme: dark; }`); // viewer's light/dark choice wins both ways
css += '\n.preview-note { background:var(--nav); color:#dbe4f5; font:13px/1.5 system-ui,sans-serif; padding:8px 16px; } .preview-note b { color:#fff; }\n';

const markup = /<body>([\s\S]*)<\/body>/.exec(read(path.join(pub, 'index.html')))[1].replace(/<script[\s\S]*?<\/script>/g, '').trim();
const js = (f) => read(f).replace(/<\/script/gi, '<\\/script');
const note = '<div class="preview-note"><b>Interactive preview.</b> This runs in your browser with sample data: nothing is saved or sent, and a refresh resets it. Questions the app would ask in a pop-up are answered automatically. User accounts, two-factor sign-in, CSV import and file downloads need the real app. Demo screening list: “Ivan Petrov” is a list match; “Ivan Petrovv” needs review.</div>';
const body = [`<title>Aircraft Deal Platform</title>`, `<style>\n${css}</style>`, note, markup,
  '<script>window.process = { env: {} };</script>', `<script>\n${js(path.join(root, 'logic.js'))}\n</script>`, `<script>\n${js(path.join(__dirname, 'preview-shim.js'))}\n</script>`, `<script>\n${js(path.join(pub, 'app.js'))}\n</script>`].join('\n');
const html = wrap ? `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"></head><body>\n${body}\n</body></html>` : body;
fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KB)`);
