'use strict';
/*
 * Candidate layouts. Every candidate exposes the same signature as
 * media/tree.js `layoutTree(nodesById, rootId, heights, opts)` and returns
 * { pos: {id:{x,y}}, width, height } so metrics.js can measure them identically.
 *
 *   A_FLEX    strategy (a): d3-flextree on the turn-only tree, then pack each
 *             agent subtree into the right margin against occupied rectangles.
 *   A_DAGRE   strategy (a) with @dagrejs/dagre as the engine (same packing).
 *   C_FLEX    strategy (c): one flextree pass over the *full* tree, then shift
 *             agent subtrees right and resolve the resulting overlaps.
 *   B_DAGRE   strategy (b): one native compound/nested dagre pass (clusters +
 *             edges) -- kept to prove that it cannot express our two directions.
 */
const { flextree, dagre, nlttl } = require('./deps');

const DEFAULTS = { nodeW: 320, hGap: 48, vGap: 72, pad: 20, agentGap: 80, agentVGap: 24 };

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

function bfs(nodesById, rootId, childFn) {
  const out = [];
  const seen = new Set();
  const q = [rootId];
  while (q.length) {
    const id = q.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const c of childFn(id)) q.push(c);
  }
  return out;
}

function bbox(rects) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const r of rects) {
    left = Math.min(left, r.x); top = Math.min(top, r.y);
    right = Math.max(right, r.x + r.w); bottom = Math.max(bottom, r.y + r.h);
  }
  if (!rects.length) return { left: 0, top: 0, right: 0, bottom: 0 };
  return { left, top, right, bottom };
}

/** d3-flextree pass over a subtree restricted to `childFn`, returns id -> top-left. */
function flextreePass(rootId, childFn, sz, o) {
  const build = (id) => ({
    id,
    w: sz.w(id),
    h: sz.h(id),
    children: childFn(id).map(build),
  });
  const layout = flextree({
    children: (d) => d.children,
    // ySize carries the vertical gap so children start at parent.y + h + vGap
    nodeSize: (n) => [n.data.w, n.data.h + o.vGap],
    spacing: () => o.hGap,
  });
  const tree = layout.hierarchy(build(rootId));
  layout(tree);
  const pos = {};
  tree.each((n) => { pos[n.data.id] = { x: n.x - n.data.w / 2, y: n.y }; });
  if (o.align === 'flush') {
    // Keep flextree's contour interleaving, but when a parent's children group
    // sits to the RIGHT of the parent card (single-child chains, or a children
    // row narrower than the card), flush the group left toward the parent's left
    // edge -- the current algorithm's invariant -- bounded by the nearest
    // obstacle sharing the group's y-band so contour interleaving is preserved.
    const shiftSubtree = (n, dx) => {
      pos[n.data.id].x += dx;
      for (const k of n.children || []) shiftSubtree(k, dx);
    };
    const collect = (n, out) => {
      out.add(n.data.id);
      for (const k of n.children || []) collect(k, out);
      return out;
    };
    const allRects = () => Object.keys(pos).map((id) => ({ id, x: pos[id].x, y: pos[id].y, w: sz.w(id), h: sz.h(id) }));
    const visit = (n) => {
      const kids = n.children || [];
      const bbs = kids.map(visit);
      let l = pos[n.data.id].x;
      let r = l + n.data.w;
      for (const b of bbs) { l = Math.min(l, b.l); r = Math.max(r, b.r); }
      if (kids.length) {
        const gl = Math.min(...bbs.map((b) => b.l));
        const px = pos[n.data.id].x;
        if (gl > px + 0.5) {
          const group = new Set();
          for (const k of kids) collect(k, group);
          const rects = allRects();
          const gRects = rects.filter((rc) => group.has(rc.id));
          const y0 = Math.min(...gRects.map((rc) => rc.y));
          const y1 = Math.max(...gRects.map((rc) => rc.y + rc.h));
          let limit = Infinity; // max allowed left shift
          for (const ob of rects) {
            if (group.has(ob.id)) continue;
            if (!(ob.y < y1 && ob.y + ob.h > y0)) continue;
            if (ob.x + ob.w > gl) continue; // obstacles to the right don't block a left shift
            limit = Math.min(limit, gl - (ob.x + ob.w + o.hGap));
          }
          const dx = Math.min(gl - px, Math.max(0, limit));
          if (dx > 0.5) {
            for (const k of kids) shiftSubtree(k, -dx);
            r -= dx;
          }
        }
      }
      return { l: Math.min(l, pos[n.data.id].x), r: Math.max(r, pos[n.data.id].x + n.data.w) };
    };
    visit(tree);
  }
  if (o.align === 'left') {
    // Keep flextree's contour interleaving but flush each parent's card to the
    // left edge of its own subtree (the current algorithm's invariant). This
    // keeps agent slots (right of the parent card) out of sibling territory.
    const leftOf = {};
    const post = (n) => {
      let left = pos[n.data.id].x;
      for (const k of n.children || []) left = Math.min(left, post(k));
      leftOf[n.data.id] = left;
      return left;
    };
    post(tree);
    tree.each((n) => {
      const kids = n.children || [];
      if (kids.length) {
        let l = Infinity;
        for (const k of kids) l = Math.min(l, leftOf[k.data.id]);
        pos[n.data.id].x = l;
      }
    });
  }
  return pos;
}

