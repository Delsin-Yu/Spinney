/*
 * Chat Tree layout — pure functions, no DOM.
 *
 * Two kinds of children, two directions:
 *   - turn children hang BELOW their parent (the conversation spine),
 *   - agent (sub-agent) children sit to the RIGHT of the parent card, packed into
 *     an aligned COLUMN-MAJOR GRID: at most `agentMaxRows` rows per column, and
 *     every further window opens a new column to the right —
 *     X0Y0..X0Y3, X1Y0..X1Y3, X2Y0.. — so "heavily parallel" work fans out
 *     sideways instead of turning the canvas into one long vertical ribbon.
 *     Rows are aligned across columns (row r shares its y band in every column)
 *     and columns are aligned across rows, so the windows read as a lattice.
 *
 * A sub-agent's OWN children follow the same rules recursively: its turn children
 * hang below its card and its sub-agents build their own grid to the right of it.
 *
 * The tidy-tree geometry is delegated to the vendored, pinned engine
 * `non-layered-tidy-tree-layout@2.0.2` (MIT) — see
 * media/vendor/non-layered-tidy-tree-layout/PROVENANCE.md.
 *
 * WHY THE SIDECAR SPACE IS RESERVED IN THE ENGINE (not packed afterwards):
 * a post-hoc packer has to push a window past whatever card already sits in its
 * y-band, which visually inserts unrelated nodes between a parent and its own
 * sub-agents ("Node B between Node A and its subagents"). Instead, each node's
 * box is *inflated* by the size of its sidecar grid and by its height, so the
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
 * The bounded row count is what keeps the price of that reservation affordable: a
 * block is at most `agentMaxRows` rows tall, so the turn children below a node are
 * pushed down by at most that much instead of by the sum of every window's height.
 *
 * THE ROUTING TABLE (`cells` in the result) exists so the webview can draw the
 * parent→window connectors without recomputing (or guessing) the grid geometry:
 * every entry names the corridors the connector may use. Rows and columns are
 * separated by `agentVGap` / `agentColGap`, and `agentTopPad` opens a corridor
 * above row 0, so each of those lines is card-free by construction — see
 * `drawEdges()` in media/main.js.
 *
 * Exposed as `window.treeLayout`.
 */
