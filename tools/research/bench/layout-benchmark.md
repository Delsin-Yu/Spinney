# Chat-tree layout: space-waste measurement + replacement design

Scope: research only. Everything here lives under `.agent-harness/research/bench/`
(gitignored). No `media/` or `src/` file was modified. Candidate packages are
installed **isolated** with `npm install --no-save` into
`.agent-harness/research/bench/tmp/` (`d3-flextree@2.1.2`, `@dagrejs/dagre@3.1.1`);
the extension's own `package.json` is untouched.

## TL;DR

* The current algorithm wastes **13–56% of the canvas area** on realistic trees
  (fill ratio 0.09–0.29) and is **quadratic in chain depth** (8.6 ms for a
  300-turn chain, 94 ms for 1000 — it runs on every streaming relayout).
* Replacement: **strategy (a) — `d3-flextree` on the turn-only tree + agent
  subtrees packed into the right margin**. It keeps every invariant of the
  current algorithm (turn children below, agents right of the parent, 0 overlaps,
  0 direction violations) and cuts area to **0.44x–1.00x** (mean **0.86x**) while
  becoming **O(n)** (0.6 ms at 300 nodes, 2.4 ms at 1000).
* Strategy (b) (native compound/multi-direction, one pass) is **not viable**:
  dagre has one rankdir per graph, `minlen: 0` crashes 3.1.1, and nested
  LR-clusters produce 10–89 overlapping cards and 3–24 agents placed off the
  right edge. Strategy (c) (one pass + post-shift) leaves **55–232 overlaps**.
* The current algorithm is still better in exactly two places: (1) **wide/shallow
  trees**, where its 0.1–0.9 ms beats the candidate's 1.3–5 ms, and (2) it is a
  zero-dependency, ~60-line function whose output is already overlap-free. A
  ~1% tail of random trees can also make naive packing up to 1.23x wider (see
  "Where the current algorithm wins").

## What was measured

`bench.js` builds synthetic sessions mimicking real chats
(`synthetic.js`): turn chains, fan-out 2–6, sub-agent sidecars at depth 1 and 2
(a sub-agent's own turns + nested sub-agents), variable card sizes (320x120
default, wide 400–900, tall 600–2000) at **10 / 30 / 100 / 300 nodes**, five
profiles: `chain`, `fanout`, `sidecars`, `mixed`, `tall`.

Every engine is measured identically (`metrics.js`):

| metric | definition |
|---|---|
| area | canvas = placed-card bbox + 20 px pad, `width * height` |
| maxW / maxH | canvas width / height |
| overlaps | count of card pairs whose AABBs intersect (must be 0) |
| fill | sum(card areas) / canvas area (higher = less waste) |
| direction violations | agent card not starting at/right of parent's right edge; parent mid-Y outside agent's Y-range; turn child not below parent |
| ms | median wall clock of the layout call |

Engines: `current` = `media/tree.js` loaded through a VM shim (`current.js`);
`A_flex` = strategy (a) with d3-flextree; `A_flex_flush` = (a) + chain-flush +
deepest-first packing; `A_dagre` = strategy (a) with dagre as the engine;
`C_flex` = strategy (c); `B_dagre` = strategy (b) compound dagre.

## Metrics table — canvas area ratio, candidate / current (< 1.00 = candidate is better)

| scenario | n | current area | A flextree+pack | A flextree+pack+flush/deep | A dagre+pack | C 1-pass shift | B dagre compound |
|---|---:|---:|---:|---:|---:|---:|---:|
| chain | 10 | 679,680 | 1.00x | 1.00x | 1.00x | 1.00x | 1.00x |
| chain | 30 | 2,062,080 | 1.00x | 1.00x | 1.00x | 1.00x | 1.00x |
| chain | 100 | 6,900,480 | 1.00x | 1.00x | 1.00x | 1.00x | 1.00x |
| chain | 300 | 20,724,480 | 1.00x | 1.00x | 1.00x | 1.00x | 1.00x |
| fanout | 10 | 2,015,200 | **0.83x** | 0.83x | 0.75x | 0.83x | 0.75x |
| fanout | 30 | 7,951,008 | **0.88x** | 0.88x | 1.39x | 0.88x | 1.39x |
| fanout | 100 | 42,854,400 | **0.94x** | 0.94x | 1.33x | 0.94x | 1.33x |
| fanout | 300 | 164,453,952 | **0.91x** | 0.91x | 1.10x | 0.91x | 1.10x |
| sidecars | 10 | 1,757,872 | **0.84x** | 0.92x | 0.84x | 4.25x | 1.34x |
| sidecars | 30 | 17,410,176 | **0.79x** | 0.90x | 0.92x | 2.82x | 1.05x |
| sidecars | 100 | 47,513,440 | **0.55x** | 0.58x | 0.56x | 2.43x | 2.33x |
| sidecars | 300 | 229,154,016 | **0.44x** | 0.43x | 0.59x | 1.12x | 3.33x |
| mixed | 10 | 2,765,440 | 1.00x | 1.00x | 1.00x | 6.97x | 1.75x |
| mixed | 30 | 19,339,872 | **0.82x** | 0.90x | 0.82x | 2.38x | 1.31x |
| mixed | 100 | 86,306,304 | **0.80x** | 0.77x | 0.74x | 1.75x | 2.03x |
| mixed | 300 | 196,310,016 | **0.77x** | 0.79x | 0.98x | 1.21x | 2.87x |
| tall | 10 | 3,821,440 | 1.00x | 1.00x | 1.00x | 4.75x | 1.17x |
| tall | 30 | 25,050,480 | **0.64x** | 0.67x | 0.73x | 2.54x | 1.79x |
| tall | 100 | 124,419,200 | **0.51x** | 0.55x | 0.60x | 1.95x | 1.75x |
| tall | 300 | 469,627,776 | **0.48x** | 0.51x | 0.75x | 1.01x | 2.27x |

