# Plan — sub-agent windows as an aligned right-hand grid (X/Y lattice)

Status: **implemented** (design G — see `nlttl-benchmark.md` REVISION 3 for the measured
outcome). Deviations from the proposal below, all forced by the geometry or by evidence:

- the lattice lines are anchored on the window **cards**, not on the subtree boxes, and each
  column/row reserves the largest card overhang (`colL`/`colR`/`rowT`/`rowB` in `tree.js`) —
  a subtree box is the bbox of the whole branch and the engine centres a card over its
  children, so box-anchored lines drift column by column (this was found by the `gridBad`
  lattice check, not by eye);
- `agentMaxRows: 4` stays the shipped default even though the sweep's area-optimal is 3
  (0.969 vs 0.976 — inside 1%);
- `R = 1` is *not* the control: it means one window per column (one long row), i.e. the
  REVISION 2 "side by side" shape. The pre-grid single column is `legacy` in the sweep
  (`agentMaxRows: 1000000`).

Sections 1–3 (goal / current state / target geometry) describe the design as proposed and
match what shipped; §4–§6 match the implementation with the three notes above. Owner files:
`media/tree.js` (geometry), `media/main.js` (connector routing, `relayout()`), the bench
suite in this folder.

Original proposal follows.

## 1. Goal

