(function () {
  'use strict';
  // views.js — the dashboard's detail view and board wiring, and the registry the page
  // starts from. app.js runs first and leaves everything the views need on
  // window.__RADAR_CTX__; b-views.js (the method and tokened views) runs next and leaves
  // its views on window.__RADAR_VIEWS_PART__; this file adds the detail view, merges the
  // part in, registers the whole on window.__RADAR_VIEWS__ and starts the page. If
  // b-views.js did not load, the registry still stands: the two views it carried become
  // honest placeholders that say so, and the board and detail views are unaffected.
  var C = window.__RADAR_CTX__;
  if (!C) {
    // app.js did not load (or died before leaving its context): no state, no data,
    // no board builder. Say so in the page instead of throwing on the destructure
    // below — a missing first script must not take the whole page down with it.
    var showMissingApp = function () {
      var host = document.getElementById('view');
      if (host) host.innerHTML = '<div class="checkbar off" role="status">app.js did not load, so the radar cannot render in this browser. The server&rsquo;s board is in board.json, beside this page.</div>';
      window.__MODEL_READY__ = true;
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showMissingApp);
    else showMissingApp();
    return;
  }
  var esc = C.esc, fmtUsd = C.fmtUsd, fmtShort = C.fmtShort, fmtPct = C.fmtPct, fmtMult = C.fmtMult,
    chainList = C.chainList,
    capitalForTvl = C.capitalForTvl, holdDaysForAge = C.holdDaysForAge, PLAYBOOKS = C.PLAYBOOKS,
    state = C.state, DATA = C.data, RESULT = C.result, PRICE = C.price,
    masthead = C.masthead, tabs = C.tabs, footer = C.footer,
    boardHash = C.boardHash, goto = C.goto, debounce = C.debounce,
    mismatchSlugs = C.mismatchSlugs, exclusionReasons = C.exclusionReasons,
    floorTvl = C.floorTvl, floorLabel = C.floorLabel, wireSortButtons = C.wireSortButtons,
    render = C.render, renderBoardRegion = C.renderBoardRegion, root = C.root;

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

  // ---------- the per-row check chain and the board wiring ----------
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

  // ---------- the registry ----------
  // b-views.js carries the method and tokened views; if it never arrived, those two
  // views become placeholders that say which file is missing, instead of the registry
  // failing and taking the working board and detail views down with it.
  var PART = window.__RADAR_VIEWS_PART__ || null;
  function partPlaceholder(name) {
    return function () {
      return masthead() + '<div class="controls">' + tabs() + '</div>' +
        '<div class="empty">The ' + name + ' view lives in b-views.js, which did not load, so it cannot be shown here. ' +
        'The board and the detail views are unaffected &mdash; use the tabs above.</div>' + footer();
    };
  }
  function partWire() { /* the missing part's wiring: nothing of it exists to wire */ }
  window.__RADAR_VIEWS__ = {
    tokenedView: PART && PART.tokenedView ? PART.tokenedView : partPlaceholder('tokened'),
    methodView: PART && PART.methodView ? PART.methodView : partPlaceholder('method'),
    detailView: detailView,
    wireTokened: PART && PART.wireTokened ? PART.wireTokened : partWire,
    wireBoard: wireBoard, wireBoardRegion: wireBoardRegion,
  };
  if (window.__RADAR_INIT__) window.__RADAR_INIT__();
})();