Mean ratio over the 20 rows: `A_flex` **0.86x**, `A_flex_flush` 0.88x,
`A_dagre` 0.91x, `C_flex` 2.04x, `B_dagre` 1.58x.

Key structural observation: **every candidate keeps `maxH` identical to the
current algorithm in all 20 scenarios** — the vertical rule (card + 72 px + child
row) is already optimal. The whole win is horizontal: sibling subtrees are packed
by contour instead of by "sum of subtree widths".

Absolute numbers for the recommended candidate (current → A_flex), fill ratio:

| scenario | n | current W x H | A_flex W x H | fill current → A_flex | overlaps | ms current → A_flex |
|---|---:|---|---|---:|---:|---:|
| mixed | 100 | 16752x5152 | 13320x5152 | 0.119 → 0.150 | 0 / 0 | 0.18 → 1.44 |
| mixed | 300 | 45696x4296 | 35394x4296 | 0.134 → 0.173 | 0 / 0 | 0.46 → 4.62 |
| sidecars | 100 | 13780x3448 | 7636x3448 | 0.117 → 0.211 | 0 / 0 | 0.22 → 1.73 |
| sidecars | 300 | 37128x6172 | 16250x6172 | 0.087 → 0.198 | 0 / 0 | 0.84 → 5.25 |
| tall | 100 | 11800x10544 | 6048x10544 | 0.140 → 0.272 | 0 / 0 | 0.25 → 1.36 |
| tall | 300 | 40016x11736 | 19372x11736 | 0.106 → 0.219 | 0 / 0 | 1.05 → 4.13 |

`agent-not-right` and `turn-not-below` are **0** for `current` and `A_flex` in
every row; `B_dagre` has 2–135 agent-placement violations per scenario.

### Wall-clock scaling (`timing.js`, median ms)

| profile | n | current | A_flex | A_flex/current |
|---|---:|---:|---:|---:|
| chain | 100 | 0.88 | 0.28 | 0.32 |
| chain | 300 | **8.73** | 0.60 | 0.07 |
| chain | 1000 | **94.34** | 2.37 | 0.03 |
| fanout | 300 | 0.26 | 0.84 | 3.20 |
| sidecars | 300 | 0.68 | 5.09 | 7.52 |
| mixed | 300 | 0.44 | 4.16 | 9.39 |
| mixed | 1000 | 1.52 | 16.08 | 10.60 |

The current algorithm is O(depth²): `subWidth`/`subHeight` are re-walked for
every child without memoization, so a 300-turn chain costs 8.7 ms **per
relayout** (relayout is rAF-throttled but fires on every streaming delta).
The candidate is O(n) for the tree pass; the packing in this prototype is
O(n²)-ish (interval scans), which is why wide trees look slower — a production
version with a sorted skyline makes it O(n log n).

### Robustness — random trees (`search.js`, 4000 trees, ≤ 24 nodes, variable sizes)

| variant | candidate worse | tie | candidate better | mean ratio | worst ratio | trees with overlaps |
|---|---:|---:|---:|---:|---:|---:|
| A_flex | 43 (1.1%) | 1423 | 2534 | 0.897 | 1.225 | 0 |
| A_flex_flush/deep | **10 / 20000 (0.05%)** | — | — | 0.907 | 1.269 | 0 |
| C_flex | 3437 (86%) | 328 | 235 | 3.561 | 18.278 | 3101 |
| B_dagre | 3014 (75%) | 302 | 684 | 1.326 | 3.572 | 0 (but invalid directions) |