(function () {
  const DEFAULTS = {
    nodeW: 320,
    hGap: 48,
    vGap: 72,
    pad: 20,
    // Agent (sub-agent) sidecar geometry.
    agentGap: 80,      // card right edge -> grid left edge
    agentVGap: 24,     // row gap
    agentColGap: 48,   // column gap
    agentMaxRows: 4,   // rows per column (the bounded axis)
    agentTopPad: 16,   // corridor above row 0
  };

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
   * @param {Object} [opts]     { nodeW, hGap, vGap, pad, widths, agentGap, agentVGap,
   *                              agentColGap, agentMaxRows, agentTopPad }
   * @returns {{ pos: Object<string, {x:number,y:number}>,
   *             cells: Object<string, {x,y,w,h,col,row,index,count,busX,chanX,corrY}>,
   *             width:number, height:number }}
   *          `cells` is keyed by agent child id; it is the connector routing table
   *          (absolute coordinates, same space as `pos`).
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
      return { pos: {}, cells: {}, width: o.nodeW + o.pad * 2, height: 120 + o.pad * 2 };
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
     * @returns {{ rootId, pos, rects, box:{left,top,right,bottom}, w, h }}
     */
    function layoutSub(id) {
      if (memo.has(id)) return memo.get(id);

      // Sidecar grid of one node: each agent subtree laid out recursively with
      // this same algorithm, then packed column-major (R rows per column) into an
      // aligned lattice.
      //
      // The lattice lines are the WINDOW CARD lines, not the subtree boxes: a
      // subtree box is the bbox of the whole sub-agent branch, and the engine
      // centres a card over its children, so the card can sit well inside its box
      // (a wide turn child pushes it right). Anchoring on the card is what makes
      // every card in a column share an x and every card in a row share a y;
      // a cell's box is then placed around its own line, and each column/row
      // reserves `colL`/`rowT` (the largest overhang) so the boxes never touch.
      const blockOf = (nid) => {
        const list = agentKids(nid).map(layoutSub);
        if (!list.length) return { list: [], cells: [], colX: [], rowY: [], w: 0, h: 0 };
        const R = Math.max(1, o.agentMaxRows | 0);
        const nCols = Math.ceil(list.length / R);
        const nRows = Math.min(R, list.length);
        const anchor = list.map((s) => {
          const c = s.pos[s.rootId];
          return { left: c.x, top: c.y, right: s.w - c.x, bottom: s.h - c.y };
        });
        const colL = new Array(nCols).fill(0);
        const colR = new Array(nCols).fill(0);
        const rowT = new Array(Math.min(R, list.length)).fill(0);
        const rowB = new Array(Math.min(R, list.length)).fill(0);
        for (let i = 0; i < list.length; i++) {
          const c = Math.floor(i / R);
          const r = i % R;
          const a = anchor[i];
          if (a.left > colL[c]) colL[c] = a.left;
          if (a.right > colR[c]) colR[c] = a.right;
          if (a.top > rowT[r]) rowT[r] = a.top;
          if (a.bottom > rowB[r]) rowB[r] = a.bottom;
        }
        const colX = [];
        let cx = 0;
        for (let c = 0; c < nCols; c++) {
          colX.push(cx + colL[c]);
          cx += colL[c] + colR[c] + o.agentColGap;
        }
        const rowY = [];
        let cy = 0;
        for (let r = 0; r < nRows; r++) {
          rowY.push(cy + rowT[r]);
          cy += rowT[r] + rowB[r] + o.agentVGap;
        }
        const cells = list.map((s, i) => {
          const col = Math.floor(i / R);
          const row = i % R;
          return { s, col, row, ax: colX[col], ay: rowY[row], left: anchor[i].left, top: anchor[i].top };
        });
        return {
          list, cells, colX, rowY, colL, colR, rowT, rowB, nCols, nRows,
          w: cx - o.agentColGap,
          h: o.agentTopPad + cy - o.agentVGap,
        };
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
      const cells = {};   // agent child id -> connector routing record
      (function walk(n) {
        pos[n.id] = { x: n.x, y: n.y };
        rects.push({ x: n.x, y: n.y, w: size(n.id).w, h: size(n.id).h });

        // The grid sits at the parent card's right edge, inside the reserved box,
        // `agentTopPad` below the card's top (that strip is the row-0 corridor).
        const blk = blockOf(n.id);
        if (blk.list.length) {
          const cardW = size(n.id).w;
          const bx = n.x + cardW + o.agentGap;
          const by = n.y + o.agentTopPad;
          const busX = n.x + cardW + o.agentGap / 2;
          for (let i = 0; i < blk.cells.length; i++) {
            const cell = blk.cells[i];
            const s = cell.s;
            const cardX = bx + cell.ax;   // this cell's card line
            const cardY = by + cell.ay;
            const dx = cardX - cell.left - s.box.left;
            const dy = cardY - cell.top - s.box.top;
            for (const sid in s.pos) pos[sid] = { x: s.pos[sid].x + dx, y: s.pos[sid].y + dy };
            for (let k = 0; k < s.rects.length; k++) {
              const r = s.rects[k];
              rects.push({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h });
            }
            // The subtree's OWN agent children (nested sub-agents) bring their
            // routing records along, shifted the same way.
            for (const cid in s.cells) {
              const c = s.cells[cid];
              cells[cid] = {
                x: c.x + dx, y: c.y + dy, w: c.w, h: c.h,
                col: c.col, row: c.row, index: c.index, count: c.count,
                busX: c.busX + dx, chanX: c.chanX + dx, corrY: c.corrY + dy,
              };
            }
            // Corridors the connector may use: the gap between the card and the
            // grid, the gap left of this cell's column, and the gap above this
            // cell's row (the top pad for row 0).
            const colStart = bx + cell.ax - blk.colL[cell.col];      // leftmost x of the column
            const prevColEnd = bx + (cell.ax - blk.colL[cell.col]) - o.agentColGap;
            const rowStart = by + cell.ay - blk.rowT[cell.row];      // topmost y of the row
            const prevRowEnd = by + (cell.ay - blk.rowT[cell.row]) - o.agentVGap;
            cells[s.rootId] = {
              x: bx + cell.ax - cell.left,
              y: by + cell.ay - cell.top,
              w: s.w,
              h: s.h,
              col: cell.col,
              row: cell.row,
              index: i,
              count: blk.cells.length,
              busX,
              chanX: cell.col === 0 ? busX : (prevColEnd + colStart) / 2,
              corrY: cell.row === 0 ? n.y + o.agentTopPad / 2 : (prevRowEnd + rowStart) / 2,
            };
          }
        }

        const kids = n.children || [];
        for (let i = 0; i < kids.length; i++) walk(kids[i]);
      })(result);

      const box = bboxOf(rects);
      const outPos = {};
      for (const k in pos) outPos[k] = { x: pos[k].x - box.left, y: pos[k].y - box.top };
      const outCells = {};
      for (const k in cells) {
        const c = cells[k];
        outCells[k] = {
          x: c.x - box.left, y: c.y - box.top, w: c.w, h: c.h,
          col: c.col, row: c.row, index: c.index, count: c.count,
          busX: c.busX - box.left, chanX: c.chanX - box.left, corrY: c.corrY - box.top,
        };
      }
      const out = {
        rootId: id,
        pos: outPos,
        cells: outCells,
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
      cells: res.cells,
      width: res.box.right + o.pad * 2,
      height: res.box.bottom + o.pad * 2,
    };
  }

  window.treeLayout = { layoutTree };
})();
