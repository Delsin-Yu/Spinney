/*
 * Chat Tree layout — pure functions, no DOM.
 *
 * Two kinds of children, two directions:
 *   - turn children hang BELOW their parent (the conversation spine),
 *   - sidecar children — sub-agent windows (`kind: 'agent'`) and background job
 *     cards (`kind: 'bg'`) — sit to the RIGHT of the parent card, packed into a
 *     COLUMN-MAJOR GRID: at most `agentMaxRows` rows per column, and every further
 *     window opens a new column to the right — X0Y0..X0Y3, X1Y0..X1Y3, X2Y0.. — so
 *     "heavily parallel" work fans out sideways instead of turning the canvas into
 *     one long vertical ribbon.
 *
 * NO SHARED ROWS. Rows are never aligned across columns: each column is its own
 * stack of windows. A column's natural stack is
 *
 *   S_c = agentTopPad + Σ (cell subtree height) + (n_c − 1) * agentVGap
 *
 * the block (the whole grid) is `B = max_c S_c` tall, and a shorter column spreads
 * its free space `L_c = B − S_c` EVENLY over its own cells — `q = L_c / n_c` each,
 * with the integer remainder going to the topmost cells first. Every cell is then
 * STRETCHED to its slot (`extent + share`), so every column ends flush with the
 * block's bottom line and no hole is left anywhere between a parent's windows.
 * Stretching is what closes the gap after a card whose own sub-grid is deeper than
 * the card itself: a sub-agent that spawned sub-agents runs down to the bottom of
 * its own sub-grid instead of ending early next to it. It is a RENDERING height
 * only — it never feeds back into the sums, so a node's own extent stays
 * `max(measuredCardH, itsOwnBlockHeight)`, computed bottom-up from the measured
 * heights the webview hands in (see `stretch` below; no cap). The single exception
 * is a cell that carries material below the card's own extent — a turn child under
 * a sidecar, which no live path builds today — where the room belongs to that
 * material, so the card stops above it.
 *
 * THE TRADEOFF this buys: a deep branch pays only in its OWN column. A shared row
 * line would let one deep sub-agent push every column down and leave a dead gap in
 * each of them (the price of a shallow column would be somebody else's depth);
 * with the per-column stack above, the shallower columns stay where they are — their
 * cards grow to soak up the difference — and every column still ends flush at the
 * block's bottom. `agentMaxRows: 1` reproduces the old single-column ribbon.
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
 * inside the parent's exclusive rectangle (its first card starts `agentTopPad`
 * below the parent card's top, its last row ends on the block's bottom line = the
 * parent card's top + B, and a stretched card still ends no lower than that), which
 * makes all of these invariants hold by construction:
 *   - no card overlaps a window,
 *   - no card sits between a parent card and its windows,
 *   - no connector crosses a foreign card.
 * The bounded row count is what keeps the price of that reservation affordable: a
 * block is at most `agentMaxRows` card rows tall — the tallest column decides the
 * rest — so the turn children below a node are pushed down by the tallest COLUMN
 * instead of by the sum of every window's height.
 *
 * THE ROUTING TABLE (`cells` in the result) exists so the webview can draw the
 * parent→window connectors without recomputing (or guessing) the grid geometry:
 * every entry names the corridors the connector may use — the bus in the gap right
 * of the parent card, the channel in the gap left of the window's column, and the
 * `corrY` line its crossing of the columns in between runs along. The bus and the
 * channels are gaps between boxes, so they are card-free by construction; the
 * crossing line is the gap directly above the window's own box (the top-pad strip
 * for a column's first row) — the card above it may be stretched, so the gap is
 * measured from that card's RENDERED bottom, never from its box — and it is used
 * only when the columns it has to cross leave it alone: a deep branch in a column
 * to its left sticks through it otherwise, and then the line slips below the card
 * that blocks it, which clears the crossing after at most one slip per card — see
 * `drawEdges()` in media/main.js.
 *
 * Exposed as `window.treeLayout`.
 */
