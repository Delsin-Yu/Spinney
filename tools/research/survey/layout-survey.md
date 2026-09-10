# JS layout packages for the chat-tree webview — survey

**Scope.** Replace the hand-written `media/tree.js` recursive layout in a VS Code webview.
Requirements: variable measured node sizes (320px × 120–2000px, user-resizable), tight packing
(no wasted horizontal space, parents centered over children), deterministic output, plain
`<script>` tag (UMD / single-file global; **no bundler**), MIT/BSD/Apache preferred, and support
for **two edge kinds**: `turn` edges (parent → child, downward) and `agent` sidecar edges
(parent → sub-agent card, rightward).

**Method.** Every fact below was verified with real commands (2026-09-10):
npm registry JSON (`registry.npmjs.org/<pkg>`), npm download API, unpkg `?meta` + raw file fetches
(headers/byte counts), GitHub REST API (`pushed_at`, license, stars), and live Node benchmarks in a
scratch dir (`/tmp/lab`). `www.npmjs.com` HTML is 403 here, so registry JSON + unpkg were used.
Verification scripts are in this directory (`_lab_*.js`, gitignored scratch).

---

## 1. Comparison table

| Package | Latest / published | License | Transitive deps¹ | Vendorable single file (format, size) | Weekly DL | Last commit | Var. node sizes | Deter-ministic | Down + right edges | 200-node layout² |
|---|---|---|---|---|---|---|---|---|---|---|
| **d3-flextree** | 2.1.2 / 2021-11-08 | **WTFPL** | 1 (`d3-hierarchy@1.x`) | `build/d3-flextree.min.js` — UMD, self-contained, **8.8 KB** | 135 k | 2023-03-01 | ✅ native | ✅ | tree only; rightward = post-pass | **0.8 ms** |
| **@dagrejs/dagre** | 3.1.1 / 2026-08-08 | **MIT** | 1 (`@dagrejs/graphlib`, bundled in dist) | `dist/dagre.min.js` — global `var dagre`, self-contained, **47.8 KB** | 3.02 M | 2026-08-08 | ✅ native | ✅ (20 runs identical) | edges yes, but not horizontal → translate pass / cluster rankdir | 53.6 ms |
| **@dagrejs/graphlib** | 4.0.5 / 2026-08-03 | MIT | 0 | `dist/graphlib.min.js` — 13.2 KB (not needed; bundled in dagre) | 4.17 M | 2026-08-03 | n/a (graph structure only) | ✅ | n/a | n/a |
| **d3-dag** | 1.2.2 / 2026-07-05 | **MIT** | 20 | `dist/d3-dag.iife.min.js` — IIFE → `globalThis.d3.*`, **140 KB** | 35 k | 2026-09-02 | ✅ native (`.nodeSize(fn)`) | ✅ (verified) | dagre-compat has no minlen/rank pinning; native `tweaks` = custom post-pass | 16.5 ms |
| **d3-hierarchy** | 3.1.2 / 2022-04-02 | ISC | 0 | `dist/d3-hierarchy.min.js` — UMD, 14.5 KB | 21.8 M | 2025-04-08 | ❌ **uniform `nodeSize` only** | ✅ | tree only | n/a |
| **elkjs** | 0.12.0 / 2026-07-17 | **EPL-2.0 OR GPL-3.0-or-later** ⚠️ | 0 | `lib/elk.bundled.js` 1.57 MB / `lib/elk-worker.min.js` 1.56 MB (worker) | 6.40 M | 2026-09-09 | ✅ | ✅ | per-graph direction; mixed needs hierarchy/ports | n/a |
| **@hpcc-js/wasm-graphviz** | 1.29.0 / 2026-09-04 | Apache-2.0 wrapper + **Graphviz EPL-2.0** ⚠️ | 0 | `dist/index.js` — **ESM only**, wasm embedded, 800 KB | 98 k | 2026-09-04 | ✅ | ✅ | ✅ **native** (`rank=same` + `constraint=false`) | n/a (wasm) |
| **@viz-js/viz** | 3.30.0 / 2026-09-01 | MIT wrapper + **Graphviz EPL-2.0** ⚠️ | 0 | `dist/viz-global.js` — UMD → `globalThis.Viz`, 1.29 MB | 147 k | 2026-09-02 | ✅ | ✅ | ✅ **native** | n/a (wasm) |
| **non-layered-tidy-tree-layout** | 2.0.2 / 2019-10-17 | **MIT** | 0 | `dist/non-layered-tidy-tree-layout.js` — UMD, **5.6 KB** | 536 k | 2022-12-11 | ✅ native | ✅ | tree only | ~1 ms |
| **entitree-flex** | 0.4.1 / 2022-02-14 | **⚠️ none (all rights reserved)** | 0 | no UMD; `dist/*.js` CJS tsc output only | 2.4 k | 2022-04-25 | ✅ | ✅ | ✅ native “side nodes” | n/a |
| **@mermaid-js/layout-tidy-tree** | 0.2.2 / 2026-05-11 | MIT | ~30 (`d3@7` meta) | `dist/*.mjs` ESM chunks (11 KB) + d3 | 323 k | 2026-05 (mermaid repo) | ✅ | ✅ | mermaid-internal API | n/a |
| **@antv/layout** | 2.0.0 / 2026-02-11 | MIT | 12+ | `dist/index.min.js` UMD, 315 KB | 201 k | 2026-06-10 | ✅ | ✅ | wraps old dagre 0.8 + force | n/a |

