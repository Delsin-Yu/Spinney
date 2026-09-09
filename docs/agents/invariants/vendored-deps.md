# Invariant: vendored dependencies are pinned forever

The tree layout engine is a **vendored, frozen** copy of
`non-layered-tidy-tree-layout@2.0.2` (MIT) in
`media/vendor/non-layered-tidy-tree-layout/`.

## Rules

1. **Do not add it to `package.json`.** It is not a dependency, not a `devDependency`,
   not a `file:` link. Nothing is resolved from npm at install/build/package time, so no
   install script, no registry compromise and no version drift can reach us.
2. **Do not edit the vendored files.** They are byte-exact copies of the published
   tarball, and their sha256s are recorded in `PROVENANCE.md`. An edit invalidates the
   audit trail. `dist/` is what the webview loads; `src/` exists only so the minified
   bundle can be re-audited offline.
3. **Do not update the version.** "Pinned forever" is the design. A new version would
   need a fresh supply-chain audit (see the checklist below) and a new `PROVENANCE.md`
   before it may be vendored.
4. **Keep the load order.** `src/chat/ChatViewProvider.ts` emits the engine `<script>`
   (same nonce, before `media/tree.js`). `media/tree.js` throws a clear error if
   `window.nonLayeredTidyTreeLayout` is missing — do not add a silent fallback layout.
5. The vendored bundle must stay `eval`/`Function`-free so the webview CSP needs no
   `'unsafe-eval'`. Re-check with:
   `grep -c "eval(\|new Function" media/vendor/non-layered-tidy-tree-layout/dist/*.js`

## Engine semantics `media/tree.js` depends on

- Box per node = `(width + hGap) × (height + vGap)`; card top-left = `boxLeft + hGap/2`;
  a node's children start at `parent.y + height + vGap`.
- Returned `x`/`y` are the **card's top-left** (already un-boxed), `y` downward.
- The input tree is **mutated** in place; sibling order is preserved (deterministic).
- Browser-only UMD (bare `window`); `window.nonLayeredTidyTreeLayout = { Layout, BoundingBox }`.
- `new BoundingBox(gap, bottomPadding)` takes **scalars** (no per-node spacing callback),
  so a per-node gap must be expressed by inflating the node's `width`/`height`.

## No obstacle support (do not plan around it)

The engine has **no concept of an arbitrary obstacle / fixed-position node**: no way to
feed it a rectangle to avoid, and no coordinate input. `grep -i "obstacle|collision|avoid|
forbid|fixed|pin"` over `src/*.js` matches nothing; `algorithm.js` is 16 functions of pure
contour separation between the nodes' own boxes (`seperate`, `updateIYL`,
`nextLeft/RightContour`, `moveSubtree`, `distributeExtra`). The only geometry lever is a
node's own box size (plus the two global scalars). `d3-flextree` is the same (only
`nodeSize`/`spacing`; `extents` is a read-only output getter).

Consequences: "keep this card at a user-chosen position and let the rest flow around it"
cannot be delegated to the engine. It would need either (a) our own post-layout repair pass
(shifts subtrees out of the pinned rect — the collision code this design deliberately
avoided, and it cascades), or (b) an engine with fixed-node support (Graphviz `pos="x,y!"`,
ELK) which is EPL-2.0 plus ~1–1.6 MB wasm — rejected on licence/CSP/size grounds.
This is why the manual-drag/pin feature was reverted rather than extended.


## Why this engine

- Same algorithm as `d3-flextree` (van der Ploeg, *Drawing Non-layered Tidy Trees in
  Linear Time*) but **MIT** instead of WTFPL, zero runtime deps, 5.6 KB, no install
  scripts, and its npm tarball's `dist` + `src` are byte-identical to GitHub tag `v2.0.2`.
- Measured (`.agent-harness/research/bench/nlttl-benchmark.md`): mean canvas area
  **0.973×** the previous hand-written packer on 20 synthetic shapes (0.811× for a
  post-hoc packing variant) and **2.2× smaller** than it on every real agent-heavy
  session, **0 overlaps, 0 interpositions, 0 foreign connector crossings**, 0.16 ms at
  300 nodes (previous: 10.4 ms — it recomputed subtree sizes per node, O(n²)).

## How `media/tree.js` uses it (engine-owned sidecar reservation)

Each node's engine box is inflated so the engine itself reserves the sidecar space:

```
width  = cardW + (hasAgents ? agentGap + blockW : 0)
height = max(cardH, blockH)          // blockH = stacked agent windows
```

The agent windows are then placed inside that box, at the parent card's right edge.
Because the box is the parent's exclusive rectangle, no other card can overlap a
window, sit between a parent card and its windows, or be crossed by the connector —
the invariants hold **by construction**, with no collision code.

The alternative (laying out the turn tree first and packing windows into free space
afterwards) is more compact on paper but has to push a window past whatever card
occupies its y-band — which inserts unrelated nodes between a parent and its own
sub-agents. That is exactly the defect this design removes; do not "optimise" it back.
The known cost is vertical: a node whose block is taller than its card pushes its turn
children down by `blockH - cardH` (~10–20% more canvas area than the post-hoc packer,
still ~2.2× smaller than the pre-vendoring packer).

Enforced by `.agent-harness/research/bench/verify-tree.js` (geometry must match the
benchmarked candidate; 0 overlaps / 0 interpositions / 0 foreign crossings on every
scenario) and by `.agent-harness/research/bench/analyze-interposition.js check ALL`
(real persisted sessions).


## Re-audit checklist (only if the version must change)

Exact version + full version history (dormancy/yank/ownership), maintainer ↔ GitHub owner
match, provenance/attestations, lifecycle scripts, static scan (`eval`, `Function`,
`child_process`, network, base64), transitive deps + licenses, LICENSE vs SPDX,
registry integrity + local sha256, `dist`/`src` vs GitHub tag byte comparison, typosquat
probes, OSV advisories. Then re-run `.agent-harness/research/bench/verify-tree.js`
(geometry must still match the benchmarked candidate) and
`node .agent-harness/research/bench/nlttl-bench.js` (area ratios must not regress).

## Related

- `media/vendor/non-layered-tidy-tree-layout/PROVENANCE.md` — pin record, hashes, audit summary.
- `docs/agents/invariants/sub-agents.md` — the recursive agent-window layout invariant.
- `docs/agents/file-map.md` — where the files live.
