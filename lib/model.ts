// The token radar's server shell: the sealed snapshot in, the ranked board and the dashboard's
// data out. All pricing lives in lib/model-core.js — one pure-function file this shell requires,
// the dashboard copies byte for byte, and the dossier shows. This file keeps what is server-only:
// snapshot parsing, the gate's board checks, the farm plans (text, priced from the core's own
// factors) and the assembly of board.json and data.js.
//
// THE SCREEN. A protocol is a radar subject when the snapshot records no token for it (no market
// cap, no CoinGecko id, no symbol) and it is not a wrapped, staked or bridged product of a token
// that already trades, not an exchange, and not a versioned sub-product of another protocol. The
// house watchlist is that same screen plus the snapshot's TVL floor; this board runs the screen
// on the whole snapshot, so the watchlist's protocols are the floor of the board, never its
// ceiling. Protocols that record a token are never ranked: the dashboard lists them apart, at
// the market's own values, and the core prices them as a control group.
//
// THE VALUE. Implied value is a conditional value, not a launch forecast: what a token would be
// worth if it were priced the way the protocol's trading peers are priced, on this record.
//   implied = TVL x M(category) x G(growth) x A(maturity) x B(breadth)
// with every constant in the core's PARAMS and every step reproducible from the core's chain.

import { createRequire } from 'node:module';

/** The one model implementation, shared with the dashboard and the dossier. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const core: any = createRequire(import.meta.url)('./model-core.js');

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them: the classic fields of the core's PARAMS. */
export interface ModelConstants {
  winsor_lo: number;
  winsor_hi: number;
  shrink_k: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  breadth_per_chain: number;
  breadth_max_extra: number;
  k_thin_base: number;
  floor_tvl: number;
}

export const MODEL: ModelConstants = {
  winsor_lo: core.PARAMS.winsor_lo,
  winsor_hi: core.PARAMS.winsor_hi,
  shrink_k: core.PARAMS.shrink_k,
  growth_weight: core.PARAMS.growth_weight,
  growth_floor: core.PARAMS.growth_floor,
  growth_cap: core.PARAMS.growth_cap,
  maturity_floor: core.PARAMS.maturity_floor,
  maturity_range: core.PARAMS.maturity_range,
  maturity_days: core.PARAMS.maturity_days,
  unknown_age_days: core.PARAMS.unknown_age_days,
  breadth_per_chain: core.PARAMS.breadth_per_chain,
  breadth_max_extra: core.PARAMS.breadth_max_extra,
  k_thin_base: core.PARAMS.k_thin_base,
  floor_tvl: core.PARAMS.floor_tvl,
};

/** The model's version label, stated on the dashboard. */
export const MODEL_VERSION: string = core.MODEL_VERSION;

/** How many live-token protocols the dashboard's Live view carries, by market cap. */
export const LIVE_ROWS = 24;

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

export const ageDays: (asOf: string, listedAt: string | null) => number | null = core.ageDays;
export const recordsNoToken: (p: SnapshotProtocol) => boolean = core.recordsNoToken;
export const isSubject: (p: SnapshotProtocol) => boolean = core.isSubject;
export const categoryOf: (p: SnapshotProtocol) => string = core.categoryOf;

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}
// ---------------------------------------------------------------- farm plans
//
// A plan is seven steps, generated from the protocol's own record: the category chooses the two
// core actions, the first chain sets the funding route and the gas budget, the TVL sets the
// capital tier, the age sets the hold. Every step carries its cost and its time; the strings are
// what board.json hands in, trimmed to the gate's 20..600 characters by stepText().

/** How much capital one farm position needs, from the protocol's own TVL. */
export function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  if (p.tvl_usd >= 25_000_000) return 75;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get the longer qualifying window. */
export function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  if (age < 730) return 35;
  return 30;
}

/** The first chain a protocol names, or a neutral phrase. */
export function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** What one transaction costs on a chain, in the words a farmer budgets by. */
export function gasProfile(chain: string): string {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 'Ethereum gas runs $3 to $15 a transaction at ordinary times; batch actions into one visit';
  if (c === 'solana') return 'Solana fees run about a cent a transaction';
  if (c === 'binance' || c === 'bsc') return 'BNB Chain fees run $0.10 to $0.50 a transaction';
  if (c === 'bitcoin') return 'Bitcoin fees vary with the mempool; budget $1 to $5 a transaction and avoid fee spikes';
  if (['base', 'arbitrum', 'optimism', 'zksync era', 'linea', 'scroll', 'mantle', 'ink', 'mode', 'blast', 'berachain', 'monad', 'sonic', 'abstract', 'soneium', 'unichain', 'world chain', 'bob', 'taiko', 'fraxtal'].includes(c)) {
    return `${chain} fees run a few cents a transaction`;
  }
  return `budget $1 to $5 a transaction in ${chain}'s gas token`;
}

