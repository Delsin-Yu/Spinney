'use strict';
// Find and dump a tree where a flush variant overlaps (debug helper).
const fs = require('fs');
const C = require('./candidates');
const { measure, rectsOf, overlapsOf } = require('./metrics');

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randomTree(rng, n, o) {
  const t = { nodesById: Object.create(null), heights: {}, widths: {} };
  let count = 0;
  const add = (kind) => {
    const id = 'n' + count++;
    t.nodesById[id] = { id, children: [], kind, parentId: '' };
    const r = rng();
    t.widths[id] = r < o.wide ? 320 + Math.round((rng() * (o.maxW - 320)) / 10) * 10 : 320;
    const r2 = rng();
    t.heights[id] = r2 < o.tall ? 400 + Math.round((rng() * 1600) / 10) * 10 : 120;
    return id;
  };
  const link = (p, c) => { t.nodesById[p].children.push(c); t.nodesById[c].parentId = p; };
  const root = add('turn');
  const q = [root];
  while (count < n) {
    const p = q.length ? q.shift() : root;
    const k = Math.floor(rng() * 4);
    for (let i = 0; i < k && count < n; i++) { const id = add('turn'); link(p, id); q.push(id); }
    const ka = Math.floor(rng() * 4);
    for (let i = 0; i < ka && count < n; i++) {
      const id = add('agent'); link(p, id); q.push(id);
      if (rng() < 0.5 && count < n) { const c = add('turn'); link(id, c); q.push(c); }
    }
    if (!q.length && count < n) q.push(p);
  }
  return t;
}
const variant = process.argv[2] || 'layoutAFlexFlush';
const rng = mulberry32(0xC0FFEE);
for (let i = 0; i < 4000; i++) {
  const n = 2 + Math.floor(rng() * 23);
  const t = randomTree(rng, n, { wide: 0.25, maxW: 900, tall: 0.2 });
  const ra = C[variant](t.nodesById, 'n0', t.heights, { widths: t.widths });
  const m = measure(ra, t);
  if (m.overlaps) {
    const rects = rectsOf(ra, t.nodesById, t.heights, t.widths);
    console.log(variant, 'overlap tree n=', n, 'ovl=', m.overlaps, JSON.stringify(overlapsOf(rects).pairs.slice(0, 3)));
    for (const id of Object.keys(t.nodesById)) {
      const nd = t.nodesById[id];
      console.log(id, nd.kind.padEnd(5), (t.widths[id] + 'x' + t.heights[id]).padStart(9), 'p=' + String(nd.parentId).padEnd(4), JSON.stringify(ra.pos[id]));
    }
    fs.writeFileSync('overlap-case.json', JSON.stringify({ tree: t, pos: ra.pos }, null, 2));
    break;
  }
}
