#!/usr/bin/env node
'use strict';
/*  archive-all-data.js — moves the rows of PoOrders.csv, then PrivateFile.csv, into ArchiveAllData.csv

    It does exactly what the "Archive data" button in the app does (same mapping, same order, same safety rules):
      * one file at a time: PoOrders first, then PrivateFile;
      * for each file the rows are first written into ArchiveAllData.csv and only then removed from the original file;
      * rows already in the archive (from an interrupted run) are not added twice; identical rows are all kept;
      * if ArchiveAllData.csv does not have the expected header, nothing is touched.

    ArchiveAllData.csv columns:  FileType, Department, Sheet/PONo, SheetName, ActionType, ShelfNo, Item Code, Item Name, Emp.No, Emp.Name, Scan.Date
      PoOrders    -> FileType "PoOrders",    Sheet/PONo = PoNo,    SheetName = "PO From Home Screen" (these rows come from the home screen)
      PrivateFile -> FileType "PrivateFile", Sheet/PONo = SheetNo, SheetName = SheetName

    Settings (environment):  DRY_RUN=true|false (default false)   DATA_DIR=.      Node 18+, no dependencies.                  */
const fs = require('fs');
const path = require('path');

const DIR = path.resolve(process.env.DATA_DIR || '.');
const DRY_RUN = String(process.env.DRY_RUN || 'false').toLowerCase() === 'true';
const ARCHIVE = 'ArchiveAllData.csv';
const ARCHIVE_HEADERS = ['FileType', 'Department', 'Sheet/PONo', 'SheetName', 'ActionType', 'ShelfNo', 'Item Code', 'Item Name', 'Emp.No', 'Emp.Name', 'Scan.Date'];
const PO_SHEETNAME = 'PO From Home Screen';

// the same CSV reading / writing as the app: every field quoted, BOM, CRLF
function parseCSVMatrix(text) {
  text = String(text).replace(/^\uFEFF/, '');
  const rows = [], row = []; let field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (quoted) { if (c === '"' && n === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c; }
    else {
      if (c === '"' && field === '') quoted = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { }
      else if (c === '\n') { row.push(field); rows.push(row.slice()); row.length = 0; field = ''; }
      else field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row.slice()); }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
}
const serializeCSVMatrix = (m) => '\uFEFF' + m.map((r) => r.map((v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"').join(',')).join('\r\n') + '\r\n';
const norm = (x) => String(x == null ? '' : x).replace(/^\uFEFF/, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const keyOf = (r) => r.map((v) => String(v == null ? '' : v)).join('\u241F');
const counts = (rows) => { const m = new Map(); rows.forEach((r) => { const k = keyOf(r); m.set(k, (m.get(k) || 0) + 1); }); return m; };
const readText = (name) => { const p = path.join(DIR, name); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; };
const writeMatrix = (name, m) => fs.writeFileSync(path.join(DIR, name), serializeCSVMatrix(m));

function loadArchive() {
  const text = readText(ARCHIVE);
  if (text == null || !text.trim()) return [ARCHIVE_HEADERS.slice()];
  const m = parseCSVMatrix(text);
  const want = ARCHIVE_HEADERS.map(norm), have = (m[0] || []).map(norm);
  if (want.length !== have.length || want.some((w, i) => w !== have[i])) throw new Error(ARCHIVE + ' does not have the expected header (' + ARCHIVE_HEADERS.join(', ') + ') — nothing was touched');
  return m;
}
function mapRow(kind, idx, r) {
  const g = (k) => (idx[k] === undefined ? '' : String(r[idx[k]] == null ? '' : r[idx[k]]));
  if (kind === 'PoOrders') return ['PoOrders', g('department'), g('pono'), PO_SHEETNAME, g('actiontype'), g('shelfno'), g('itemcode'), g('itemname'), g('empno'), g('empname'), g('scandate')];
  return ['PrivateFile', g('department'), g('sheetno'), g('sheetname'), g('actiontype'), g('shelfno'), g('itemcode'), g('itemname'), g('empno'), g('empname'), g('scandate')];
}

function moveOne(spec) {
  const text = readText(spec.file);
  if (text == null || !text.trim()) return { total: 0, moved: 0, note: 'file not found or empty' };
  const m = parseCSVMatrix(text);
  if (norm(m[0][0]) !== 'department') throw new Error(spec.file + ': unexpected first column "' + m[0][0] + '" — left untouched');
  const header = m[0], rows = m.slice(1);
  if (!rows.length) return { total: 0, moved: 0, note: 'no rows' };
  const idx = {}; header.forEach((h, i) => { const k = norm(h); if (k && idx[k] === undefined) idx[k] = i; });
  for (const need of spec.required) if (idx[need] === undefined) throw new Error(spec.file + ': column "' + need + '" not found — left untouched');
  const mapped = rows.map((r) => mapRow(spec.kind, idx, r));

  const arch = loadArchive();                       // refuses a wrong header before anything is written
  const have = counts(arch.slice(1)), seen = new Map(), toAdd = [];
  mapped.forEach((r) => { const k = keyOf(r), n = (seen.get(k) || 0) + 1; seen.set(k, n); if (n > (have.get(k) || 0)) toAdd.push(r); });
  if (DRY_RUN) return { total: rows.length, moved: 0, wouldAdd: toAdd.length, note: 'dry run — nothing changed' };

  toAdd.forEach((r) => arch.push(r));
  writeMatrix(ARCHIVE, arch);                       // 1) the rows are in the archive ...
  writeMatrix(spec.file, [header]);                 // 2) ... and only then removed from the original file
  return { total: rows.length, moved: rows.length, added: toAdd.length, archiveRows: arch.length - 1 };
}

const SPECS = [
  { kind: 'PoOrders', file: 'PoOrders.csv', required: ['department', 'pono', 'actiontype', 'shelfno', 'itemcode', 'itemname', 'empno', 'empname', 'scandate'] },
  { kind: 'PrivateFile', file: 'PrivateFile.csv', required: ['department', 'sheetno', 'sheetname', 'actiontype', 'shelfno', 'itemcode', 'itemname', 'empno', 'empname', 'scandate'] }
];
console.log('ArchiveAllData — ' + (DRY_RUN ? 'DRY RUN (nothing is changed)' : 'REAL RUN'));
let failed = false;
for (const spec of SPECS) {                          // strictly one after the other; a failure stops the next file
  try {
    const r = moveOne(spec);
    console.log(' - ' + spec.file + ': ' + r.total + ' rows' + (r.note ? ' (' + r.note + ')' : '') + (r.wouldAdd != null ? ', would add ' + r.wouldAdd + ' to the archive' : '') + (r.moved ? ' -> moved ' + r.moved + ' (' + r.added + ' new in the archive; archive now ' + r.archiveRows + ' rows)' : ''));
  } catch (e) {
    console.error(' - ' + spec.file + ': FAILED — ' + e.message);
    failed = true; break;
  }
}
process.exit(failed ? 1 : 0);