The current algorithm produced 0 overlaps in all 4000 random trees — it is a
correct algorithm, just a wasteful one.

## Strategy evaluation (exact API calls)

### (a) turn-only layout + pack agent blocks into the right margin — **BEST**

```js
const { flextree } = require('d3-flextree');          // 2.1.2
const layout = flextree({
  children: (d) => d.children,                        // turn-only tree
  nodeSize: (n) => [n.data.w, n.data.h + vGap],       // ySize carries vGap
  spacing:  () => hGap,                               // horizontal sibling gap
});
const tree = layout.hierarchy(buildTurnOnly(rootId)); // {id,w,h,children}
layout(tree);                                         // n.x = centre, n.y = top
// -> pos[id] = { x: n.x - n.data.w / 2, y: n.y }
// then, for every turn node in BFS order, for each agent child:
//   block = layoutAFlex(agentSubtree)                  (recursive, same fn)
//   x0 = parent.right + agentGap                       (natural slot)
//   x  = smallest x >= x0 free of every placed rect sharing the block's y-band
//   place the rigid block at (x, parent.top), stack siblings by agentVGap
```

Measured on `mixed n=100`: 86.3 M → 68.6 M px² (**0.80x**), 0 overlaps,
0 direction violations, 1.44 ms. This is the only strategy that reproduces both
edge semantics.

### (b) native compound/nested or multi-direction support — **NOT VIABLE**

dagre has a single `rankdir` per graph; there is no per-edge direction.
Nested clusters (`compound: true`) keep parents/agents in one cluster:

```js
const g = new dagre.graphlib.Graph({ compound: true });
g.setGraph({ rankdir: 'TB', nodesep: hGap, ranksep: vGap });
g.setDefaultEdgeLabel(() => ({}));
g.setNode(id, { width, height });
g.setNode('cl_' + id, {});            // cluster per node that owns agents
g.setParent(id, 'cl_' + parent);      // nearest ancestor owner -> nesting
g.setParent(agentChild, 'cl_' + id);
g.setEdge(parent, child);             // every edge is a plain TB edge
dagre.layout(g);                      // g.node(id) -> centre x/y
```

Result on `mixed n=100`: 1.86x area, **34 agents not right of their parent**,
36 agents not vertically centred, 3 overlapping cards. Agents land below/left.

The only way to get a right-edge is `minlen: 0` (same rank):

```js
g.setEdge(parent, agentChild, { minlen: 0 });   // throws in @dagrejs/dagre 3.1.1
// TypeError: Cannot read properties of undefined (reading 'forEach')
```

dagre 3.x *does* have per-cluster `rankdir` (`g.setNode(cluster,{rankdir:'LR'})`),
and a 3-node toy case looks right (turn child below, agent right), so it was
tested at scale: LR cluster = parent + its agents, turn children in the outer TB
graph. It fails because a node can belong to only one cluster, so an agent's own
turn children are ranked below the whole cluster:

| scenario | ratio | overlaps | agent-not-right | agent-not-centred |
|---|---:|---:|---:|---:|
| mixed n=30 | 0.58x | 10 | 3 | 5 |
| mixed n=100 | 1.22x | 32 | 9 | 20 |
| mixed n=300 | 2.28x | **89** | 24 | 54 |
| sidecars n=100 | 0.67x | 33 | 13 | 16 |

Verdict: no candidate can express two edge directions in one pass; do not use (b).

### (c) one flextree pass over the full tree + post-shift — **NOT VIABLE**

```js
const layout = flextree({ children: (d) => d.children,
  nodeSize: (n) => [n.data.w, n.data.h + vGap], spacing: () => hGap });
layout(layout.hierarchy(buildFull(rootId)));   // turn + agent children together
// then: for each agent subtree, shift so subtree.left = parent.right + agentGap,
//       then iterate "if overlapping anything, shift right by ix + hGap" 20x
```

`mixed n=100`: 61 overlaps before resolution, **55 still overlapping after 20
iterations**, area 1.75x. `sidecars n=100`: 54 overlaps left, area 2.43x.
Post-shifting a subtree right after a global pass always collides with the
sibling that the tree layout placed to its right.

## Recommended integration

Keep `layoutTree(nodesById, rootId, heights, opts) -> {pos,width,height}` — the
call site in `media/main.js:1045` needs **no change**. Replace the body with:

```js
// media/tree.js (browser bundle; d3-flextree is ~6 kB min, MIT-ish WTFPL)
function layoutTree(nodesById, rootId, heights, opts) {
  const o = Object.assign({ nodeW: 320, hGap: 48, vGap: 72, pad: 20,
                            agentGap: 80, agentVGap: 24 }, opts);
  const widths = o.widths || {};
  const sz = { w: (id) => widths[id] || o.nodeW, h: (id) => heights[id] || 120 };

  // 1. turn-only contour layout (variable node sizes)
  const layout = flextree({
    children: (d) => d.children,
    nodeSize: (n) => [n.data.w, n.data.h + o.vGap],
    spacing:  () => o.hGap,
  });

  // 2. recursive place(): returns { pos, rects, box }
  //    - flextree pass over turn children only
  //    - each agent child gets its own place() (rigid block)
  //    - block x = smallest free x >= parent.right + agentGap on its y-band
  //    - siblings stack with agentVGap from the parent's top
  // 3. normalise bbox to (0,0); width/height += pad*2
  return placeSubtree(rootId);
}
```

Implementation reference: `.agent-harness/research/bench/candidates.js`
(`layoutAFlex`, ~60 lines) is a working prototype of exactly this; it can be
copied into `media/tree.js` once d3-flextree is vendored (the extension ships no
bundler, so vendor `d3-flextree` + `d3-hierarchy` or hand-port the ~150-line
algorithm). Optional hardening, both measured: `align: 'flush'` (flush a
single-child chain under its parent, bounded by the nearest obstacle) and
`agentOrder: 'deepest-first'` — these cut the "candidate worse" tail from 1.1%
to 0.05% of random trees at the cost of ~2% area on some wide scenarios.

Integration notes:
* Edge drawing in `media/main.js:1134-1174` is unchanged — it reads final card
  rects, not layout internals.
* `pos` must contain every node (including nested agents); the prototype's
  recursion does that.
* Keep the current algorithm behind a flag for one release and compare
  `layoutDiagnostic` overlap reports (both are 0 by construction, but the
  candidate changes card positions, which is the risky part).

## Where the current algorithm is (still) better

1. **Pure turn chains — exact tie.** `chain` rows are 1.00x at every size: both
   produce `x = 0` and identical heights, so the candidate adds a dependency for
   no gain.
2. **Wide/shallow trees — 3–10x faster.** At n=300: `fanout` 0.26 vs 0.84 ms,
   `sidecars` 0.68 vs 5.09 ms, `mixed` 0.44 vs 4.16 ms. The prototype's packing
   is O(n²); the current is O(n) in breadth (but O(depth²)). If relayout latency
   matters more than canvas area, the current wins here — and this can be fixed
   in the candidate with a sorted skyline.
3. **~1% tail of random trees, up to 1.23x wider.** Mechanism: d3-flextree
   *centres* a parent over its children, so a deep chain under a wide ancestor
   shifts every agent slot right. Worst found (`search-worst-aflex.json`,
   n=5): current 800x3076 vs candidate 980x3076 (1.225x) — a 760 px root card,
   a 2-deep 320 px chain, then an agent block. The current algorithm's
   left-alignment avoids it. The `flush` refinement fixes this exact tree
   (back to 800x3076) but shifts a children group into a sibling's contour in
   other trees unless the shift is bounded — implemented and measured.
4. **Wide + tall agent blocks.** The band-local packer can be forced far right
   by a tall sibling subtree at the same y-band (`find-worst.js
   layoutAFlexFlushDeep` worst = 1.269x, n=13); the current algorithm's row-wide
   reservation avoids it. Frequency: 10 / 20000 random trees (0.05%).
5. **Simplicity / no dependency.** ~60 lines, no vendored package, no bundler
   change, deterministic, already overlap-free. The candidate needs
   `d3-flextree` (+ `d3-hierarchy`) vendored into `media/`.

## Reproduce

```bash
cd .agent-harness/research/bench
cd tmp && npm install --no-save d3-flextree @dagrejs/dagre && cd ..   # isolated
node bench.js            # 20 scenarios x 5 engines -> results.json / results.md
node bench.js --quick    # 10/30/100 only
node strategies.js       # (a)/(b)/(c) probes with the exact API calls
node timing.js           # wall-clock scaling table
node search.js 4000 24   # adversarial random-tree comparison
node find-worst.js layoutAFlexFlushDeep 20000
node dump.js mixed 100   # side-by-side layout of one scenario
```

Files: `synthetic.js` (tree generator), `current.js` (VM shim for
`media/tree.js`), `candidates.js` (all engines), `metrics.js`, `bench.js`,
`strategies.js`, `timing.js`, `search.js`, `find-worst.js`, `find-overlap.js`,
`dump.js`, `deps.js`, `results.json`, `results.md`.