/**
 * non-layered-tidy-tree-layout pass (MIT, 5.6 KB, zero deps) over a subtree
 * restricted to `childFn`, returns id -> top-left of the card.
 * Box semantics: box = (w + hGap) x (h + vGap); card sits at boxLeft + hGap/2;
 * children start at parent.y + boxHeight. x/y returned are already card top-left.
 */
function nlttlPass(rootId, childFn, sz, o) {
  const L = new nlttl.Layout(new nlttl.BoundingBox(o.hGap, o.vGap));
  const build = (id) => ({
    id,
    width: sz.w(id),
    height: sz.h(id),
    children: childFn(id).map(build),
  });
  const { result } = L.layout(build(rootId));
  const pos = {};
  const walk = (n) => {
    pos[n.id] = { x: n.x, y: n.y };
    for (const c of n.children || []) walk(c);
  };
  walk(result);
  return pos;
}

function dagrePass(rootId, childFn, sz, o, rankdir) {
  const g = new dagre.graphlib.Graph({ compound: false });
  g.setGraph({ rankdir: rankdir || 'TB', nodesep: o.hGap, ranksep: o.vGap });
  g.setDefaultEdgeLabel(() => ({}));
  const ids = bfs({}, rootId, childFn); // childFn walks the real tree
  for (const id of ids) g.setNode(id, { width: sz.w(id), height: sz.h(id) });
  for (const id of ids) for (const c of childFn(id)) g.setEdge(id, c);
  dagre.layout(g);
  const pos = {};
  for (const id of ids) {
    const n = g.node(id);
    pos[id] = { x: n.x - n.width / 2, y: n.y - n.height / 2 };
  }
  return pos;
}

// ---------------------------------------------------------------- strategy (a)
/**
 * Turn-only tree via `engine`, then agent subtrees packed into the right margin
 * against occupied rectangles (band-local max right edge, not the whole row).
 */
