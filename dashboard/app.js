// Token Radar dashboard: a working radar over window.RADAR (data.js, built by main.ts from the
// sealed snapshot). The page re-prices every row in the browser with a-model.js — the model's
// own source, byte for byte the file the server runs — then checks its board against the
// server's, line by line, and says so at the top. No fetch, no network: all renders locally.
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
    if (typeof window.ModelCore === 'undefined') { CHECK_ERROR = 'a-model.js did not load'; return; }
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
        ' rows from the snapshot&rsquo;s raw fields &mdash; every priced field the server publishes (value, rank, multiple, peers, the growth, maturity and breadth factors, the shrinkage weight, quality, group and cap flag) matches the server&rsquo;s board, row for row &middot; ' + sha + '</div>';
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
  // constants — the prose carries <span data-stat> placeholders, never literals.
  // scripts/lint-hardcode.mjs enforces it.
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
  // A row's badges are computed from its record, never from which list it arrived on: the
  // floor badge appears only when the TVL is actually under the floor, and a board-only row
  // above the floor says why it is not on the watchlist instead of borrowing the floor's label.
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
  // One state object; each tab keeps its own filter and sort. The hash is a view of the
  // state: navigation writes it, back/forward restore it, and typing in a search box
  // replaces it silently while only the table region re-renders.
  var state = {
    view: 'board',
    slug: '',
    board: { q: '', cat: 'all', chain: 'all', watch: false, band: 'all', sort: 'rank', dir: 1, hideThin: false },
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
    else if (st.sort === 'rank') p.set('dir', 'desc');
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
      var bsort = params.get('sort') || 'rank';
      state.board = {
        q: params.get('q') || '', cat: params.get('cat') || 'all', chain: params.get('chain') || 'all',
        watch: params.get('watch') === '1', band: params.get('band') || 'all',
        // Rank's resting direction is 1 (rank 1 first); every other column rests at -1.
        sort: bsort, dir: params.get('dir') === 'asc' ? 1 : params.get('dir') === 'desc' ? -1 : bsort === 'rank' ? 1 : -1,
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
    // Rank ascending is value descending: when rank is the sort, the value column
    // runs opposite to dir, and its aria-sort has to say so.
    var dir = key === 'value' && st.sort === 'rank' ? -st.dir : st.dir;
    var aria = active ? (dir === 1 ? 'asc' : 'desc') : 'none';
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
      // Rank sorts by the rank itself: dir 1 is rank 1 first, dir -1 turns the board
      // over. (It used to be pinned at rank-ascending whatever dir said, so clicking
      // the rank header changed the aria-sort but never the order.)
      if (st.sort === 'rank') return (a.rank - b.rank) * st.dir;
      var av = st.sort === 'peers' ? a.model.peer_count : a[key];
      var bv = st.sort === 'peers' ? b.model.peer_count : b[key];
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (av !== bv) return (av - bv) * st.dir;
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
    if (window.__RADAR_VIEWS__) window.__RADAR_VIEWS__.wireBoardRegion();
    else wireBoardRegionFallback();
  }

  // ---------- the board without views.js ----------
  // If views.js fails to load, the board still has to work: the wiring below is the
  // same wiring views.js would have done (sort, clear, row navigation, the check
  // chain), done here from app.js's own pieces. The chain expansion falls back to
  // the one-line multiplication — the step-by-step chain is views.js's work — and
  // render() shows a notice saying the other views are unavailable.
  function fallbackChainHtml(r) {
    return '<div class="chainline">' + fmtShort(r.tvl_usd) + ' TVL &times; ' + r.model.category_multiple.toFixed(3) + ' multiple &times; ' +
      r.model.growth_multiplier.toFixed(3) + ' growth &times; ' + r.model.maturity_multiplier.toFixed(3) + ' maturity &times; ' +
      r.model.breadth_multiplier.toFixed(3) + ' breadth = ' + fmtShort(r.implied_value_usd) +
      ' (the step-by-step check chain needs views.js, which did not load)</div>';
  }
  function wireBoardRegionFallback() {
    wireSortButtons('board-host', state.board, boardHash);
    root.querySelectorAll('#board-host [data-clear]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.board = { q: '', cat: 'all', chain: 'all', watch: false, band: 'all', sort: 'rank', dir: 1, hideThin: false };
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
        xr.innerHTML = '<td colspan="9">' + fallbackChainHtml(row) + '</td>';
        tr.after(xr);
        btn.setAttribute('aria-expanded', 'true');
        btn.innerHTML = '&#9662;';
      });
    });
  }
  function wireBoardFallback() {
    wireBoardRegionFallback();
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
  // The visible notice for the degraded page: no views.js means no tokened, method
  // or detail views — the board only, and it says so, instead of silently showing
  // the board under another view's URL.
  function viewsNotice() {
    var V = window.__RADAR_VIEWS__;
    if (V) {
      // Registered, but the view this URL asks for is not among its functions (a part
      // script failed on its own): the board is shown, and the page says so.
      var fn = state.view === 'tokened' ? 'tokenedView' : state.view === 'method' ? 'methodView' : state.view === 'protocol' ? 'detailView' : null;
      if (!fn || V[fn]) return '';
      return '<div class="checkbar warn" role="status">The ' + state.view + ' view is unavailable (its script did not load in full), so the board is shown instead. ' +
        'The board below is complete: sorting, filtering, search and the per-row check chain all work.</div>';
    }
    var asked = state.view === 'board' ? '' : 'The ' + state.view + ' view you asked for needs it, so the board is shown instead. ';
    return '<div class="checkbar warn" role="status">views.js did not load, so the Tokened, Method and detail views are unavailable. ' +
      asked + 'The board below is complete: sorting, filtering, search and the per-row check chain all work.</div>';
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
        else { st.sort = key; st.dir = key === 'rank' ? 1 : -1; }
        goto(hashOf(st));
      });
    });
  }


  function render() {
    if (/[?&]shot=1/.test(window.location.search)) document.body.classList.add('shot');
    if (!DATA) {
      root.innerHTML = '<div class="empty">The radar data file did not load.</div>';
      window.__MODEL_READY__ = true;
      return;
    }
    fillStats();
    var VIEWS = window.__RADAR_VIEWS__ || null;
    var html;
    // Each view is asked for by name and used only if that function is really there:
    // a views script that loaded in part (or a part script that never arrived) must
    // degrade to the board, never throw the whole page away with it.
    if (state.view === 'tokened' && VIEWS && VIEWS.tokenedView) html = VIEWS.tokenedView();
    else if (state.view === 'method' && VIEWS && VIEWS.methodView) html = VIEWS.methodView();
    else if (state.view === 'protocol' && VIEWS && VIEWS.detailView) html = VIEWS.detailView();
    else html = boardView();
    root.innerHTML = checkBar() + viewsNotice() + html;
    root.setAttribute('aria-busy', 'false');
    wireCommon();
    if (VIEWS && state.view === 'board' && VIEWS.wireBoard) VIEWS.wireBoard();
    else if (VIEWS && state.view === 'tokened' && VIEWS.wireTokened) VIEWS.wireTokened();
    else if (!VIEWS || state.view === 'board') wireBoardFallback();
    window.__MODEL_READY__ = true;
  }

  // Everything the view scripts (b-views.js, then views.js) need, left where they can
  // reach it; views.js registers the views and calls __RADAR_INIT__. The timeout is a
  // fallback in case views.js ever fails to load: the board still renders.
  window.__RADAR_CTX__ = {
    esc: esc, fmtUsd: fmtUsd, fmtShort: fmtShort, fmtPct: fmtPct, fmtAge: fmtAge, fmtMult: fmtMult,
    chainList: chainList, capitalForTvl: capitalForTvl,
    holdDaysForAge: holdDaysForAge, PLAYBOOKS: PLAYBOOKS, state: state, data: DATA,
    result: RESULT, price: PRICE, masthead: masthead, tabs: tabs, footer: footer,
    sortHead: sortHead, boardHash: boardHash, tokenedHash: tokenedHash, goto: goto,
    debounce: debounce, mismatchSlugs: mismatchSlugs, exclusionReasons: exclusionReasons,
    floorTvl: floorTvl, floorLabel: floorLabel, wireSortButtons: wireSortButtons,
    render: render, renderBoardRegion: renderBoardRegion, root: root,
  };
  // Init is idempotent: views.js calls it after registering the views, and the delayed
  // fallback calls it only if views.js never arrived (the board still renders, degraded).
  // The hashchange listener is bound now, not in init, so it can never be bound twice.
  window.__RADAR_INIT__ = function () { parseHash(); render(); };
  window.addEventListener('hashchange', function () { parseHash(); render(); });
  setTimeout(function () { if (!window.__RADAR_VIEWS__) window.__RADAR_INIT__(); }, 800);
})();
