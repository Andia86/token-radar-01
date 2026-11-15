// test-core.mjs — unit checks for the pricing core's pure functions.
// Usage: node scripts/test-core.mjs   (exit 0 = all pass)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const core = require('../lib/model-core.js');

let failures = 0;
function eq(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  process.stdout.write(`${ok ? 'ok' : 'FAIL'}  ${label}: got ${actual}, want ${expected}\n`);
}
function near(label, actual, expected, tol = 1e-9) {
  const ok = Math.abs(actual - expected) <= tol;
  if (!ok) failures++;
  process.stdout.write(`${ok ? 'ok' : 'FAIL'}  ${label}: got ${actual}, want ~${expected}\n`);
}
function throws(label, fn) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  if (!threw) failures++;
  process.stdout.write(`${threw ? 'ok' : 'FAIL'}  ${label}: expected a throw\n`);
}

// true median
eq('median [1,2,3,4]', core.median([1, 2, 3, 4]), 2.5);
eq('median [3,1,2]', core.median([3, 1, 2]), 2);
eq('median [5]', core.median([5]), 5);
eq('median [4,1]', core.median([4, 1]), 2.5);
throws('median []', () => core.median([]));

// quantile (R type 7)
eq('quantile p75 of [1,2,3,4]', core.quantile([1, 2, 3, 4], 0.75), 3.25);
eq('quantile of single', core.quantile([7], 0.75), 7);
throws('quantile []', () => core.quantile([], 0.5));

// layered log shrinkage weights with the shipped constants (K=6, thin base 3):
// w_c must be 0.053 / 0.182 / 0.333 / 0.5 at n = 1 / 2 / 3 / 6.
const P = core.PARAMS;
const fakeTable = {
  global_median: 0.25,
  groups: { 'Credit & Yield': { name: 'Credit & Yield', peers: 40, median: 0.4, p75: 0.9, m: 0.38, w: 40 / 46 } },
  by_category: {},
};
function entry(n, medianValue) { return { category: 'Lending', peers: n, median: medianValue }; }
near('w_c n=1', core.shrinkMultiple(entry(1, 2.0), fakeTable, P, 'Lending').w, 1 / 19, 1e-12);
near('w_c n=2', core.shrinkMultiple(entry(2, 2.0), fakeTable, P, 'Lending').w, 2 / 11, 1e-12);
near('w_c n=3', core.shrinkMultiple(entry(3, 2.0), fakeTable, P, 'Lending').w, 1 / 3, 1e-12);
near('w_c n=6', core.shrinkMultiple(entry(6, 2.0), fakeTable, P, 'Lending').w, 0.5, 1e-12);
// a one-peer category's multiple must sit between its group multiple and its own median,
// much closer to the group: log-interpolated at w=1/19.
{
  const s = core.shrinkMultiple(entry(1, 2.0), fakeTable, P, 'Lending');
  const want = Math.exp((1 / 19) * Math.log(2.0) + (18 / 19) * Math.log(0.38));
  near('n=1 log blend', s.m, want, 1e-12);
  eq('n=1 quality', s.quality, 'very-thin');
}
// n=0 borrows the group multiple outright.
{
  const s = core.shrinkMultiple(null, fakeTable, P, 'Lending');
  eq('n=0 borrows group m', s.m, 0.38);
  eq('n=0 quality', s.quality, 'borrowed');
}
// the group cap: a category may not price above 1.5x its group's p75.
{
  const s = core.shrinkMultiple(entry(50, 4.0), fakeTable, P, 'Lending');
  eq('cap at 1.5 x p75', s.m, 0.9 * 1.5);
  eq('cap flagged', s.capped, true);
}
// quality ladder
eq('quality 5', core.qualityFor(5), 'solid');
eq('quality 4', core.qualityFor(4), 'thin');
eq('quality 3', core.qualityFor(3), 'thin');
eq('quality 2', core.qualityFor(2), 'very-thin');
eq('quality 1', core.qualityFor(1), 'very-thin');
eq('quality 0', core.qualityFor(0), 'borrowed');
// every snapshot category is mapped (checked against the real snapshot when one is passed)
if (process.argv[2]) {
  const snapshot = JSON.parse((await import('node:fs')).readFileSync(process.argv[2], 'utf8'));
  const cats = new Set(snapshot.protocols.map((p) => p.category ?? 'Uncategorized'));
  const missing = [...cats].filter((c) => !(c in core.CATEGORY_GROUPS));
  eq('unmapped categories in snapshot', missing.length, 0);
  if (missing.length) process.stdout.write('  missing: ' + missing.join(', ') + '\n');
}

process.stdout.write(failures ? `test-core: ${failures} FAILURE(S)\n` : 'test-core: all pass\n');
process.exit(failures ? 1 : 0);