/** The category's playbook name, as the detail view states the plan's basis. */
export function playbookOf(p: SnapshotProtocol): string {
  const c = categoryOf(p);
  const known: Record<string, string> = {
    Lending: 'supply-and-borrow',
    Dexs: 'liquidity provision',
    Derivatives: 'margin and hedged flow',
    'Risk Curators': 'curated vaults',
    'Onchain Capital Allocator': 'allocator vaults',
    RWA: 'tokenized yield',
    Yield: 'yield position',
    'Yield Aggregator': 'aggregated vaults',
    CDP: 'collateralized mint',
    'CDP Manager': 'managed CDP',
    'Basis Trading': 'basis vault',
    Chain: 'native chain activity',
    'Prediction Market': 'market participation',
    Insurance: 'cover purchase',
    'Cross Chain Bridge': 'bridge routes',
    Restaking: 'restaking position',
    'Staking Pool': 'pooled staking',
    Payments: 'payment flow',
    Indexes: 'index position',
    'Liquidity Manager': 'managed liquidity',
    'Leveraged Farming': 'leveraged position',
    'CeDeFi': 'managed yield',
    'Stablecoin Wrapper': 'stablecoin position',
    'Collateral Markets': 'collateral supply',
  };
  return known[c] ?? 'flagship product';
}

interface CoreSteps {
  core: string;
  second: string;
}

/**
 * The two category actions of a plan: what the farmer actually does in this kind of protocol.
 * `usd` is the capital, `chain` the first chain, `p` the protocol itself. Amounts and assets are
 * the category's ordinary ones; nothing here names a feature the record does not imply.
 */
