'use strict';
/*
 * Design N — engine-owned sidecar reservation (the minimal-glue design).
 *
 * Idea: instead of laying out the turn tree first and then packing agent
 * subtrees into free space (Design A), inflate each node's *box* so that the
 * engine itself reserves the sidecar rectangle. non-layered-tidy-tree-layout
 * computes box = (width + hGap) x (height + vGap), puts the card at
 * boxLeft + hGap/2, and starts children at parent.y + boxHeight. So feeding
 *   width  = cardW + (hasAgents ? agentGap + blockW : 0)
 *   height = max(cardH, blockH)
 * makes the contour pass push every sibling clear of the sidecar rectangle, and
 * pushes the turn children below it. Overlap-freedom is therefore *constructive*
 * (no collision code at all), but we pay for it: a node whose sidecar block is
 * taller than its card pushes its turn children down by blockH - cardH.
 *
 * Signature identical to media/tree.js layoutTree().
 */
// Loaded from the vendored dist (see engine.js) plus the two helpers this file
// used to borrow from candidates.js, so the layout regression tests need no npm
// install. `C` keeps the old call sites below unchanged.
const nlttl = require('./engine');

const DEFAULTS = { nodeW: 320, hGap: 48, vGap: 72, pad: 20, agentGap: 80, agentVGap: 24 };

function bbox(rects) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const r of rects) {
    left = Math.min(left, r.x); top = Math.min(top, r.y);
    right = Math.max(right, r.x + r.w); bottom = Math.max(bottom, r.y + r.h);
  }
  if (!rects.length) return { left: 0, top: 0, right: 0, bottom: 0 };
  return { left, top, right, bottom };
}

function helpers(nodesById, heights, widths, o) {
  const w = (id) => widths[id] || o.nodeW;
  const h = (id) => heights[id] || 120;
  const isAgent = (id) => !!(nodesById[id] && nodesById[id].kind === 'agent');
  const kids = (id) => (nodesById[id] && nodesById[id].children) || [];
  return {
    w, h, isAgent,
    turnKids: (id) => kids(id).filter((c) => nodesById[c] && !isAgent(c)),
    agentKids: (id) => kids(id).filter((c) => nodesById[c] && isAgent(c)),
    allKids: (id) => kids(id).filter((c) => !!nodesById[c]),
  };
}

const C = { nlttl, bbox, helpers, DEFAULTS };

