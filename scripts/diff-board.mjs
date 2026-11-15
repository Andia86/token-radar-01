// diff-board.mjs — compare two board.json files row by row.
// Usage: node scripts/diff-board.mjs <old-board.json> <new-board.json> [topN]
// Prints the top N rows of the NEW board with old/new implied values and old/new ranks,
// then a one-line summary of how much of the board moved.
import { readFileSync } from 'node:fs';

const [oldPath, newPath, topArg] = process.argv.slice(2);
if (!oldPath || !newPath) {
  process.stderr.write('usage: node scripts/diff-board.mjs <old-board.json> <new-board.json> [topN]\n');
  process.exit(2);
}
function rows(path) {
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  return Array.isArray(doc) ? doc : doc.rows;
}
const oldRows = rows(oldPath);
const newRows = rows(newPath);
const topN = Number(topArg || 10);
const oldBySlug = new Map(oldRows.map((r) => [r.slug, r]));
const fmt = (n) => '$' + Math.round(n).toLocaleString('en-US');

process.stdout.write(`#  slug  new_rank  old_rank  new_implied  old_implied  change\n`);
for (const r of newRows.slice(0, topN)) {
  const o = oldBySlug.get(r.slug);
  const pct = o ? ((r.implied_value_usd / o.implied_value_usd - 1) * 100).toFixed(1) + '%' : 'new';
  process.stdout.write(
    `${r.rank}  ${r.slug}  new #${r.rank}  old #${o ? o.rank : '—'}  ${fmt(r.implied_value_usd)}  ${o ? fmt(o.implied_value_usd) : '—'}  ${pct}\n`,
  );
}
let changed = 0;
let rankMoved = 0;
let maxRankJump = 0;
for (const r of newRows) {
  const o = oldBySlug.get(r.slug);
  if (!o) continue;
  if (o.implied_value_usd !== r.implied_value_usd) changed++;
  if (o.rank !== r.rank) rankMoved++;
  maxRankJump = Math.max(maxRankJump, Math.abs(o.rank - r.rank));
}
process.stdout.write(
  `summary: ${newRows.length} rows; ${changed} changed value, ${rankMoved} changed rank, largest rank move ${maxRankJump}\n`,
);