function coreSteps(p: SnapshotProtocol, usd: number, chain: string): CoreSteps {
  const name = p.name;
  const c = categoryOf(p);
  const half = Math.max(25, Math.round(usd / 2));
  switch (c) {
    case 'Lending':
      return {
        core: `Supply $${usd} of USDC to ${name}'s main lending market on ${chain} and keep the supply position open in the wallet.`,
        second: `Borrow about $${Math.round(usd / 4)} of USDC against the supply and repay it a week later, keeping the health factor above 2 the whole time so the position is never near liquidation.`,
      };
    case 'Dexs':
      return {
        core: `Provide $${usd} of liquidity, split between USDC and the pool's other asset, to ${name}'s flagship pool on ${chain} and keep the LP position open.`,
        second: `Make one small swap in each direction through ${name} every week, about $${half} a side, so the wallet shows real trading flow and not only deposits.`,
      };
    case 'Derivatives':
      return {
        core: `Deposit $${usd} of USDC as margin on ${name} on ${chain} and open one small position, no more than a fifth of the margin at risk.`,
        second: `Keep the position hedged or small enough that funding payments stay under a dollar a week, and close and reopen it once a fortnight rather than letting it sit untouched.`,
      };
    case 'Risk Curators':
      return {
        core: `Deposit $${usd} of USDC into a ${name}-curated vault on ${chain}: pick the vault whose strategy page states its risk bounds in numbers, and keep the vault shares.`,
        second: p.chains.length > 1
          ? `Add $${half} to a ${name}-curated vault on ${p.chains[1]}, its next chain on record, and read each vault's allocation page monthly: a curator is the product, and its published allocations are each position's report card.`
          : `Read the vault's allocation page once a week and note any strategy change in the farm log; a curator's vault is the product, so its published allocations are the position's report card.`,
      };
    case 'Onchain Capital Allocator':
      return {
        core: `Deposit $${usd} of USDC into ${name}'s flagship vault on ${chain} and keep the vault shares in the wallet.`,
        second: p.chains.length > 1
          ? `Add $${half} to ${name}'s vault on ${p.chains[1]}, its next chain on record, so the wallet has history with the allocator on two chains.`
          : `Top the vault up by $${half} after a fortnight rather than depositing once, so the wallet's history shows a user who returns.`,
      };
    case 'RWA':
      return {
        core: `Deposit $${usd} of USDC into ${name}'s flagship yield product on ${chain} and hold the position token it issues; do not trade the position token away.`,
        second: `Check the product's own reporting page once a month and log the stated backing and yield, so the hold rests on the issuer's reports and not on the deposit alone.`,
      };
    case 'Yield':
    case 'Yield Aggregator':
      return {
        core: `Deposit $${usd} of USDC into ${name}'s main vault on ${chain} and keep the shares; yields move, the deposit is the position.`,
        second: `Claim any rewards the vault pays out once a month and restake or bank them in the same wallet, keeping one address's history unbroken.`,
      };
    case 'CDP':
    case 'CDP Manager':
      return {
        core: `Deposit $${usd} of the chain's main collateral asset into ${name} on ${chain} and mint about $${half} of its stablecoin against it, keeping the collateral ratio above 200% at all times.`,
        second: `Hold the minted stablecoin in the wallet or in ${name}'s own stability pool; do not spend it into other protocols, so the position reads as one user's CDP.`,
      };
    case 'Basis Trading':
      return {
        core: `Deposit $${usd} of USDC into ${name}'s basis vault on ${chain} and keep the shares; the vault runs the hedge, the deposit is the position.`,
        second: `Read the vault's stated funding and hedge report once a month and log it; basis returns invert when funding flips, and the log is what proves the hold was deliberate.`,
      };
    case 'Chain':
      return {
        core: `Bridge $${usd} of USDC or the chain's main asset to ${chain} and hold it in the wallet; a chain's future token, if any, is farmed by being a real user of the chain.`,
        second: `Use two or three of ${chain}'s established apps with the same wallet over the hold — a swap, a lend, a stake — in ordinary amounts, a few transactions a week.`,
      };
    case 'Prediction Market':
      return {
        core: `Fund $${usd} on ${name} and take positions in two liquid markets, no more than $${half} in either, choosing markets that settle inside the hold.`,
        second: `Settle or roll each position as its market resolves and keep the account active every week; an account with only a deposit and no positions reads as parked, not used.`,
      };
    case 'Insurance':
      return {
        core: `Buy about $${usd} of cover from ${name} on ${chain} for a position the wallet actually holds elsewhere, for the length of the hold.`,
        second: `Keep the policy document and the covered position's record together in the farm log; cover bought with no position behind it is the pattern to avoid.`,
      };
    case 'Cross Chain Bridge':
      return {
        core: `Bridge $${usd} of USDC to ${chain} through ${name}, then use the bridged funds in one established app at the destination rather than bridging straight back.`,
        second: `Repeat the route in the other direction a fortnight later with a smaller amount, so the wallet has genuine two-way history on the bridge.`,
      };
    case 'Restaking':
    case 'Staking Pool':
      return {
        core: `Stake $${usd} of the chain's staking asset through ${name} on ${chain} and keep the receipt token in the wallet.`,
        second: `Claim staking rewards as they land and restake them in the same position once a month, so the wallet's history compounds in one place.`,
      };
    case 'Payments':
      return {
        core: `Route about $${usd} of real payments through ${name} over the hold, in the amounts the wallet would pay anyway, rather than one round trip.`,
        second: `Keep the payment records in the farm log with dates and counterparties; a payments product is farmed by usage, and usage is what the log shows.`,
      };
    default:
      return {
        core: `Deposit $${usd} of USDC into ${name}'s flagship product on ${chain} and keep the position open in the wallet.`,
        second: `Use ${name}'s second ordinary action once a fortnight — a claim, a vote, a top-up or a withdrawal and redeposit of a small part — so the wallet's history is a user's, not a single deposit's.`,
      };
  }
}

