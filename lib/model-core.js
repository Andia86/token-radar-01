// model-core.js — the token radar's pricing model, as one pure-function file.
//
// This file is the ONLY implementation of the model. The server (lib/model.ts) requires it to
// build board.json; the dashboard ships a byte-for-byte copy as dashboard/model.js and re-prices
// every row in the browser from the snapshot's own fields; the dossier shows this source. It
// reads no files, touches no DOM, uses no randomness and no clock: same rows in, same board out.
//
//   implied = TVL x M(category) x G(growth) x A(maturity) x B(breadth)
//
// M is the market's price for a dollar of that category's TVL: the median market-cap/TVL ratio
// of the snapshot's trading peers in the category, each peer ratio first winsorized (clamped)
// to [winsor_lo, winsor_hi], the category median then shrunk toward its parent (its category
// group, then the global peer median) in log space, in proportion to how few peers stand behind
// it. G counts the clamped seven-day TVL change at half weight. A runs from maturity_floor to
// maturity_floor + maturity_range over maturity_days on record. B adds breadth_per_chain for
// each chain past the first, up to breadth_max_extra. No protocol is named anywhere in this
// file: one function prices every row, and every input is one of the snapshot's ten fields.
(function (global, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  global.ModelCore = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /** The snapshot's ten fields, in order. data.js raw rows carry exactly these, nothing else. */
  var INPUT_FIELDS = ['slug', 'name', 'category', 'chains', 'tvl_usd', 'change_7d', 'mcap_usd', 'listed_at', 'gecko_id', 'symbol'];

  /** Every model constant, in this one place: the server, the page and the dossier all read these. */
  var PARAMS = {
    winsor_lo: 0.02,
    winsor_hi: 4,
    shrink_k: 6,
    k_thin_base: 3,
    growth_weight: 0.5,
    growth_floor: -60,
    growth_cap: 120,
    maturity_floor: 0.6,
    maturity_range: 0.4,
    maturity_days: 1095,
    unknown_age_days: 365,
    breadth_per_chain: 0.03,
    breadth_max_extra: 8,
    floor_tvl: 50000000,
  };

  var MODEL_VERSION = 'peer-median-1';

  var DAY_MS = 86400000;
  var bySlugAsc = function (a, b) { return a < b ? -1 : a > b ? 1 : 0; };

  /** A whole day count from listedAt to asOf, clamped at zero; null when either date is absent or bad. */
  function ageDays(asOf, listedAt) {
    if (listedAt === null || listedAt === undefined) return null;
    var a = Date.parse(asOf + 'T00:00:00Z');
    var b = Date.parse(listedAt + 'T00:00:00Z');
    if (!isFinite(a) || !isFinite(b)) return null;
    return Math.max(0, Math.floor((a - b) / DAY_MS));
  }

  /** Whether the record records no token at all. */
  function recordsNoToken(p) {
    return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
  }

  /** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
  var VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
  /** Categories that are a wrapped, staked or bridged product of a token that trades, or an exchange. */
  var PRODUCT_CATEGORIES = { 'Bridge': 1, 'Canonical Bridge': 1, 'Liquid Staking': 1, 'Liquid Restaking': 1, 'Restaked BTC': 1, 'CEX': 1 };
  /** A whole word in a name that marks a wrapped or staked product. */
  var PRODUCT_WORD = /\b(wrapped|staked|staking)\b/i;
  /** Names that begin with an exchange's name. */
  var EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)/;

  /**
   * Whether a protocol is a radar subject: it records no token and is not a product of one that
   * trades. The watchlist's rule, run on the whole snapshot.
   */
  function isSubject(p) {
    return (
      recordsNoToken(p) &&
      !PRODUCT_CATEGORIES[p.category || ''] &&
      !VERSIONED.test(p.name) &&
      !PRODUCT_WORD.test(p.name) &&
      !EXCHANGE_PREFIX.test(p.name)
    );
  }

  /** The category key two protocols share. */
  function categoryOf(p) {
    return p.category === null || p.category === undefined ? 'Uncategorized' : p.category;
  }

  /** The middle value of a non-empty list of numbers (legacy definition: the upper of the two middle values). */
  function median(values) {
    var s = values.slice().sort(function (a, b) { return a - b; });
    if (s.length === 0) throw new Error('median of an empty list');
    return s[Math.floor(s.length / 2)];
  }

  /** The p-quantile of an ascending-sorted list, linear interpolation (R type 7). */
  function quantile(sorted, p) {
    var n = sorted.length;
    if (n === 0) throw new Error('quantile of an empty list');
    if (n === 1) return sorted[0];
    var h = (n - 1) * p;
    var lo = Math.floor(h);
    var hi = Math.ceil(h);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
  }

  /** One ratio clamped to the winsor band. */
  function winsorizeValue(x, params) {
    return Math.min(params.winsor_hi, Math.max(params.winsor_lo, x));
  }

  /** Every ratio of a list clamped to the winsor band, order kept. */
  function winsorize(xs, params) {
    return xs.map(function (x) { return winsorizeValue(x, params); });
  }

  /**
   * The peer table, from the records alone: a peer is a protocol that records a token with a
   * market cap and a TVL; its ratio is market cap over TVL, winsorized before any median.
   * Returns { global_median, peer_count, by_category } with by_category a plain object whose
   * keys are in first-seen order; each entry keeps the raw and winsorized ratios and peer ids.
   */
  function buildPeerTable(rows, params) {
    var ratios = {};
    var rawRatios = {};
    var peerIds = {};
    var order = [];
    var all = [];
    rows.forEach(function (p) {
      if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) return;
      var raw = p.mcap_usd / p.tvl_usd;
      var r = winsorizeValue(raw, params);
      var key = categoryOf(p);
      if (!ratios[key]) { ratios[key] = []; rawRatios[key] = []; peerIds[key] = []; order.push(key); }
      ratios[key].push(r);
      rawRatios[key].push(raw);
      peerIds[key].push(p.slug);
      all.push(r);
    });
    var globalMedian = median(all);
    var byCategory = {};
    order.forEach(function (category) {
      var list = ratios[category];
      byCategory[category] = {
        category: category,
        peers: list.length,
        median: median(list),
        median_raw: median(rawRatios[category]),
        multiple: 0,
        ratios: list,
        ratios_raw: rawRatios[category],
        peer_ids: peerIds[category],
      };
    });
    var table = { global_median: globalMedian, peer_count: all.length, all_ratios: all, by_category: byCategory };
    order.forEach(function (category) {
      byCategory[category].multiple = shrinkMultiple(byCategory[category], table, params).m;
    });
    return table;
  }

  /**
   * The multiple a category prices at, shrunk toward the global peer median in proportion to
   * how few peers it has: M = (n x median + K x global) / (n + K); a category with no trading
   * peers prices at the global median. Returns { m, w, parent, parent_m, n, median }.
   */
  function shrinkMultiple(catEntry, table, params) {
    var n = catEntry ? catEntry.peers : 0;
    if (!catEntry || n === 0) {
      return { m: table.global_median, w: 0, parent: 'global', parent_m: table.global_median, n: 0, median: null };
    }
    var m = (n * catEntry.median + params.shrink_k * table.global_median) / (n + params.shrink_k);
    return { m: m, w: n / (n + params.shrink_k), parent: 'global', parent_m: table.global_median, n: n, median: catEntry.median };
  }

  /** The multiple entry a category prices from: its peer entry, or a peerless one at the global median. */
  function multipleFor(table, category) {
    var entry = table.by_category[category];
    if (entry) return entry;
    return { category: category, peers: 0, median: null, median_raw: null, multiple: table.global_median, ratios: [], ratios_raw: [], peer_ids: [] };
  }

  /** The model's three adjustments for one record, each with the input it came from. */
  function factors(p, asOf, params) {
    var age = ageDays(asOf, p.listed_at);
    var rawGrowth = typeof p.change_7d === 'number' && isFinite(p.change_7d) ? p.change_7d : 0;
    var growthPct = Math.min(params.growth_cap, Math.max(params.growth_floor, rawGrowth));
    var growthMult = 1 + (growthPct / 100) * params.growth_weight;
    var ageForModel = age === null ? params.unknown_age_days : age;
    var maturityMult = params.maturity_floor + (Math.min(Math.max(ageForModel, 0), params.maturity_days) / params.maturity_days) * params.maturity_range;
    var extraChains = Math.min(Math.max(p.chains.length - 1, 0), params.breadth_max_extra);
    var breadthMult = 1 + params.breadth_per_chain * extraChains;
    return {
      growth_pct: growthPct,
      growth_multiplier: growthMult,
      maturity_multiplier: maturityMult,
      breadth_multiplier: breadthMult,
      age_days: age,
    };
  }

  /**
   * Price one record under the model: the implied value and the whole chain that produced it.
   * Step = { label, value, formula, refs }: the dashboard prints the chain and computes nothing.
   */
  function priceRow(p, asOf, table, params) {
    var category = categoryOf(p);
    var entry = multipleFor(table, category);
    var shrink = shrinkMultiple(table.by_category[category] || null, table, params);
    var f = factors(p, asOf, params);
    var implied = Math.max(1, Math.round(p.tvl_usd * entry.multiple * f.growth_multiplier * f.maturity_multiplier * f.breadth_multiplier));
    var chain = [
      { label: 'TVL', value: p.tvl_usd, formula: 'snapshot field tvl_usd', refs: [p.slug] },
      { label: 'Category multiple', value: entry.multiple, formula: 'shrunk peer median of ' + category, refs: entry.peer_ids.slice() },
      { label: 'Growth factor', value: f.growth_multiplier, formula: '1 + clamp(change_7d, ' + params.growth_floor + ', +' + params.growth_cap + ') x ' + params.growth_weight, refs: [] },
      { label: 'Maturity factor', value: f.maturity_multiplier, formula: params.maturity_floor + ' + ' + params.maturity_range + ' x min(age, ' + params.maturity_days + 'd) / ' + params.maturity_days + 'd', refs: [] },
      { label: 'Breadth factor', value: f.breadth_multiplier, formula: '1 + ' + params.breadth_per_chain + ' x extra chains (max ' + params.breadth_max_extra + ')', refs: [] },
      { label: 'Implied value', value: implied, formula: 'TVL x multiple x growth x maturity x breadth, rounded', refs: [] },
    ];
    return {
      implied: implied,
      category: category,
      peers: entry.peers,
      multiple: entry.multiple,
      shrink: shrink,
      growth_pct: f.growth_pct,
      growth_multiplier: f.growth_multiplier,
      maturity_multiplier: f.maturity_multiplier,
      breadth_multiplier: f.breadth_multiplier,
      age_days: f.age_days,
      chain: chain,
    };
  }

  /**
   * Run the whole model over the snapshot's records. opts: { as_of, watchlist (array of slugs),
   * params }. Returns { board, tokened, peerTable, stats, sensitivity }:
   * - board: the ranked pre-token subjects, each { row, price, rank } (price is priceRow's result);
   * - tokened: the protocols that record a token, priced the same way as a control group, each
   *   { row, price }, by market cap;
   * - stats: every count the page and the README state, from this run and no other source.
   */
  function runModel(rows, opts) {
    var params = opts.params || PARAMS;
    var asOf = opts.as_of;
    var table = buildPeerTable(rows, params);
    var subjects = rows.filter(isSubject);
    var priced = subjects.map(function (p) { return { row: p, price: priceRow(p, asOf, table, params) }; });
    priced.sort(function (a, b) {
      return b.price.implied - a.price.implied || b.row.tvl_usd - a.row.tvl_usd || bySlugAsc(a.row.slug, b.row.slug);
    });
    priced.forEach(function (entry, i) { entry.rank = i + 1; });
    var tokened = rows
      .filter(function (p) { return !recordsNoToken(p); })
      .map(function (p) { return { row: p, price: priceRow(p, asOf, table, params) }; });
    tokened.sort(function (a, b) {
      return (b.row.mcap_usd || 0) - (a.row.mcap_usd || 0) || b.row.tvl_usd - a.row.tvl_usd || bySlugAsc(a.row.slug, b.row.slug);
    });
    var catCount = 0;
    var maxPeerRatioRaw = null;
    for (var k in table.by_category) {
      catCount++;
      var raws = table.by_category[k].ratios_raw;
      for (var i = 0; i < raws.length; i++) {
        if (maxPeerRatioRaw === null || raws[i] > maxPeerRatioRaw) maxPeerRatioRaw = raws[i];
      }
    }
    var stats = {
      protocolCount: rows.length,
      tokenedPeerCount: table.peer_count,
      boardCount: priced.length,
      tokenedCount: tokened.length,
      watchlistSize: (opts.watchlist || []).length,
      globalMedian: table.global_median,
      catCount: catCount,
      maxPeerRatioRaw: maxPeerRatioRaw,
      thinCatCount: 0,
      thinRowCount: 0,
    };
    return { board: priced, tokened: tokened, peerTable: table, stats: stats, sensitivity: null };
  }

  /**
   * Compare a locally recomputed board against the server's rows: implied and multiple within a
   * relative error of 1e-9, rank and peer count exact. Rows are matched by slug.
   * Returns { ok, total, matched, mismatches: [{ slug, field, local, server }] }.
   */
  function selfCheck(local, server) {
    var bySlug = {};
    server.forEach(function (r) { bySlug[r.slug] = r; });
    var mismatches = [];
    var matched = 0;
    local.forEach(function (entry) {
      var s = bySlug[entry.row.slug];
      if (!s) {
        mismatches.push({ slug: entry.row.slug, field: 'presence', local: 'present', server: 'missing' });
        return;
      }
      var rowBad = false;
      function rel(field, a, b) {
        var err = Math.abs(a - b) / Math.max(Math.abs(b), 1);
        if (err > 1e-9) { mismatches.push({ slug: entry.row.slug, field: field, local: a, server: b }); rowBad = true; }
      }
      function exact(field, a, b) {
        if (a !== b) { mismatches.push({ slug: entry.row.slug, field: field, local: a, server: b }); rowBad = true; }
      }
      rel('implied', entry.price.implied, s.implied_value_usd);
      exact('rank', entry.rank, s.rank);
      exact('peers', entry.price.peers, s.model.peer_count);
      // The server publishes multiples rounded to four decimals; the check reproduces the
      // published figure from the local full-precision one, so a real divergence still shows.
      rel('multiple', Math.round(entry.price.multiple * 1e4) / 1e4, s.model.category_multiple);
      if (!rowBad) matched++;
    });
    if (server.length !== local.length) {
      mismatches.push({ slug: '(board)', field: 'length', local: local.length, server: server.length });
    }
    return { ok: mismatches.length === 0, total: local.length, matched: matched, mismatches: mismatches };
  }

  return {
    INPUT_FIELDS: INPUT_FIELDS,
    PARAMS: PARAMS,
    MODEL_VERSION: MODEL_VERSION,
    ageDays: ageDays,
    recordsNoToken: recordsNoToken,
    isSubject: isSubject,
    categoryOf: categoryOf,
    median: median,
    quantile: quantile,
    winsorize: winsorize,
    winsorizeValue: winsorizeValue,
    buildPeerTable: buildPeerTable,
    shrinkMultiple: shrinkMultiple,
    multipleFor: multipleFor,
    factors: factors,
    priceRow: priceRow,
    runModel: runModel,
    selfCheck: selfCheck,
  };
});