A node's sub-agent (agent child) windows must stop forming an unbounded vertical
ribbon to the right of the parent card. They become an **aligned lattice**: a cell
grid that grows **rightward in columns**, with a bounded number of rows per column,
so cell *k* sits at a fixed `(col, row)` — the user's `X0Y0, X0Y1…X0Y3, X1Y0…X1Y3,
X2Y0…` reading. Nested sub-agents are **unchanged in rule**: a sub-agent's own
sub-agents are still placed to the right of *that* sub-agent's card (recursive
sidecar), just in their own grid.

Why: the current design stacks all agent windows of one parent in a single column
(`media/tree.js` `blockOf()` + the `cursorY` loop). Under heavy parallel spawning
(real sessions in this workspace reach 4–7 agent siblings per parent, and 12+ is the
reported use case) the block becomes the dominant vertical cost and the parent's own
turn children are pushed down by it (`height = max(cardH, blockH)`).

## 2. Current state (what exactly changes)

| piece | today |
|---|---|
| `media/tree.js` `blockOf(nid)` | `w = max(window widths)`, `h = Σ window heights + agentVGap`; one column |
| `media/tree.js` `build()` | `width = cardW + (blockW ? agentGap + blockW : 0)`, `height = max(cardH, blockH)` — the engine reserves this rectangle |
| `media/tree.js` `walk()` | windows placed at `x = cardRight + agentGap`, `y` walking down by `agentVGap` |
| `media/main.js` `relayout()` | passes `agentGap: 80, agentVGap: 24`; card sizes measured from the DOM |
| `media/main.js` `drawEdges()` | one cubic spline per agent child: parent right-mid → window left-mid |
| `tools/research/bench/*` | design N = the shipped single-column design; `layoutEngineReserveWrapped` (grid, **row**-major, `maxCols`) exists but was **rejected** in `nlttl-benchmark.md` REVISION 2 (own-window connector crossings 13/18 + area growth) |

## 3. Target geometry

Parameters (added to `DEFAULTS` in `media/tree.js`; wired through `relayout()`):

```
agentGap    = 80   // card right edge → block left channel (unchanged)
agentVGap   = 24   // row gap
agentColGap = 48   // NEW — column gap
agentMaxRows= 4    // NEW — rows per column (the axis that is bounded)
agentTopPad = 16   // NEW — corridor above row 0 (see §5)
```

For one node with `k` agent children, each already laid out recursively as subtree
box `(w_i, h_i)`:

1. `nCols = ceil(k / R)`, `col = floor(i / R)`, `row = i % R` (**column-major**:
   fill the column's rows first, then open the next column to the right).
2. `colW[c] = max(w_i | col(i)=c)`, `rowH[r] = max(h_i | row(i)=r)` — rows are
   aligned across all columns, columns are aligned across all rows (this is the
   "lattice" property).
3. `colX[0]=0`, `colX[c] = colX[c-1] + colW[c-1] + agentColGap`;
   `rowY[0]=0`, `rowY[r] = rowY[r-1] + rowH[r-1] + agentVGap`.
4. `blockW = colX[last] + colW[last]`, `blockH = agentTopPad + rowY[lastUsed] + rowH[lastUsed]`.
5. Cells are placed top-aligned at `bx = cardRight + agentGap`, `by = cardY + agentTopPad`;
   cell `i` at `(bx + colX[col], by + rowY[row])`, its box normalized like today.

The engine contract is untouched: the node's box is still inflated to
`cardW + agentGap + blockW` × `max(cardH, blockH)`, so the reserved rectangle still
contains the whole block and every existing by-construction invariant (no overlap, no
interposition, no foreign crossing) survives. Only the *shape* of `blockH` changes:
it is now bounded by `R` row heights instead of `k` subtree heights, so the vertical
push on the parent's turn children drops by roughly `k/R`.

`layoutTree()` additionally returns a routing table (new, backward-compatible field;
`verify-tree.js` only reads `pos`):

```
cells[childId] = { x, y, w, h,            // cell box (absolute)
                   busX, chanX, corrY }   // corridor midlines, see §5
```

## 4. `media/tree.js` change sketch

```js
const blockOf = (nid) => {
  const list = agentKids(nid).map(layoutSub);
  if (!list.length) return { list: [], cells: [], w: 0, h: 0 };
  const R = Math.max(1, o.agentMaxRows | 0);
  const nCols = Math.ceil(list.length / R);
  const colW = new Array(nCols).fill(0);
  const rowH = new Array(R).fill(0);
  list.forEach((s, i) => {
    const c = Math.floor(i / R), r = i % R;
    if (s.w > colW[c]) colW[c] = s.w;
    if (s.h > rowH[r]) rowH[r] = s.h;
  });
  const colX = []; let x = 0;
  for (let c = 0; c < nCols; c++) { colX.push(x); x += colW[c] + (c < nCols - 1 ? o.agentColGap : 0); }
  const rowY = []; let y = 0;
  for (let r = 0; r < R; r++) { rowY.push(y); y += rowH[r] + (r < R - 1 ? o.agentVGap : 0); }
  const cells = list.map((s, i) => ({ s, col: Math.floor(i / R), row: i % R,
                                      x: colX[Math.floor(i / R)], y: rowY[i % R] }));
  return { list, cells, colX, rowY, colW, rowH, w: x, h: o.agentTopPad + y };
};
```

* `build()` uses `blk.w` / `blk.h` exactly as today.
* `walk()` loops `blk.cells` instead of the `cursorY` stack (`dx = bx + cell.x - s.box.left`,
  `dy = by + cell.y - s.box.top`) and fills the routing table.
* Sub-agent **turn** children keep hanging below their own card (inside the cell box) —
  no change, so nesting stays "to the right of each sub-agent node".

## 5. Connector routing (`media/main.js drawEdges()`)

Measured problem with the current spline under a grid: a spline to column *c* passes
through the cards of columns `0..c-1` (REVISION 2 measured 13/18 such crossings for
a 2-column trial). The grid opens card-free **corridors** by construction, so the
agent connector becomes an orthogonal elbow that only uses them:

```
( cardRight, exitY )
  → ( busX,  exitY )        // channel between card and block, x = cardRight + agentGap/2
  → ( busX,  corrY )        // vertical in that channel
  → ( chanX, corrY )        // horizontal in the row corridor
  → ( chanX, cellMidY )     // vertical in the column channel left of the target column
  → ( cellX, cellMidY )     // stub into the target cell's left edge
```

* `exitY = cardTop + cardH * (i + 1) / (n + 1)` — the parent's agent exits are spread
  over its right edge instead of all leaving at the card's mid.
* `busX = cardRight + agentGap/2`; for `col > 0`, `chanX = colLeft - agentColGap/2`
  (`busX` for `col = 0`).
* `corrY = by - agentTopPad/2` for `row = 0`, else `rowTop[row] - agentVGap/2`.
  Every segment lies in a gap that no card occupies (row bands and column bands are
  separated by `agentVGap` / `agentColGap`; `agentTopPad` creates the row-0 corridor),
  so own-group crossings go to **0** as well.
* Keep one `<path class="edge-agent">` per child with `data-agent="<childId>"` and the
  `edge-done` / `edge-error` classes — `onAgentDone()` (main.js ~L1203) keeps working
  untouched. Corners: plain `L` segments (a small radius is optional polish).

Cost: block height grows by `agentTopPad` (16 px) per node; blocks get wider.

## 6. Sweep and validation

New bench script `tools/research/bench/grid-sweep.js` (same loader style as
`analyze-interposition.js`, `TEMP/hstate.vscdb` → `agentHarness.state.sessions`):
for `R ∈ {1, 2, 3, 4, 6, 8}` × {synthetic profiles, the real sessions that contain
agents} print: canvas W×H, area, `overlaps`, foreign crossings, own-group crossings,
**rows-aligned violations**, worst block height. `R = 1` reproduces today's design and
is the control.

Pass bar (must hold for the chosen `R`):

1. `node verify-tree.js` → `maxDelta = 0` against the matching bench candidate, `overlaps = 0`,
   `agentNotRight = 0`, `turnNotBelow = 0`, `interpositions = 0`, `foreignCross = 0`,
   **`crossOwnGroup = 0`** (new, from §5), and the new lattice check.
2. `node analyze-interposition.js check ALL heights=heuristic` on the 7 persisted
   agent-bearing sessions → 0 interpositions / 0 crossings (foreign *and* own).
3. `node bench.js --quick` and `node nlttl-bench.js` → no timing regression
   (`media/tree.js` stays O(n); the grid adds O(k) per node).
4. `npm run check:webview`, `npm run check:models`, `npm run compile`.
5. Manual, on the busiest real session (`mtu9u1lvlz7if1`: 6/5/5 siblings):
   `Ctrl+Alt+D` layout diagnostic → 0 overlapping cards; eyeball the lattice and the
   edges; drag-resize one card (widths come from the DOM) → rows stay aligned.

Bench-known data for choosing `R` (agent siblings per parent, 56 persisted sessions,
7 with agents): `{1:16, 2:26, 3:7, 4:3, 5:2, 6:1, 7:1}`; nested agent-with-agents:
10 parents in `mtt7sjpjmoj5os`. `R = 4` puts every observed parent in 1–2 columns and
the 12-sub-agent case in 3 columns × 4 rows.

Bench-code updates that ship with the change:

* `nlttl-candidates.js` — add `layoutEngineReserveGrid` (column-major, `R` rows,
  `agentTopPad`); keep `layoutEngineReserveWrapped` for the record.
* `metrics.js` `directionViolations()` — `agentNotCentered` is **no longer valid**
  (rows 1..R-1 legitimately sit below the parent's mid). Replace with
  `agentNotRight` (unchanged) + `gridMisaligned` (cells of one parent must share at
  most `R` distinct row tops, equal column x per column, equal row y within a row).
* `violations.js` — unchanged definitions; `crossOwnGroup` becomes a reported *and*
  asserted number.
* `synthetic.js` — add a `parallel` profile (`agentProb: 1, maxAgents: 12,
  nestedAgentProb: 0.2`), because today's profiles cap at 3 siblings and never
  exercise the second column.

## 7. Docs to update when it ships

* `docs/agents/file-map.md` — the `media/tree.js` bullet ("stack the windows into one
  block" → grid + routing table) and the `media/main.js` edge sentence.
* `tools/research/prior-art/sidecar-verdict.md` §4 step 2 (the minimised glue is now
  "pack the windows into a bounded-row grid").
* `tools/research/bench/nlttl-benchmark.md` — add **REVISION 3** with the sweep table
  and an explicit statement that REVISION 2's rejection of wrapped blocks is
  overturned *for the grid + corridor-routing combination*, with the numbers.
* `AGENTS.md` — no change (the index does not describe the layout).

## 8. Open decisions (need a call before coding)

1. **Rows per column `R`**: fixed `4` (matches the example, matches the data,
   layout stable while spawning — the recommended default) vs. adaptive
   `clamp(round(cardH / medianCellH), 2, 6)`. Adaptive keeps the block about as tall
   as the card but makes the lattice cell count depend on measured DOM heights.
2. **Fill order**: **column-major** (recommended: bounded height, new columns appear
   to the right, earlier cells never move — the user's `X0Y0…X0Y3, X1Y0…` order) vs.
   row-major (`layoutEngineReserveWrapped`'s existing order; the block would keep
   growing downward, so the "infinite stacking" is only halved).
3. **Edges**: orthogonal corridor routing (§5, recommended — 0 crossing lines) vs.
   keep the splines (small diff, but lines visibly cut across the nearer columns'
   cards).

## 9. Delivery order

| step | content | size |
|---|---|---|
| 1 | `media/tree.js` grid block + routing table + `DEFAULTS` params; `main.js` `relayout()` passes `agentColGap` / `agentMaxRows` / `agentTopPad` | M |
| 2 | bench updates (`layoutEngineReserveGrid`, `metrics.js` lattice check, `parallel` profile, `grid-sweep.js`); run the sweep and pick `R` | M |
| 3 | `main.js drawEdges()` elbow routing + `exitY` spread | S–M |
| 4 | docs (§7), then `npm run compile` → `powershell -File build-deploy.ps1` → **reload the window** (or `hvsc reboot`) | S |