function layoutSidecarPack(nodesById, rootId, heights, opts, engine, agentOrder, align) {
  const o = Object.assign({}, DEFAULTS, opts || {}, agentOrder ? { agentOrder } : {}, align ? { align } : {});
  const widths = o.widths || {};
  if (!nodesById[rootId]) return { pos: {}, width: o.nodeW + o.pad * 2, height: 120 + o.pad * 2 };
  const sz = { w: (id) => widths[id] || o.nodeW, h: (id) => heights[id] || 120 };
  const H = helpers(nodesById, heights, widths, o);
  const pass =
    engine === 'dagre' ? dagrePass : engine === 'nlttl' ? nlttlPass : flextreePass;

  function place(id) {
    const local = {};
    const rects = [];
    const tp = pass(id, H.turnKids, sz, o);
    for (const nid in tp) {
      local[nid] = tp[nid];
      rects.push({ id: nid, x: tp[nid].x, y: tp[nid].y, w: sz.w(nid), h: sz.h(nid) });
    }
    const order = bfs(nodesById, id, H.turnKids);
    // Deepest-first placement: an inner node's agent block claims its right
    // margin before an outer ancestor block can squat on it.
    if (o.agentOrder === 'deepest-first') order.reverse();

    // 1. Lay out every agent subtree (independent of where its block lands).
    const blocks = Object.create(null); // turn node -> [{agent, sub}]
    for (const nid of order) {
      const ak = H.agentKids(nid);
      if (!ak.length) continue;
      blocks[nid] = ak.map((a) => ({ a, sub: place(a) }));
    }

    // 2. Place blocks: natural slot (right of the parent card) when free, else
    //    clear of every rect that shares the y-band.
    for (const nid of order) {
      if (!blocks[nid]) continue;
      const parentRight = local[nid].x + sz.w(nid);
      let cursorY = local[nid].y;
      for (const { sub } of blocks[nid]) {
        const bw = sub.box.right - sub.box.left;
        const bh = sub.box.bottom - sub.box.top;
        const y0 = cursorY;
        const y1 = cursorY + bh;
        // 1-D leftmost-fit: smallest x >= parent.right + gap whose block does
        // not intersect any rect sharing this y-band (strictly tighter than the
        // current algorithm's "right of the whole turn row" rule).
        const iv = [];
        for (const r of rects) if (r.y < y1 && r.y + r.h > y0) iv.push([r.x, r.x + r.w]);
        iv.sort((p, q) => p[0] - q[0]);
        let x = parentRight + o.agentGap;
        for (const [a, b] of iv) {
          if (x + bw <= a) break;
          if (x >= b) continue;
          x = b + o.agentGap;
        }
        const dx = x - sub.box.left;
        const dy = cursorY - sub.box.top;
        for (const k in sub.pos) local[k] = { x: sub.pos[k].x + dx, y: sub.pos[k].y + dy };
        for (const r of sub.rects) rects.push({ id: r.id, x: r.x + dx, y: r.y + dy, w: r.w, h: r.h });
        cursorY += bh + o.agentVGap;
      }
    }
    return { pos: local, rects, box: bbox(rects) };
  }

  const res = place(rootId);
  const pos = {};
  const dx = -res.box.left;
  const dy = -res.box.top;
  for (const id in res.pos) pos[id] = { x: res.pos[id].x + dx, y: res.pos[id].y + dy };
  return {
    pos,
    width: res.box.right - res.box.left + o.pad * 2,
    height: res.box.bottom - res.box.top + o.pad * 2,
  };
}