/** A step as one string: the action, then its cost and its time, within the gate's 20..600 characters once trimmed. */
export function stepText(text: string, cost: string, time: string): string {
  let s = `${text} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/**
 * A protocol's farm plan: seven steps from its own record. Steps 1, 2, 5 and 7 are the shared
 * discipline (wallet, funding route, weekly cadence, exit); 3 and 4 are the category's actions;
 * 6 is the hold the protocol's age sets.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = chainOf(p);
  const usd = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasProfile(chain);
  const reserve = chain === 'Ethereum' ? 25 : usd >= 150 ? 10 : 5;
  const { core, second } = coreSteps(p, usd, chain);
  const steps: Array<[string, string, string]> = [
    [
      `Use a fresh wallet for ${p.name} that holds only the funds this plan uses, and keep its seed phrase offline.`,
      'nothing',
      '5 minutes',
    ],
    [
      `Fund the wallet on ${chain}: move $${usd + reserve + 20} of USDC there and keep about $${reserve} aside in the gas token. Note that ${gas}.`,
      'about $1 in bridge fees on most routes, more from Ethereum',
      '10 to 20 minutes',
    ],
    [core, `the $${usd} stays in the position; ${gas.split(';')[0]!.replace(/^./, (ch) => ch.toLowerCase())}`, '10 to 15 minutes'],
    [second, 'small amounts of gas and any stated interest, budgeted at $2 a month', '10 minutes, repeated as stated'],
    [
      `Make one qualifying action a week — a top-up, a claim, a vote or a small trade inside ${p.name} — and never manufacture volume that only washes between your own wallets.`,
      'about $2 a week in gas at most chains\' prices',
      '10 minutes a week',
    ],
    [
      `Hold the position for at least ${hold} days so it stands in several weekly snapshots, and check it weekly rather than moving it.`,
      `the $${usd} stays in the position for the hold`,
      `${hold} days`,
    ],
    [
      `Before withdrawing, open ${p.name}'s own points or rewards page and claim only from a link the protocol itself publishes; log the wallet, the dates and every transaction hash, and withdraw only after any announced snapshot date has passed.`,
      'never pay a fee to claim; gas as above',
      '15 minutes',
    ],
  ];
  return steps.map(([t, c, tm]) => stepText(t, c, tm));
}

// ---------------------------------------------------------------- the board

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    category: string;
    peer_count: number;
    category_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
    age_days: number | null;
    quality: string;
    shrink_w: number;
    group: string;
    capped: boolean;
  };
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the page shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  symbol: string | null;
}

/** One category's line in the dashboard's peer table. */
export interface CategoryLine {
  category: string;
  peers: number;
  median_raw: number | null;
  multiple: number;
  subjects: number;
}

/** Everything the dashboard renders, built from the snapshot by buildRadar. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  global_median: number;
  peer_count: number;
  protocol_count: number;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_count: number;
  live_size: number;
  categories: CategoryLine[];
  rows: BoardRow[];
  live: LiveRow[];
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const bySlugAsc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One core-priced subject as a board row: the core's numbers, this shell's farm plan. */
function toBoardRow(entry: { row: SnapshotProtocol; price: never; rank: number }, watch: Set<string>): BoardRow {
  const p = entry.row;
  const v = entry.price as {
    implied: number; category: string; peers: number; multiple: number;
    growth_pct: number; growth_multiplier: number; maturity_multiplier: number; breadth_multiplier: number; age_days: number | null;
    quality: string; group: string; shrink: { w: number; capped: boolean };
  };
  return {
    rank: entry.rank,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    mcap_usd: p.mcap_usd,
    listed_at: p.listed_at,
    gecko_id: p.gecko_id,
    symbol: p.symbol,
    token_status: 'pre-token' as const,
    watchlist: watch.has(p.slug),
    age_days: v.age_days,
    implied_value_usd: v.implied,
    model: {
      category: v.category,
      peer_count: v.peers,
      category_multiple: round4(v.multiple),
      growth_pct: v.growth_pct,
      growth_multiplier: round4(v.growth_multiplier),
      maturity_multiplier: round4(v.maturity_multiplier),
      breadth_multiplier: round4(v.breadth_multiplier),
      age_days: v.age_days,
      quality: v.quality,
      shrink_w: round4(v.shrink.w),
      group: v.group,
      capped: v.shrink.capped,
    },
    farm_steps: farmSteps(p, v.age_days),
  };
}

/**
 * The board: every subject of the screen, priced by the core's one function, ranked by implied
 * value (ties by TVL, then slug, so two runs of the program write the same board byte for byte).
 */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const result = core.runModel(snapshot.protocols, { as_of: snapshot.as_of, watchlist: snapshot.watchlist, params: core.PARAMS });
  const watch = new Set(snapshot.watchlist);
  return result.board.map((entry: never) => toBoardRow(entry, watch));
}

