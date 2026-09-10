# Prior art & gap check — variable-size rectangular tree layout with sidecar children

Scope: VS Code webview chat tree. **Turn** children hang *below* the parent; **sub-agent
(`agent`) cards sit to the RIGHT of the parent**. Cards are DOM elements with measured,
variable width/height. Target: replace the hand-written `media/tree.js` packer with a
proven algorithm/package, vendored as a single file, pinned forever.

Repo context that constrains the answer:
- `package.json` → `"license": "MIT"`, **zero runtime dependencies** (everything in `media/`
  is hand-vendored, e.g. `media/markdown-it.min.js`).
- `media/tree.js` is 116 lines, pure, exposed as `window.treeLayout.layoutTree`.
- `media/main.js` `relayout()` (line ~1021) is called on every streamed token (rAF-throttled),
  reads `offsetWidth/offsetHeight` for all cards, writes all positions; `collectLayout()`
  does an **O(n²) pairwise overlap check** (line ~1068, debounced 400 ms).
- So: two edge directions per node, variable sizes, frequent full relayout, MIT.

---

## 1. Algorithmic families and trade-offs (our exact case)

| # | Family | Canonical algorithms | JS packages | Complexity | Variable W/H nodes? | 2nd edge direction / sidecar? | Deterministic | Maintenance / license | Fit |
|---|--------|----------------------|-------------|-----------|--------------------|-------------------------------|---------------|-----------------------|-----|
| 1 | **Layered tidy tree** | Reingold–Tilford 1981; Walker 1990; Buchheim–Jünger–Leipert 2002 | `d3-hierarchy` `tree()`, `@mermaid-js/layout-tidy-tree` (no), `xyflow-tree` | O(n) | ❌ **assumes uniform node box + uniform level height** | ❌ one direction | ✅ | d3-hierarchy ISC, maintained | ❌ overlaps variable cards |
| 2 | **Non-layered tidy tree (variable size)** | van der Ploeg 2013 | `d3-flextree`, `non-layered-tidy-tree-layout`, `@mermaid-js/layout-tidy-tree` | O(n) | ✅ **designed for it** | ❌ one direction only | ✅ | MIT / WTFPL; see §4 | ✅ **core**; needs sidecar pass |
| 3 | **Tidy tree + side nodes** | van der Ploeg + spouse/sibling extension | `entitree-flex` | O(n) | ✅ | ✅ **side nodes in all 4 orientations** | ✅ | GPL-3.0, last push 2022-04, 88★ | ⚠️ algorithmically ideal, **license blocker** |
| 4 | **Sugiyama layered (DAG)** | Sugiyama–Tagawa–Toda 1981 | `@dagrejs/dagre`, `dagre`, `d3-dag`, `graphre` | O(n log n)…O(n^1.6) + crossings | ✅ node w/h | ❌ single `rankdir` per graph | mostly ✅ | MIT | ⚠️ overkill, edge routing, no sidecar |
| 5 | **Compound / hierarchical** | ELK layered + `INCLUDE_CHILDREN`; Graphviz clusters | `elkjs`, `dagre-compound`, `@hpcc-js/wasm-graphviz` | heavier (multi-level passes) | ✅ (with bugs, see §3) | ✅ **per-parent direction** | ✅ | EPL-2.0 / MIT / EPL-1.0 | ⚠️ size, license, per-relayout cost |
| 6 | **Rectangle packing / skyline** | MaxRects, skyline/shelf, guillotine | `maxrects-packer`, `bin-packing` | O(n log n) | ✅ (its whole point) | ❌ ignores parent-child | ✅ | MIT | ❌ loses tree structure |
| 7 | **Force-directed** | Barnes–Hut, ForceAtlas2 | `d3-force`, `graphology-layout-forceatlas2`, `@cosmos.gl/graph` | O(n log n)/tick × many ticks | ✅ via collide force | ❌ | ❌ **jitter** | MIT/ISC (cosmos CC-BY-NC) | ❌ unstable UI |
| 8 | **Constraint-based** | Cassowary; flexbox; AutoLayout VFL | `kiwi.js`, `yoga-layout` | solve O(n)-ish | ✅ | ✅ **nested flex-direction per container** | ✅ | MIT | ⚠️ no tidy/centering; poor aesthetics |

