'use strict';
// Find the worst (candidate/current) area ratio for a variant over random trees.
//   node find-worst.js [variant] [trials]
const fs = require('fs');
const C = require('./candidates');
const current = require('./current');
const { measure } = require('./metrics');

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
const variant = process.argv[2] || 'layoutAFlexFlushDeep';
const trials = +(process.argv[3] || 4000);
const rng = mulberry32(0xC0FFEE);
let worst = { ratio: 0 };
let worse = 0;
for (let i = 0; i < trials; i++) {
  const n = 2 + Math.floor(rng() * 23);
  const t = randomTree(rng, n, { wide: 0.25, maxW: 900, tall: 0.2 });
  const opts = { widths: t.widths };
  const rc = current.layoutTree(t.nodesById, 'n0', t.heights, opts);
  const mc = measure(rc, t);
  const ra = C[variant](t.nodesById, 'n0', t.heights, opts);
  const ma = measure(ra, t);
  const ratio = ma.area / mc.area;
  if (ratio > 1.0005) worse++;
  if (ratio > worst.ratio) worst = { ratio, n, tree: t, mc, ma };
}
console.log(variant, 'worse:', worse, '/', trials, 'worst ratio', worst.ratio.toFixed(4), 'n=' + worst.n);
if (worst.ratio > 1.0005) {
  const t = worst.tree;
  const rc = current.layoutTree(t.nodesById, 'n0', t.heights, { widths: t.widths });
  const ra = C[variant](t.nodesById, 'n0', t.heights, { widths: t.widths });
  console.log('current', rc.width + 'x' + rc.height, ' candidate', ra.width + 'x' + ra.height);
  for (const id of Object.keys(t.nodesById)) {
    const nd = t.nodesById[id];
    console.log(id, nd.kind.padEnd(5), (t.widths[id] + 'x' + t.heights[id]).padStart(9), 'p=' + String(nd.parentId).padEnd(4), 'cur', JSON.stringify(rc.pos[id]).padEnd(22), 'cand', JSON.stringify(ra.pos[id]));
  }
  fs.writeFileSync('worst-' + variant + '.json', JSON.stringify({ tree: t }, null, 2));
}