/** The live-token protocols, by market cap: the market's own values, kept apart from the ranking. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !recordsNoToken(p))
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || bySlugAsc(a.slug, b.slug))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      symbol: p.symbol,
    }));
}

/** Everything the dashboard needs: the board, the live set, the peer table and the model it runs. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData; result: unknown } {
  const result = core.runModel(snapshot.protocols, { as_of: snapshot.as_of, watchlist: snapshot.watchlist, params: core.PARAMS });
  const table = result.peerTable;
  const watch = new Set(snapshot.watchlist);
  const board: BoardRow[] = result.board.map((entry: never) => toBoardRow(entry, watch));
  const liveAll = snapshot.protocols.filter((p) => !recordsNoToken(p));
  const subjectCount = new Map<string, number>();
  for (const r of board) subjectCount.set(r.model.category, (subjectCount.get(r.model.category) ?? 0) + 1);
  const categories: CategoryLine[] = [...subjectCount.entries()]
    .map(([category, subjects]) => {
      const price = core.multipleFor(table, category);
      return { category, peers: price.peers, median_raw: price.median_raw === null ? null : round4(price.median_raw), multiple: round4(price.multiple), subjects };
    })
    .sort((a, b) => b.subjects - a.subjects || bySlugAsc(a.category, b.category));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: MODEL,
    model_version: MODEL_VERSION,
    global_median: round4(table.global_median),
    peer_count: table.peer_count,
    protocol_count: snapshot.protocols.length,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.watchlist).length,
    live_count: liveAll.length,
    live_size: Math.min(LIVE_ROWS, liveAll.length),
    categories,
    rows: board,
    live: liveRows(snapshot),
  };
  return { board, radar, result };
}

/**
 * Why a board is not one the gate will take, or null. Mirrors the gate's board rows: coverage,
 * ranks 1..N once each, implied value never rising with rank, not one shared value, row bounds
 * and farm-step bounds.
 */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100 to 4000`;
  const slugs = new Set<string>();
  for (const r of board) {
    if (slugs.has(r.slug)) return `slug ${r.slug} appears twice`;
    slugs.add(r.slug);
  }
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) if (!known.has(r.slug)) return `slug ${r.slug} is not in the snapshot`;
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) {
    if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `rank ${byRank[i]!.rank} outvalues rank ${byRank[i - 1]!.rank}`;
  }
  if (board.length >= 2 && byRank[0]!.implied_value_usd === byRank[byRank.length - 1]!.implied_value_usd) {
    return 'every row shares one implied value: a board that ranks nothing by value is not a ranking';
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters once trimmed`;
    }
  }
  return null;
}

/** The dashboard's raw block: every protocol's ten fields, columnar, with category and chain dictionary-encoded. */
export interface RawData {
  cols: string[];
  dict: { category: string[]; chain: string[] };
  rows: unknown[][];
  source: { file: string; sha256: string; taken_at: string };
}

/**
 * The snapshot's records as the browser's model input: exactly the core's INPUT_FIELDS, in the
 * snapshot's order, at the snapshot's own precision. Only the fields the core reads are carried.
 */
export function buildRaw(snapshot: Snapshot, snapshotSha: string): RawData {
  const cols: string[] = core.INPUT_FIELDS;
  const catDict: string[] = [];
  const chainDict: string[] = [];
  const catIndex = new Map<string, number>();
  const chainIndex = new Map<string, number>();
  const intern = (dict: string[], index: Map<string, number>, value: string): number => {
    let at = index.get(value);
    if (at === undefined) {
      at = dict.length;
      dict.push(value);
      index.set(value, at);
    }
    return at;
  };
  const rows = snapshot.protocols.map((p) => {
    const record: Record<string, unknown> = { ...p };
    for (const field of cols) {
      if (!(field in record)) throw new SnapshotError(`protocol ${p.slug} lacks the model input field ${field}`);
    }
    return [
      p.slug,
      p.name,
      p.category === null ? -1 : intern(catDict, catIndex, p.category),
      p.chains.map((c) => intern(chainDict, chainIndex, c)),
      p.tvl_usd,
      p.change_7d,
      p.mcap_usd,
      p.listed_at,
      p.gecko_id,
      p.symbol,
    ];
  });
  return { cols, dict: { category: catDict, chain: chainDict }, rows, source: { file: 'snapshot.json', sha256: snapshotSha, taken_at: snapshot.as_of } };
}

/**
 * The dashboard's data.js: the model's two hashes, the raw records the browser re-prices from,
 * the server's board (kept as the self-check's reference) and the live set. No fetch, no network.
 */
export function dataScript(
  snapshot: Snapshot,
  board: BoardRow[],
  live: LiveRow[],
  result: { stats: Record<string, number> },
  modelSha: string,
  snapshotSha: string,
  raw: RawData,
): string {
  const data = {
    meta: {
      as_of: snapshot.as_of,
      source: snapshot.source,
      floor_usd: snapshot.floor_usd,
      model: MODEL,
      model_version: MODEL_VERSION,
      model_sha: modelSha,
      snapshot_sha: snapshotSha,
      watchlist: snapshot.watchlist,
      stats: result.stats,
    },
    raw,
    board,
    live,
  };
  return `window.RADAR=${JSON.stringify(data)};\n`;
}