### 1.1 Layered tidy tree (Reingold–Tilford / Walker / Buchheim)
- Reingold & Tilford, *Tidier Drawings of Trees*, IEEE TSE 1981 — https://doi.org/10.1109/TSE.1981.230844
- Walker, *A node-positioning algorithm for general trees*, SPE 1990 — https://doi.org/10.1002/spe.4380200705
- Buchheim, Jünger, Leipert, *Improving Walker's Algorithm to Run in Linear Time*, GD 2002 — https://doi.org/10.1007/3-540-45848-4_27
- `d3-hierarchy.tree()` implements exactly this; the docs state it is the Reingold–Tilford
  algorithm improved to linear time by Buchheim et al. — https://d3js.org/d3-hierarchy/tree
- **The trap:** these algorithms model a node as a point/uniform box. `tree.nodeSize([w,h])`
  is a *single* uniform size for the whole tree; `separation(a,b)` receives the two nodes
  but **not their measured sizes**, so any card wider/taller than the assumed box overlaps
  its neighbour. This is the canonical "naive tidy tree breaks with variable sizes" failure.

### 1.2 Non-layered tidy tree (variable sizes, linear time) — **the correct family**
- A.J. van der Ploeg, *Drawing Non-layered Tidy Trees in Linear Time* (2013):
  paper https://ir.cwi.nl/pub/21856 · PDF https://ir.cwi.nl/pub/21856/21856B.pdf ·
  DOI https://doi.org/10.1002/spe.2213 · reference Java impl https://github.com/cwi-swat/non-layered-tidy-trees
- Uses **contour threading** (`el/er/msel/mser`, left/right contours) to pack subtrees of
  *arbitrary* width/height with no overlap and no wasted reservation, in O(n).
- JS ports:
  - `d3-flextree` — https://github.com/Klortho/d3-flextree · https://www.npmjs.com/package/d3-flextree
    (WTFPL; `nodeSize` + `spacing` accessors; O(n)). **Unmaintained**: the author
    Chris Maloney passed away — https://github.com/Klortho/d3-flextree/issues/38.
    Known variable-size spacing quirk: https://github.com/Klortho/d3-flextree/issues/36.
  - `non-layered-tidy-tree-layout` — https://github.com/stetrevor/non-layered-tidy-tree-layout ·
    https://www.npmjs.com/package/non-layered-tidy-tree-layout (MIT, **zero deps**,
    explicit `width`/`height` per node, `BoundingBox(gap, bottomPadding)`, returns
    `{result, boundingBox:{left,right,top,bottom}}`).
  - `@mermaid-js/layout-tidy-tree` — https://www.npmjs.com/package/@mermaid-js/layout-tidy-tree
    (MIT). Mermaid's mindmap engine; its `package.json` bundles
    `non-layered-tidy-tree-layout@^2.0.2` — independent corroboration that this is the
    maintained, correct variable-size engine.
- **Gap:** all of these are *single-direction* (top-down or left-right). None emits a
  sidecar column, so the "agent cards to the right" axis must be added by us or by a
  compound engine.

### 1.3 Tidy tree with side nodes — `entitree-flex` (the only native fit)
- https://github.com/codeledge/entitree-flex · https://www.npmjs.com/package/entitree-flex
- README: a port of van der Ploeg extended with **side nodes** ("spouses"/"siblings"),
  `orientation: "vertical"` (parents top, children bottom) with side nodes left/right —
  *exactly* our turn-below + agent-right shape. Variable sizes via `enableFlex`
  (`node.width`/`node.height`), linear runtime, TS types, zero runtime deps.
- Settings map 1:1 onto our model: `targetsAccessor:"children"` = turn children below;
  `nextAfterAccessor:"spouses"` = agent sidecars to the right; `nextBeforeAccessor:"siblings"`.
