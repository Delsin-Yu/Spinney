'use strict';
// Shared metrics: identical measurement for every layout engine.
const PAD = 20; // media/main.js layoutTree default pad

function rectsOf(result, nodesById, heights, widths) {
  const rects = [];
  for (const id in result.pos) {
    if (!nodesById[id]) continue;
    rects.push({
      id,
      x: result.pos[id].x,
      y: result.pos[id].y,
      w: widths[id] || 320,
      h: heights[id] || 120,
    });
  }
  return rects;
}

function overlapsOf(rects) {
  const pairs = [];
  let area = 0;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ix > 0 && iy > 0) {
        area += ix * iy;
        pairs.push({ a: a.id, b: b.id, over: Math.round(ix * iy) });
      }
    }
  }
  return { count: pairs.length, area, pairs };
}

/** Bounding box of the placed cards (canvas = bbox + pad on right/bottom, like media/main.js). */
function bboxOf(rects) {
  if (!rects.length) return { left: 0, top: 0, right: 320, bottom: 120 };
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const r of rects) {
    left = Math.min(left, r.x);
    top = Math.min(top, r.y);
    right = Math.max(right, r.x + r.w);
    bottom = Math.max(bottom, r.y + r.h);
  }
  return { left, top, right, bottom };
}

/** Direction invariants: turn child below parent; agent child right of parent, vertically centered. */
function directionViolations(rects, nodesById) {
  const byId = Object.create(null);
  for (const r of rects) byId[r.id] = r;
  let agentNotRight = 0;
  let agentNotCentered = 0;
  let turnNotBelow = 0;
  for (const id in nodesById) {
    const p = nodesById[id].parentId ? byId[nodesById[id].parentId] : null;
    if (!p || !byId[id]) continue;
    const c = byId[id];
    if (nodesById[id].kind === 'agent') {
      if (c.x + 1 < p.x + p.w) agentNotRight++;               // must start at/right of parent's right edge
      const pc = p.y + p.h / 2;
      if (pc < c.y || pc > c.y + c.h) agentNotCentered++;      // right-middle -> left-middle edge
    } else if (c.y + 1 < p.y + p.h) {
      turnNotBelow++;
    }
  }
  return { agentNotRight, agentNotCentered, turnNotBelow };
}

function measure(result, tree, times) {
  const { nodesById, heights, widths } = tree;
  const rects = rectsOf(result, nodesById, heights, widths);
  const bbox = bboxOf(rects);
  const width = bbox.right - bbox.left + PAD * 2;
  const height = bbox.bottom - bbox.top + PAD * 2;
  const ov = overlapsOf(rects);
  let cardArea = 0;
  for (const r of rects) cardArea += r.w * r.h;
  const area = width * height;
  const dir = directionViolations(rects, nodesById);
  return {
    nodes: rects.length,
    width: Math.round(width),
    height: Math.round(height),
    area: Math.round(area),
    maxW: Math.round(width),
    maxH: Math.round(height),
    overlaps: ov.count,
    overlapArea: Math.round(ov.area),
    fill: +(cardArea / area).toFixed(4),
    cardArea: Math.round(cardArea),
    ...dir,
    ms: times ? +times.toFixed(2) : null,
  };
}

module.exports = { measure, rectsOf, overlapsOf, bboxOf, directionViolations, PAD };
