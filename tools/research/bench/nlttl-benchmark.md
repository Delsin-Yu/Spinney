# Engine bake-off — non-layered-tidy-tree-layout (MIT) vs d3-flextree (WTFPL) vs current

Generated 2026-09-10. Reproduce: `cd .agent-harness/research/bench && node nlttl-bench.js`
(this file's tables come from `nlttl-results.json`), and `node verify-tree.js` to prove the
shipped `media/tree.js` reproduces the chosen candidate exactly.

## Candidates

| key | what it is |
|---|---|
| `current` | the pre-change `media/tree.js` (kept as `legacy-tree.js`): hand-written recursive packer, `subWidth`/`subHeight` recomputed per node → O(n²) |
| `A_flex` | strategy A with **d3-flextree@2.1.2** (WTFPL) as engine + sidecar packing |
| `A_nlttl` | strategy A with **non-layered-tidy-tree-layout@2.0.2** (MIT) as engine + the same packing |
| `N_nlttl` | design N: nlttl with **engine-owned sidecar reservation** (inflate each box by the sidecar block; zero collision code) |

Both engines implement the same paper (van der Ploeg, *Drawing Non-layered Tidy Trees in
Linear Time*), so `A_flex` and `A_nlttl` are expected to agree — they do, **exactly**, on
every scenario (identical area, W×H and fill to the digit).

## Results

| scenario | n | current area | legacy W×H | fill | A_flex | A_nlttl | N_nlttl | A_nlttl W×H | A_nlttl fill | A_nlttl ms |
|---|---:|---:|---|---:|---:|---:|---:|---|---:|---:|
| chain | 10 | 679680 | 360×1888 | 0.565 | 1.00x | 1.00x | 1.00x | 360×1888 | 0.565 | 0.02 |
| chain | 30 | 2062080 | 360×5728 | 0.5587 | 1.00x | 1.00x | 1.00x | 360×5728 | 0.5587 | 0.04 |
| chain | 100 | 6900480 | 360×19168 | 0.5565 | 1.00x | 1.00x | 1.00x | 360×19168 | 0.5565 | 0.08 |
| chain | 300 | 20724480 | 360×57568 | 0.5559 | 1.00x | 1.00x | 1.00x | 360×57568 | 0.5559 | 0.16 |
| fanout | 10 | 2015200 | 2200×916 | 0.2912 | 0.83x | 0.83x | 0.83x | 1832×916 | 0.3497 | 0.01 |
| fanout | 30 | 7951008 | 6648×1196 | 0.2207 | 0.88x | 0.88x | 0.88x | 5880×1196 | 0.2495 | 0.02 |
| fanout | 100 | 42854400 | 27900×1536 | 0.129 | 0.94x | 0.94x | 0.94x | 26204×1536 | 0.1374 | 0.05 |
| fanout | 300 | 164453952 | 77136×2132 | 0.1023 | 0.91x | 0.91x | 0.91x | 70516×2132 | 0.1119 | 0.36 |
| sidecars | 10 | 1757872 | 2428×724 | 0.2853 | 0.84x | 0.84x | 1.18x | 2028×724 | 0.3416 | 0.01 |
| sidecars | 30 | 17410176 | 4284×4064 | 0.1275 | 0.79x | 0.79x | 0.78x | 3374×4064 | 0.1618 | 0.02 |
| sidecars | 100 | 47513440 | 13780×3448 | 0.1172 | 0.55x | 0.55x | 0.79x | 7636×3448 | 0.2114 | 0.12 |
| sidecars | 300 | 229154016 | 37128×6172 | 0.0866 | 0.44x | 0.44x | 0.79x | 16250×6172 | 0.1979 | 0.7 |
| mixed | 10 | 2765440 | 1160×2384 | 0.4374 | 1.00x | 1.00x | 1.10x | 1160×2384 | 0.4374 | 0.01 |
| mixed | 30 | 19339872 | 5244×3688 | 0.1594 | 0.82x | 0.82x | 1.27x | 4324×3688 | 0.1933 | 0.02 |
| mixed | 100 | 86306304 | 16752×5152 | 0.1193 | 0.80x | 0.80x | 0.93x | 13320×5152 | 0.1501 | 0.1 |
| mixed | 300 | 196310016 | 45696×4296 | 0.1338 | 0.77x | 0.77x | 1.19x | 35394×4296 | 0.1727 | 0.69 |
| tall | 10 | 3821440 | 1120×3412 | 0.3077 | 1.00x | 1.00x | 1.17x | 1120×3412 | 0.3077 | 0 |
| tall | 30 | 25050480 | 4588×5460 | 0.1759 | 0.64x | 0.64x | 0.83x | 2928×5460 | 0.2757 | 0.02 |
| tall | 100 | 124419200 | 11800×10544 | 0.1395 | 0.51x | 0.51x | 0.93x | 6048×10544 | 0.2722 | 0.1 |
| tall | 300 | 469627776 | 40016×11736 | 0.1058 | 0.48x | 0.48x | 0.94x | 19372×11736 | 0.2186 | 0.41 |
| **realistic** | 71 | 63072000 | 8760×7200 | 0.1166 | 0.36x | 0.36x | 0.35x | 3160×7200 | 0.3232 | 0.05 |

`realistic` = the shape that actually matters: a 12-turn chain where each turn spawns 1–4
sub-agent cards (heights 140–820 px), some with their own turn work and depth-2 sub-agents.

### Summary (20 synthetic scenarios)

| engine | mean area vs current | best | worst | overlaps | direction violations | 300-node ms |
|---|---|---:|---:|---:|---:|---:|
| A_flex | 0.811x | 0.44x | 1.00x | 0 | 0 | 0.7–4.4 |
| A_nlttl | **0.811x** | **0.44x** | **1.00x** | **0** | **0** | **0.16–0.70** |
| N_nlttl | 0.973x | 0.78x | **1.27x** | 0 | 0 | 0.04–0.4 |

Correction: the earlier report's headline "A_flex 0.86x average" was wrong; the table it
came from averages to **0.811x**. This run reproduces that table exactly.

## Why design N was rejected despite being the smallest glue

Design N lets the engine own the reservation (inflate `width` by `agentGap + blockW`,
`height` to `max(cardH, blockH)`), which removes *all* collision code (~40 lines). It is
constructively overlap-free — but the vertical inflation pushes a node's turn children
**below its sidecar block**, so a session with tall sub-agent blocks becomes a long thin
ribbon: the realistic scenario lands at **1160×19080** (vs 3160×7200 for design A) for
essentially the same area, and it is *worse than the current packer* on 5 of 20 synthetic
scenarios (worst 1.27x). Area is not the only cost — a 19,080 px-tall canvas is worse to
navigate than a balanced one. Rejected.

## Verdict

**Engine: `non-layered-tidy-tree-layout@2.0.2` (MIT). Strategy: A (turn-only engine pass +
sidecar packing).**

- Same geometry as the WTFPL `d3-flextree` (byte-for-byte identical metrics) — the MIT
  license costs nothing.
- 2–7× faster than `d3-flextree` at n=300, and 2–65× faster than the old O(n²) packer
  (old: 10.4 ms on a 300-turn chain; new: 0.16 ms).
- Never worse than the old layout (worst ratio 1.00x on pure turn chains, where the two are
  identical by construction).
- Reclaims the space that was wasted: sidecar-heavy trees 0.44x, tall 0.48x, the realistic
  session 0.36x; fill factor 0.087 → 0.198 (sidecars n=300) and 0.117 → 0.323 (realistic).
- 0 overlaps and 0 direction violations in every scenario, including the 300-node ones.

Hand-written logic that remains (unavoidable — no package expresses "some children below,
some to the side" natively; see `../prior-art/sidecar-verdict.md`): the turn/agent child
partition, the sidecar window stacking and the 1-D leftmost-fit band scan (~110 lines in
`media/tree.js`). Everything geometric — contour packing, subtree separation, variable-size
placement, tidy centring — is the package's.

---

# REVISION 2 — strategy A was wrong; shipped design N instead

**Trigger:** the user reported, on a real 109-node / 36-agent session (`mtsu3t96x05msc`,
"This is a plan task…"): *"Node B placed between Node A and its subagents"*.

**Diagnosis.** Area/overlap metrics cannot see this defect. Strategy A lays out the turn
tree first and packs each sidecar window afterwards, pushing it right past whatever card
already occupies its y-band. The result is overlap-free but relationally wrong: unrelated
cards end up between a parent and its own windows, and the parent→window connector (the
cubic bezier in `media/main.js drawEdges`) cuts across them.

Added two metrics (`violations.js`, exactly the webview geometry):

- **interposition** — a foreign card horizontally between a parent card and one of its
  windows, inside the window's y-band (the parent's own other windows do not count);
- **crossing** — the parent→window bezier passing through a foreign card.

Measured on the real session (109 nodes / 36 agents, heuristic heights, cards capped at the
CSS 600px):

| layout | canvas | interpositions | crossings |
|---|---|---:|---:|
| strategy A (shipped at the time) | 4660×27896 | **26** | **26** |
| pre-vendoring hand-written packer (`legacy-tree.js`) | 12344×27896 | 5 | 4 |
| **design N (engine-owned reservation)** | 4984×31152 | **0** | **0** |

Swept across **all 7 persisted sessions that contain agent nodes**:

| session | nodes/agents | strategy A int/cross | legacy int/cross | design N int/cross | design N canvas |
|---|---|---|---:|---:|---:|---|
| mtsu3t96x05m | 109/36 | 26/26 | 5/4 | **0/0** | 4984×31152 |
| mtt7sjpjmoj5 | 43/31 | 10/7 | 7/5 | **0/0** | 2328×9774 |
| mttc2rlx6j9z | 17/11 | 1/0 | 1/1 | **0/0** | 1160×5914 |
| mtu9u1lvlz7i | 68/27 | 12/12 | 12/10 | **0/0** | 1496×35064 |
| mtuezs4o69w5 | 3/2 | 0/0 | 0/0 | 0/0 | 760×1264 |
| mtufn9h1cda8 | 11/10 | 0/0 | 0/0 | 0/0 | 1160×4384 |
| mtuimzc6vivr | 9/7 | 0/0 | 0/0 | 0/0 | 760×5056 |

Design N is the only variant with zero interpositions and zero crossings on every session,
and it is ~2.2× smaller in area than the pre-vendoring packer on the big ones (mtsu:
155M vs 344M; mtu9u: 52M vs 118M; mtt7sjpjmoj5: 23M vs 51M). It costs ~10–20% area versus
strategy A, which is the price of correctness (strategy A's canvas is only smaller because
it is broken).

**Wrapped blocks were tested and rejected** (`designN2`/`designN3`, windows side by side):
they remove interpositions but the parent→window connector then crosses the parent's *own*
other windows (13 / 18 crossings on the real session) and area grows (7192×28976 and
8848×28352). Vertical single-column stacking inside the reserved box stays clean.

**What shipped:** design N in `media/tree.js`. On the 20 synthetic scenarios it is identical
to `layoutEngineReserve`, with 0 overlaps / 0 interpositions / 0 *foreign* crossings
(remaining crossings are the parent's own sidecar descendants, inside the parent's reserved
area — see `verify-tree.js`). Mean area 0.973× the pre-vendoring packer, worst 1.27×, best
0.78×; at n=2000 it is 4 ms with 0 interpositions. Reproduce:
`node verify-tree.js` and `node analyze-interposition.js check ALL heights=heuristic engine=shipped`.


---

# REVISION 3 — the sidecar becomes a column-major lattice (design G)

**Trigger:** heavy parallel work. Real sessions in this workspace reach 4–7 agent
children on one parent, and a 12-way `spawn_agents` is a normal shape. Under design N
every window of one parent stacked in *one* column, so a 12-way spawn became a 12-row
ribbon (worst sidecar block measured: **11224 px**), and because a node's box is
`max(cardH, blockH)` tall, every extra window pushed that node's own turn children
further down.

**Design G** (shipped in `media/tree.js`) keeps design N's reservation contract and
changes only the block's *shape*:

- the windows are packed **column-major into an aligned lattice**: at most
  `agentMaxRows` (4) rows per column, and every further window opens a column to the
  right — `X0Y0…X0Y3, X1Y0…X1Y3, X2Y0…`;
- rows are aligned across columns and columns across rows: the lattice lines are
  anchored on the window **cards**, each column/row reserving the largest card
  overhang (a subtree box is the bbox of the whole branch and the engine centres a
  card over its children, so anchoring on boxes would drift);
- `agentTopPad` (16 px) opens a corridor above row 0, `agentColGap` (48 px) between
  columns, `agentVGap` (24 px) between rows. `layoutTree()` returns those corridors
  per window (the `cells` routing table), and `media/main.js drawEdges()` now routes
  the parent→window connector as an **orthogonal elbow** through them instead of a
  cubic spline. That is what REVISION 2's side-by-side trials were missing — their
  connectors cut across the parent's own nearer windows (13/18 crossings).

**Sweep** (`node grid-sweep.js`; synthetic profiles + all 7 persisted sessions with
agent nodes; `legacy` = pre-grid single column; ratios are whole-corpus sums):

| R | area | canvas height | worst sidecar block | defects (all kinds) | lattice violations |
|---|---:|---:|---:|---:|---:|
| legacy (one column) | 1.000 | 1.000 | **11224** | 0 | 0 |
| 1 (one long row) | 1.098 | 0.753 | 4004 | 0 | 0 |
| 2 | 1.036 | 0.880 | 5512 | 0 | 0 |
| 3 | **0.969** | 0.924 | 6384 | 0 | 0 |
| **4 (shipped)** | 0.976 | 0.947 | 6528 | 0 | 0 |
| 6 | 0.996 | 0.976 | 7980 | 0 | 0 |
| 8 | 0.995 | 0.984 | 8768 | 0 | 0 |

R=3 and R=4 are within 1% of each other; R=4 ships because it matches the 4-row
mental model and the real corpus (max 7 siblings → 1–2 columns). The area win over
the single column is small (2.4%) because a tall turn spine usually dominates; the
real win is the **bounded vertical push** (worst block 11224 → 6528) and the fact
that a 12-way spawn fans out sideways instead of stretching the canvas downwards.

**Evidence at R=4:**

- `node verify-tree.js` — 24/24 scenarios (incl. the new `parallel` profile, up to 12
  windows per parent): `maxDelta=0` against `layoutEngineReserveGrid`, 0 overlaps, 0
  interpositions, 0 foreign **and** 0 own-group crossings, 0 lattice violations.
- `node analyze-interposition.js check ALL heights=heuristic` — 7/7 real sessions
  0/0. Sessions whose fan-out fits one column keep design N's geometry plus the
  16 px top pad (e.g. `mtsu3t96x05m` 4984×31264 vs 4984×31152); the two with a 5–6-way
  fan-out wrap and shrink (`mtu9u1lvlz7i` 1496×32696 vs 1496×35064;
  `mtuimzc6vivr` 1128×3200 vs 760×5056).
- `tools/research/bench/render-svg.js` renders any synthetic profile or persisted
  session to SVG (`--r <rows>`), with the same cards and connectors the webview
  draws — the visual check for a shape metrics cannot judge. Committed previews at
  `--r 4`: `preview-parallel.svg` (synthetic `parallel` 60), `preview-7agents.svg`
  (`mtu9u1lvlz7i`, 7-way fan-out), `preview-mtsu.svg` (`mtsu3t96x05msc`, 36 agents).

**REVISION 2's rejection of side-by-side windows is therefore narrowed, not erased:**
"wrap the windows and keep the old spline connector" is still rejected (that is what
measured 13/18 own crossings). The shipped combination is *grid + corridor routing*,
where the connector never leaves a card-free gap.