¹ measured with a clean `npm i <pkg>` + `npm ls --all --parseable | grep -c node_modules`.
² measured locally, 200-node random tree, widths 280–480, heights 120–2000, warm loop average.

---

## 2. Per-candidate notes

### 2.1 d3-flextree — 2.1.2 (2021-11-08) — **WTFPL**
- Registry: `https://registry.npmjs.org/d3-flextree` · tarball `https://registry.npmjs.org/d3-flextree/-/d3-flextree-2.1.2.tgz`
- Repo: https://github.com/klortho/d3-flextree (365★, 20 open issues, last push 2023-03-01)
- **Algorithm:** port of A.J. van der Ploeg, *Drawing Non-layered Tidy Trees in Linear Time* (2013) —
  Buchheim/Walker-style tidy tree extended to **variable node sizes**, **O(n)**. This is the exact
  algorithm the current hand-written code approximates (and gets wrong).
- **Dist:** `build/d3-flextree.min.js` (9,039 B) is a UMD that assigns `d3.flextree`; verified
  **0 `require(` calls** → fully self-contained (d3-hierarchy is inlined). Also `build/d3-flextree.js` (22.6 KB, unminified).
- **API:** `flextree({nodeSize: n => [w,h], spacing: (a,b)=>px})` → `layout.hierarchy(data)` →
  `layout(tree)` → read `node.x` (**horizontal centre**), `node.y` (**top**), plus `node.left/right/top/bottom`
  and `tree.extents = {top,bottom,left,right}`. Verified: parent is centred over children and leaves are
  packed by contour (no sum-of-subtree reservation).
- **Variable sizes:** native. **Deterministic:** pure arithmetic, yes.
- **Two edge kinds:** tree-only — no concept of edges. Sidecars need a post-pass.
- **Vendoring:** `https://unpkg.com/d3-flextree@2.1.2/build/d3-flextree.min.js` or
  `https://cdn.jsdelivr.net/npm/d3-flextree@2.1.2/build/d3-flextree.min.js`
- **Risk:** unmaintained since 2023; **WTFPL** (permissive but some legal teams reject it);
  no sidecar support. MIT alternative with the *same* algorithm: `non-layered-tidy-tree-layout` (§2.9).

### 2.2 @dagrejs/dagre — 3.1.1 (2026-08-08) — **MIT**
- Registry: `https://registry.npmjs.org/@dagrejs%2Fdagre` · tarball `https://registry.npmjs.org/@dagrejs/dagre/-/dagre-3.1.1.tgz`
- Repo: https://github.com/dagrejs/dagre (5,787★, last push 2026-08-08) — actively maintained.
- **Algorithm:** Sugiyama layered layout with network-simplex ranking + Brandes–Köpf coordinate
  assignment. Proven, used by mermaid/React Flow historically.
- **Dist:** `dist/dagre.min.js` (48,956 B) — `"use strict"; var dagre=(()=>{…})()`, **0 `require(` calls**,
  **graphlib is bundled** (`{graphlib:ee, version, layout, …}`). Works from a plain `<script>` tag
  (top-level `var` → `window.dagre`). MIT text in `dist/dagre.min.js.LEGAL.txt`.
