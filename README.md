# Token Radar — a make.fun "Build the best token launch radar" entry

Ranks the sealed DefiLlama snapshot's pre-token protocols by an implied value priced off the
snapshot's own trading peers, and ships an offline dashboard, a ranked board, and a dossier.

## Run

```
node main.ts --input /path/to/snapshot.json        # writes /output (or $MAKEFUN_OUTPUT_DIR)
```

Node ≥ 22.18, standard library only. `--input` takes the snapshot file or its directory;
`--output` or `MAKEFUN_OUTPUT_DIR` stands in for `/output` outside the grader's container.
The run is deterministic: two runs over the same snapshot write byte-identical outputs.

## What it writes

- `board.json` — 198 rows: the 40-protocol watchlist plus every other protocol that passes the
  same screen (records no token; not a wrapped/staked/bridged product of a trading token, not an
  exchange, not a versioned sub-product), whether above or below the watchlist's $50M floor. Each row carries its implied value, its full pricing
  decomposition, and a seven-step farm plan with a cost and a time on every step.
- `data.js` + `dashboard/` — the offline page: a sortable, filterable board, a detail view per
  protocol (the value shown as its multiplication, plus the farm plan), a live-tokens view that
  keeps already-trading protocols apart at the market's own values, and a method view that states
  the model and the per-category peer table.
- `screenshots/` — the board, a detail view, and a filtered view, all rendered from the built page.
- `dossier.json` — written last, with the vendored `buildDossier`, byte-identical to a rebuild.

## The model (lib/model.ts)

`implied = TVL × M(category) × G(growth) × A(maturity) × B(breadth)`. M is the median
market-cap/TVL of the snapshot's 128 trading peers in the category, each peer ratio winsorized to
[0.02, 4], the median shrunk toward the global peer median (0.223) with weight K = 6 against the
peer count; peerless categories price at the global median. G counts the clamped seven-day TVL
change (−60%…+120%) at half weight; A runs 0.60→1.00 over three years on record; B adds 3% per
extra chain, capped at eight. No protocol is named in the model.

## Check

```
node validate.mjs <output-dir> <snapshot.json>
```

replicates the gate's seven rows (dashboard files, board file, sorted by value, coverage,
farm steps, screenshots, dossier byte-compare) and reports each.
