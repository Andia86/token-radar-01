// lint-hardcode.mjs — the single-source-of-truth lint.
//
// Every figure the dashboard or the README states must come from the model run (core stats in
// data.js, filled into <span data-stat> placeholders and the generated README), never from a
// hand-written literal that can drift. This lint fails when:
//   1. any current stat value, in any common formatting, appears as a literal in
//      dashboard/index.html, dashboard/app.js or README.md; or
//   2. lib/model-core.js names any protocol that appears in the snapshot (the model must price
//      from fields, never from names).
//
// Usage: node scripts/lint-hardcode.mjs <output-dir> <snapshot.json>
// CSS is not scanned: it states no figures. data.js itself is the source, not a copy, and the
// template README.tpl.md carries placeholders, so neither is scanned.
//
// Exit code 0 = clean, 1 = hits (printed), 2 = bad usage.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [outDir, snapshotPath] = process.argv.slice(2);
if (!outDir || !snapshotPath) {
  process.stderr.write('usage: node scripts/lint-hardcode.mjs <output-dir> <snapshot.json>\n');
  process.exit(2);
}

const dataJs = readFileSync(join(outDir, 'data.js'), 'utf8');
const data = JSON.parse(dataJs.slice('window.RADAR='.length, dataJs.endsWith(';\n') ? -2 : undefined));
const stats = data.meta.stats;
const model = data.meta.model;

function forms(value, formatters) {
  return formatters.map((f) => f(value)).filter((s) => s !== null && s !== '');
}
const plain = (v) => String(v);
const grouped = (v) => String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const fixed3 = (v) => v.toFixed(3);
const fixed2 = (v) => v.toFixed(2);
const rounded = (v) => String(Math.round(v));

// value -> the literal spellings a hand-written copy might take
const checks = [
  ['board_count', forms(stats.boardCount, [plain, grouped])],
  ['protocol_count', forms(stats.protocolCount, [plain, grouped])],
  ['not_ranked', forms(stats.protocolCount - stats.boardCount, [plain, grouped])],
  ['peer_count', forms(stats.tokenedPeerCount, [plain, grouped])],
  ['tokened_count', forms(stats.tokenedCount, [plain, grouped])],
  ['watchlist_size', forms(stats.watchlistSize, [plain])],
  ['global_median', forms(stats.globalMedian, [fixed3, (v) => v.toFixed(4)])],
  ['max_peer_ratio', forms(stats.maxPeerRatioRaw, [rounded])],
  ['g_range', forms(1 + (model.growth_floor / 100) * model.growth_weight, [fixed2]).concat(forms(1 + (model.growth_cap / 100) * model.growth_weight, [fixed2]))],
  ['b_max', forms(1 + model.breadth_per_chain * model.breadth_max_extra, [fixed2])],
];

const targets = ['dashboard/index.html', 'dashboard/app.js', 'README.tpl.md'];
const root = process.cwd();
let hits = 0;
const seen = new Set();
for (const rel of targets) {
  const text = readFileSync(join(root, rel), 'utf8');
  const lines = text.split('\n');
  for (const [label, literals] of checks) {
    for (const literal of literals) {
      if (literal.length < 2) continue;
      const re = new RegExp(`(?<![\\d.])${literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\d])`);
      lines.forEach((line, i) => {
        const key = `${rel}:${i + 1}:${label}`;
        if (re.test(line) && !seen.has(key)) {
          seen.add(key);
          process.stdout.write(`HIT ${rel}:${i + 1}  ${label} = ${literal}  ::  ${line.trim().slice(0, 110)}\n`);
          hits++;
        }
      });
    }
  }
}

// The model core must not name any protocol in the snapshot. The classification constants
// (exchange prefixes, product categories and words) are class rules, not protocol names, so
// their declaration lines are stripped before the scan; what remains must contain no slug.
const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
const coreText = readFileSync(join(root, 'lib/model-core.js'), 'utf8')
  .split('\n')
  .filter((line) => !/PRODUCT_CATEGORIES|PRODUCT_WORD|EXCHANGE_PREFIX|VERSIONED =/.test(line))
  .join('\n')
  .toLowerCase();
const names = new Set();
for (const p of snapshot.protocols) {
  if (p.slug && p.slug.length >= 4) names.add(p.slug.toLowerCase());
}
// Slugs that are also ordinary English words, used in the core as English, not as names:
// "exactly" (a protocol whose slug is the adverb) and "wrapped" (the product-class word).
const GENERIC_WORD_SLUGS = new Set(['exactly', 'wrapped']);
for (const name of names) {
  if (GENERIC_WORD_SLUGS.has(name)) continue;
  const re = new RegExp(`(?<![a-z0-9-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9-])`);
  if (re.test(coreText)) {
    process.stdout.write(`HIT lib/model-core.js  names protocol slug "${name}"\n`);
    hits++;
  }
}

if (hits > 0) {
  process.stdout.write(`lint-hardcode: ${hits} hit(s) — figures must come from the run, and the model must not name protocols\n`);
  process.exit(1);
}
process.stdout.write('lint-hardcode: clean — no stat literal in the dashboard sources or README, and the model core names no protocol\n');