- **API:** `new dagre.graphlib.Graph().setGraph({rankdir:'TB',nodesep,ranksep})`;
  `setNode(id,{width,height})` (variable sizes); `setEdge(v,w,{minlen,weight})`;
  `dagre.layout(g)`; read `g.node(id).x/.y` (**centre**), `g.node(id).rank`, `g.graph().width/height`.
  v3 adds `layout(g, {constraints:[{left,right}]})` (ordering) and per-cluster `rankdir`.
- **Determinism:** verified identical x/y over 20 runs on a 60-node random graph.
- **Two edge kinds:** see §3. `minlen: 0` (the classic same-rank trick) **crashes v3.1.1**
  (`TypeError: Cannot read properties of undefined (reading 'forEach')` in `translateGraph`, reproduced on 2- and 3-node graphs).
  A cluster node with its own `rankdir:'LR'` works internally but the cluster is still ranked by the
  parent TB graph (verified: agents end up below the parent, side by side).
- **Vendoring:** `https://unpkg.com/@dagrejs/dagre@3.1.1/dist/dagre.min.js`
- **Risk:** the sidecar direction needs a workaround; 53 ms/layout at 200 nodes (debounce resize).

### 2.3 d3-dag — 1.2.2 (2026-07-05) — **MIT**
- Registry: `https://registry.npmjs.org/d3-dag` · tarball `https://registry.npmjs.org/d3-dag/-/d3-dag-1.2.2.tgz`
- Repo: https://github.com/erikbrinkman/d3-dag (1,518★, last push 2026-09-02) — actively maintained.
- **Dist:** `dist/d3-dag.iife.min.js` (143,370 B) → `globalThis.d3 = Object.assign(globalThis.d3 ?? {}, …)`
  (merges into the `d3` namespace). Bundles its deps (quadprog present, no external `require`).
  Also CJS 145 KB / ESM 138.9 KB.
- **API (native):** `graphStratify()(data)` → `sugiyama().nodeSize(n=>[w,h]).gap([hgap,vgap])`
  `.layering(layeringSimplex()).decross(decrossTwoLayer()).coord(coordSimplex())`; read `node.x/.y`,
  result `{width,height}`. Verified variable sizes + identical output across runs.
  **v1.2.2 also ships a dagre-compatible facade**: `dagre.graphlib.Graph`, `setNode({width,height})`,
  `setGraph({rankdir,nodesep,ranksep,quality,ranker,algorithm})`, `dagre.layout(grf)`.
- **Two edge kinds:** the dagre-compat layer supports **no** `minlen`/`minRank`/`constraints` (checked
  `dist/dagre.d.ts`). The native API has `Group`/`layerSeparation` and, importantly, first-class
  **`Tweak`** operators (`tweakDirection`, `tweakFlip`, `tweakShape`, custom tweaks) — a clean extension
  point for moving agent subtrees rightward, but still custom code.
- **Vendoring:** `https://unpkg.com/d3-dag@1.2.2/dist/d3-dag.iife.min.js`
- **Risk:** 140 KB + 20 transitive deps; newer/less battle-tested API; `decrossOpt` pulls an ILP solver.

### 2.4 d3-hierarchy — 3.1.2 (2022-04-02) — ISC
- Repo https://github.com/d3/d3-hierarchy (1,272★, last push 2025-04-08).
- `dist/d3-hierarchy.min.js` 14.5 KB UMD. `d3.tree()` implements Buchheim et al. but **`nodeSize`
  is a single uniform `[w,h]` for all nodes** — it cannot do variable sizes. `d3.treemap` is not a
  node-link tree layout. **Fails the core requirement.** (d3-flextree exists precisely to fix this gap.)
- Only worth loading if you already need d3 elsewhere.

### 2.5 elkjs — 0.12.0 (2026-07-17) — **EPL-2.0 OR GPL-3.0-or-later** ⚠️
- Repo https://github.com/kieler/elkjs (2,762★, active). `LICENSE.md` verified EPL-2.0.
- 1.57 MB `lib/elk.bundled.js` (sync, UMD-ish) or 1.56 MB worker + `workerUrl`; no deps but a huge
  GWT-transpiled Java payload. Extremely capable (hierarchy, ports, per-graph direction).
