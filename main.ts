// Token radar entry (Node 22, standard library only).
//
// Reads the sealed snapshot from /input/snapshot.json (or --input <file|dir>), prices every radar
// subject with the model in lib/model.ts, writes the ranked board to /output/board.json and the
// dashboard's data to /output/data.js, copies this repository's dashboard/ and screenshots/ into
// /output, and writes /output/dossier.json last with the vendored make.fun library — the scorer
// rebuilds the dossier from /output and compares bytes, so the dossier is written from the final
// tree and never touched after.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../token-radar-01-kit/input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL, boardIssue, buildRadar, buildRaw, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps, as the rules state them; the dossier caps only refuse, they never shape bytes. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapBytes = readFileSync(inputFile);
const snapshotSha = createHash('sha256').update(snapBytes).digest('hex');
const snapshot = parseSnapshot(snapBytes.toString('utf8'));
const { board, radar, result } = buildRadar(snapshot) as {
  board: ReturnType<typeof buildRadar>['board'];
  radar: ReturnType<typeof buildRadar>['radar'];
  result: { stats: Record<string, number> };
};
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

// The model's own hash: the dashboard's model.js is this file's bytes, and the page, the board
// and the dossier all name the same two hashes (the model's and the snapshot's).
const coreBytes = readFileSync(join(here, 'lib/model-core.js'));
const modelSha = createHash('sha256').update(coreBytes).digest('hex');
const raw = buildRaw(snapshot, snapshotSha);
const rawBytes = Buffer.byteLength(JSON.stringify(raw), 'utf8');
if (rawBytes > 150_000) {
  process.stderr.write(`token radar: the raw model input is ${rawBytes} bytes, over the 150000 the dashboard budget allows\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ meta: { model_version: radar.model_version, model_sha: modelSha, snapshot_sha: snapshotSha }, rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(snapshot, board, radar.live, result, modelSha, snapshotSha, raw));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
writeFileSync(join(out, 'dashboard', 'model.js'), coreBytes);
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The README is generated, never hand-edited: every figure in it is filled from this run's
// stats and the model's constants, so the README cannot drift from the board it describes.
const tplPath = join(here, 'README.tpl.md');
if (existsSync(tplPath)) {
  const stats = result.stats as Record<string, number>;
  const values: Record<string, string> = {
    board_count: String(stats.boardCount),
    watchlist_size: String(stats.watchlistSize),
    peer_count: String(stats.tokenedPeerCount),
    protocol_count: String(stats.protocolCount),
    tokened_count: String(stats.tokenedCount),
    floor_m: String(snapshot.floor_usd / 1e6),
    global_median: (stats.globalMedian as number).toFixed(3),
    shrink_k: String(MODEL.shrink_k),
    k_thin_base: String(MODEL.k_thin_base),
    winsor_lo: String(MODEL.winsor_lo),
    winsor_hi: String(MODEL.winsor_hi),
    growth_floor: String(MODEL.growth_floor),
    growth_cap: String(MODEL.growth_cap),
    maturity_floor: MODEL.maturity_floor.toFixed(2),
    maturity_max: (MODEL.maturity_floor + MODEL.maturity_range).toFixed(2),
    breadth_pct: String(Math.round(MODEL.breadth_per_chain * 100)),
    breadth_max_extra: String(MODEL.breadth_max_extra),
    model_version: radar.model_version,
  };
  const rendered = readFileSync(tplPath, 'utf8').replace(/\{\{(\w+)\}\}/g, (whole, key: string) => {
    if (!(key in values)) throw new Error(`README.tpl.md: no value for {{${key}}}`);
    return values[key]!;
  });
  writeFileSync(join(here, 'README.md'), rendered);
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: DASHBOARD_CAPS }));

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows ranked (${radar.early_size} beyond the watchlist, ${radar.live_count} live-token protocols set aside)\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')}, ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
