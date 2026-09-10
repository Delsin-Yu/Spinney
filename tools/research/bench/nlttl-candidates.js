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
const C = require('./candidates');

const { bfs, bbox, helpers, DEFAULTS } = C;

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

module.exports = { layoutEngineReserve, layoutEngineReserveWrapped };