// ---------------------------------------------------------------- strategy (c)
/** One flextree pass over the whole tree, then shift agent subtrees right. */
function layoutPostShift(nodesById, rootId, heights, opts, resolve) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const widths = o.widths || {};
  if (!nodesById[rootId]) return { pos: {}, width: o.nodeW + o.pad * 2, height: 120 + o.pad * 2, rawOverlaps: 0 };
  const sz = { w: (id) => widths[id] || o.nodeW, h: (id) => heights[id] || 120 };
  const H = helpers(nodesById, heights, widths, o);
  const pos = flextreePass(rootId, H.allKids, sz, o);

  const desc = Object.create(null);
  for (const id of bfs(nodesById, rootId, H.allKids).reverse()) {
    desc[id] = new Set([id]);
    for (const c of H.allKids(id)) for (const d of desc[c] || []) desc[id].add(d);
  }
  const order = bfs(nodesById, rootId, H.allKids);
  const shift = (set, dx) => { for (const id of set) pos[id].x += dx; };

  // first pass: align every agent subtree's left edge to parent.right + agentGap
  for (const id of order) {
    for (const a of H.agentKids(id)) {
      const set = desc[a];
      let minX = Infinity;
      for (const k of set) minX = Math.min(minX, pos[k].x);
      shift(set, pos[id].x + sz.w(id) + o.agentGap - minX);
    }
  }
  const rectsNow = () => Object.keys(pos).map((id) => ({ id, x: pos[id].x, y: pos[id].y, w: sz.w(id), h: sz.h(id) }));
  const countOverlaps = (rects) => {
    let n = 0;
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        if (Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0 &&
            Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0) n++;
      }
    }
    return n;
  };
  const rawOverlaps = countOverlaps(rectsNow());

  if (resolve !== false) {
    for (let iter = 0; iter < 20; iter++) {
      const rects = rectsNow();
      let moved = false;
      for (const id of order) {
        for (const a of H.agentKids(id)) {
          const set = desc[a];
          let push = 0;
          for (const r of rects) {
            if (set.has(r.id)) continue;
            for (const k of set) {
              const kr = rects.find((q) => q.id === k);
              const ix = Math.min(kr.x + kr.w, r.x + r.w) - Math.max(kr.x, r.x);
              const iy = Math.min(kr.y + kr.h, r.y + r.h) - Math.max(kr.y, r.y);
              if (ix > 0 && iy > 0) push = Math.max(push, ix + o.hGap);
            }
          }
          if (push > 0) { shift(set, push); moved = true; }
        }
      }
      if (!moved) break;
    }
  }
  const rects = rectsNow();
  const b = bbox(rects);
  const posOut = {};
  for (const id in pos) posOut[id] = { x: pos[id].x - b.left, y: pos[id].y - b.top };
  return {
    pos: posOut,
    width: b.right - b.left + o.pad * 2,
    height: b.bottom - b.top + o.pad * 2,
    rawOverlaps,
  };
}

// ---------------------------------------------------------------- strategy (b)
/**
 * One native compound/nested dagre pass. Clusters nest agent subtrees inside
 * their parent's cluster; every edge is a plain parent->child edge, because
 * dagre has no per-edge direction (rankdir is per graph, and minlen:0 crashes
 * in 3.1.1 -- see strategies.js).
 */
function layoutDagreCompound(nodesById, rootId, heights, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const widths = o.widths || {};
  if (!nodesById[rootId]) return { pos: {}, width: o.nodeW + o.pad * 2, height: 120 + o.pad * 2 };
  const sz = { w: (id) => widths[id] || o.nodeW, h: (id) => heights[id] || 120 };
  const H = helpers(nodesById, heights, widths, o);
  const ids = bfs(nodesById, rootId, H.allKids);

  const g = new dagre.graphlib.Graph({ compound: true });
  g.setGraph({ rankdir: 'TB', nodesep: o.hGap, ranksep: o.vGap });
  g.setDefaultEdgeLabel(() => ({}));
  for (const id of ids) g.setNode(id, { width: sz.w(id), height: sz.h(id) });
  // cluster per node that owns agent sidecars; nest by nearest ancestor owner
  for (const id of ids) {
    if (H.agentKids(id).length) g.setNode('cl_' + id, {});
  }
  const owner = (id) => {
    let p = nodesById[id].parentId;
    while (p) {
      if (H.agentKids(p).length) return 'cl_' + p;
      p = nodesById[p].parentId;
    }
    return undefined;
  };
  for (const id of ids) {
    const own = owner(id);
    if (own) g.setParent(id, own);
  }
  for (const id of ids) {
    if (g.hasNode('cl_' + id)) {
      const own = owner(id);
      if (own) g.setParent('cl_' + id, own);
    }
  }
  for (const id of ids) for (const c of H.allKids(id)) g.setEdge(id, c);
  dagre.layout(g);

  const pos = {};
  for (const id of ids) {
    const n = g.node(id);
    pos[id] = { x: n.x - n.width / 2, y: n.y - n.height / 2 };
  }
  const rects = ids.map((id) => ({ id, x: pos[id].x, y: pos[id].y, w: sz.w(id), h: sz.h(id) }));
  const b = bbox(rects);
  const out = {};
  for (const id of ids) out[id] = { x: pos[id].x - b.left, y: pos[id].y - b.top };
  return { pos: out, width: b.right - b.left + o.pad * 2, height: b.bottom - b.top + o.pad * 2 };
}

