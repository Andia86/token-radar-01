(function () {
  'use strict';
  // views.js — the dashboard's second script: the tokened, method and detail views. app.js
  // runs first and leaves everything these views need on window.__RADAR_CTX__; this file
  // registers the views on window.__RADAR_VIEWS__ and starts the page. The split exists so
  // the dossier's path order shows the model (a-model.js) first and these views last.
  var C = window.__RADAR_CTX__;
  var esc = C.esc, fmtUsd = C.fmtUsd, fmtShort = C.fmtShort, fmtPct = C.fmtPct, fmtAge = C.fmtAge,
    fmtMult = C.fmtMult, chainList = C.chainList,
    capitalForTvl = C.capitalForTvl, holdDaysForAge = C.holdDaysForAge, PLAYBOOKS = C.PLAYBOOKS,
    state = C.state, DATA = C.data, RESULT = C.result, PRICE = C.price,
    masthead = C.masthead, tabs = C.tabs, footer = C.footer, sortHead = C.sortHead,
    boardHash = C.boardHash, tokenedHash = C.tokenedHash, goto = C.goto, debounce = C.debounce,
    mismatchSlugs = C.mismatchSlugs, exclusionReasons = C.exclusionReasons,
    floorTvl = C.floorTvl, floorLabel = C.floorLabel, wireSortButtons = C.wireSortButtons,
    render = C.render, renderBoardRegion = C.renderBoardRegion, root = C.root;

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
        'a-model.js, shipped beside this page and printed in full in the dossier; its sha256 is in the footer of every view.</p>' +
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
      '<div class="detail-cols"><div class="col-main">' +
      '<h2 class="sec">Why this value</h2>' +
      '<p class="arith"><b>' + fmtUsd(r.tvl_usd) + '</b> TVL &times; <b>' + fmtMult(m.category_multiple) + '</b> category &times; <b>' +
      fmtMult(m.growth_multiplier) + '</b> growth &times; <b>' + fmtMult(m.maturity_multiplier) + '</b> maturity &times; <b>' +
      fmtMult(m.breadth_multiplier) + '</b> breadth = <span class="eq">' + fmtUsd(r.implied_value_usd) + '</span></p>' +
      '<p class="why">' + whyValue(r) + '</p>' +
      derivationCard(r) +
      (mismatchSlugs()[r.slug] ? '<p class="server-val">This row differs from the server&rsquo;s board (see the check bar above for both values).</p>' : '') +
      '</div><div class="col-side">' +
      '<h2 class="sec">Farm plan</h2>' +
      '<p class="basis">Plan basis: ' + esc(PLAYBOOKS[r.category] || 'flagship product') + ' playbook &middot; ' +
      esc(r.chains[0] || 'main chain') + ' route &middot; $' + capitalForTvl(r.tvl_usd) + ' capital tier &middot; ' + holdDaysForAge(r.age_days) + '-day hold</p>' +
      '<ol class="plan">' + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
      '<p class="plan-total">Plan total: <b>$' + capitalForTvl(r.tvl_usd) + '</b> working capital &middot; <b>' + holdDaysForAge(r.age_days) + ' days</b> planned hold &middot; <b>' + r.farm_steps.length + ' steps</b></p>' +
      '</div></div>';
    return html + footer();
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
  window.__RADAR_VIEWS__ = {
    tokenedView: tokenedView, methodView: methodView, detailView: detailView, wireTokened: wireTokened, wireBoard: wireBoard, wireBoardRegion: wireBoardRegion,
  };
  if (window.__RADAR_INIT__) window.__RADAR_INIT__();
})();
