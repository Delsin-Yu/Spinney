'use strict';
/*
 * Visual-integrity checks for a layout result. These are the invariants the user
 * actually cares about (and that area metrics alone cannot see):
 *
 *   interposition — a foreign card sits horizontally between a parent card and
 *                   one of its agent windows (inside the window's y-band). This is
 *                   the reported defect: "Node B placed between Node A and its
 *                   sub-agents". The parent's OWN other windows do not count.
 *   crossing      — the parent->agent connector (the exact cubic bezier media/main.js
 *                   drawEdges emits) passes through some other card.
 *
 * rects come from metrics.rectsOf (same geometry the webview produces).
 */
const { rectsOf } = require('./metrics');

function descendants(nodesById, id) {
  const out = new Set();
  const q = [id];
  while (q.length) {
    const n = q.shift();
    if (out.has(n)) continue;
    out.add(n);
    for (const c of (nodesById[n] && nodesById[n].children) || []) q.push(c);
  }
  return out;
}

function bezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}
const inRect = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

function violations(result, tree) {
  const { nodesById, heights, widths } = tree;
  const rects = rectsOf(result, nodesById, heights, widths);
  const byId = new Map(rects.map((r) => [r.id, r]));
  const out = { interpositions: [], crossings: [] };

  for (const pid in nodesById) {
    const p = nodesById[pid];
    if (!byId.has(pid)) continue;
    const agentKids = (p.children || []).filter((c) => nodesById[c] && nodesById[c].kind === 'agent' && byId.has(c));
    if (!agentKids.length) continue;
    const pr = byId.get(pid);
    const ownAll = new Set();
    for (const a of agentKids) for (const d of descendants(nodesById, a)) ownAll.add(d);

    for (const aid of agentKids) {
      const w = byId.get(aid);
      const own = descendants(nodesById, aid);
      const siblingsOwn = new Set([...ownAll].filter((x) => !own.has(x)));

      const band = rects.filter(
        (c) =>
          c.id !== pid &&
          !own.has(c.id) &&
          !siblingsOwn.has(c.id) &&
          c.y < w.y + w.h &&
          c.y + c.h > w.y &&
          c.x + c.w > pr.x + pr.w &&
          c.x < w.x,
      );
      if (band.length) {
        out.interpositions.push({ parent: pid, window: aid, between: band.map((c) => c.id) });
      }

      // media/main.js drawEdges: parent right edge -> window left edge
      const p0 = { x: pr.x + pr.w, y: pr.y + pr.h / 2 };
      const p3 = { x: w.x, y: w.y + w.h / 2 };
      const mx = (p0.x + p3.x) / 2;
      const p1 = { x: mx, y: p0.y };
      const p2 = { x: mx, y: p3.y };
      const hit = new Set();
      for (let i = 0; i <= 80; i++) {
        const pt = bezier(p0, p1, p2, p3, i / 80);
        for (const c of rects) {
          if (c.id === pid || own.has(c.id)) continue;
          if (inRect(pt, c)) hit.add(c.id);
        }
      }
      if (hit.size) out.crossings.push({ parent: pid, window: aid, crossed: [...hit] });
    }
  }
  return out;
}

module.exports = { violations, descendants };
