# Sidecar verdict — native package vs glue

Question: can "agent cards to the RIGHT of the parent" be produced by a permissively
licensed package instead of hand-written placement logic?

**Answer: no. Glue is required.** Every native implementation of that shape is either
copyleft/unlicensed or too heavy. The glue is minimised to the child-kind partition + a
1-D band scan; all contour packing / separation / tidy placement is package-owned.

## 1. `entitree-flex` — UNUSABLE (two independent blockers)

The two earlier reports disagreed ("no license" vs "GPL-3.0"); both readings block vendoring.

| check | result | source |
|---|---|---|
| npm `versions['0.4.1'].license` | **absent** | https://registry.npmjs.org/entitree-flex |
| tarball `package.json` | **no license field**, `files:["/dist"]` | https://unpkg.com/entitree-flex@0.4.1/package.json |
| tarball contents | **no LICENSE file**; CJS `tsc` output only | https://unpkg.com/entitree-flex@0.4.1/?meta |
| GitHub API `license` | **`null`** | https://api.github.com/repos/codeledge/entitree-flex |
| README | **"GNU General Public License v3.0"**, "Copyright (c) 2022, Codeledge" | https://raw.githubusercontent.com/codeledge/entitree-flex/main/README.md |

Read as GPL-3.0 → copyleft, incompatible with this MIT extension. Read as "no license" →
all rights reserved, no redistribution right at all. Also: CJS-only (no UMD for a plain
`<script>`), last push 2022-04, 2.4k weekly downloads. **Out.**

## 2. Fresh sweep — no permissive native option exists

Searched npm registry + GitHub with: side nodes tree layout, spouse node tree, org chart /
family tree layout javascript, tidy tree side branch, mindmap variable size, sugiyama
same-rank edges, conversation/thread tree UI.

| package | license | native side nodes? |
|---|---|---|
| `entitree-flex` | GPL-3.0 / none | yes — **unusable** (§1) |
| `elkjs@0.12.0` | EPL-2.0 OR GPL-3.0+ | yes (per-compound `elk.direction`) — 1.57 MB + copyleft engine |
| `@viz-js/viz` / `@hpcc-js/wasm-graphviz` | wrapper MIT/Apache, **Graphviz engine EPL-2.0** | yes (`rank=same` + `constraint=false`) — 0.8–1.3 MB + needs `'wasm-unsafe-eval'` in CSP |
| `@mermaid-js/layout-tidy-tree@0.2.2` | MIT | no; ESM-only + `d3@^7` + peer `mermaid` → not loadable from a plain nonce'd script |
| `simple-family-tree-layout` | MIT | family model, React-only |
| `d3-flextree`, `non-layered-tidy-tree-layout`, `@antv/hierarchy`, `@plait/layouts` | WTFPL / MIT | no — single direction |
| `@dagrejs/dagre@3.1.1` | MIT | no — one `rankdir`; `minlen:0` **crashes**; cluster `rankdir` only changes direction *inside* the cluster (agents still land below, 81–135 violations at n=300) |
| `yoga-layout` | MIT | partial (nested `flexDirection`) but flexbox ≠ tidy tree |

Conclusion: the two-direction tree is not available off the shelf under a permissive license.

## 3. `d3-flextree`'s hooks cannot express direction

`extents` is a **read-only computed getter** (subtree bbox output), not an input hook;
the only geometry inputs are `nodeSize` and `spacing`. A child is always placed at
`parent.y + parent.ySize`. So no package API can say "this child goes right" — but box
inflation *can* make the engine reserve space for a sidecar (tested as design N, rejected
in `../bench/nlttl-benchmark.md`: mean 0.973x, worst 1.27x, and it turns a 12-turn session
into a 1160×19080 ribbon).

## 4. Minimal glue (shipped in `media/tree.js`)

Package-owned: contour packing, subtree separation, variable-size placement, tidy centring,
subtree bounding boxes, determinism, O(n) behaviour.
Hand-written (~90 lines, no collision resolution):

1. split children into turn kids / agent kids (`kind === 'agent'`),
2. for each node, lay out each agent subtree **recursively** with the same algorithm and
   pack the windows into one grid: **column-major**, at most `agentMaxRows` (4) rows per
   column, a new column to the right per further window — rows aligned across columns and
   columns aligned across rows, lattice lines anchored on the window cards, each column/row
   reserving the largest card overhang (block width = Σ column reservations + gaps, height =
   `agentTopPad` + Σ row reservations + gaps),
3. build the engine tree over the turn spine with each node's box **inflated** by its grid
   (`agentGap + blockW` wide, `max(cardH, blockH)` tall) — the engine then reserves the
   sidecar rectangle itself,
4. place each grid inside that reserved box at the parent card's right edge, and hand the
   webview the `cells` routing table (`busX` / `chanX` / `corrY`) so `media/main.js
   drawEdges()` can route each connector through the row/column gaps as an orthogonal elbow
   — every segment card-free by construction, which is what removes the connector crossings
   that sank the earlier side-by-side trial (see `../bench/nlttl-benchmark.md` REVISION 3).

Overlap-freedom *and* non-interposition follow by construction: the block lives inside the
parent's exclusive rectangle, so no card can overlap a window or sit between a parent card
and its own sub-agents. Verified on 24 synthetic scenarios (`verify-tree.js`, incl. a
`parallel` profile with up to 12 windows per parent) and on all 7 persisted sessions that
contain agent nodes (`analyze-interposition.js check ALL`): 0 overlaps, 0 interpositions,
0 connector crossings — foreign *and* own-group (the corridors are card-free), plus 0
lattice violations (`gridBad` in `grid-sweep.js`). A post-hoc packing variant (lay out
first, pack windows into free space afterwards) is more compact on paper but measured 26
interpositions / 26 crossings on the real 109-node session — see
`../bench/nlttl-benchmark.md` REVISION 2.