(function () {
  /** A display-only sidecar card: a sub-agent window or a background job card. */
  function isSidecarKind(kind) {
    return kind === 'agent' || kind === 'bg';
  }

  const DEFAULTS = {
    nodeW: 320,
    hGap: 48,
    vGap: 72,
    pad: 20,
    // Agent (sub-agent) sidecar geometry.
    agentGap: 80,      // card right edge -> grid left edge
    agentVGap: 24,     // gap between two cards of a column
    agentColGap: 48,   // gap between two columns
    agentMaxRows: 4,   // rows per column (the bounded axis)
    agentTopPad: 16,   // strip above a column's first card
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
   * @param {Object} nodesById  id -> { id, children: string[], kind?: 'turn'|'agent'|'bg' }
   * @param {string} rootId
   * @param {Object} heights    id -> measured pixel height
   * @param {Object} [opts]     { nodeW, hGap, vGap, pad, widths, agentGap, agentVGap,
   *                              agentColGap, agentMaxRows, agentTopPad }
   * @returns {{ pos: Object<string, {x:number,y:number}>,
   *             cells: Object<string, {x,y,w,h,col,row,index,count,busX,chanX,corrY}>,
   *             stretch: Object<string, number>,
   *             width:number, height:number }}
   *          `cells` is keyed by sidecar child id; it is the connector routing table
   *          (absolute coordinates, same space as `pos`: `x`/`y` are the card's own
   *          slot corner, `w`/`h` the size of its subtree box). `stretch` is keyed by
   *          sidecar child id as well and gives the card's rendered height, which is
   *          always >= its measured height; turn nodes never appear in it.
   */
  function layoutTree(nodesById, rootId, heights, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const widths = o.widths || {};
    const size = (id) => ({ w: widths[id] || o.nodeW, h: heights[id] || 120 });
    const kidsOf = (id) => (nodesById[id] && nodesById[id].children) || [];
    // Sidecars: sub-agent windows (`kind: 'agent'`) and background job cards
    // (`kind: 'bg'`). Both hang to the RIGHT of their parent, in the same lattice.
    const isSidecar = (id) => !!nodesById[id] && isSidecarKind(nodesById[id].kind);
    const turnKids = (id) => kidsOf(id).filter((c) => !!nodesById[c] && !isSidecar(c));
    const agentKids = (id) => kidsOf(id).filter((c) => !!nodesById[c] && isSidecar(c));

    if (!nodesById[rootId]) {
      return { pos: {}, cells: {}, stretch: {}, width: o.nodeW + o.pad * 2, height: 120 + o.pad * 2 };
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

    // A subtree is laid out once per node and a node's sidecar grid is packed once:
    // `memo` and `blocks` keep the lookups that need them (build the engine tree,
    // place the blocks, collect the routing table) from redoing that work.
    const memo = new Map();
    const blocks = new Map();

    /**
     * The sidecar grid of one node. `list[i]` is the memoized subtree layout of the
     * i-th sidecar child — column-major, `col = floor(i / R)` and `row = i % R` —
     * and `cells[i]` is its placement inside the block; `w`/`h` are the block's size,
     * i.e. exactly what the node's engine box reserves for it. See the header for
     * the per-column-sum + even-fill model.
     */
    const blockOf = (nid) => {
      const hit = blocks.get(nid);
      if (hit) return hit;
      const list = agentKids(nid).map(layoutSub);
      const n = list.length;
      if (!n) {
        const empty = { list: [], cells: [], nCols: 0, w: 0, h: 0 };
        blocks.set(nid, empty);
        return empty;
      }

      const R = Math.max(1, o.agentMaxRows | 0);
      const nCols = Math.ceil(n / R);

      // Columns: a column's x is where the previous column ended and its width is
      // the widest subtree box in it (nothing of a column reaches past that, so the
      // next column's boxes can never touch it); `colNat` is the column's natural
      // stack, i.e. its cells' own subtree box heights plus the gaps between them.
      const colX = new Array(nCols);
      const colCount = new Array(nCols);
      const colNat = new Array(nCols);
      let blockW = 0;
      let B = 0;
      for (let c = 0; c < nCols; c++) {
        const cnt = Math.min(R, n - c * R);
        let colw = 0;
        let sum = 0;
        for (let i = c * R; i < c * R + cnt; i++) {
          const s = list[i];
          if (s.w > colw) colw = s.w;
          sum += s.h;
        }
        const nat = o.agentTopPad + sum + (cnt - 1) * o.agentVGap;
        colX[c] = blockW;
        colCount[c] = cnt;
        colNat[c] = nat;
        if (nat > B) B = nat;
        blockW += colw + o.agentColGap;
      }
      blockW -= o.agentColGap;

      // Even fill: a shorter column spreads its free space over its own cells (the
      // remainder to the topmost ones), which stretches those cards. Every column
      // then ends exactly at `B`, so nothing is left over anywhere.
      const cells = new Array(n);
      for (let c = 0; c < nCols; c++) {
        const cnt = colCount[c];
        const free = B - colNat[c];
        const q = Math.floor(free / cnt);
        const rem = free - q * cnt;
        let y = o.agentTopPad;   // a column starts at the block's top + top pad
        for (let r = 0; r < cnt; r++) {
          const i = c * R + r;
          const s = list[i];
          const slotH = s.h + (r < rem ? q + 1 : q);
          cells[i] = { s, col: c, row: r, boxX: colX[c], boxY: y, slotH, corrY: 0 };
          y += slotH + o.agentVGap;
        }
        // `y - agentVGap === B`: the column is flush with the block's bottom line.
      }

      // The connector's crossing line: the gap directly above the cell's own box —
      // the top-pad strip for a column's first cell, the gap below the card above it
      // otherwise (that card may be stretched, so the gap starts at its *rendered*
      // bottom, not at its box). The line is card-free inside the cell's own column,
      // but a column to the left may reach through it; the line then slips below the
      // card that blocks it, which clears the column-by-column crossing after at most
      // one slip per card.
      for (let i = 0; i < n; i++) {
        const cell = cells[i];
        const above = cell.row > 0 ? cells[i - 1] : null;   // the card above, same column
        const gapTop = above ? above.boxY + above.slotH : cell.boxY - o.agentTopPad;
        let y = (gapTop + cell.boxY) / 2;
        for (let guard = 0; guard < n; guard++) {
          let blocked = null;
          for (let j = 0; j < n; j++) {
            const other = cells[j];
            if (other.col < cell.col && y > other.boxY && y < other.boxY + other.slotH) { blocked = other; break; }
          }
          if (!blocked) break;
          y = blocked.boxY + blocked.slotH + o.agentVGap / 2;
        }
        cell.corrY = y;
      }

      const blk = { list, cells, nCols, w: blockW, h: B };
      blocks.set(nid, blk);
      return blk;
    };

    /**
     * Lay out the subtree rooted at `id` (turn spine + its sidecar blocks),
     * normalized so its own bounding box starts at (0, 0).
     * @returns {{ rootId, pos, cells, stretch, rects, box, w, h }}
     */
    function layoutSub(id) {
      if (memo.has(id)) return memo.get(id);

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
      const cells = {};     // sidecar child id -> connector routing record
      const stretch = {};   // sidecar child id -> rendered card height
      (function walk(n) {
        pos[n.id] = { x: n.x, y: n.y };
        rects.push({ x: n.x, y: n.y, w: size(n.id).w, h: size(n.id).h });

        // The grid sits at the parent card's right edge, inside the reserved box and
        // flush with the card's top: the block's first `agentTopPad` strip is the
        // row-0 corridor and the block's bottom line is the card's top + B.
        const blk = blockOf(n.id);
        if (blk.list.length) {
          const cardW = size(n.id).w;
          const bx = n.x + cardW + o.agentGap;
          const by = n.y;
          const busX = n.x + cardW + o.agentGap / 2;
          for (let i = 0; i < blk.cells.length; i++) {
            const cell = blk.cells[i];
            const s = cell.s;
            const a = s.pos[s.rootId];
            // Place the cell's box at its slot's top-left corner; the cell's own card
            // ends up where the cell's layout put it inside that box.
            const dx = bx + cell.boxX - a.x;
            const dy = by + cell.boxY - a.y;
            const cardX = a.x + dx;
            const cardY = a.y + dy;
            for (const sid in s.pos) pos[sid] = { x: s.pos[sid].x + dx, y: s.pos[sid].y + dy };
            for (let k = 0; k < s.rects.length; k++) {
              const r = s.rects[k];
              rects.push({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h });
            }
            // A nested sub-agent's OWN grid: its routing records shift with it, its
            // stretches (heights) come along unchanged.
            for (const cid in s.cells) {
              const c = s.cells[cid];
              cells[cid] = {
                x: c.x + dx, y: c.y + dy, w: c.w, h: c.h,
                col: c.col, row: c.row, index: c.index, count: c.count,
                busX: c.busX + dx, chanX: c.chanX + dx, corrY: c.corrY + dy,
              };
            }
            for (const tid in s.stretch) stretch[tid] = s.stretch[tid];
            // Corridors the connector may use: the bus in the gap between the parent
            // card and the grid, the channel in the gap left of this cell's column,
            // and `corrY`, the line it crosses the columns in between at (`blockOf`
            // picked it card-free).
            const colStart = bx + cell.boxX;
            const prevColEnd = colStart - o.agentColGap;
            cells[s.rootId] = {
              x: cardX,
              y: cardY,
              w: s.w,
              h: s.h,
              col: cell.col,
              row: cell.row,
              index: i,
              count: blk.cells.length,
              busX,
              chanX: cell.col === 0 ? busX : (prevColEnd + colStart) / 2,
              corrY: by + cell.corrY,
            };
            // The card fills its whole slot — except when the cell holds material
            // below the card's own extent: a turn child hanging under a sidecar (a
            // shape no live path builds today, but a session file could carry) needs
            // the room above it, so the card stops at its own extent and the slot's
            // spare space stays empty instead of being swallowed by the card. The
            // clamp is a no-op for every reachable shape: there the box IS the card's
            // own extent and `tail` is 0, so the card soaks up the whole slot.
            const ownH = Math.max(size(s.rootId).h, blockOf(s.rootId).h);
            const tail = s.h - (a.y + ownH);
            const room = tail > 0 ? ownH - a.y : cell.slotH;
            stretch[s.rootId] = Math.max(size(s.rootId).h, room);
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
        stretch,
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
      stretch: res.stretch,
      width: res.box.right + o.pad * 2,
      height: res.box.bottom + o.pad * 2,
    };
  }

  window.treeLayout = { layoutTree };
})();