- **Disqualified by license** (EPL/GPL is a problem for this project) and by size.

### 2.6 @hpcc-js/wasm-graphviz — 1.29.0 (2026-09-04) — Apache-2.0 wrapper ⚠️ Graphviz EPL-2.0
- Repo https://github.com/hpcc-systems/hpcc-js-wasm (389★, active). `dist/index.js` is **ESM-only**
  (`type: module`, `export {Graphviz}`), 800 KB, **wasm embedded** in the file (verified: no separate
  `.wasm` fetch; compressed blob + `atob`), so no extra asset to vendor — but you must load it as
  `<script type="module">` with a CSP nonce.
- Natively expresses the two edge kinds (`rank=same` subgraphs, `constraint=false`, `rankdir`), and
  can emit `json`/`plain`/`svg` for coordinate extraction.
- **Risks:** Graphviz itself is **EPL-2.0** (verified `gitlab.com/graphviz/graphviz/-/raw/main/LICENSE`);
  VS Code webview CSP must add `'wasm-unsafe-eval'`; ESM-only; 800 KB.

### 2.7 @viz-js/viz — 3.30.0 (2026-09-01) — MIT wrapper ⚠️ Graphviz EPL-2.0
- Repo https://github.com/mdaines/viz-js (4,347★, active). `dist/viz-global.js` is a **UMD** that sets
  `globalThis.Viz` (1,324,675 B) and includes engines `dot/circo/neato/…` and formats incl. `json`,
  `xdot_json`, `plain`, `svg`. Same Graphviz EPL-2.0 caveat + wasm CSP caveat; bigger than hpcc.

### 2.8 entitree-flex — 0.4.1 (2022-02-14) — **no license** ⚠️
- Repo https://github.com/codeledge/entitree-flex (88★, last push 2022-04-25). **`license: null` in the
  GitHub API and no LICENSE file in the published tarball** → all rights reserved; cannot be vendored.
- Semantically the closest fit (“side nodes” via `spouses`/`siblings`, variable sizes, all 4
  orientations) and dist is only CJS `tsc` output (no UMD). Disqualified on licensing + build format.

### 2.9 non-layered-tidy-tree-layout — 2.0.2 (2019-10-17) — **MIT**
- Repo https://github.com/stetrevor/non-layered-tidy-tree-layout (27★, last push 2022-12-11).
- Same van der Ploeg algorithm as d3-flextree, **zero deps**, dist **5,599 B** UMD. API:
  `new Layout(new BoundingBox(gap, bottomPadding)).layout(treeData)` → `{result, boundingBox}`,
  `x` is the centre. Native variable sizes.
- **Quirks:** the UMD calls `}(window, …)` → **ReferenceError under Node** (browser/webview only);
  it mutates the input nodes with x/y; tiny project, unmaintained. A license-clean fallback for
  d3-flextree.

### 2.10 Also-considered / rejected
- `@mermaid-js/layout-tidy-tree` 0.2.2 (MIT, 323 k DL): mermaid-internal chunked ESM + `d3@7` meta-dep
  (≈30 packages); not a standalone layout library.
- `@antv/layout` 2.0.0 (MIT, 201 k DL): 315 KB kitchen-sink wrapping old `dagre@0.8.5` + force layouts.
- `dagre@0.8.5` (2019, unmaintained) — superseded by `@dagrejs/dagre@3`.
- `graphology-layout`, `d3-force`: force layouts are **non-deterministic** and don't do tidy trees.

---

## 3. The two-edge-kind problem (down + right)

No candidate except the Graphviz/wasm ones can express a *rightward* edge natively; every
pure-JS layout engine has exactly one direction per layout (dagre `rankdir`, d3-dag `tweakDirection`,
elk `direction`). Concretely:

