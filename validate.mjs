// A local replica of the sealed gate's seven rows, run against a built /output directory.
// Usage: node validate.mjs <output-dir> <snapshot.json>
// Prints PASS/FAIL per row with the detail the gate would name, and exits 1 on any failure.

import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildDossier } from './vendor/makefun-board.ts';

const out = process.argv[2];
const snapPath = process.argv[3];
if (!out || !snapPath) {
  process.stderr.write('usage: node validate.mjs <output-dir> <snapshot.json>\n');
  process.exit(2);
}
const snapshot = JSON.parse(readFileSync(snapPath, 'utf8'));
const PLAIN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const rows = [];
const report = (name, ok, detail) => rows.push({ name, ok, detail });

function walk(root) {
  const files = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    for (const e of readdirSync(rel === '' ? root : join(root, rel), { withFileTypes: true })) {
      const p = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) stack.push(p);
      else files.push({ path: p, name: e.name, dir: e.isDirectory(), file: e.isFile(), link: e.isSymbolicLink() });
    }
  }
  return files;
}

// ---- 1. dashboard_files
{
  const dir = join(out, 'dashboard');
  let detail = null;
  if (!existsSync(dir)) detail = 'no dashboard/ directory';
  let files = [];
  if (!detail) {
    files = walk(dir);
    if (files.some((f) => !f.file)) detail = 'a dashboard entry is not a regular file';
    else if (files.some((f) => !PLAIN.test(f.name))) detail = `a file name is not plain: ${files.find((f) => !PLAIN.test(f.name)).path}`;
    else if (files.length > 400) detail = `${files.length} files, over 400`;
    else {
      const bytes = files.reduce((n, f) => n + lstatSync(join(dir, f.path)).size, 0);
      if (bytes > 4_194_304) detail = `${bytes} bytes, over 4 MiB`;
      else if (!files.some((f) => f.path === 'index.html')) detail = 'no index.html';
      else if (!files.some((f) => f.path.endsWith('.css'))) detail = 'no .css file';
      else if (!files.some((f) => f.path.endsWith('.js'))) detail = 'no .js file';
      else {
        // the no-network rule: no http(s) in an HTML attribute value, a <style> body, an inline
        // script import, a CSS file, or a JS import/export/require/dynamic-import specifier.
        for (const f of files) {
          const text = readFileSync(join(dir, f.path), 'utf8');
          if (f.path.endsWith('.css') && /https?:\/\//.test(text)) { detail = `${f.path}: a CSS file names a network address`; break; }
          if (f.path.endsWith('.html')) {
            if (/(?:href|src|action|poster|data)\s*=\s*["'][^"']*https?:\/\//i.test(text)) { detail = `${f.path}: an HTML attribute names a network address`; break; }
            const style = text.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) ?? [];
            if (style.some((s) => /https?:\/\//.test(s))) { detail = `${f.path}: a <style> body names a network address`; break; }
            const scripts = text.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
            if (scripts.some((s) => /\bimport\b[^;]*['"]https?:\/\//.test(s))) { detail = `${f.path}: an inline script imports a network address`; break; }
          }
          if (/\.(?:js|mjs)$/.test(f.path)) {
            if (/(?:\bimport\s*(?:[^'"]*from\s*)?|\bexport\s+[^'"]*from\s*|\brequire\s*\(|\bimport\s*\()\s*['"]https?:\/\//.test(text)) {
              detail = `${f.path}: a JavaScript import names a network address`;
              break;
            }
          }
        }
      }
    }
  }
  report('dashboard_files', detail === null, detail ?? `${files.length} files, ${files.reduce((n, f) => n + lstatSync(join(dir, f.path)).size, 0)} bytes, index.html + css + js present, no network address`);
}

// ---- board rows, shared by rows 2, 3, 4, 5
let board = null;
let boardBytes = 0;
{
  const path = join(out, 'board.json');
  if (existsSync(path)) {
    const buf = readFileSync(path);
    boardBytes = buf.length;
    try {
      const parsed = JSON.parse(buf.toString('utf8'));
      board = Array.isArray(parsed) ? parsed : parsed.rows;
    } catch { board = null; }
  }
}
const slugSet = new Set(snapshot.protocols.map((p) => p.slug));

// ---- 2. board_file
{
  let detail = null;
  if (!Array.isArray(board)) detail = 'board.json is not a JSON object with a rows array';
  else if (boardBytes > 8 * 1024 * 1024) detail = `board.json is ${boardBytes} bytes, over 8 MiB`;
  else if (board.length < 100 || board.length > 4000) detail = `${board.length} rows, outside 100 to 4000`;
  else {
    const seen = new Set();
    for (const r of board) {
      if (typeof r.slug !== 'string' || !slugSet.has(r.slug)) { detail = `slug ${JSON.stringify(r.slug)} is not one of the snapshot's protocols`; break; }
      if (seen.has(r.slug)) { detail = `slug ${r.slug} appears more than once`; break; }
      seen.add(r.slug);
      if (typeof r.name !== 'string' || r.name.length === 0) { detail = `${r.slug} has an empty name`; break; }
      if (!Number.isSafeInteger(r.rank) || r.rank <= 0) { detail = `${r.slug} has rank ${r.rank}`; break; }
      if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) { detail = `${r.slug} has implied_value_usd ${r.implied_value_usd}`; break; }
      if (!Array.isArray(r.farm_steps)) { detail = `${r.slug} has no farm_steps array`; break; }
    }
    if (!detail && board.length >= 2 && board.every((r) => r.implied_value_usd === board[0].implied_value_usd)) {
      detail = 'every row shares one implied value';
    }
  }
  report('board_file', detail === null, detail ?? `${board?.length} rows, ${boardBytes} bytes, all slugs in the snapshot`);
}

// ---- 3. sorted_by_value
{
  let detail = null;
  if (!Array.isArray(board)) detail = 'no board';
  else {
    const byRank = [...board].sort((a, b) => a.rank - b.rank);
    for (let i = 0; i < byRank.length; i++) if (byRank[i].rank !== i + 1) { detail = `rank ${i + 1} is ${byRank[i].rank}`; break; }
    if (!detail) for (let i = 1; i < byRank.length; i++) {
      if (byRank[i].implied_value_usd > byRank[i - 1].implied_value_usd) { detail = `rank ${byRank[i].rank} ($${byRank[i].implied_value_usd}) outvalues rank ${byRank[i - 1].rank} ($${byRank[i - 1].implied_value_usd})`; break; }
    }
  }
  report('sorted_by_value', detail === null, detail ?? 'ranks 1..N once each, implied value never rises with rank');
}

// ---- 4. coverage
{
  let detail = null;
  if (!Array.isArray(board)) detail = 'no board';
  else {
    const have = new Set(board.map((r) => r.slug));
    const missing = snapshot.watchlist.filter((s) => !have.has(s));
    if (missing.length) detail = `missing ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  }
  report('coverage', detail === null, detail ?? `all ${snapshot.watchlist.length} watchlist slugs on the board`);
}

// ---- 5. farm_steps
{
  let detail = null;
  if (!Array.isArray(board)) detail = 'no board';
  else {
    for (const r of board) {
      if (!Array.isArray(r.farm_steps) || r.farm_steps.length < 3 || r.farm_steps.length > 12) { detail = `${r.slug} has ${r.farm_steps?.length} farm steps`; break; }
      for (const s of r.farm_steps) {
        if (typeof s !== 'string') { detail = `${r.slug} has a non-string farm step`; break; }
        const t = s.trim().length;
        if (t < 20 || t > 600) { detail = `${r.slug} has a farm step of ${t} characters once trimmed`; break; }
      }
      if (detail) break;
    }
  }
  report('farm_steps', detail === null, detail ?? 'every row holds 3 to 12 steps of 20 to 600 characters');
}

// ---- 6. screenshots
function pngSize(buf) {
  if (buf.length < 24) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}
{
  const dir = join(out, 'screenshots');
  let detail = null;
  let info = [];
  if (!existsSync(dir)) detail = 'no screenshots/ directory';
  else {
    const names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.startsWith('.')).map((e) => e.name);
    if (names.length < 3 || names.length > 4) detail = `${names.length} images, outside 3 to 4`;
    else {
      for (const name of names) {
        if (!PLAIN.test(name)) { detail = `${name}: the name is not plain`; break; }
        const buf = readFileSync(join(dir, name));
        if (buf.length > 512 * 1024) { detail = `${name} is ${buf.length} bytes, over 512 KiB`; break; }
        const isPng = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        const isJpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
        if (!isPng && !isJpg) { detail = `${name} is neither a whole PNG nor a JPEG`; break; }
        const size = isPng ? pngSize(buf) : jpegSize(buf);
        if (!size) { detail = `${name}: cannot read its dimensions`; break; }
        const long = Math.max(size.w, size.h), short = Math.min(size.w, size.h);
        info.push(`${name} ${size.w}x${size.h} ${buf.length}B`);
        if (long > 1440) { detail = `${name}: long side ${long} over 1440`; break; }
        if (short < 800) { detail = `${name}: short side ${short} under 800`; break; }
      }
    }
  }
  report('screenshots', detail === null, detail ?? info.join('; '));
}

// ---- 7. dossier_matches
{
  let detail = null;
  const path = join(out, 'dossier.json');
  if (!existsSync(path)) detail = 'no dossier.json';
  else {
    try {
      const rebuilt = buildDossier(out, { text_max_bytes: 65_536 });
      const mine = readFileSync(path);
      if (!Buffer.from(rebuilt).equals(mine)) detail = `dossier.json (${mine.length} bytes) differs from buildDossier's rebuild (${rebuilt.length} bytes)`;
      else if (mine.length > 1.5 * 1024 * 1024) detail = `dossier.json is ${mine.length} bytes, over 1.5 MiB`;
      else detail = null;
      if (!detail) report('dossier_matches', true, `byte for byte, ${mine.length} bytes`);
    } catch (err) {
      detail = `buildDossier refuses: ${err.message}`;
    }
  }
  if (detail) report('dossier_matches', false, detail);
}

let failed = 0;
for (const r of rows) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}: ${r.detail}`);
  if (!r.ok) failed++;
}
console.log(failed === 0 ? 'VALID: all seven gate rows pass' : `INVALID: ${failed} gate row(s) fail`);
process.exit(failed === 0 ? 0 : 1);
