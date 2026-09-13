# Invariant: vendored dependencies are pinned forever

Two assets under `media/vendor/` are **vendored, frozen** copies of published npm
tarballs, shipped inside the `.vsix`:

| Asset | Vendored copy | Pin record |
|---|---|---|
| tree layout engine `non-layered-tidy-tree-layout@2.0.2` (MIT) | `media/vendor/non-layered-tidy-tree-layout/` | that directory's `PROVENANCE.md` |
| Markdown renderer `markdown-it@14.3.1` (MIT) | `media/vendor/markdown-it/` | that directory's `PROVENANCE.md` |

## Rules

1. **Do not add either of them to `package.json`.** Neither is a dependency, a
   `devDependency` or a `file:` link, and nothing is resolved from npm at
   install/build/package time, so no install script, no registry compromise and no
   version drift can reach the shipped webview payload. One caveat that does **not**
   weaken the rule: `markdown-it` (with its `linkify-it`, `mdurl`, `uc.micro`,
   `punycode.js` and `entities` dependencies) also appears in `package-lock.json` as a
   *transitive* dev dependency of `@vscode/vsce`. That copy is resolved at build time
   only, is never shipped, and is never what the webview loads — the vendored bundle is.
   Its existence is not a reason to relax the pin, and no runtime code may import from
   `node_modules`.
2. **Do not edit the vendored files.** They are byte-exact copies of the published
   tarball, and their sha256s are recorded in each `PROVENANCE.md`. An edit invalidates
   the audit trail. The engine's `dist/` is what the webview loads and its `src/` exists
   only so the minified bundle can be re-audited offline; for `markdown-it` only the
   minified browser bundle ships (`LICENSE` + `PROVENANCE.md` are the paperwork).
3. **Do not update a version.** "Pinned forever" is the design. A new version would
   need a fresh supply-chain audit (see the checklist below) and a new `PROVENANCE.md`
   before it may be vendored — including a later patch of a package already vendored.
4. **Keep the load order.** `src/chat/ChatViewProvider.ts` emits the engine `<script>`
   (same nonce, before `media/tree.js`) and the `markdown-it` `<script>` the webview
   renderer needs. `media/tree.js` throws a clear error if
   `window.nonLayeredTidyTreeLayout` is missing — do not add a silent fallback layout.
5. The vendored bundles must stay `eval`/`Function`-free so the webview CSP needs no
   `'unsafe-eval'`. Re-check with:
   `grep -c "eval(\|new Function" media/vendor/non-layered-tidy-tree-layout/dist/*.js`
   and `grep -c "eval(\|new Function" media/vendor/markdown-it/markdown-it.min.js`
   (both must print `0`).

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
- Measured (benchmark notes are not part of this repository): mean canvas area
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

The geometry invariants (0 overlaps / 0 interpositions / 0 foreign crossings) were
enforced by bench scripts while this engine was chosen. Those scripts belonged to the
pre-vendoring survey and are not part of this repository. The surviving contract is
`media/tree.js` plus the sidecar rules in `docs/agents/invariants/sub-agents.md`.


## Re-audit checklist (only if the version must change)

Exact version + full version history (dormancy/yank/ownership), maintainer ↔ GitHub owner
match, provenance/attestations, lifecycle scripts, static scan (`eval`, `Function`,
`child_process`, network, base64), transitive deps + licenses, LICENSE vs SPDX,
registry integrity + local sha256, `dist`/`src` vs GitHub tag byte comparison, typosquat
probes, OSV advisories. Then re-check the geometry by hand (0 overlaps /
0 interpositions / 0 foreign crossings on the shapes in
`docs/agents/invariants/sub-agents.md`) and compare the canvas area against the
numbers quoted above.

## Related

- `media/vendor/non-layered-tidy-tree-layout/PROVENANCE.md` — pin record, hashes, audit summary.
- `media/vendor/markdown-it/PROVENANCE.md` — pin record for the Markdown renderer:
  version, tarball integrity, sha256/byte count, and the third-party code inlined in
  its bundle.
- `THIRD_PARTY_NOTICES.md` (repository root, shipped in the `.vsix`) — the
  redistribution notice: both bundles, their copyright lines and the paths of the
  bundled `LICENSE` files.
- The pre-vendoring survey (registry/OSV JSONs, benchmark scripts, prior-art notes)
  was removed from the repository when it went open source. The `PROVENANCE.md` files
  above are the surviving pin records: version, tarball integrity, per-file sha256, and
  (for the engine) the byte comparison against the upstream tag.
- `docs/agents/invariants/sub-agents.md` — the recursive agent-window layout invariant.
- `docs/agents/file-map.md` — where the files live.
