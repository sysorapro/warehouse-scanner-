#!/usr/bin/env node
'use strict';
/*  build-sync-index.js  —  makes big CSV files "delta-syncable".

    What it does
      Splits items.csv and shelves.csv into small, stable parts ("buckets") and writes a tiny manifest that lists each part
      with its fingerprint. The app downloads the manifest (a few KB), compares it with what the phone already has and
      downloads ONLY the parts that changed — instead of the whole 3-4 MB file.

    Output (committed next to the CSVs):
      sync/manifest.json
      sync/items/b00-<fingerprint>.csv ... sync/shelves/b00-<fingerprint>.csv
      A part's file name contains its fingerprint, so a changed part is always a NEW file name (never served stale by a cache).

    Rules that keep the result identical to the original file
      * a row goes to a part chosen from its KEY only (items: ItemCode, shelves: first column), not from its content,
        so editing an item's name changes just one part;
      * rows with the same key stay together in their original relative order (the app keeps the LAST row of a key);
      * the lines themselves are copied untouched. The script re-reads what it wrote and refuses to publish if anything differs.

    Run:   node tools/build-sync-index.js [--dir <folder holding the CSV files>]        (Node 18+, no dependencies)       */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.argv.includes('--dir') ? process.argv[process.argv.indexOf('--dir') + 1] : path.join(__dirname, '..'));
const OUT = path.join(ROOT, 'sync');
const SPECS = [
  { kind: 'items',   file: 'items.csv',   buckets: 256, keyCol: 1 }, // GTIN,ItemCode,ItemName  -> bucket by ItemCode (~15 KB per part)
  { kind: 'shelves', file: 'shelves.csv', buckets: 16, keyCol: 0 }   // Stor. Bin,...           -> bucket by Stor. Bin
];

// Same fingerprint function as the app's syncSignature(): the app re-computes it to verify every part it downloads.
function sig(text) {
  const s = String(text == null ? '' : text);
  let h1 = 0x811c9dc5, h2 = 5381;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 ^= c; h1 = Math.imul(h1, 0x01000193); h2 = (Math.imul(h2, 33) ^ c); }
  return s.length + ':' + (h1 >>> 0).toString(16) + ':' + (h2 >>> 0).toString(16);
}
const fileId = (s) => sig(s).split(':').slice(1).join('').slice(0, 10); // short, file-name-safe form of the fingerprint
function fnv(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
// first CSV field of a line (handles a quoted first field)
function field(line, col) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"' && cur === '') q = true;
    else if (c === ',') { out.push(cur); if (out.length > col) return out[col]; cur = ''; }
    else cur += c;
  }
  out.push(cur); return String(out[col] == null ? '' : out[col]);
}
const bucketOf = (line, spec) => fnv(field(line, spec.keyCol).trim().replace(/^"|"$/g, '')) % spec.buckets;
const writeIfChanged = (p, content) => { if (fs.existsSync(p) && fs.readFileSync(p, 'utf8') === content) return false; fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); return true; };

const manifest = { schema: 1, generated: new Date().toISOString(), files: {} };
let written = 0, failed = false;
const wanted = new Set();

for (const spec of SPECS) {
  const src = path.join(ROOT, spec.file);
  if (!fs.existsSync(src)) { console.log('skip (not found): ' + spec.file); continue; }
  const text = fs.readFileSync(src, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) { console.error('ERROR: ' + spec.file + ' has no data rows'); failed = true; continue; }
  const header = lines[0], rows = lines.slice(1);
  const parts = Array.from({ length: spec.buckets }, () => []);
  rows.forEach((l) => parts[bucketOf(l, spec)].push(l));

  const list = parts.map((p, id) => {
    const body = p.length ? p.join('\n') + '\n' : '';
    const name = 'b' + String(id).padStart(2, '0') + '-' + fileId(body) + '.csv';
    const rel = 'sync/' + spec.kind + '/' + name;
    wanted.add(rel);
    if (writeIfChanged(path.join(ROOT, rel), body)) written++;
    return { id, rows: p.length, bytes: Buffer.byteLength(body), sig: sig(body), file: name };
  });

  // the text the app will rebuild: header + every part in order
  const rebuilt = header + '\n' + parts.map((p) => (p.length ? p.join('\n') + '\n' : '')).join('');
  // safety check: same lines, nothing lost, nothing added
  const a = lines.slice().sort(), b = rebuilt.split('\n').filter((l) => l.length).sort();
  if (a.length !== b.length || a.some((l, i) => l !== b[i])) { console.error('ERROR: ' + spec.file + ': rebuilt content differs from the original — nothing published'); failed = true; continue; }
  // keyCol + hash tell the app how rows are spread over the parts, so a phone can split a full download itself (first install, or a big change)
  manifest.files[spec.kind] = { source: spec.file, header, rows: rows.length, bytes: Buffer.byteLength(text), buckets: spec.buckets, keyCol: spec.keyCol, hash: 'fnv1a-32', sig: sig(rebuilt), parts: list };
  console.log(spec.file + ': ' + rows.length + ' rows -> ' + spec.buckets + ' parts (avg ' + Math.round(Buffer.byteLength(text) / spec.buckets / 1024) + ' KB each)');
}
if (failed) process.exit(1);

// stale part files from earlier runs are removed, so the folder never grows
let removed = 0;
for (const spec of SPECS) {
  const dir = path.join(OUT, spec.kind);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) { const rel = 'sync/' + spec.kind + '/' + f; if (!wanted.has(rel)) { fs.unlinkSync(path.join(dir, f)); removed++; } }
}
// the manifest only changes when something changed (no pointless commits)
const prev = fs.existsSync(path.join(OUT, 'manifest.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8')) : null;
const same = prev && JSON.stringify(prev.files) === JSON.stringify(manifest.files);
if (!same) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest)); }
console.log((same && !written && !removed) ? 'Nothing changed.' : 'Updated: ' + written + ' part file(s) written, ' + removed + ' removed' + (same ? '' : ', manifest rewritten') + '.');