| Approach | Works? | Notes |
|---|---|---|
| dagre `setEdge(v,w,{minlen:0})` (classic same-rank trick) | ❌ | **crashes dagre 3.1.1** (`translateGraph`: edge `points` undefined). Reproduced on 2- and 3-node graphs. |
| dagre `setNode(id,{minRank:r,maxRank:r})` | ❌ | `minRank/maxRank` only create cluster *border* segments; the ranker still assigns the real rank (verified: node stayed at rank 2). |
| dagre cluster node with its own `rankdir:'LR'` | ⚠️ partial | Agents lay out LR *inside* the cluster, but the cluster is ranked by the parent TB graph → it lands **below** the parent, not to the right (verified). |
| dagre `constraints:[{left:'root',right:'a1'}]` | ✅ ordering only | Controls left/right order within a rank; does not create the rank. |
| **dagre two-pass**: pass 1 = turn edges only (TB); pass 2 = per-parent agent forest (own dagre/flextree run), then translate each agent forest to `parent.right + gap` and stack vertically; final overlap sweep | ✅ | Fully deterministic and non-overlapping; ~60 lines of glue. This is the recommended workaround if dagre is chosen. |
| d3-dag custom `Tweak` (native extension point) | ✅ | `tweakDirection`/`tweakFlip` are whole-graph; a custom tweak can translate agent subtrees. Clean, but custom code. |
| d3-flextree: feed agents as extra children, then translate them right by their extents | ✅ | Agents are accounted for in the contour packing; a post-pass moves each agent subtree right of the parent's `right`. Small, deterministic. |
| Graphviz `rank=same` + `constraint=false` | ✅ native | The only true native mixed-direction solution, but EPL-2.0 + wasm CSP + 0.8–1.3 MB. |

**Recommendation on the edge problem:** model the turn tree as the primary layout and keep the
agent cards as a *placement* concern (right of the parent), because that is how the data actually
behaves (agents are sidecars, not graph edges). Any package above needs roughly the same ~50–60 line
post-pass; the choice should therefore be driven by tree quality, size, license and re-layout speed.

---

## 4. Ranked top-3 recommendation

### 🥇 #1 — d3-flextree 2.1.2 (WTFPL; MIT-equivalent alternative: non-layered-tidy-tree-layout)
**Why:** the chat tree *is* a tree; the current bug is exactly what a variable-size tidy tree fixes.
- Directly solves the complaint: contour-based packing (no sum-of-subtree reservation) and parents
  **centred** over children. Verified on a 5-node sample: root centred at x=0 with children at
  −170/+170, total width 830 px vs the current left-aligned reservation.
- **0.80 ms** for 200 nodes — re-layout on every resize/drag is free (dagre is 67× slower).
- 8.8 KB UMD, self-contained, plain `<script>` tag, `d3.flextree`.
- **Two-edge-kind:** turn tree natively; keep the existing agent stacking as a post-pass, but drive
  the agent block's x from the parent's `node.right` and y from `node.top`, and expand the root's
  width by the agent block. Because flextree already returns `extents`, the post-pass is small.
- **Single most important risk:** **WTFPL license** (and the package is unmaintained since 2023).
  Mitigation: `non-layered-tidy-tree-layout` (MIT, 5.6 KB, same van der Ploeg algorithm) is a
  drop-in fallback — but it is browser-only (`window` reference) and even less maintained.

### 🥈 #2 — @dagrejs/dagre 3.1.1 (MIT)
**Why:** the only non-EPL, single-file, plain-script-tag package that can take the **whole graph**
(turn + agent edges) and return one globally non-overlapping, tightly packed, deterministic layout,
with variable sizes and ordering constraints.
- MIT, 47.8 KB self-contained UMD-ish (`window.dagre`), active (2026-08-08), 3 M weekly DL.
- Verified deterministic (20 runs identical) and variable-size correct.
- **Two-edge-kind:** the weakest point — `minlen:0` crashes, `minRank/maxRank` doesn't pin, cluster
  `rankdir` only changes the cluster's internal direction. Use the **two-pass + translate** approach
  in §3. `constraints` can still enforce “agent right of parent”.
- **Single most important risk:** the **53.6 ms/layout at 200 nodes** during interactive resize
  (needs debouncing), plus the extra glue code for sidecars; and the `minlen:0` crash means the
  “obvious” same-rank trick is unavailable.