function layoutEngineReserve(nodesById, rootId, heights, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const widths = o.widths || {};
  const H = helpers(nodesById, heights, widths, o);
  const sz = { w: (id) => widths[id] || o.nodeW, h: (id) => heights[id] || 120 };

  if (!nodesById[rootId]) {
    return { pos: {}, width: o.nodeW + o.pad * 2, height: 120 + o.pad * 2 };
  }

  const memo = new Map();

  // Lay out the subtree rooted at `id` (turn or agent) with Design N, returning
  // normalized coords (box.left = box.top = 0) plus card rects.
  function layoutSub(id) {
    if (memo.has(id)) return memo.get(id);

    // Per-node sidecar block: each agent kid is laid out recursively (same
    // engine), then the blocks are stacked vertically at their natural width.
    const infoOf = (nid) => {
      const ak = H.agentKids(nid);
      const list = ak.map(layoutSub);
      const w = list.length ? Math.max(...list.map((s) => s.w)) : 0;
      const h = list.length
        ? list.reduce((acc, s) => acc + s.h, 0) + o.agentVGap * (list.length - 1)
        : 0;
      return { list, w, h };
    };

    // Turn-only tree with inflated boxes: the engine reserves the sidecar space.
    const build = (nid) => {
      const info = infoOf(nid);
      return {
        id: nid,
        width: sz.w(nid) + (info.w ? o.agentGap + info.w : 0),
        height: Math.max(sz.h(nid), info.h),
        children: H.turnKids(nid).map(build),
      };
    };

    const L = new C.nlttl.Layout(new C.nlttl.BoundingBox(o.hGap, o.vGap));
    const { result } = L.layout(build(id));

    const pos = {};
    const rects = [];
    const walk = (n) => {
      pos[n.id] = { x: n.x, y: n.y };
      rects.push({ id: n.id, x: n.x, y: n.y, w: sz.w(n.id), h: sz.h(n.id) });
      const info = infoOf(n.id);
      if (info.list.length) {
        // Sidecar block: card right edge + agentGap, inside the reserved box.
        let cy = n.y;
        for (const s of info.list) {
          const dx = n.x + sz.w(n.id) + o.agentGap - s.box.left;
          const dy = cy - s.box.top;
          for (const sid in s.pos) {
            pos[sid] = { x: s.pos[sid].x + dx, y: s.pos[sid].y + dy };
          }
          for (const r of s.rects) {
            rects.push({ id: r.id, x: r.x + dx, y: r.y + dy, w: r.w, h: r.h });
          }
          cy += s.h + o.agentVGap;
        }
      }
      for (const c of n.children || []) walk(c);
    };
    walk(result);

    const box = bbox(rects);
    const out = {
      pos: {},
      rects: rects.map((r) => ({ ...r, x: r.x - box.left, y: r.y - box.top })),
      box: { left: 0, top: 0, right: box.right - box.left, bottom: box.bottom - box.top },
      w: box.right - box.left,
      h: box.bottom - box.top,
    };
    for (const id2 in pos) out.pos[id2] = { x: pos[id2].x - box.left, y: pos[id2].y - box.top };
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

// ---------------------------------------------------------------- wrapped blocks
/**
 * Design N with wrapped sidecar blocks: a node's agent windows are arranged in a
 * grid of at most `maxCols` columns instead of a single vertical stack. The block
 * is shorter (less vertical inflation, so turn children are pushed down less) but
 * wider (the parent's box reserves more width).
 */
function layoutEngineReserveWrapped(nodesById, rootId, heights, opts, maxCols) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const cols = Math.max(1, maxCols || 2);
  const hGapWin = o.agentHGap || o.hGap;
  const widths = o.widths || {};
  const H = helpers(nodesById, heights, widths, o);
  const sz = { w: (id) => widths[id] || o.nodeW, h: (id) => heights[id] || 120 };

  if (!nodesById[rootId]) {
    return { pos: {}, width: o.nodeW + o.pad * 2, height: 120 + o.pad * 2 };
  }

  const memo = new Map();

  function layoutSub(id) {
    if (memo.has(id)) return memo.get(id);

    const infoOf = (nid) => {
      const ak = H.agentKids(nid);
      const list = ak.map(layoutSub);
      if (!list.length) return { items: [], w: 0, h: 0 };
      // grid packing: row-major, at most `cols` per row
      const nCols = Math.min(cols, list.length);
      const rows = Math.ceil(list.length / nCols);
      const colW = new Array(nCols).fill(0);
      const rowH = new Array(rows).fill(0);
      list.forEach((s, i) => {
        const c = i % nCols;
        const r = Math.floor(i / nCols);
        colW[c] = Math.max(colW[c], s.w);
        rowH[r] = Math.max(rowH[r], s.h);
      });
      const colX = [];
      let x = 0;
      for (let c = 0; c < nCols; c++) {
        colX.push(x);
        x += colW[c] + (c < nCols - 1 ? hGapWin : 0);
      }
      const rowY = [];
      let y = 0;
      for (let r = 0; r < rows; r++) {
        rowY.push(y);
        y += rowH[r] + (r < rows - 1 ? o.agentVGap : 0);
      }
      const items = list.map((s, i) => ({ s, x: colX[i % nCols], y: rowY[Math.floor(i / nCols)] }));
      return { items, w: x, h: y };
    };

    const build = (nid) => {
      const info = infoOf(nid);
      return {
        id: nid,
        width: sz.w(nid) + (info.w ? o.agentGap + info.w : 0),
        height: Math.max(sz.h(nid), info.h),
        children: H.turnKids(nid).map(build),
      };
    };

    const L = new C.nlttl.Layout(new C.nlttl.BoundingBox(o.hGap, o.vGap));
    const { result } = L.layout(build(id));

    const pos = {};
    const rects = [];
    const walk = (n) => {
      pos[n.id] = { x: n.x, y: n.y };
      rects.push({ id: n.id, x: n.x, y: n.y, w: sz.w(n.id), h: sz.h(n.id) });
      const info = infoOf(n.id);
      if (info.items.length) {
        const bx = n.x + sz.w(n.id) + o.agentGap;
        const by = n.y;
        for (const it of info.items) {
          const dx = bx + it.x - it.s.box.left;
          const dy = by + it.y - it.s.box.top;
          for (const sid in it.s.pos) pos[sid] = { x: it.s.pos[sid].x + dx, y: it.s.pos[sid].y + dy };
          for (const r of it.s.rects) rects.push({ id: r.id, x: r.x + dx, y: r.y + dy, w: r.w, h: r.h });
        }
      }
      for (const c of n.children || []) walk(c);
    };
    walk(result);

    const box = bbox(rects);
    const out = {
      pos: {},
      rects: rects.map((r) => ({ ...r, x: r.x - box.left, y: r.y - box.top })),
      box: { left: 0, top: 0, right: box.right - box.left, bottom: box.bottom - box.top },
      w: box.right - box.left,
      h: box.bottom - box.top,
    };
    for (const id2 in pos) out.pos[id2] = { x: pos[id2].x - box.left, y: pos[id2].y - box.top };
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

// ------------------------------------------------------------------ shipped grid
/**
 * Design G — design N with the sidecar block packed into an aligned, column-major
 * LATTICE (`agentMaxRows` rows per column; every further window opens a column to
 * the right) instead of a single vertical stack, plus the connector routing table
 * the webview draws from.
 *
 * This is an independent copy of the shipped `media/tree.js` algorithm: it exists
 * so `verify-tree.js` can pin the shipped file position-for-position against a
 * benchmarked design (if someone edits tree.js, `maxDelta` goes non-zero).
 */
const GRID_DEFAULTS = {
  nodeW: 320, hGap: 48, vGap: 72, pad: 20,
  agentGap: 80, agentVGap: 24, agentColGap: 48, agentMaxRows: 4, agentTopPad: 16,
};

function layoutEngineReserveGrid(nodesById, rootId, heights, opts) {
  const o = Object.assign({}, GRID_DEFAULTS, opts || {});
  const widths = o.widths || {};
  const size = (id) => ({ w: widths[id] || o.nodeW, h: heights[id] || 120 });
  const kidsOf = (id) => (nodesById[id] && nodesById[id].children) || [];
  const isAgent = (id) => !!nodesById[id] && nodesById[id].kind === 'agent';
  const turnKids = (id) => kidsOf(id).filter((c) => !!nodesById[c] && !isAgent(c));
  const agentKids = (id) => kidsOf(id).filter((c) => !!nodesById[c] && isAgent(c));

  if (!nodesById[rootId]) {
    return { pos: {}, cells: {}, width: o.nodeW + o.pad * 2, height: 120 + o.pad * 2 };
  }

  const memo = new Map();

  function layoutSub(id) {
    if (memo.has(id)) return memo.get(id);

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

    const build = (nid) => {
      const blk = blockOf(nid);
      return {
        id: nid,
        width: size(nid).w + (blk.w ? o.agentGap + blk.w : 0),
        height: Math.max(size(nid).h, blk.h),
        children: turnKids(nid).map(build),
      };
    };

    const L = new C.nlttl.Layout(new C.nlttl.BoundingBox(o.hGap, o.vGap));
    const { result } = L.layout(build(id));

    const pos = {};
    const rects = [];
    const cells = {};
    (function walk(n) {
      pos[n.id] = { x: n.x, y: n.y };
      rects.push({ x: n.x, y: n.y, w: size(n.id).w, h: size(n.id).h });

      const blk = blockOf(n.id);
      if (blk.list.length) {
        const cardW = size(n.id).w;
        const bx = n.x + cardW + o.agentGap;
        const by = n.y + o.agentTopPad;
        const busX = n.x + cardW + o.agentGap / 2;
        for (let i = 0; i < blk.cells.length; i++) {
          const cell = blk.cells[i];
          const s = cell.s;
          const cardX = bx + cell.ax;
          const cardY = by + cell.ay;
          const dx = cardX - cell.left - s.box.left;
          const dy = cardY - cell.top - s.box.top;
          for (const sid in s.pos) pos[sid] = { x: s.pos[sid].x + dx, y: s.pos[sid].y + dy };
          for (let k = 0; k < s.rects.length; k++) {
            const r = s.rects[k];
            rects.push({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h });
          }
          for (const cid in s.cells) {
            const c = s.cells[cid];
            cells[cid] = {
              x: c.x + dx, y: c.y + dy, w: c.w, h: c.h,
              col: c.col, row: c.row, index: c.index, count: c.count,
              busX: c.busX + dx, chanX: c.chanX + dx, corrY: c.corrY + dy,
            };
          }
          const colStart = bx + cell.ax - blk.colL[cell.col];
          const prevColEnd = bx + (cell.ax - blk.colL[cell.col]) - o.agentColGap;
          const rowStart = by + cell.ay - blk.rowT[cell.row];
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

      for (const c of n.children || []) walk(c);
    })(result);

    const box = bbox(rects);
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

module.exports = { layoutEngineReserve, layoutEngineReserveWrapped, layoutEngineReserveGrid, GRID_DEFAULTS };