- **Blocker:** **GPL-3.0** (README), repo has no SPDX license detected, last push
  2022-04-25, 88★. Vendoring GPL code into an MIT extension is a licensing problem.
  (The *algorithm/idea* is not patented; a clean-room reimplementation is possible.)

### 1.4 Sugiyama layered (dagre, d3-dag, ELK)
- Sugiyama, Tagawa, Toda 1981 — https://doi.org/10.1109/TSMC.1981.4308636
- `@dagrejs/dagre` (MIT, 3.1.1) / `dagre` (0.8.5, stale) — https://github.com/dagrejs/dagre.
  Accepts per-node `width`/`height`, but ranks nodes into layers and adds edge routing;
  **no native compound** support (open issues: https://github.com/dagrejs/dagre/issues/467,
  https://github.com/dagrejs/dagre/issues/238) and a single `rankdir` for the whole graph.
- `d3-dag` (MIT, 1.5k★) — https://github.com/erikbrinkman/d3-dag. Sugiyama/Zherebko/grid,
  variable node sizes, TS, small bundle; explicitly positioned as a dagre replacement.
  Still one global direction, DAG-oriented.
- `elkjs` layered — see §3. Handles variable sizes and compound, but is the heaviest option.
- Verdict: a tree is a degenerate DAG; layered layout buys nothing here and costs
  crossing-minimisation passes, edge routing we don't want, and no sidecar axis.

### 1.5 Rectangle packing / skyline
- `maxrects-packer` (MIT, 0 deps) — https://github.com/soimy/maxrects-packer; skyline /
  shelf / guillotine are classic 2D bin-packing heuristics.
- Solves "variable rectangles, zero overlap" but **throws away the tree**: children no
  longer sit under parents and sidecars no longer sit beside them. Usable only as a
  last-resort de-overlap pass, never as the layout.

### 1.6 Force-directed
- `d3-force` (ISC) — https://d3js.org/d3-force; `graphology-layout-forceatlas2` (MIT);
  `@cosmos.gl/graph` (CC-BY-NC — license trap).
- Variable sizes via `forceCollide` radius, but positions are the fixed point of an
  iterative simulation: **non-deterministic jitter**, many ticks per relayout, and no
  parent-above-child guarantee. Disqualified for a stable, frequently-relaid-out tree.

### 1.7 Constraint-based
- `yoga-layout` (MIT, 3.2.1) — https://github.com/facebook/yoga: an embeddable flexbox
  engine. You *can* express per-edge direction by nesting containers (`flexDirection:
  column` for turn children, `row` for agent children) — the only non-ELK way to get
  per-node direction natively. But flexbox gives sequential boxes, not tidy centring or
  contour packing, so the result is space-wasteful and visually unlike a tree.
- `kiwi.js` (Cassowary, MIT) — https://github.com/IjzerenHein/kiwi.js: same story; you'd
  hand-write the constraints, i.e. you're back to writing the algorithm.

---

## 2. The variable-size trap (where naive implementations break)
1. **Uniform-box assumption.** Reingold–Tilford/Walker/Buchheim and `d3-hierarchy.tree()`
   assume every node occupies the same box; `nodeSize` is global and `separation()` never
   sees measured sizes → variable cards overlap. Fix = van der Ploeg non-layered tidy tree
   (contour-based, per-node w/h). (`d3-flextree` README; https://d3js.org/d3-hierarchy/tree)
2. **Over-reservation.** Our current `media/tree.js` `subWidth()` reserves each turn
   child's *entire subtree width* in the parent's row → deep trees waste horizontal space
   exponentially. A contour-based algorithm reserves only the actual right/left contour.
3. **Recomputed subtrees.** `subWidth()`/`subHeight()` are called from `place()` and
   recurse over whole subtrees without memoisation → the current packer is **O(n²)** (and
   `collectLayout()` adds another O(n²)). Both must go.
4. **Compound/edge case bugs.** ELK's own tracker shows node widths not respected when a
   node has children — https://github.com/kieler/elkjs/issues/311 (open). Compound layout
   is the hardest case; don't assume "ELK = solved".

---

## 3. Native per-edge direction / nested compound — verified findings

### ELK (elkjs) — the known answer, with a cost
- `elk.direction` (RIGHT/LEFT/DOWN/UP) — "Applies To: **parents**", "Overall direction of
  edges" — https://eclipse.dev/elk/reference/options/org-eclipse-elk-direction.html
  i.e. **direction is set on each compound parent**, so different nesting levels can run in
  different directions.
- `elk.hierarchyHandling = INCLUDE_CHILDREN` lays out a node and all descendants in a
  single layout run — https://eclipse.dev/elk/reference/options/org-eclipse-elk-hierarchyHandling.html
- Layered algorithm explicitly supports compound graphs with cross-hierarchy edges —
  https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html
- **Cost (measured from the published package):**
  - `elkjs@0.12.0`, license **EPL-2.0 OR GPL-3.0-or-later** (must pick EPL-2.0 for MIT use).
  - unpacked **8.05 MB**; `lib/elk.bundled.js` **1.61 MB**, `lib/elk-worker.js` **4.79 MB**,
    `lib/elk-worker.min.js` **1.60 MB** — GWT-compiled Java. Vendoring one file = the
    1.61 MB bundled build; the worker build avoids blocking the UI thread.
  - Per-relayout cost is far above a tidy tree (ranking + crossing minimisation + edge
    routing); risky for a `relayout()` that fires on every streamed token.
  - repo https://github.com/kieler/elkjs · docs https://eclipse.dev/elk/
- **Verdict:** it *does* natively do per-edge direction, but it is the largest, slowest and
  licence-heaviest option, and it solves a harder problem than ours.

### Others
- **Graphviz** — cluster subgraphs can override `rankdir`; `@hpcc-js/wasm-graphviz`
  (Apache-2.0 wrapper, 2.08 MB, zero deps) ships the EPL-1.0 engine as WASM
  (https://graphviz.org/docs/attrs/rankdir/, https://github.com/hpcc-systems/hpcc-js-wasm).
  Proven engine, variable node sizes, but WASM size + cluster `rankdir` quirks + async load.
- **dagre** — **no** native compound support (issues above); `dagre-compound` (MIT,
  0.0.13, 2022) bolts it on, still one direction.
- **entitree-flex** — native side nodes, but GPL-3.0 (§1.3).
- **yoga-layout** — native nested direction via flex containers, but not a graph layout.
- No permissive, maintained, single-file package does *variable-size tidy tree + sidecar*.

---

## 4. Packages we may have missed (npm + GitHub sweep)

Searches run against the npm registry search API (`tidy tree layout`, `tree layout`,
`sugiyama`, `graph layout`, `dagre`, `elk layout`, `hierarchy layout`, `family tree layout`,
`pedigree layout`, `side nodes tree layout`, `mindmap layout`) and the GitHub repo API.

| Package | License | Size (unpacked) | Notes / verdict |
|---|---|---|---|
| `non-layered-tidy-tree-layout` 2.0.2 | MIT | 61 KB (dist UMD **5.6 KB**, 0 deps) | van der Ploeg port; variable w/h; O(n); **best vendorable core** |
| `d3-flextree` 2.1.2 | WTFPL | 704 KB (build **9 KB min**) | Same algorithm; `d3-hierarchy` dep; **author deceased, unmaintained** |
| `@mermaid-js/layout-tidy-tree` 0.2.2 | MIT | 248 KB | Mermaid mindmap; bundles `non-layered-tidy-tree-layout`; single direction |
| `entitree-flex` 0.4.1 | **GPL-3.0** | 144 KB | **Only tidy-tree package with side nodes**; stale 2022; license blocker |
| `elkjs` 0.12.0 | EPL-2.0 OR GPL-3.0 | 8.05 MB | Native compound + per-parent direction; heavy (see §3) |
| `dagre-compound` 0.0.13 | MIT | 1.16 MB | dagre + compound; single direction; 2022 |
| `@dagrejs/dagre` 3.1.1 | MIT | — | Layered, variable node size, no compound |
| `d3-dag` 1.x | MIT | small | Sugiyama/Zherebko/grid; dagre replacement; no sidecar |
| `graphre` 0.1.3 | MIT | 62 KB | dagre successor by original author; 0 deps; layered |
| `sun-hierarchy` 1.0.1 | MIT | 249 KB | Sugiyama framework; `lodash` dep; niche |
| `eland` 0.2.4 | ISC | 779 KB | ELK-Layered-compatible TS; no compound direction |
| `@antv/hierarchy` 0.7.1 | MIT | 145 KB | compactBox/mindmap; `direction: 'LR'`, `getWidth/getHeight` — variable size, **single direction** |
| `@plait/layouts` 0.94.0 | MIT | — | Mind-map logic; framework-coupled |
| `clarity-mind` 0.1.3 | MIT | — | Headless mind-map + tidy-tree; new (2026-07) |
| `@nodus-dev/layout-tree` 1.0.0 | MIT | — | Dependency-free tidy-tree adapter; new (2026-08) |
| `auto-tree-layout` 0.0.2 | MIT | — | 5 strategies on non-layered tidy tree; new, unproven |
| `xyflow-tree` 0.3.0 | MIT | 42 KB | **Repo URL 404s** (github.com/codeledge/xyflow-layout) → unverifiable, treat as unsafe |
| `simple-family-tree-layout` 0.2.45 | MIT | 42 KB | React + TanStack deps → not vendorable into a vanilla webview |
| `yoga-layout` 3.2.1 | MIT | 224 KB | Flexbox engine; nested direction but no tidy packing |
| `maxrects-packer` 2.7.3 | MIT | 370 KB | 2D bin packing; loses tree structure |
| `d3-force` 3.0.0 | ISC | 90 KB | Non-deterministic jitter |
| `kiwi.js` | MIT | — | Cassowary; you write the constraints yourself |

**Prior art — chat/session-tree UIs with sidecar branches** (none solves the layout):
- `stello-agent/stello` (Apache-2.0) — session-tree *data model* (`packages/core/src/session/session-tree.ts`), not a layout engine; https://github.com/stello-agent/stello
- `Robbings/chatgpt-graph-navigator` (127★) — knowledge-graph view of ChatGPT branches
- `iterabloom/BranchyMcChatFace` (MPL-2.0), `lukasgabriel/ChatGPT-Tree-Viz`,
  `akivacp/chatgpt-json-tree-viewer` — viewers, custom/D3 drawing, no reusable layout.
- Conclusion: **no off-the-shelf chat-tree layout exists**; the sidecar axis is genuinely novel.

---

## 5. Failure modes to avoid (checklist for whatever we pick)

| Failure mode | Cause | How the choice must prevent it |
|---|---|---|
| **Overlapping cards** | Uniform-box tidy tree; ELK compound width bugs (#311) | Contour-based variable-size tidy tree, or verify sizes after layout |
| **Non-deterministic jitter** | Force-directed iteration; unstable sibling order; `Math.random` | Deterministic algorithm + **stable child sort** (id/createdAt), no random seeds |
| **O(n²) blowup at 300 nodes** | Recomputed subtree metrics; pairwise overlap test | O(n) layout; drop `collectLayout()`'s O(n²) scan (use spatial hash if needed) |
| **Layout thrash on every token** | Full re-measure + re-write per rAF; ELK/force per tick | Dirty-set on size change, coalesce to one rAF, skip unchanged positions |
| **Dependency / license risk** | GPL-3.0 (entitree-flex), EPL-2.0 (elkjs), CC-BY-NC (cosmos) | Prefer MIT/ISC/WTFPL; pin exact version + integrity; vendor LICENSE + source |

Notes specific to the current code:
- `relayout()` reads `offsetWidth/Height` for every card then writes every card's
  `left/top`; during streaming this is a forced reflow per frame. A proven O(n) layout
  won't fix the thrash by itself — add a dirty-set + coalescing pass.
- `collectLayout()` is O(n²) and only debounced 400 ms; at 300 nodes it is ~45 k pair tests
  per run. Replace with a spatial hash or delete once overlap is structurally impossible.

---

## 6. Recommendation

**Family:** variable-size **non-layered tidy tree** (van der Ploeg 2013) with a
**sidecar/contour extension** for the agent axis. This is the only family that is
simultaneously O(n), deterministic, overlap-free for measured rectangles, and cheap enough
to re-run on every streamed token. Everything else either ignores variable sizes
(layered tidy tree), ignores the tree (packing), jitters (force), or is too heavy/licensed
for a MIT single-file vendoring (ELK).

**One package, if it were my call:** **`non-layered-tidy-tree-layout@2.0.2` (MIT)** as the
vendored core (single 5.6 KB UMD file, zero deps, per-node `width`/`height`, returns a
`boundingBox`), plus ~150–250 lines of *our own* sidecar glue:
1. Lay out the turn-only forest with the tidy tree → turn positions + per-subtree bbox.
2. For each node with agent children, lay each agent subtree out independently (same
   engine) and stack them vertically to the right of the parent's **subtree bbox** (not the
   card), then fold the agent block into the bbox and run one linear contour/shift pass so
   neighbouring sibling subtrees cannot overlap.
3. Keep sibling order stable (id/createdAt) for determinism; feed only measured sizes.

Why not the alternatives:
- `d3-flextree` — same algorithm, WTFPL, but **unmaintained since the author's death**
  (issue #38) and has an open variable-size spacing complaint (#36). Fine fallback.
- `entitree-flex` — does exactly our shape natively and in O(n), but **GPL-3.0** is
  incompatible with vendoring into an MIT extension; its side-node algorithm is
  reimplementable clean-room if we want to borrow the idea.
- `elkjs` — the only package with true per-parent direction, but 1.61 MB bundled,
  EPL-2.0, worker-oriented, and per-relayout cost too high for token-rate relayout.
- `d3-force` / packing — jitter / no tree semantics.

If the team refuses *any* custom algorithm code, the fallback is `elkjs` with
`hierarchyHandling: INCLUDE_CHILDREN` + per-compound `elk.direction` (DOWN for turn,
RIGHT for the agent compound) — accept the size, EPL-2.0 and relayout cost.

### Sources (primary)
- Reingold–Tilford 1981 https://doi.org/10.1109/TSE.1981.230844
- Walker 1990 https://doi.org/10.1002/spe.4380200705
- Buchheim et al. 2002 https://doi.org/10.1007/3-540-45848-4_27
- d3-hierarchy tree docs https://d3js.org/d3-hierarchy/tree
- van der Ploeg 2013 https://ir.cwi.nl/pub/21856 · https://ir.cwi.nl/pub/21856/21856B.pdf
- reference Java impl https://github.com/cwi-swat/non-layered-tidy-trees
- d3-flextree https://github.com/Klortho/d3-flextree (issues #38, #36)
- non-layered-tidy-tree-layout https://github.com/stetrevor/non-layered-tidy-tree-layout
- mermaid tidy tree https://www.npmjs.com/package/@mermaid-js/layout-tidy-tree
- entitree-flex https://github.com/codeledge/entitree-flex
- Sugiyama 1981 https://doi.org/10.1109/TSMC.1981.4308636
- dagre https://github.com/dagrejs/dagre (issues #467, #238)
- d3-dag https://github.com/erikbrinkman/d3-dag
- ELK https://eclipse.dev/elk/ · elkjs https://github.com/kieler/elkjs (issue #311)
- ELK direction https://eclipse.dev/elk/reference/options/org-eclipse-elk-direction.html
- ELK hierarchyHandling https://eclipse.dev/elk/reference/options/org-eclipse-elk-hierarchyHandling.html
- ELK layered https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html
- Graphviz rankdir https://graphviz.org/docs/attrs/rankdir/ · hpcc-js/wasm https://github.com/hpcc-systems/hpcc-js-wasm
- d3-force https://d3js.org/d3-force · yoga https://github.com/facebook/yoga · kiwi.js https://github.com/IjzerenHein/kiwi.js
- maxrects-packer https://github.com/soimy/maxrects-packer
- chat-tree prior art https://github.com/stello-agent/stello
