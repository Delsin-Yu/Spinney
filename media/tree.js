/*
 * Chat Tree layout — pure functions, no DOM.
 *
 * Two kinds of children, two directions:
 *   - turn children hang BELOW their parent (the conversation spine),
 *   - agent (sub-agent) children stack to the RIGHT of the parent card.
 *
 * The tidy-tree geometry is delegated to the vendored, pinned engine
 * `non-layered-tidy-tree-layout@2.0.2` (MIT) — see
 * media/vendor/non-layered-tidy-tree-layout/PROVENANCE.md.
 *
 * WHY THE SIDECAR SPACE IS RESERVED IN THE ENGINE (not packed afterwards):
 * a post-hoc packer has to push a window past whatever card already sits in its
 * y-band, which visually inserts unrelated nodes between a parent and its own
 * sub-agents ("Node B between Node A and its subagents"). Instead, each node's
 * box is *inflated* by the width of its sidecar block and by its height, so the
 * engine treats the block as part of the node:
 *
 *   width  = cardW + (blockW ? agentGap + blockW : 0)
 *   height = max(cardH, blockH)
 *
 * The engine then keeps every other card out of that box (contour separation),
 * and starts the node's turn children below the block. The block therefore lives
 * inside the parent's exclusive rectangle, which makes all of these invariants
 * hold by construction:
 *   - no card overlaps a window,
 *   - no card sits between a parent card and its windows,
 *   - no connector crosses a foreign card.
 * The price is vertical: a node whose block is taller than its card pushes its
 * turn children down by (blockH - cardH). Measured on real sessions this costs
 * ~10-20% canvas area versus a post-hoc packer, while being ~2.2x smaller than
 * the previous hand-written packer, with zero layout defects.
 *
 * Exposed as `window.treeLayout`.
 */
(function () {
  const DEFAULTS = { nodeW: 320, hGap: 48, vGap: 72, pad: 20, agentGap: 80, agentVGap: 24 };

  /** The vendored engine, loaded by a separate <script> tag in the webview. */
  function engine() {
    const g = window.nonLayeredTidyTreeLayout;
    if (!g || typeof g.Layout !== 'function' || typeof g.BoundingBox !== 'function') {
      throw new Error('vendored layout engine missing: non-layered-tidy-tree-layout');
    }
    return g;
  }

  /**
   * @param {Object} nodesById  id -> { id, children: string[], kind?: 'turn'|'agent' }
   * @param {string} rootId
   * @param {Object} heights    id -> measured pixel height
   * @param {Object} [opts]     { nodeW, hGap, vGap, pad, widths, agentGap, agentVGap }
   * @returns {{ pos: Object<string, {x:number,y:number}>, width:number, height:number }}
   */
  function layoutTree(nodesById, rootId, heights, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const widths = o.widths || {};
    const size = (id) => ({ w: widths[id] || o.nodeW, h: heights[id] || 120 });
    const kidsOf = (id) => (nodesById[id] && nodesById[id].children) || [];
    const isAgent = (id) => !!nodesById[id] && nodesById[id].kind === 'agent';
    const turnKids = (id) => kidsOf(id).filter((c) => !!nodesById[c] && !isAgent(c));
    const agentKids = (id) => kidsOf(id).filter((c) => !!nodesById[c] && isAgent(c));

    if (!nodesById[rootId]) {
      return { pos: {}, width: o.nodeW + o.pad * 2, height: 120 + o.pad * 2 };
    }

    function bboxOf(rects) {
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        if (r.x < left) left = r.x;
        if (r.y < top) top = r.y;
        if (r.x + r.w > right) right = r.x + r.w;
        if (r.y + r.h > bottom) bottom = r.y + r.h;
      }
      if (!rects.length) return { left: 0, top: 0, right: 0, bottom: 0 };
      return { left, top, right, bottom };
    }

    // Agent subtrees are laid out once per node; `memo` keeps the two lookups
    // (build the engine tree, then place the blocks) from redoing that work.
    const memo = new Map();

    /**
     * Lay out the subtree rooted at `id` (turn spine + its sidecar blocks),
     * normalized so its own bounding box starts at (0, 0).
     * @returns {{ pos, rects, box:{left,top,right,bottom}, w, h }}
     */
    function layoutSub(id) {
      if (memo.has(id)) return memo.get(id);

      // Sidecar block of one node: each agent subtree laid out recursively with
      // this same algorithm, then stacked vertically at the block's natural width.
      const blockOf = (nid) => {
        const list = agentKids(nid).map(layoutSub);
        const w = list.length ? Math.max.apply(null, list.map((s) => s.w)) : 0;
        let h = 0;
        for (let i = 0; i < list.length; i++) h += list[i].h + (i ? o.agentVGap : 0);
        return { list, w, h };
      };

      // Engine tree over the turn spine, with boxes inflated to reserve the blocks.
      const build = (nid) => {
        const blk = blockOf(nid);
        return {
          id: nid,
          width: size(nid).w + (blk.w ? o.agentGap + blk.w : 0),
          height: Math.max(size(nid).h, blk.h),
          children: turnKids(nid).map(build),
        };
      };

      const E = engine();
      const layout = new E.Layout(new E.BoundingBox(o.hGap, o.vGap));
      const result = layout.layout(build(id)).result;

      const pos = {};
      const rects = [];
      (function walk(n) {
        pos[n.id] = { x: n.x, y: n.y };
        rects.push({ x: n.x, y: n.y, w: size(n.id).w, h: size(n.id).h });

        // Blocks sit at the parent card's right edge, inside the reserved box.
        const blk = blockOf(n.id);
        if (blk.list.length) {
          let cursorY = n.y;
          const bx = n.x + size(n.id).w + o.agentGap;
          for (let i = 0; i < blk.list.length; i++) {
            const s = blk.list[i];
            const dx = bx - s.box.left;
            const dy = cursorY - s.box.top;
            for (const sid in s.pos) pos[sid] = { x: s.pos[sid].x + dx, y: s.pos[sid].y + dy };
            for (let k = 0; k < s.rects.length; k++) {
              const r = s.rects[k];
              rects.push({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h });
            }
            cursorY += s.h + o.agentVGap;
          }
        }

        const kids = n.children || [];
        for (let i = 0; i < kids.length; i++) walk(kids[i]);
      })(result);

      const box = bboxOf(rects);
      const outPos = {};
      for (const k in pos) outPos[k] = { x: pos[k].x - box.left, y: pos[k].y - box.top };
      const out = {
        pos: outPos,
        rects: rects.map((r) => ({ x: r.x - box.left, y: r.y - box.top, w: r.w, h: r.h })),
        box: { left: 0, top: 0, right: box.right - box.left, bottom: box.bottom - box.top },
        w: box.right - box.left,
        h: box.bottom - box.top,
      };
      memo.set(id, out);
      return out;
    }

    const res = layoutSub(rootId);
    return {
      pos: res.pos,
      width: res.box.right + o.pad * 2,
      height: res.box.bottom + o.pad * 2,
    };
  }

  window.treeLayout = { layoutTree };
})();
