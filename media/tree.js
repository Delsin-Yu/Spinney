/*
 * Chat Tree layout — pure functions, no DOM.
 *
 * Two kinds of children, two directions:
 *   - turn children hang BELOW their parent (the conversation spine),
 *   - sidecar children — sub-agent windows (`kind: 'agent'`) and background job
 *     cards (`kind: 'bg'`) — sit to the RIGHT of the parent card, grouped into DEPTH
 *     BANDS: each band is a lattice of columns holding at most `agentMaxRows` cards, and
 *     the bands follow each other to the right — so "heavily parallel" work fans out
 *     sideways instead of turning the canvas into one long vertical ribbon, and a window
 *     that spawned windows spends a BAND of its own instead of growing its parent's cell.
 *
 * NO SHARED ROWS, AND NO STRETCH. Rows are never aligned across columns: each column
 * is its own stack, every cell occupies exactly its own subtree box, and a column
 * ends where its last cell ends —
 *
 *   S_c = agentTopPad + Σ (cell extent) + (n_c − 1) * agentVGap
 *
 * The block (the whole grid) is `B = max_c S_c` tall, and a shorter column simply
 * stops earlier: nothing is padded, filled or stretched to make the columns flush,
 * so the spare space of a shallow column stays visible as blank canvas inside the
 * parent's reserved box. A card is rendered at exactly the height it measured —
 * `layoutTree` hands out no rendered height at all — so the *card* is the unit of
 * height here, never the cell.
 *
 * DEPTH BANDS, NOT NESTED CELLS. The windows are not packed as one flat lattice, and a
 * window that spawned windows does NOT put its own windows inside its cell: they are
 * grouped by DEPTH — depth 1 is the node's own sidecar children, depth 2 theirs, and so on
 * — and each depth gets its own BAND of columns, the bands following each other to the
 * right.
 *
 * WHY: the parent's engine box is `max(cardH, B)` tall and its turn children — the
 * conversation's own continuation — start below it, so every pixel of B is paid for by the
 * spine. Nesting inside a cell made B grow with the forest: a window owning windows
 * reserved its own stack in its own cell, that cell became huge, it forked the node's
 * lattice into columns of one, and the canvas turned into a ribbon. With bands a cell
 * reserves ONE CARD — `agentMonitorH` for a monitor, the measured height for the one window
 * the user has open — and never another cell's forest, so `B` is a stack of at most
 * `agentMaxRows` cards no matter how deep or how wide the forest is. What the forest costs
 * instead is WIDTH: one band per depth.
 *
 * A window's card is a MONITOR by default: a fixed-height card that shows its live progress
 * (its head, its counters, the tail of its work log) instead of its whole transcript. The
 * one window the user has open measures taller and grows its own column only. `layoutTree`
 * never forces a card's height — the webview renders a monitor and measures what it
 * rendered, and that measurement is what this file weighs.
 *
 * THE TRADEOFF: a deep forest pays in columns, a shallow one pays nothing, and the spine
 * pays at most `agentMaxRows` card heights — nothing at all when the parent's own card is
 * that tall or taller. Rows are never a shared line across bands (each column is its own
 * stack of cards), but every column starts at the same top pad, and the gaps between rows
 * are what the connectors cross on.
 *
 * A sub-agent's turn children — a shape no live path builds, since `attachNode` never puts a
 * turn node under a sidecar — hang below its card inside its own slot; its sub-agents occupy
 * the NEXT depth band, never a grid of their own inside its cell.
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
 * below the parent card's top, the tallest column ends on the block's bottom line = the
 * parent card's top + B, and no card is ever rendered below that line), which
 * makes all of these invariants hold by construction:
 *   - no card overlaps a window,
 *   - no card sits between a parent card and its windows,
 *   - no connector crosses a foreign card.
 * The depth bands and the row cap are what keep the price of that reservation affordable: a
 * column holds at most `agentMaxRows` cards and never another cell's forest, so the turn
 * children below a node are pushed down by a bounded stack instead of by the sum of every
 * window's height.
 *
 * THE ROUTING TABLE (`cells` in the result) exists so the webview can draw the
 * parent→window connectors without recomputing (or guessing) the grid geometry:
 * every entry names the corridors the connector may use — the bus in the gap right
 * of the parent card, the channel in the gap left of the window's column, and the
 * `corrY` line its crossing of the columns in between runs along. The bus and the
 * channels are gaps between boxes, so they are card-free by construction; the
 * crossing line is the gap directly above the window's own box (the top-pad strip
 * for a column's first row) — no card is ever rendered taller than its own box, so
 * that gap is card-free by construction — and it is used
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
    agentColGap: 48,      // gap between two columns, and between two depth bands
    agentMaxRows: 3,      // cards in one column, in every depth band
    agentMonitorH: 200,   // the height of a sub-window card (a "monitor")
    agentTopPad: 16,      // strip above a band's first row
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
   *                              agentColGap, agentMaxRows, agentMaxBlockH, agentTopPad }
   * @returns {{ pos: Object<string, {x:number,y:number}>,
   *             cells: Object<string, {x,y,w,h,col,row,index,count,depth,busX,chanX,corrY}>,
   *             width:number, height:number }}
   *          `cells` is keyed by sidecar child id; it is the connector routing table
   *          (absolute coordinates, same space as `pos`: `x`/`y` are the card's own
   *          box corner, `w`/`h` the size of its subtree box). No rendered height is
   *          returned: every card is rendered at exactly the height it measured.
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

    // A subtree is laid out once per node and a node's sidecar grid is packed once:
    // `memo` and `blocks` keep the lookups that need them (build the engine tree,
    // place the blocks, collect the routing table) from redoing that work.
    const memo = new Map();
    const blocks = new Map();

    /**
     * The sub-agent FOREST of one node: every sidecar below it, grouped into DEPTH BANDS —
     * `bands[d - 1]` holds depth d, i.e. the node's own sidecar children first, then theirs.
     * A band is a lattice: columns of at most `agentMaxRows` cards, in child order, and the
     * bands follow each other to the right.
     *
     * A cell is a CARD, never a subtree: its slot is the card's own height (`agentMonitorH`
     * for a monitor, the measured height for the one window the user has open) plus the room
     * a turn child under it needs (a shape no live path builds). Nothing ever reserves another
     * cell's forest, which is what bounds the block. `w`/`h` are the block's size, i.e.
     * exactly what the node's engine box reserves for it. See the header.
     */
    const forestOf = (nid) => {
      const hit = blocks.get(nid);
      if (hit) return hit;

      const rows = Math.max(1, o.agentMaxRows | 0);
      const cells = [];
      const spawner = new Map();   // forest member -> the card that spawned it
      let x = 0;
      let B = 0;
      let nCols = 0;

      // Lay `list` out in columns of `rows` cards, and DIRECTLY AFTER EACH COLUMN lay out the
      // group formed by that column's cells' own windows. That is what keeps a family together:
      // a window's own windows stand one column hop right of its own column instead of after the
      // whole level, so a connector never crosses a sibling's subtree on its way to its child.
      // The total number of columns is the same either way; only their ORDER changes.
      const placeGroup = (list, depth) => {
        for (let start = 0; start < list.length; start += rows) {
          const col = list.slice(start, start + rows);
          // A column is as wide as the WIDEST card in it: a monitor is `nodeW` wide, and the one
          // card the user has open measures wider (`.node.expanded` is 560px), so the pitch has
          // to follow the cards instead of a fixed `nodeW`.
          let colW = 0;
          for (const id of col) colW = Math.max(colW, size(id).w);
          const colX = x;
          x += colW + o.agentColGap;
          nCols++;
          let y = o.agentTopPad;   // every column starts at its own group's top pad
          const kids = [];
          for (let r = 0; r < col.length; r++) {
            const id = col[r];
            const own = Math.max(o.agentMonitorH, size(id).h);
            const turn = turnKids(id).map(layoutSub);
            let slotH = own;
            for (let i = 0; i < turn.length; i++) slotH += o.agentVGap + turn[i].h;
            cells.push({
              id, subs: turn, boxX: colX, boxY: y, slotW: colW, slotH,
              depth, col: Math.floor(start / rows), row: r,
              index: start + r, count: list.length, corrY: 0,
            });
            if (y + slotH > B) B = y + slotH;
            y += slotH + o.agentVGap;
            for (const k of agentKids(id)) { kids.push(k); spawner.set(k, id); }
          }
          if (kids.length) placeGroup(kids, depth + 1);
        }
      };
      placeGroup(agentKids(nid), 1);
      const W = x ? x - o.agentColGap : 0;

      // The connector's crossing line: the gap directly above the cell's own box — the
      // top-pad strip for a column's first cell, the gap below the box above it otherwise.
      // A card is never rendered taller than its own slot, so that gap is free of the cell's
      // own column; a column to the LEFT may still reach through it, and the line then slips
      // below the box that blocks it, which clears the column-by-column crossing after at
      // most one slip per cell.
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        const above = cell.row > 0 ? cells[i - 1] : null;
        const gapTop = above ? above.boxY + above.slotH : cell.boxY - o.agentTopPad;
        let y = (gapTop + cell.boxY) / 2;
        for (let guard = 0; guard < cells.length; guard++) {
          let blocked = null;
          for (let j = 0; j < cells.length; j++) {
            const other = cells[j];
            if (other.boxX < cell.boxX && y > other.boxY && y < other.boxY + other.slotH) { blocked = other; break; }
          }
          if (!blocked) break;
          y = blocked.boxY + blocked.slotH + o.agentVGap / 2;
        }
        cell.corrY = y;
      }

      const blk = { cells, spawner, nCols, w: W, h: B };
      blocks.set(nid, blk);
      return blk;
    };

    /**
     * Lay out the subtree rooted at `id` (turn spine + its sidecar blocks),
     * normalized so its own bounding box starts at (0, 0).
     * @returns {{ rootId, pos, cells, rects, box, w, h }}
     */
    function layoutSub(id) {
      if (memo.has(id)) return memo.get(id);

      // Engine tree over the turn spine, with boxes inflated to reserve each node's forest.
      const build = (nid) => {
        const blk = forestOf(nid);
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
      (function walk(n) {
        pos[n.id] = { x: n.x, y: n.y };
        rects.push({ x: n.x, y: n.y, w: size(n.id).w, h: size(n.id).h });

        // The forest sits at the parent card's right edge, inside the reserved box and flush
        // with the card's top: the block's first `agentTopPad` strip is the row-0 corridor and
        // the block's bottom line is the card's top + B.
        const blk = forestOf(n.id);
        if (blk.cells.length) {
          const cardW = size(n.id).w;
          const bx = n.x + cardW + o.agentGap;
          const by = n.y;
          const placed = {};   // forest member id -> where its card was put
          for (let i = 0; i < blk.cells.length; i++) {
            const cell = blk.cells[i];
            const id = cell.id;
            const x = bx + cell.boxX;
            const y = by + cell.boxY;
            placed[id] = { x, y };
            pos[id] = { x, y };
            rects.push({ x, y, w: size(id).w, h: size(id).h });

            // Whatever hangs under this card — a turn child under a sidecar, a shape no live
            // path builds — lives inside the slot, below the card.
            let ty = y + Math.max(o.agentMonitorH, size(id).h) + o.agentVGap;
            for (const s of cell.subs) {
              for (const sid in s.pos) pos[sid] = { x: s.pos[sid].x + x, y: s.pos[sid].y + ty };
              for (let k = 0; k < s.rects.length; k++) {
                const r = s.rects[k];
                rects.push({ x: r.x + x, y: r.y + ty, w: r.w, h: r.h });
              }
              for (const cid in s.cells) {
                const c = s.cells[cid];
                cells[cid] = {
                  x: c.x + x, y: c.y + ty, w: c.w, h: c.h,
                  col: c.col, row: c.row, index: c.index, count: c.count,
                  depth: c.depth,
                  busX: c.busX + x, chanX: c.chanX + x, corrY: c.corrY + ty,
                };
              }
              ty += s.h + o.agentVGap;
            }

            // The corridors the connector may use: the bus in the gap right of the card that
            // SPAWNED this window — the node itself for depth 1, another window for a deeper
            // band — the channel in the gap immediately left of this card's own column, and
            // `corrY`, the line it crosses every column in between on (`forestOf` picked it
            // card-free). The rect below is the CARD's own box, size and all: a cell is a card
            // here, never a subtree, so there is no inset to worry about.
            const spId = blk.spawner.get(id) || n.id;
            const sp = placed[spId] || { x: n.x, y: n.y };
            const colStart = bx + cell.boxX;
            cells[id] = {
              x,
              y,
              w: size(id).w,
              h: cell.slotH,
              col: cell.col,
              row: cell.row,
              index: cell.index,
              count: cell.count,
              depth: cell.depth,
              busX: sp.x + size(spId).w + o.agentGap / 2,
              chanX: colStart - o.agentColGap / 2,
              corrY: by + cell.corrY,
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
          depth: c.depth,
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