### 🥉 #3 — d3-dag 1.2.2 (MIT)
**Why:** modern, actively maintained, MIT, and the only candidate with a **first-class post-layout
extension point** (`Tweak` operators) — which is exactly the shape the sidecar workaround needs.
Also ships a dagre-compatible facade, so it can be a drop-in for dagre users.
- `dist/d3-dag.iife.min.js` 140 KB IIFE → `globalThis.d3.*`, no bundler.
- Verified variable node sizes (`.nodeSize(fn)`) and deterministic output; 16.5 ms at 200 nodes
  (3× faster than dagre, 20× slower than flextree).
- **Two-edge-kind:** dagre-compat has no `minlen`/`minRank`/`constraints`; use a custom `Tweak` or
  the same two-pass. `tweakDirection` is whole-graph only.
- **Single most important risk:** 20 transitive deps + 140 KB bundle, and a newer API surface than
  dagre/flextree (more code to maintain, less community precedent for this exact use case).

**Not recommended despite being the only native mixed-direction engine:** Graphviz via
`@hpcc-js/wasm-graphviz` / `@viz-js/viz`. It solves down+right cleanly (`rank=same`,
`constraint=false`), but ships an **EPL-2.0** Graphviz binary (license problem), needs
`'wasm-unsafe-eval'` in the webview CSP, and adds 0.8–1.3 MB. Keep as plan B only if the
sidecar layout must be 100 % engine-driven.

---

## 5. Exact vendoring URLs (all verified HTTP 200)

| Package | File to vendor | Format | Bytes |
|---|---|---|---|
| d3-flextree | https://unpkg.com/d3-flextree@2.1.2/build/d3-flextree.min.js | UMD → `d3.flextree` | 9,039 |
| d3-flextree (unmin) | https://unpkg.com/d3-flextree@2.1.2/build/d3-flextree.js | UMD | 22.6 KB |
| @dagrejs/dagre | https://unpkg.com/@dagrejs/dagre@3.1.1/dist/dagre.min.js | global `var dagre` (graphlib bundled) | 48,956 |
| @dagrejs/graphlib (optional) | https://unpkg.com/@dagrejs/graphlib@4.0.5/dist/graphlib.min.js | global `var graphlib` | 13.2 KB |
| d3-dag | https://unpkg.com/d3-dag@1.2.2/dist/d3-dag.iife.min.js | IIFE → `globalThis.d3` | 143,370 |
| d3-hierarchy | https://unpkg.com/d3-hierarchy@3.1.2/dist/d3-hierarchy.min.js | UMD | 14.5 KB |
| non-layered-tidy-tree-layout | https://unpkg.com/non-layered-tidy-tree-layout@2.0.2/dist/non-layered-tidy-tree-layout.js | UMD → `nonLayeredTidyTreeLayout` | 5,599 |
| @viz-js/viz (plan B) | https://unpkg.com/@viz-js/viz@3.30.0/dist/viz-global.js | UMD → `globalThis.Viz` | 1,324,675 |
| @hpcc-js/wasm-graphviz (plan B) | https://unpkg.com/@hpcc-js/wasm-graphviz@1.29.0/dist/index.js | **ESM only** | 819,284 |
| elkjs (plan B) | https://unpkg.com/elkjs@0.12.0/lib/elk.bundled.js | UMD-ish, sync | 1,572 KB |

Tarballs (for offline vendoring): `https://registry.npmjs.org/<pkg>/-/<name>-<version>.tgz`, e.g.
`https://registry.npmjs.org/d3-flextree/-/d3-flextree-2.1.2.tgz`,
`https://registry.npmjs.org/@dagrejs/dagre/-/dagre-3.1.1.tgz`.

## 6. Reproduce the verification

```bash
curl -s https://registry.npmjs.org/d3-flextree | node -e '...'          # version/license/deps/tarball
curl -s "https://unpkg.com/@dagrejs/dagre@3.1.1/?meta"                  # dist artifacts + byte sizes
curl -sL https://unpkg.com/d3-flextree@2.1.2/build/d3-flextree.min.js | head -c 200   # UMD header
curl -s https://api.npmjs.org/downloads/point/last-week/d3-flextree     # weekly downloads
curl -s https://api.github.com/repos/klortho/d3-flextree                # pushed_at / license / stars
```
Local benchmarks/experiments: `_lab_bench.js`, `_lab_dagre.js`, `_lab_d3dag.js`, `_lab_nlt.js`
(require packages installed under a scratch dir; they are not part of the repo build).