// ---------------------------------------------------------------- strategy (b2)
/**
 * Strategy (b) variant: per-cluster rankdir (dagre 3.x). Each node that owns
 * agent children gets an LR cluster containing it + its agent children, so the
 * agents land to its RIGHT; turn children stay in the outer TB graph (below).
 * Turn children of an AGENT can only be ranked below the whole cluster, because
 * a node belongs to exactly one cluster.
 */
function layoutDagreLRClusters(nodesById, rootId, heights, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const widths = o.widths || {};
  if (!nodesById[rootId]) return { pos: {}, width: o.nodeW + o.pad * 2, height: 120 + o.pad * 2 };
  const sz = { w: (id) => widths[id] || o.nodeW, h: (id) => heights[id] || 120 };
  const H = helpers(nodesById, heights, widths, o);
  const ids = bfs(nodesById, rootId, H.allKids);

  const g = new dagre.graphlib.Graph({ compound: true });
  g.setGraph({ rankdir: 'TB', nodesep: o.hGap, ranksep: o.vGap });
  g.setDefaultEdgeLabel(() => ({}));
  for (const id of ids) g.setNode(id, { width: sz.w(id), height: sz.h(id) });
  for (const id of ids) {
    if (!H.agentKids(id).length) continue;
    g.setNode('cl_' + id, { rankdir: 'LR' });
    g.setParent(id, 'cl_' + id);
    for (const a of H.agentKids(id)) {
      if (H.agentKids(a).length) g.setParent('cl_' + a, 'cl_' + id);
      else g.setParent(a, 'cl_' + id);
    }
  }
  for (const id of ids) for (const c of H.allKids(id)) g.setEdge(id, c);
  dagre.layout(g);

  const pos = {};
  for (const id of ids) {
    const n = g.node(id);
    if (!n) continue;
    pos[id] = { x: n.x - n.width / 2, y: n.y - n.height / 2 };
  }
  const rects = ids.filter((id) => pos[id]).map((id) => ({ id, x: pos[id].x, y: pos[id].y, w: sz.w(id), h: sz.h(id) }));
  const b = bbox(rects);
  const out = {};
  for (const id in pos) out[id] = { x: pos[id].x - b.left, y: pos[id].y - b.top };
  return { pos: out, width: b.right - b.left + o.pad * 2, height: b.bottom - b.top + o.pad * 2 };
}

module.exports = {
  DEFAULTS,
  layoutAFlex: (n, r, h, o) => layoutSidecarPack(n, r, h, o, 'flex'),
  layoutAFlexLeft: (n, r, h, o) => layoutSidecarPack(n, r, h, o, 'flex', null, 'left'),
  layoutAFlexLeftDeep: (n, r, h, o) => layoutSidecarPack(n, r, h, o, 'flex', 'deepest-first', 'left'),
  layoutAFlexFlush: (n, r, h, o) => layoutSidecarPack(n, r, h, o, 'flex', null, 'flush'),
  layoutAFlexFlushDeep: (n, r, h, o) => layoutSidecarPack(n, r, h, o, 'flex', 'deepest-first', 'flush'),
  layoutADagre: (n, r, h, o) => layoutSidecarPack(n, r, h, o, 'dagre'),
  layoutANlttl: (n, r, h, o) => layoutSidecarPack(n, r, h, o, 'nlttl'),
  layoutANlttlLeft: (n, r, h, o) => layoutSidecarPack(n, r, h, o, 'nlttl', null, 'left'),
  layoutCFlex: (n, r, h, o) => layoutPostShift(n, r, h, o, true),
  layoutCFlexRaw: (n, r, h, o) => layoutPostShift(n, r, h, o, false),
  layoutBDagre: layoutDagreCompound,
  layoutBDagreLR: layoutDagreLRClusters,
  flextreePass,
  nlttlPass,
  nlttl,
  dagrePass,
  bfs,
  bbox,
  helpers,
};
