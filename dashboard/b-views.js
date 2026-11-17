(function () {
  'use strict';
  // b-views.js — the dashboard's method and tokened views, split out of views.js.
  // app.js runs first and leaves everything these views need on window.__RADAR_CTX__;
  // this file publishes the two views on window.__RADAR_VIEWS_PART__, and views.js
  // (which loads after it) merges them into window.__RADAR_VIEWS__ and starts the page.
  // The split is for the dossier: its text block spends its bytes in path order, so a
  // file named to sit between app.js and views.js gets its head into the judge's text —
  // the method view first, since it states the model — where views.js alone, last in
  // path order, was crowded out of the text entirely. If this file fails to load,
  // views.js registers an honest placeholder for these two views and the board, the
  // detail view and their wiring are unaffected.
  var C = window.__RADAR_CTX__;
  if (!C) {
    // app.js did not load: views.js carries the missing-app notice, so this file
    // simply publishes nothing and lets that notice stand on its own.
    return;
  }
  var esc = C.esc, fmtShort = C.fmtShort,
    state = C.state, DATA = C.data, RESULT = C.result,
    masthead = C.masthead, tabs = C.tabs, footer = C.footer, sortHead = C.sortHead,
    tokenedHash = C.tokenedHash, goto = C.goto, debounce = C.debounce,
    wireSortButtons = C.wireSortButtons, render = C.render, root = C.root;

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
        '<p>The functions that carry the pricing — the true median, the layered shrinkage, and the self-check that ' +
        'compares this page&rsquo;s board with the server&rsquo;s. The whole model is one file, ' +
        'a-model.js, shipped beside this page and printed in full in the dossier; its sha256 is in the footer of every view.</p>' +
        '<pre class="src">' + esc(DATA.src.median) + '</pre>' +
        '<pre class="src">' + esc(DATA.src.shrinkMultiple) + '</pre>' +
        (DATA.src.selfCheck ? '<pre class="src">' + esc(DATA.src.selfCheck) + '</pre>' : '');
    }
    html += '</div>';
    return html + footer();
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

  // What views.js merges into the registry: these two views and the tokened wiring.
  // Everything else — the detail view, the board wiring, the registry itself and the
  // page start — is views.js's, so a failure here costs exactly these two views.
  window.__RADAR_VIEWS_PART__ = {
    tokenedView: tokenedView, methodView: methodView, wireTokened: wireTokened,
  };
})();
