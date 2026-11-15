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

  var MODEL_VERSION = 'peer-median-2';

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

  /** The true median of a non-empty list of numbers: the middle value, or the mean of the two middle values. */
  function median(values) {
    var s = values.slice().sort(function (a, b) { return a - b; });
    if (s.length === 0) throw new Error('median of an empty list');
    var mid = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  /**
   * Category groups: the middle layer of the shrinkage. A thin category borrows strength first
   * from the group of like categories, and only then from the global median, so a one-peer
   * category is pulled toward its kin before it is pulled toward the whole market. Every
   * category in the sealed snapshot is mapped; buildPeerTable reports any it cannot place.
   */
  var CATEGORY_GROUPS = {
    'Lending': 'Credit & Yield', 'Risk Curators': 'Credit & Yield', 'Yield': 'Credit & Yield',
    'Yield Aggregator': 'Credit & Yield', 'CDP': 'Credit & Yield', 'CDP Manager': 'Credit & Yield',
    'Basis Trading': 'Credit & Yield', 'Uncollateralized Lending': 'Credit & Yield',
    'Leveraged Farming': 'Credit & Yield', 'Farm': 'Credit & Yield',
    'Onchain Capital Allocator': 'Credit & Yield', 'Collateral Management': 'Credit & Yield',
    'Collateral Markets': 'Credit & Yield', 'Interest Rate Derivatives': 'Credit & Yield',
    'Indexes': 'Credit & Yield', 'CeDeFi': 'Credit & Yield',
    'Dexs': 'Trading & Markets', 'CEX': 'Trading & Markets', 'Derivatives': 'Trading & Markets',
    'Options': 'Trading & Markets', 'Options Vault': 'Trading & Markets', 'Synthetics': 'Trading & Markets',
    'Prediction Market': 'Trading & Markets', 'Liquidity Manager': 'Trading & Markets',
    'NFT Marketplace': 'Trading & Markets', 'OTC Marketplace': 'Trading & Markets', 'Launchpad': 'Trading & Markets',
    'Liquid Staking': 'Staking & Restaking', 'Liquid Restaking': 'Staking & Restaking',
    'Restaking': 'Staking & Restaking', 'Staking Pool': 'Staking & Restaking',
    'Anchor BTC': 'Bitcoin', 'Decentralized BTC': 'Bitcoin', 'Restaked BTC': 'Bitcoin',
    'Stablecoin Issuer': 'Money, Payments & Stablecoins', 'Stablecoin Wrapper': 'Money, Payments & Stablecoins',
    'Algo-Stables': 'Money, Payments & Stablecoins', 'Dual-Token Stablecoin': 'Money, Payments & Stablecoins',
    'Reserve Currency': 'Money, Payments & Stablecoins', 'Payments': 'Money, Payments & Stablecoins',
    'Crypto Card Issuer': 'Money, Payments & Stablecoins',
    'Bridge': 'Bridges & Chains', 'Canonical Bridge': 'Bridges & Chains',
    'Cross Chain Bridge': 'Bridges & Chains', 'Chain': 'Bridges & Chains',
    'RWA': 'Real-World Assets',
    'AI Agents': 'Data, AI & Other', 'Decentralized AI': 'Data, AI & Other', 'Privacy': 'Data, AI & Other',
    'Insurance': 'Data, AI & Other', 'Governance Incentives': 'Data, AI & Other',
    'Token Locker': 'Data, AI & Other', 'DOR': 'Data, AI & Other', 'Uncategorized': 'Data, AI & Other',
  };

  /** The group a category shrinks through; an unmapped category is its own group. */
  function groupOf(category) {
    return CATEGORY_GROUPS[category] || category;
  }

  /** How much evidence stands behind a category multiple, in words the board can print. */
  function qualityFor(n) {
    if (n >= 5) return 'solid';
    if (n >= 3) return 'thin';
    if (n >= 1) return 'very-thin';
    return 'borrowed';
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
    var unmapped = [];
    rows.forEach(function (p) {
      var key = categoryOf(p);
      if (!(key in CATEGORY_GROUPS) && unmapped.indexOf(key) < 0) unmapped.push(key);
      if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) return;
      var raw = p.mcap_usd / p.tvl_usd;
      var r = winsorizeValue(raw, params);
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
    // The group layer: each group's own median, itself shrunk toward the global median in log
    // space with the same K, plus the group's 75th percentile, which caps what any one of its
    // categories may price at (1.5x) no matter how extreme its own handful of peers looks.
    var groupRatios = {};
    var groupOrder = [];
    order.forEach(function (category) {
      var g = groupOf(category);
      if (!groupRatios[g]) { groupRatios[g] = []; groupOrder.push(g); }
      groupRatios[g] = groupRatios[g].concat(ratios[category]);
    });
    var groups = {};
    groupOrder.forEach(function (g) {
      var list = groupRatios[g];
      var med = median(list);
      var w = list.length / (list.length + params.shrink_k);
      var sorted = list.slice().sort(function (a, b) { return a - b; });
      groups[g] = {
        name: g,
        peers: list.length,
        median: med,
        p75: quantile(sorted, 0.75),
        m: Math.exp(w * Math.log(med) + (1 - w) * Math.log(globalMedian)),
        w: w,
      };
    });
    var table = {
      global_median: globalMedian,
      peer_count: all.length,
      all_ratios: all,
      by_category: byCategory,
      groups: groups,
      unmapped_categories: unmapped,
      params: params,
    };
    order.forEach(function (category) {
      var s = shrinkMultiple(byCategory[category], table, params, category);
      byCategory[category].multiple = s.m;
      byCategory[category].shrink = s;
      byCategory[category].group = s.group;
      byCategory[category].quality = s.quality;
    });
    return table;
  }

  /**
   * The multiple a category prices at, shrunk in log space through two layers: first the
   * category group toward the global peer median (weight n_g / (n_g + K)), then the category
   * toward its group (weight n / (n + K_eff)); below k_thin_base peers the pull strengthens,
   * K_eff = K x (k_thin_base / n), so a one-peer category keeps only a sliver of its own
   * median. The result is capped at 1.5x the group's 75th percentile. A category with no
   * trading peers borrows its group's multiple outright.
   * Returns { m, w, parent, parent_m, n, median, group, group_n, group_median, group_w,
   *           k_eff, capped, quality }.
   */
  function shrinkMultiple(catEntry, table, params, category) {
    var cat = category || (catEntry && catEntry.category);
    var gname = groupOf(cat);
    var g = table.groups[gname] || null;
    var groupM = g ? g.m : table.global_median;
    var n = catEntry ? catEntry.peers : 0;
    if (!catEntry || n === 0) {
      return {
        m: groupM, w: 0, parent: 'group', parent_m: groupM, n: 0, median: null,
        group: gname, group_n: g ? g.peers : 0, group_median: g ? g.median : null,
        group_w: g ? g.w : 0, k_eff: params.shrink_k, capped: false, quality: qualityFor(0),
      };
    }
    var kEff = n >= params.k_thin_base ? params.shrink_k : params.shrink_k * (params.k_thin_base / n);
    var w = params.force_group ? 0 : n / (n + kEff);
    var m = Math.exp(w * Math.log(catEntry.median) + (1 - w) * Math.log(groupM));
    var capped = false;
    if (g && m > g.p75 * 1.5) { m = g.p75 * 1.5; capped = true; }
    return {
      m: m, w: w, parent: 'group', parent_m: groupM, n: n, median: catEntry.median,
      group: gname, group_n: g ? g.peers : 0, group_median: g ? g.median : null,
      group_w: g ? g.w : 0, k_eff: kEff, capped: capped, quality: qualityFor(n),
    };
  }

  /** The multiple entry a category prices from: its peer entry, or a peerless one at its group's multiple. */
  function multipleFor(table, category) {
    var entry = table.by_category[category];
    if (entry) return entry;
    var s = shrinkMultiple(null, table, table.params || PARAMS, category);
    return {
      category: category, peers: 0, median: null, median_raw: null, multiple: s.m,
      ratios: [], ratios_raw: [], peer_ids: [], shrink: s, group: s.group, quality: s.quality,
    };
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
    var shrink = shrinkMultiple(table.by_category[category] || null, table, params, category);
    var f = factors(p, asOf, params);
    var implied = Math.max(1, Math.round(p.tvl_usd * entry.multiple * f.growth_multiplier * f.maturity_multiplier * f.breadth_multiplier));
    var multipleFormula = shrink.n === 0
      ? 'no trading peers in ' + category + ': borrows the ' + shrink.group + ' group multiple ' + shrink.parent_m.toFixed(4) + ' outright'
      : 'log-shrunk peer median of ' + category + ': category weight ' + shrink.w.toFixed(3) + ' on its own median, the rest on the ' +
        shrink.group + ' group (group weight ' + shrink.group_w.toFixed(3) + ' toward the global median)' + (shrink.capped ? '; capped at 1.5x the group 75th percentile' : '');
    var chain = [
      { label: 'TVL', value: p.tvl_usd, formula: 'snapshot field tvl_usd', refs: [p.slug] },
      { label: 'Category multiple', value: entry.multiple, formula: multipleFormula, refs: entry.peer_ids.slice() },
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
      quality: shrink.quality,
      group: shrink.group,
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
    var thinCats = {};
    priced.forEach(function (entry) { if (entry.price.shrink.n < 5) thinCats[entry.price.category] = 1; });
    var stats = {
      protocolCount: rows.length,
      tokenedPeerCount: table.peer_count,
      boardCount: priced.length,
      tokenedCount: tokened.length,
      watchlistSize: (opts.watchlist || []).length,
      globalMedian: table.global_median,
      catCount: catCount,
      maxPeerRatioRaw: maxPeerRatioRaw,
      thinCatCount: Object.keys(thinCats).length,
      thinRowCount: priced.filter(function (entry) { return entry.price.shrink.n < 5; }).length,
      unmappedCatCount: table.unmapped_categories.length,
    };
    var sensitivity = opts.sensitivityTopN ? computeSensitivity(rows, opts, priced) : null;
    return { board: priced, tokened: tokened, peerTable: table, stats: stats, sensitivity: sensitivity };
  }
  /**
   * Sensitivity of the board's head: re-price the top rows under five settings that stress the
   * shrinkage — K=3, K=12, group-only pricing (w_c = 0), leave-one-out over each row's own
   * category peers, and no winsorize — and report, per row, the implied range, the rank range
   * and in how many of the five settings the row still ranks in the top three. Ranks under
   * leave-one-out are the worst rank across that category's removals.
   */
  function computeSensitivity(rows, opts, board) {
    var params = opts.params || PARAMS;
    var top = board.slice(0, opts.sensitivityTopN || 10);
    var settings = [
      { key: 'k3', params: Object.assign({}, params, { shrink_k: 3 }) },
      { key: 'k12', params: Object.assign({}, params, { shrink_k: 12 }) },
      { key: 'group-only', params: Object.assign({}, params, { force_group: true }) },
      { key: 'no-winsorize', params: Object.assign({}, params, { winsor_lo: 0, winsor_hi: Infinity }) },
    ];
    var runs = {};
    settings.forEach(function (s) {
      var run = runModel(rows, { as_of: opts.as_of, watchlist: opts.watchlist, params: s.params });
      var bySlug = {};
      run.board.forEach(function (e) { bySlug[e.row.slug] = e; });
      runs[s.key] = bySlug;
    });
    return top.map(function (entry) {
      var slug = entry.row.slug;
      var values = [entry.price.implied];
      var ranks = [entry.rank];
      var top3 = 0;
      settings.forEach(function (s) {
        var e = runs[s.key][slug];
        if (!e) return;
        values.push(e.price.implied);
        ranks.push(e.rank);
        if (e.rank <= 3) top3++;
      });
      // leave-one-out over the row's category peers: remove one peer at a time, rebuild the
      // table, re-price every subject, and take the row's worst rank and value range.
      var table = buildPeerTable(rows, params);
      var catEntry = table.by_category[entry.price.category];
      if (catEntry && catEntry.peer_ids.length > 0) {
        var worstRank = 0;
        catEntry.peer_ids.forEach(function (peerSlug) {
          var reduced = rows.filter(function (r) { return r.slug !== peerSlug; });
          var t2 = buildPeerTable(reduced, params);
          var subjects = reduced.filter(isSubject);
          var priced = subjects.map(function (p) { return { row: p, price: priceRow(p, opts.as_of, t2, params) }; });
          priced.sort(function (a, b) { return b.price.implied - a.price.implied || b.row.tvl_usd - a.row.tvl_usd || bySlugAsc(a.row.slug, b.row.slug); });
          priced.forEach(function (e2, i) {
            if (e2.row.slug === slug) {
              values.push(e2.price.implied);
              if (i + 1 > worstRank) worstRank = i + 1;
            }
          });
        });
        if (worstRank > 0) { ranks.push(worstRank); if (worstRank <= 3) top3++; }
      }
      return {
        slug: slug,
        impliedMin: Math.min.apply(null, values),
        impliedMax: Math.max.apply(null, values),
        rankMin: Math.min.apply(null, ranks),
        rankMax: Math.max.apply(null, ranks),
        top3Share: top3,
        settings: 5,
      };
    });
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
    CATEGORY_GROUPS: CATEGORY_GROUPS,
    groupOf: groupOf,
    qualityFor: qualityFor,
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
    computeSensitivity: computeSensitivity,
    selfCheck: selfCheck,
  };
});
