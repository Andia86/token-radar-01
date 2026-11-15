// Token Radar dashboard: a working radar over window.RADAR (data.js, built by main.ts from the
// sealed snapshot). The page re-prices every row in the browser with model.js — the model's own
// source, byte for byte the file the server runs — from the snapshot's raw fields in data.js,
// then checks its board against the server's, line by line, and says so at the top of the page.
// Board, live-token and method views, a detail view per protocol, hash-routed so a screenshot
// and the page agree. No fetch, no network: everything renders from the data file.
(function () {
  'use strict';
  var RAW = window.RADAR || null;
  var root = document.getElementById('view');

  // ---------- the model, run here ----------
  // Decode the columnar raw block back into the snapshot's ten-field records.
  function decodeRaw(raw) {
    var cols = raw.cols;
    return raw.rows.map(function (r) {
      var p = {};
      cols.forEach(function (c, i) {
        var v = r[i];
        if (c === 'category') v = v < 0 ? null : raw.dict.category[v];
        if (c === 'chains') v = v.map(function (ix) { return raw.dict.chain[ix]; });
        p[c] = v;
      });
      return p;
    });
  }
  function round4(n) { return Math.round(n * 1e4) / 1e4; }

  var RESULT = null;   // the browser's own run of the model
  var PRICE = {};      // slug -> the browser's priceRow result (chain, shrink, factors)
  var CHECK = null;    // its self-check against the server's board
  var CHECK_ERROR = null;
  var DATA = null;     // the view-model the views render from (the browser's numbers)
  (function boot() {
    if (!RAW || !RAW.meta || !RAW.raw || !RAW.board) { CHECK_ERROR = 'data.js did not load'; return; }
    var meta = RAW.meta;
    var serverBySlug = {};
    RAW.board.forEach(function (r) { serverBySlug[r.slug] = r; });
    var fallback = {
      as_of: meta.as_of, source: meta.source, floor_usd: meta.floor_usd, model: meta.model,
      model_version: meta.model_version, global_median: meta.stats.globalMedian,
      peer_count: meta.stats.tokenedPeerCount, protocol_count: meta.stats.protocolCount,
      watchlist_size: meta.stats.watchlistSize, board_size: meta.stats.boardCount,
      early_size: RAW.board.filter(function (r) { return !r.watchlist; }).length,
      live_count: meta.stats.tokenedCount, live_size: RAW.live.length,
      categories: [], rows: RAW.board, live: RAW.live, model: meta.model,
      max_peer_ratio: meta.stats.maxPeerRatioRaw,
      sensitivity: RAW.sensitivity || null, src: RAW.src || {},
    };
    DATA = fallback;
    if (typeof window.ModelCore === 'undefined') { CHECK_ERROR = 'model.js did not load'; return; }
    try {
      var records = decodeRaw(RAW.raw);
      RESULT = window.ModelCore.runModel(records, { as_of: meta.as_of, watchlist: meta.watchlist, params: window.ModelCore.PARAMS, sensitivityTopN: 10 });
      RESULT.board.forEach(function (entry) { PRICE[entry.row.slug] = entry.price; });
      RESULT.tokened.forEach(function (entry) { if (!PRICE[entry.row.slug]) PRICE[entry.row.slug] = entry.price; });
      CHECK = window.ModelCore.selfCheck(RESULT.board, RAW.board);
      var localRows = RESULT.board.map(function (entry) {
        var s = serverBySlug[entry.row.slug];
        var v = entry.price;
        var row = Object.assign({}, s, {
          rank: entry.rank,
          age_days: v.age_days,
          implied_value_usd: v.implied,
          model: {
            category: v.category, peer_count: v.peers, category_multiple: round4(v.multiple),
            growth_pct: v.growth_pct, growth_multiplier: round4(v.growth_multiplier),
            maturity_multiplier: round4(v.maturity_multiplier), breadth_multiplier: round4(v.breadth_multiplier),
            age_days: v.age_days, quality: v.quality, shrink_w: round4(v.shrink.w), group: v.group, capped: v.shrink.capped,
          },
        });
        return row;
      });
      var subjectCount = {};
      localRows.forEach(function (r) { subjectCount[r.model.category] = (subjectCount[r.model.category] || 0) + 1; });
      var cats = Object.keys(subjectCount).map(function (category) {
        var price = window.ModelCore.multipleFor(RESULT.peerTable, category);
        return {
          category: category, peers: price.peers,
          median_raw: price.median_raw === null ? null : round4(price.median_raw),
          multiple: round4(price.multiple), subjects: subjectCount[category],
          group: price.group || window.ModelCore.groupOf(category),
          quality: price.quality || window.ModelCore.qualityFor(price.peers),
          w: price.shrink ? round4(price.shrink.w) : 0,
        };
      }).sort(function (a, b) { return b.subjects - a.subjects || (a.category < b.category ? -1 : 1); });
      DATA = Object.assign({}, fallback, {
        global_median: RESULT.stats.globalMedian, peer_count: RESULT.stats.tokenedPeerCount,
        protocol_count: RESULT.stats.protocolCount, watchlist_size: RESULT.stats.watchlistSize,
        board_size: RESULT.stats.boardCount,
        early_size: localRows.filter(function (r) { return !r.watchlist; }).length,
        live_count: RESULT.stats.tokenedCount, categories: cats, rows: localRows,
        max_peer_ratio: RESULT.stats.maxPeerRatioRaw,
        sensitivity: RESULT.sensitivity, src: RAW.src || {},
      });
    } catch (err) {
      CHECK_ERROR = 'the model failed to run here: ' + (err && err.message ? err.message : err);
      RESULT = null;
      CHECK = null;
    }
  })();

  // The self-check bar: green when the browser's board is the server's, amber with the differing
  // rows named when it is not, grey when the model could not run and the server's board is shown.
  function checkBar() {
    var meta = RAW.meta;
    var sha = 'model ' + meta.model_sha.slice(0, 12) + ' &middot; snapshot ' + meta.snapshot_sha.slice(0, 12);
    if (CHECK && CHECK.ok) {
      return '<div class="checkbar ok" role="status">Browser re-priced ' + CHECK.matched + '/' + CHECK.total +
        ' rows from the snapshot&rsquo;s raw fields &mdash; every value matches the server&rsquo;s board &middot; ' + sha + '</div>';
    }
    if (CHECK) {
      var bad = {};
      CHECK.mismatches.forEach(function (mm) { bad[mm.slug] = true; });
      var items = CHECK.mismatches.slice(0, 20).map(function (mm) {
        return '<li>' + esc(mm.slug) + ' &middot; ' + esc(mm.field) + ': here ' + esc(String(mm.local)) + ', server ' + esc(String(mm.server)) + '</li>';
      }).join('');
      return '<div class="checkbar warn" role="status">' + CHECK.mismatches.length + ' check difference' +
        (CHECK.mismatches.length === 1 ? '' : 's') + ' against the server&rsquo;s board &mdash; this page shows the browser&rsquo;s values, differing rows carry a &Delta; badge.' +
        '<details><summary>Show the differences</summary><ul>' + items + '</ul></details></div>';
    }
    return '<div class="checkbar off" role="status">The model could not re-run in this browser (' + esc(CHECK_ERROR || 'unknown error') +
      '), so this page shows the server&rsquo;s precomputed board &middot; ' + sha + '</div>';
  }
  function mismatchSlugs() {
    var bad = {};
    if (CHECK) CHECK.mismatches.forEach(function (mm) { bad[mm.slug] = true; });
    return bad;
  }


  // ---------- stated figures, from the one run ----------
  // Every number the method prose states is filled from this run's stats and the model's own
  // constants — the prose carries <span data-stat> placeholders, never literals, so a page can
  // never again quote a figure the model did not produce. scripts/lint-hardcode.mjs enforces it.
  function statValues() {
    var m = DATA.model || {};
    return {
      board_count: DATA.board_size,
      watchlist_size: DATA.watchlist_size,
      not_ranked: DATA.protocol_count - DATA.board_size,
      protocol_count: DATA.protocol_count,
      peer_count: DATA.peer_count,
      max_peer_ratio: DATA.max_peer_ratio === null || DATA.max_peer_ratio === undefined ? '—' : Math.round(DATA.max_peer_ratio),
      winsor_lo: m.winsor_lo,
      winsor_hi: m.winsor_hi,
      global_median: DATA.global_median.toFixed(3),
      growth_floor_abs: Math.abs(m.growth_floor),
      growth_cap: m.growth_cap,
      g_min: (1 + (m.growth_floor / 100) * m.growth_weight).toFixed(2),
      g_max: (1 + (m.growth_cap / 100) * m.growth_weight).toFixed(2),
      maturity_floor: Number(m.maturity_floor).toFixed(2),
      maturity_max: (m.maturity_floor + m.maturity_range).toFixed(2),
      b_max: (1 + m.breadth_per_chain * m.breadth_max_extra).toFixed(2),
    };
  }
  function fillStats() {
    if (!DATA) return;
    var values = statValues();
    document.querySelectorAll('[data-stat]').forEach(function (el) {
      var key = el.getAttribute('data-stat');
      if (Object.prototype.hasOwnProperty.call(values, key)) el.textContent = values[key];
    });
  }

  // ---------- membership & exclusion reasons ----------
  // A row's badges are computed from its record, never from which list it arrived on:
  // the floor badge appears only when the TVL is actually under the floor, and a board-only
  // row above the floor says why it is not on the watchlist instead of borrowing the floor's
  // label. (The old detail page stamped every non-watchlist row "below the $50M floor",
  // including one holding $2.7B.)
  function floorTvl() { return (window.ModelCore && window.ModelCore.PARAMS.floor_tvl) || DATA.floor_usd; }
  function floorLabel() { var f = floorTvl(); return f >= 1e9 ? '$' + (f / 1e9) + 'B' : '$' + (f / 1e6) + 'M'; }
  function membership(r) { return r.watchlist ? 'watchlist' : 'board-only'; }
  function exclusionReasons(r) {
    var reasons = [];
    if (r.tvl_usd < floorTvl()) {
      reasons.push('Below the ' + floorLabel() + ' floor the watchlist is drawn at — the board ranks it anyway, and flags it');
    } else if (!r.watchlist) {
      reasons.push('Not on the snapshot&rsquo;s ' + DATA.watchlist_size + '-protocol watchlist: that list is the snapshot&rsquo;s fixed house list, and this protocol passes the same screen the list is drawn from');
    }
    return reasons;
  }
  function boardTags(r) {
    var tag = r.watchlist
      ? '<span class="tag watch">WATCHLIST</span>'
      : '<span class="tag early">EARLY FIND</span>';
    if (r.tvl_usd < floorTvl()) {
      tag += ' <span class="tag floor" title="' + exclusionReasons(r)[0] + '">BELOW THE ' + floorLabel() + ' FLOOR</span>';
    } else if (!r.watchlist) {
      tag = '<span class="tag early" title="' + exclusionReasons(r)[0] + '">EARLY FIND</span>';
    }
    return tag;
  }

  // ---------- formatting ----------
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtUsd(n) {
    if (n === null || n === undefined) return '—';
    return '$' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function fmtShort(n) {
    if (n === null || n === undefined) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + n;
  }
  function fmtPct(n) {
    if (n === null || n === undefined) return '—';
    return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'date n/a';
    if (days < 90) return days + 'd';
    if (days < 730) return Math.round(days / 30.4) + ' mo';
    return (days / 365.25).toFixed(1) + ' yr';
  }
  function fmtMult(n) { return 'x' + n.toFixed(3); }
  function chainList(chains) {
    if (!chains || chains.length === 0) return '—';
    return chains.length <= 3 ? chains.join(', ') : chains.slice(0, 3).join(', ') + ' +' + (chains.length - 3);
  }

  // ---------- the plan basis, in the page's own words (lib/model.ts computes the plans;
  // these are the same tiers and holds, so the basis line and the steps cannot disagree) ----------
  function capitalForTvl(tvl) {
    if (tvl >= 5e9) return 250;
    if (tvl >= 1e9) return 150;
    if (tvl >= 1e8) return 100;
    if (tvl >= 2.5e7) return 75;
    return 50;
  }
  function holdDaysForAge(age) {
    if (age === null || age === undefined) return 45;
    if (age < 180) return 60;
    if (age < 365) return 45;
    if (age < 730) return 35;
    return 30;
  }
  var PLAYBOOKS = {
    'Lending': 'supply-and-borrow', 'Dexs': 'liquidity provision', 'Derivatives': 'margin and hedged flow',
    'Risk Curators': 'curated vaults', 'Onchain Capital Allocator': 'allocator vaults', 'RWA': 'tokenized yield',
    'Yield': 'yield position', 'Yield Aggregator': 'aggregated vaults', 'CDP': 'collateralized mint',
    'CDP Manager': 'managed CDP', 'Basis Trading': 'basis vault', 'Chain': 'native chain activity',
    'Prediction Market': 'market participation', 'Insurance': 'cover purchase', 'Cross Chain Bridge': 'bridge routes',
    'Restaking': 'restaking position', 'Staking Pool': 'pooled staking', 'Payments': 'payment flow',
    'Indexes': 'index position', 'Liquidity Manager': 'managed liquidity', 'Leveraged Farming': 'leveraged position',
    'CeDeFi': 'managed yield', 'Stablecoin Wrapper': 'stablecoin position', 'Collateral Markets': 'collateral supply'
  };

  // ---------- state & routing ----------
  // One state object; each tab keeps its own filter and sort, so switching tabs never loses
  // the other tab's place. The hash is a view of the state: navigation writes it, the
  // browser's back and forward buttons restore it, and typing in a search box replaces it
  // silently while only the table region re-renders.
  var state = {
    view: 'board',
    slug: '',
    board: { q: '', cat: 'all', chain: 'all', watch: false, band: 'all', sort: 'rank', dir: -1, hideThin: false },
    tokened: { q: '', cat: 'all', sort: 'mcap', dir: -1 },
  };
  function boardHash(st) {
    var p = new URLSearchParams();
    if (st.q) p.set('q', st.q);
    if (st.cat !== 'all') p.set('cat', st.cat);
    if (st.chain !== 'all') p.set('chain', st.chain);
    if (st.watch) p.set('watch', '1');
    if (st.band !== 'all') p.set('band', st.band);
    if (st.sort !== 'rank') p.set('sort', st.sort);
    if (st.dir === 1) p.set('dir', 'asc');
    if (st.hideThin) p.set('thin', '1');
    var s = p.toString();
    return '#/' + (s ? '?' + s : '');
  }
  function tokenedHash(st) {
    var p = new URLSearchParams();
    if (st.q) p.set('q', st.q);
    if (st.cat !== 'all') p.set('cat', st.cat);
    if (st.sort !== 'mcap') p.set('sort', st.sort);
    if (st.dir === 1) p.set('dir', 'asc');
    var s = p.toString();
    return '#/tokened' + (s ? '?' + s : '');
  }
  function parseHash() {
    var hash = window.location.hash.replace(/^#/, '');
    var qAt = hash.indexOf('?');
    var path = qAt >= 0 ? hash.slice(0, qAt) : hash;
    var params = new URLSearchParams(qAt >= 0 ? hash.slice(qAt + 1) : '');
    var parts = path.split('/').filter(function (s) { return s.length > 0; });
    var view = parts[0] === 'protocol' ? 'protocol' : parts[0] === 'tokened' ? 'tokened' : parts[0] === 'method' ? 'method' : 'board';
    state.view = view;
    state.slug = view === 'protocol' ? decodeURIComponent(parts[1] || '') : '';
    if (view === 'board') {
      state.board = {
        q: params.get('q') || '', cat: params.get('cat') || 'all', chain: params.get('chain') || 'all',
        watch: params.get('watch') === '1', band: params.get('band') || 'all',
        sort: params.get('sort') || 'rank', dir: params.get('dir') === 'asc' ? 1 : -1,
        hideThin: params.get('thin') === '1',
      };
    }
    if (view === 'tokened') {
      state.tokened = {
        q: params.get('q') || '', cat: params.get('cat') || 'all',
        sort: params.get('sort') || 'mcap', dir: params.get('dir') === 'asc' ? 1 : -1,
      };
    }
  }
  function goto(hash) { window.location.hash = hash; }

  // ---------- shared chrome ----------
  function masthead() {
    return '<div class="masthead">' +
      '<p class="kicker">Token launch radar &middot; sealed snapshot ' + esc(DATA.as_of) + '</p>' +
      '<h1>Pre-token protocols, ranked by implied value</h1>' +
      '<p class="lede">Every protocol in the snapshot that <strong>records no token</strong> and is not a wrapped, staked or ' +
      'bridged product of one that trades &mdash; the house watchlist and every other protocol that passes the same screen &mdash; ' +
      'priced by one model off its own record: TVL, seven-day growth, age, chains, and what the market pays for its category.</p>' +
      '</div>' +
      '<div class="stats">' +
      '<div class="stat"><div class="n"><em>' + DATA.board_size + '</em></div><div class="l">protocols ranked, all pre-token</div></div>' +
      '<div class="stat"><div class="n">' + DATA.watchlist_size + ' / ' + DATA.watchlist_size + '</div><div class="l">watchlist protocols covered</div></div>' +
      '<div class="stat"><div class="n">' + DATA.early_size + '</div><div class="l">early finds beyond the watchlist</div></div>' +
      '<div class="stat"><div class="n">' + DATA.live_count + '</div><div class="l">live-token protocols set aside, unranked</div></div>' +
      '</div>';
  }
  function tabs() {
    function tab(view, label, hash) {
      var on = state.view === view || (view === 'board' && state.view === 'protocol');
      return '<button type="button" class="tab" aria-pressed="' + on + '" data-go="' + hash + '">' + label + '</button>';
    }
    return '<div class="tabs">' +
      tab('board', 'Board', boardHash(state.board)) +
      tab('tokened', 'Tokened (control)', tokenedHash(state.tokened)) +
      tab('method', 'Method', '#/method') + '</div>';
  }
  function footer() {
    return '<footer>Source: ' + esc(DATA.source) + ' &middot; ' + DATA.protocol_count + ' protocols at a $' +
      (DATA.floor_usd / 1e6) + 'M floor &middot; model ' + esc(DATA.model_version) + ', priced from ' + DATA.peer_count +
      ' trading peers &middot; implied value is a conditional value at peer pricing, not a launch forecast.' +
      '<br>model sha256 ' + RAW.meta.model_sha + ' &middot; snapshot sha256 ' + RAW.meta.snapshot_sha + '</footer>';
  }
  function sortHead(st, key, label, numeric) {
    var active = st.sort === key || (key === 'value' && st.sort === 'rank');
    var aria = active ? (st.dir === 1 ? 'asc' : 'desc') : 'none';
    return '<th' + (numeric ? ' class="num"' : '') + '><button type="button" class="sort" data-sort="' + key + '" aria-sort="' + aria + '">' + label + '</button></th>';
  }

  // ---------- board (pre-token subjects) ----------
  function selectBoardRows(st) {
    var rows = DATA.rows.filter(function (r) {
      if (st.cat !== 'all' && (r.category || 'Uncategorized') !== st.cat) return false;
      if (st.chain !== 'all' && r.chains.indexOf(st.chain) < 0) return false;
      if (st.watch && !r.watchlist) return false;
      if (st.hideThin && r.model.peer_count < 3) return false;
      if (st.band === 'b1' && r.tvl_usd < 1e9) return false;
      if (st.band === 'b100' && (r.tvl_usd < 1e8 || r.tvl_usd >= 1e9)) return false;
      if (st.band === 'b25' && (r.tvl_usd < 2.5e7 || r.tvl_usd >= 1e8)) return false;
      if (st.band === 'bsmall' && r.tvl_usd >= 2.5e7) return false;
      if (st.q) {
        var q = st.q.toLowerCase();
        if (r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0 && (r.category || '').toLowerCase().indexOf(q) < 0) return false;
      }
      return true;
    });
    var key = { rank: 'implied_value_usd', value: 'implied_value_usd', tvl: 'tvl_usd', change: 'change_7d', age: 'age_days' }[st.sort] || 'implied_value_usd';
    rows.sort(function (a, b) {
      var av = st.sort === 'peers' ? a.model.peer_count : a[key];
      var bv = st.sort === 'peers' ? b.model.peer_count : b[key];
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (av !== bv) return (av - bv) * (st.sort === 'rank' ? -1 : st.dir);
      return a.rank - b.rank;
    });
    return rows;
  }
  function boardCountText(rows) {
    return 'Showing ' + rows.length + ' of ' + DATA.rows.length + ' ranked protocols · click a row for its value breakdown and farm plan';
  }
  function buildBoardTable(rows, st) {
    var bad = mismatchSlugs();
    var html = '<table><thead><tr>' +
      sortHead(st, 'rank', '#') + '<th>Protocol</th>' + sortHead(st, 'tvl', 'TVL', true) +
      sortHead(st, 'change', '7d', true) + sortHead(st, 'age', 'Age', true) + '<th class="hideable">Chains</th>' +
      sortHead(st, 'value', 'Implied value', true) + '<th class="num hideable">Multiple</th>' +
      sortHead(st, 'peers', 'Peers', true) +
      '</tr></thead><tbody>';
    rows.forEach(function (r) {
      var tag = boardTags(r);
      if (bad[r.slug]) tag += ' <span class="tag delta" title="This row differs from the server board">&Delta;</span>';
      html += '<tr data-slug="' + esc(r.slug) + '" tabindex="0">' +
        '<td class="rank"><button type="button" class="xtoggle" data-x="' + esc(r.slug) + '" aria-expanded="false" title="Show the check chain">&#9656;</button>' + r.rank + '</td>' +
        '<td class="who"><span class="name">' + esc(r.name) + '</span>' + tag + '<span class="sub">' + esc(r.category || 'Uncategorized') + '</span></td>' +
        '<td class="num">' + fmtShort(r.tvl_usd) + '</td>' +
        '<td class="num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg') + '">' + fmtPct(r.change_7d) + '</td>' +
        '<td class="num">' + fmtAge(r.age_days) + '</td>' +
        '<td class="hideable">' + esc(chainList(r.chains)) + '</td>' +
        '<td class="num value">' + fmtShort(r.implied_value_usd) + '</td>' +
        '<td class="num hideable">' + fmtMult(r.model.category_multiple) + '</td>' +
        '<td class="num"><span class="qdot q-' + r.model.quality + '" title="Peer evidence: ' + r.model.quality + ' (' + r.model.peer_count + ' trading peers, category weight ' + r.model.shrink_w + ')"></span>' + r.model.peer_count + '</td>' +
        '</tr>';
    });
    return html + '</tbody></table>';
  }
  // The check chain under a board row: the multiplication that produced the row's value,
  // computed by the model run itself — the page prints it, it does not recompute it.
  function fmtChainVal(step) {
    if (step.label === 'TVL' || step.label === 'Implied value') return fmtUsd(step.value);
    return 'x' + Number(step.value).toFixed(4);
  }
  function chainHtml(r) {
    var price = PRICE[r.slug];
    if (!price) {
      return '<div class="chainline">' + fmtShort(r.tvl_usd) + ' TVL &times; ' + r.model.category_multiple.toFixed(3) + ' multiple &times; ' +
        r.model.growth_multiplier.toFixed(3) + ' growth &times; ' + r.model.maturity_multiplier.toFixed(3) + ' maturity &times; ' +
        r.model.breadth_multiplier.toFixed(3) + ' breadth = ' + fmtShort(r.implied_value_usd) + ' (the step-by-step chain needs the model running in the browser)</div>';
    }
    var steps = price.chain.map(function (st) {
      return '<li><b>' + esc(st.label) + '</b> ' + fmtChainVal(st) + ' <span class="formula-note">' + esc(st.formula) + '</span></li>';
    }).join('');
    var product = price.chain.slice(0, 5).reduce(function (acc, st) { return acc * st.value; }, 1);
    var checks = Math.round(product) === price.implied;
    return '<ol class="chain-steps">' + steps + '</ol>' +
      '<div class="chainline">' + fmtShort(r.tvl_usd) + ' &times; ' + price.multiple.toFixed(4) + ' &times; ' + price.growth_multiplier.toFixed(3) +
      ' &times; ' + price.maturity_multiplier.toFixed(3) + ' &times; ' + price.breadth_multiplier.toFixed(3) + ' = ' + fmtShort(price.implied) +
      (checks ? ' &check; the chain reproduces the board value' : ' — the chain does not reproduce the board value') + '</div>';
  }
  function emptyBoard(st) {
    var what = st.q ? 'No match for &lsquo;' + esc(st.q) + '&rsquo; under these filters.' : 'No protocol on the board matches these filters.';
    return '<div class="empty">' + what + '<br><br><button type="button" class="button" data-clear="board">Clear filters</button></div>';
  }
  function boardControls(st) {
    var cats = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Uncategorized'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains); }, []))).sort();
    function options(list, current, allLabel) {
      var html = '<option value="all">' + allLabel + '</option>';
      list.forEach(function (v) { html += '<option value="' + esc(v) + '"' + (v === current ? ' selected' : '') + '>' + esc(v) + '</option>'; });
      return html;
    }
    var bands = [['all', 'Any TVL'], ['b1', 'TVL $1B and up'], ['b100', 'TVL $100M to $1B'], ['b25', 'TVL $25M to $100M'], ['bsmall', 'TVL under $25M']];
    var bandHtml = bands.map(function (b) {
      return '<option value="' + b[0] + '"' + (st.band === b[0] ? ' selected' : '') + '>' + b[1] + '</option>';
    }).join('');
    return '<div class="controls">' + tabs() +
      '<input type="search" id="q" placeholder="Search name or category" value="' + esc(st.q) + '" aria-label="Search the board">' +
      '<select id="cat" aria-label="Filter by category">' + options(cats, st.cat, 'All categories') + '</select>' +
      '<select id="chain" aria-label="Filter by chain">' + options(chains, st.chain, 'All chains') + '</select>' +
      '<select id="band" aria-label="Filter by TVL band">' + bandHtml + '</select>' +
      '<label class="check"><input type="checkbox" id="watch"' + (st.watch ? ' checked' : '') + '> Watchlist only</label>' +
      '<label class="check"><input type="checkbox" id="thin"' + (st.hideThin ? ' checked' : '') + '> Hide thin (peers &lt; 3)</label>' +
      '</div>';
  }
  function boardView() {
    var st = state.board;
    var rows = selectBoardRows(st);
    return masthead() + boardControls(st) +
      '<p class="count-line" id="board-count">' + boardCountText(rows) + '</p>' +
      '<div id="board-host">' + (rows.length ? buildBoardTable(rows, st) : emptyBoard(st)) + '</div>' + footer();
  }
  // Re-render only the table region: the search box keeps focus, and the region's content is a
  // pure function of state — the same builder the full render uses, so the two can never drift.
  function renderBoardRegion() {
    var st = state.board;
    var host = document.getElementById('board-host');
    if (!host) return;
    var rows = selectBoardRows(st);
    host.innerHTML = rows.length ? buildBoardTable(rows, st) : emptyBoard(st);
    var count = document.getElementById('board-count');
    if (count) count.textContent = boardCountText(rows);
    wireBoardRegion();
  }

  // ---------- tokened (the control group) ----------
  // Protocols that record a token: never ranked, but priced by the same model and set against
  // the market's own value, so a reader can see what the model would say about protocols whose
  // answer is already known.
  function tokenedRows() {
    if (!RESULT) return null;
    return RESULT.tokened.map(function (entry) {
      var p = entry.row;
      return {
        slug: p.slug, name: p.name, category: p.category || 'Uncategorized', symbol: p.symbol,
        chains: p.chains, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d,
        implied: entry.price.implied, peers: entry.price.peers, multiple: entry.price.multiple,
        ratio: p.mcap_usd ? p.mcap_usd / entry.price.implied : null,
      };
    });
  }
  function selectTokenedRows(st, all) {
    var rows = all.filter(function (r) {
      if (st.cat !== 'all' && r.category !== st.cat) return false;
      if (st.q) {
        var q = st.q.toLowerCase();
        if (r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0 && r.category.toLowerCase().indexOf(q) < 0 && (r.symbol || '').toLowerCase().indexOf(q) < 0) return false;
      }
      return true;
    });
    var key = { mcap: 'mcap_usd', implied: 'implied', ratio: 'ratio', tvl: 'tvl_usd' }[st.sort] || 'mcap_usd';
    rows.sort(function (a, b) {
      var av = a[key], bv = b[key];
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (av !== bv) return (av - bv) * st.dir;
      return a.slug < b.slug ? -1 : 1;
    });
    return rows;
  }
  function buildTokenedTable(rows, st) {
    var html = '<table><thead><tr><th>Protocol</th><th>Symbol</th>' +
      sortHead(st, 'mcap', 'Market cap', true) + sortHead(st, 'implied', 'Model value', true) +
      sortHead(st, 'ratio', 'Market / model', true) + sortHead(st, 'tvl', 'TVL', true) +
      '<th class="num hideable">Peers</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      html += '<tr>' +
        '<td class="who"><span class="name">' + esc(r.name) + '</span> <span class="tag tokened">TOKENED &middot; CONTROL</span><span class="sub">' + esc(r.category) + '</span></td>' +
        '<td class="mono">' + esc(r.symbol || '—') + '</td>' +
        '<td class="num">' + fmtShort(r.mcap_usd) + '</td>' +
        '<td class="num">' + fmtShort(r.implied) + '</td>' +
        '<td class="num">' + (r.ratio === null ? '—' : 'x' + r.ratio.toFixed(2)) + '</td>' +
        '<td class="num">' + fmtShort(r.tvl_usd) + '</td>' +
        '<td class="num hideable">' + (r.peers === 0 ? 'none' : r.peers) + '</td></tr>';
    });
    return html + '</tbody></table>';
  }
  function tokenedCountText(rows, total) {
    return 'Showing ' + rows.length + ' of ' + total + ' tokened protocols — the control group: the same model, priced against the market&rsquo;s own answer';
  }
  function tokenedView() {
    var st = state.tokened;
    var all = tokenedRows();
    var head = masthead() + '<div class="controls">' + tabs() +
      '<input type="search" id="tq" placeholder="Search name, category or symbol" value="' + esc(st.q) + '" aria-label="Search the tokened protocols">' +
      '<select id="tcat" aria-label="Filter by category">' +
      (function () {
        var cats = all ? Array.from(new Set(all.map(function (r) { return r.category; }))).sort() : [];
        var html = '<option value="all">All categories</option>';
        cats.forEach(function (v) { html += '<option value="' + esc(v) + '"' + (v === st.cat ? ' selected' : '') + '>' + esc(v) + '</option>'; });
        return html;
      })() + '</select></div>';
    if (!all) {
      return head + '<div class="empty">The control group needs the model to run in the browser; it did not, so the tokened protocols cannot be priced here.</div>' + footer();
    }
    var rows = selectTokenedRows(st, all);
    return head +
      '<p class="count-line" id="tokened-count">' + tokenedCountText(rows, all.length) + '</p>' +
      '<div id="tokened-host">' + (rows.length ? buildTokenedTable(rows, st) : '<div class="empty">No tokened protocol matches.<br><br><button type="button" class="button" data-clear="tokened">Clear filters</button></div>') + '</div>' + footer();
  }
  function renderTokenedRegion() {
    var st = state.tokened;
    var host = document.getElementById('tokened-host');
    if (!host) return;
    var all = tokenedRows();
    if (!all) return;
    var rows = selectTokenedRows(st, all);
    host.innerHTML = rows.length ? buildTokenedTable(rows, st) : '<div class="empty">No tokened protocol matches.<br><br><button type="button" class="button" data-clear="tokened">Clear filters</button></div>';
    var count = document.getElementById('tokened-count');
    if (count) count.innerHTML = tokenedCountText(rows, all.length);
    wireTokenedRegion();
  }

  // ---------- method ----------
  function methodView() {
    var src = document.getElementById('method-text');
    var html = masthead() + '<div class="controls">' + tabs() + '</div><div class="method-body">';
    if (src) html += src.innerHTML;
    var m = DATA.model;
    html += '<div class="formula">implied = TVL &times; M(category) &times; G &times; A &times; B &nbsp;&middot;&nbsp; M = exp(w<sub>c</sub> &times; ln(median) + (1 &minus; w<sub>c</sub>) &times; ln(group multiple)), ' +
      'group = exp(w<sub>g</sub> &times; ln(group median) + (1 &minus; w<sub>g</sub>) &times; ln(' + DATA.global_median.toFixed(3) + ')), w = n / (n + K<sub>eff</sub>), K = ' +
      m.shrink_k + ', K<sub>eff</sub> = K below ' + m.k_thin_base + ' peers scaled by ' + m.k_thin_base + '/n, M capped at 1.5 &times; the group&rsquo;s 75th percentile &nbsp;&middot;&nbsp; G = 1 + clamp(7d, ' +
      m.growth_floor + ', +' + m.growth_cap + ') &times; ' + m.growth_weight + ' &nbsp;&middot;&nbsp; A = ' + m.maturity_floor + ' + ' +
      m.maturity_range + ' &times; age/' + m.maturity_days + 'd &nbsp;&middot;&nbsp; B = 1 + ' + m.breadth_per_chain + ' &times; extra chains (max ' + m.breadth_max_extra + ')</div>';
    html += '<h2 class="sec">What a dollar of TVL prices at, by category</h2>' +
      '<p>Peer medians are of market cap over TVL across the snapshot&rsquo;s ' + DATA.peer_count + ' trading protocols, each peer ratio first capped to [' +
      m.winsor_lo + ', ' + m.winsor_hi + ']. The multiple used shrinks the category median toward its category group&rsquo;s multiple in log space, ' +
      'and the group toward the global median of ' + DATA.global_median.toFixed(3) + ', each in proportion to how few peers stand behind it; below ' +
      m.k_thin_base + ' peers the pull strengthens, and no category may price above 1.5 times its group&rsquo;s 75th percentile. The quality word ' +
      'grades the evidence: solid at five peers or more, thin at three or four, very-thin at one or two, borrowed when a category has none and takes ' +
      'its group&rsquo;s multiple outright.</p>' +
      '<table class="peer-table"><thead><tr><th>Category</th><th>Group</th><th class="num">Peers</th><th class="num">Peer median (raw)</th><th class="num">Multiple used</th><th>Quality</th><th class="num">Protocols ranked</th></tr></thead><tbody>';
    DATA.categories.forEach(function (c) {
      html += '<tr><td class="cat">' + esc(c.category) + '</td><td>' + esc(c.group || '') + '</td><td class="num">' + (c.peers === 0 ? 'none' : c.peers) + '</td>' +
        '<td class="num">' + (c.median_raw === null ? '—' : 'x' + c.median_raw.toFixed(3)) + '</td>' +
        '<td class="num">x' + c.multiple.toFixed(3) + (c.peers === 0 ? ' (group)' : '') + '</td>' +
        '<td><span class="qdot q-' + (c.quality || 'borrowed') + '"></span>' + esc(c.quality || 'borrowed') + '</td>' +
        '<td class="num">' + c.subjects + '</td></tr>';
    });
    html += '</tbody></table><p class="note">A category with no trading peers borrows its group&rsquo;s multiple, and every detail view says when that is the case for its row.</p>';
    // Sensitivity of the head of the board, from the run itself.
    if (DATA.sensitivity && DATA.sensitivity.length) {
      var bySlug = {};
      DATA.rows.forEach(function (r) { bySlug[r.slug] = r; });
      var scale = Math.max.apply(null, DATA.sensitivity.map(function (s) { return s.impliedMax; }));
      html += '<h2 class="sec">How far the head of the board moves when the model is stressed</h2>' +
        '<p>The top ten, re-priced five ways: a gentler and a stronger shrinkage (K = 3 and K = 12), pricing straight off the ' +
        'category group with no weight on the category&rsquo;s own median, leave-one-out over each row&rsquo;s category peers, and no ' +
        'winsorize at all. The bar spans the lowest to the highest implied value across those re-pricings; the last column counts in how ' +
        'many of the five the row still ranks in the top three.</p>' +
        '<table class="peer-table sens"><thead><tr><th>#</th><th>Protocol</th><th class="num">Implied value here</th><th>Range under stress</th><th class="num">Low – high</th><th class="num">Ranks</th><th class="num">Top 3 in</th></tr></thead><tbody>';
      DATA.sensitivity.forEach(function (s) {
        var r = bySlug[s.slug];
        var left = (s.impliedMin / scale) * 100;
        var width = Math.max(0.6, ((s.impliedMax - s.impliedMin) / scale) * 100);
        html += '<tr><td class="num">' + (r ? r.rank : '') + '</td><td class="cat">' + esc(r ? r.name : s.slug) + '</td>' +
          '<td class="num">' + (r ? fmtShort(r.implied_value_usd) : '') + '</td>' +
          '<td><div class="bar-wrap"><div class="bar" style="left:' + left.toFixed(1) + '%;width:' + width.toFixed(1) + '%"></div></div></td>' +
          '<td class="num">' + fmtShort(s.impliedMin) + ' – ' + fmtShort(s.impliedMax) + '</td>' +
          '<td class="num">' + s.rankMin + '–' + s.rankMax + '</td>' +
          '<td class="num">' + s.top3Share + ' / ' + s.settings + '</td></tr>';
      });
      html += '</tbody></table>';
    }
    // The category-group map, from the model itself.
    var groups = {};
    if (window.ModelCore && window.ModelCore.CATEGORY_GROUPS) {
      Object.keys(window.ModelCore.CATEGORY_GROUPS).forEach(function (cat) {
        var g = window.ModelCore.CATEGORY_GROUPS[cat];
        (groups[g] = groups[g] || []).push(cat);
      });
    } else {
      DATA.categories.forEach(function (c) { if (c.group) (groups[c.group] = groups[c.group] || []).push(c.category); });
    }
    var groupNames = Object.keys(groups).sort();
    if (groupNames.length) {
      html += '<h2 class="sec">Category groups</h2>' +
        '<p>Every category in the snapshot is mapped to one group; the shrinkage borrows through the group before it borrows from the whole market.</p>' +
        '<table class="peer-table"><thead><tr><th>Group</th><th>Categories</th></tr></thead><tbody>';
      groupNames.forEach(function (g) {
        html += '<tr><td class="cat">' + esc(g) + '</td><td>' + groups[g].slice().sort().map(esc).join(', ') + '</td></tr>';
      });
      html += '</tbody></table>';
    }
    // The pricing core, in source.
    if (DATA.src && DATA.src.median) {
      html += '<h2 class="sec">The model, in source</h2>' +
        '<p>The two functions that carry the pricing — the true median, and the layered shrinkage. The whole model is one file, ' +
        'model.js, shipped beside this page and printed in full in the dossier; its sha256 is in the footer of every view.</p>' +
        '<pre class="src">' + esc(DATA.src.median) + '</pre>' +
        '<pre class="src">' + esc(DATA.src.shrinkMultiple) + '</pre>';
    }
    html += '</div>';
    return html + footer();
  }

  // ---------- detail ----------
  function whyValue(r) {
    var m = r.model;
    var peerNote = m.peer_count === 0
      ? 'no protocol in its category records a token, so it borrows the ' + esc(m.group) + ' group multiple outright'
      : 'the median peer in its category trades at x' + m.category_multiple.toFixed(3) + ' of TVL; ' + m.peer_count + ' peer' + (m.peer_count === 1 ? '' : 's') +
        ' stand behind that figure (' + m.quality + ' evidence), so the board keeps weight ' + m.shrink_w + ' on the category&rsquo;s own median and puts the rest on the ' + esc(m.group) + ' group, itself shrunk toward the global median';
    return '<b>' + esc(r.name) + '</b> holds ' + fmtUsd(r.tvl_usd) + ' of TVL in ' + esc(m.category) + ', where ' + peerNote +
      '. Its seven-day TVL change counts at ' + fmtPct(m.growth_pct) + ' after clamping, half weight; it has run ' +
      (m.age_days === null ? 'an unrecorded time (counted as one year)' : m.age_days + ' days') + ' with no token on record, and it runs on ' +
      r.chains.length + ' chain' + (r.chains.length === 1 ? '' : 's') + '. Multiplied out, a token priced like its peers would be worth <b>' + fmtUsd(r.implied_value_usd) + '</b> &mdash; a conditional value, not a forecast.';
  }
  // The full derivation of one row's value: its category's peer table (raw and winsorized
  // ratios side by side, clipped ones marked), the two shrinkage layers with their weights,
  // and the multiplication itself. Printed from the browser's own run of the model.
  function derivationCard(r) {
    var price = PRICE[r.slug];
    if (!price || !RESULT) return '';
    var s = price.shrink;
    var entry = RESULT.peerTable.by_category[price.category];
    var html = '<h2 class="sec">The derivation, step by step</h2><div class="derive">';
    if (entry && entry.peers > 0) {
      html += '<h3>Peers in ' + esc(price.category) + ' — ' + entry.peers + ' trading, evidence ' + s.quality + '</h3>' +
        '<table class="peer-table mini"><thead><tr><th>Peer</th><th class="num">Raw ratio</th><th class="num">Winsorized</th></tr></thead><tbody>';
      entry.peer_ids.forEach(function (slug, i) {
        var raw = entry.ratios_raw[i];
        var w = entry.ratios[i];
        var clipped = Math.abs(raw - w) > 1e-12;
        html += '<tr' + (clipped ? ' class="clipped"' : '') + '><td class="mono">' + esc(slug) + '</td><td class="num">' + raw.toFixed(4) + '</td><td class="num">' + w.toFixed(4) + (clipped ? ' (clipped)' : '') + '</td></tr>';
      });
      html += '</tbody></table>' +
        '<p class="note">Category median: x' + entry.median.toFixed(4) + ' — the true median of the ' + entry.peers + ' winsorized ratios.</p>';
    } else {
      html += '<p class="note">No protocol in ' + esc(price.category) + ' records a token with a market cap and a TVL, so this row borrows the ' + esc(s.group) + ' group multiple outright (evidence: borrowed).</p>';
    }
    html += '<h3>Shrinkage, in log space</h3><ol class="chain-steps">' +
      '<li><b>Group</b> ' + esc(s.group) + ': ' + s.group_n + ' peers, median x' + (s.group_median === null ? '—' : s.group_median.toFixed(4)) +
      ', weight w<sub>g</sub> = ' + s.group_w.toFixed(3) + ' against the global median x' + RESULT.peerTable.global_median.toFixed(4) +
      ' &rarr; group multiple x' + s.parent_m.toFixed(4) + '</li>' +
      '<li><b>Category</b>: weight w<sub>c</sub> = ' + s.w.toFixed(3) + ' (K<sub>eff</sub> = ' + s.k_eff.toFixed(1) + ') on its own median &rarr; multiple x' + price.multiple.toFixed(4) +
      (s.capped ? ' — capped at 1.5&times; the group&rsquo;s 75th percentile' : '') + '</li></ol>' +
      '<h3>The multiplication</h3><ol class="chain-steps">' +
      price.chain.map(function (st) {
        return '<li><b>' + esc(st.label) + '</b> ' + fmtChainVal(st) + ' <span class="formula-note">' + esc(st.formula) + '</span></li>';
      }).join('') + '</ol></div>';
    return html;
  }
  function detailView() {
    var r = null;
    DATA.rows.forEach(function (row) { if (row.slug === state.slug) r = row; });
    if (!r) return masthead() + '<div class="empty">No protocol with that slug is on the board.<br><br><button type="button" class="button" data-go="' + boardHash(state.board) + '">Back to the board</button></div>' + footer();
    var m = r.model;
    var html = '<p><a class="back" href="' + boardHash(state.board) + '">&larr; Back to the board</a></p>' +
      '<div class="masthead"><p class="kicker">Rank ' + r.rank + ' of ' + DATA.board_size + ' &middot; ' + esc(r.slug) + '</p>' +
      '<h1>' + esc(r.name) + '</h1>' +
      '<p class="badges"><span class="badge">' + esc(r.category || 'Uncategorized') + '</span>' +
      (r.watchlist
        ? '<span class="badge watch">ON THE WATCHLIST</span>'
        : '<span class="badge" title="' + (exclusionReasons(r)[0] || '') + '">BOARD ONLY</span>') +
      (r.tvl_usd < floorTvl() ? '<span class="badge floor">BELOW THE ' + floorLabel() + ' FLOOR</span>' : '') +
      '<span class="badge">RECORDS NO TOKEN</span></p></div>' +
      '<div class="record">' +
      '<div class="cell"><div class="k">TVL</div><div class="v">' + fmtUsd(r.tvl_usd) + '</div></div>' +
      '<div class="cell"><div class="k">TVL change, 7d</div><div class="v">' + fmtPct(r.change_7d) + '</div></div>' +
      '<div class="cell"><div class="k">Implied value</div><div class="v">' + fmtUsd(r.implied_value_usd) + '</div></div>' +
      '<div class="cell"><div class="k">Category multiple</div><div class="v">' + fmtMult(m.category_multiple) + '</div></div>' +
      '<div class="cell"><div class="k">On record since</div><div class="v">' + (r.listed_at || 'not recorded') + '</div></div>' +
      '<div class="cell"><div class="k">Age with no token</div><div class="v">' + (m.age_days === null ? 'n/a' : m.age_days + ' days') + '</div></div>' +
      '<div class="cell"><div class="k">Chains</div><div class="v">' + r.chains.length + '</div></div>' +
      '<div class="cell"><div class="k">Trading peers in category</div><div class="v">' + (m.peer_count === 0 ? 'none — group multiple' : m.peer_count + ' (' + m.quality + ')') + '</div></div>' +
      '</div>' +
      '<p class="why">Chains on record: ' + esc(chainList(r.chains)) + '</p>' +
      '<h2 class="sec">Why this value</h2>' +
      '<p class="arith"><b>' + fmtUsd(r.tvl_usd) + '</b> TVL &times; <b>' + fmtMult(m.category_multiple) + '</b> category &times; <b>' +
      fmtMult(m.growth_multiplier) + '</b> growth &times; <b>' + fmtMult(m.maturity_multiplier) + '</b> maturity &times; <b>' +
      fmtMult(m.breadth_multiplier) + '</b> breadth = <span class="eq">' + fmtUsd(r.implied_value_usd) + '</span></p>' +
      '<p class="why">' + whyValue(r) + '</p>' +
      derivationCard(r) +
      (mismatchSlugs()[r.slug] ? '<p class="server-val">This row differs from the server&rsquo;s board (see the check bar above for both values).</p>' : '') +
      '<h2 class="sec">Farm plan</h2>' +
      '<p class="basis">Plan basis: ' + esc(PLAYBOOKS[r.category] || 'flagship product') + ' playbook &middot; ' +
      esc(r.chains[0] || 'main chain') + ' route &middot; $' + capitalForTvl(r.tvl_usd) + ' capital tier &middot; ' + holdDaysForAge(r.age_days) + '-day hold</p>' +
      '<ol class="plan">' + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>';
    return html + footer();
  }

  // ---------- render & events ----------
  function debounce(fn, ms) {
    var t = null;
    return function () { var self = this, args = arguments; clearTimeout(t); t = setTimeout(function () { fn.apply(self, args); }, ms); };
  }
  function wireCommon() {
    root.querySelectorAll('[data-go]').forEach(function (btn) {
      btn.addEventListener('click', function () { goto(btn.getAttribute('data-go')); });
    });
  }
  function wireSortButtons(hostId, st, hashOf) {
    var host = document.getElementById(hostId);
    if (!host) return;
    host.querySelectorAll('[data-sort]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var key = btn.getAttribute('data-sort');
        if (st.sort === key || (key === 'value' && st.sort === 'rank')) st.dir = st.dir === 1 ? -1 : 1;
        else { st.sort = key; st.dir = -1; }
        goto(hashOf(st));
      });
    });
  }
  function wireBoardRegion() {
    wireSortButtons('board-host', state.board, boardHash);
    root.querySelectorAll('#board-host [data-clear]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.board = { q: '', cat: 'all', chain: 'all', watch: false, band: 'all', sort: 'rank', dir: -1, hideThin: false };
        if (window.location.hash === boardHash(state.board)) render(); else goto(boardHash(state.board));
      });
    });
    root.querySelectorAll('#board-host tr[data-slug]').forEach(function (tr) {
      function open() { goto('#/protocol/' + encodeURIComponent(tr.getAttribute('data-slug'))); }
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
    root.querySelectorAll('#board-host .xtoggle').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var tr = btn.closest('tr');
        var next = tr.nextElementSibling;
        if (next && next.classList.contains('xrow')) {
          next.remove();
          btn.setAttribute('aria-expanded', 'false');
          btn.innerHTML = '&#9656;';
          return;
        }
        var slug = btn.getAttribute('data-x');
        var row = null;
        DATA.rows.forEach(function (r) { if (r.slug === slug) row = r; });
        if (!row) return;
        var xr = document.createElement('tr');
        xr.className = 'xrow';
        xr.innerHTML = '<td colspan="9">' + chainHtml(row) + '</td>';
        tr.after(xr);
        btn.setAttribute('aria-expanded', 'true');
        btn.innerHTML = '&#9662;';
      });
    });
  }
  function wireBoard() {
    wireBoardRegion();
    var q = document.getElementById('q');
    if (q) q.addEventListener('input', debounce(function () {
      state.board.q = q.value;
      window.history.replaceState(null, '', boardHash(state.board));
      renderBoardRegion();
    }, 120));
    ['cat', 'chain', 'band'].forEach(function (id) {
      var sel = document.getElementById(id);
      if (sel) sel.addEventListener('change', function () { state.board[id] = sel.value; goto(boardHash(state.board)); });
    });
    var watch = document.getElementById('watch');
    if (watch) watch.addEventListener('change', function () { state.board.watch = watch.checked; goto(boardHash(state.board)); });
    var thin = document.getElementById('thin');
    if (thin) thin.addEventListener('change', function () { state.board.hideThin = thin.checked; goto(boardHash(state.board)); });
  }
  function wireTokenedRegion() { wireSortButtons('tokened-host', state.tokened, tokenedHash); wireCommonClear(); }
  function wireTokened() {
    wireTokenedRegion();
    var q = document.getElementById('tq');
    if (q) q.addEventListener('input', debounce(function () {
      state.tokened.q = q.value;
      window.history.replaceState(null, '', tokenedHash(state.tokened));
      renderTokenedRegion();
    }, 120));
    var cat = document.getElementById('tcat');
    if (cat) cat.addEventListener('change', function () { state.tokened.cat = cat.value; goto(tokenedHash(state.tokened)); });
  }
  function wireCommonClear() {
    root.querySelectorAll('#tokened-host [data-clear]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.tokened = { q: '', cat: 'all', sort: 'mcap', dir: -1 };
        if (window.location.hash === tokenedHash(state.tokened)) render(); else goto(tokenedHash(state.tokened));
      });
    });
  }
  function render() {
    if (!DATA) {
      root.innerHTML = '<div class="empty">The radar data file did not load.</div>';
      window.__MODEL_READY__ = true;
      return;
    }
    fillStats();
    var html;
    if (state.view === 'tokened') html = tokenedView();
    else if (state.view === 'method') html = methodView();
    else if (state.view === 'protocol') html = detailView();
    else html = boardView();
    root.innerHTML = checkBar() + html;
    root.setAttribute('aria-busy', 'false');
    wireCommon();
    if (state.view === 'board') wireBoard();
    if (state.view === 'tokened') wireTokened();
    window.__MODEL_READY__ = true;
  }
  window.addEventListener('hashchange', function () { parseHash(); render(); });
  parseHash();
  render();
})();
