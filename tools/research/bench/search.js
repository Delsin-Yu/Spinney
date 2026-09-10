'use strict';
/*
 * Adversarial search: random small trees, look for any case where the current
 * algorithm's canvas area is SMALLER than a candidate (ratio > 1).
 *   node search.js [trials] [maxNodes]
 */
const current = require('./current');
const C = require('./candidates');
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
      const id = add('agent'); link(p, id);
      q.push(id);
      if (rng() < 0.5 && count < n) { const c = add('turn'); link(id, c); q.push(c); }
    }
    if (!q.length && count < n) q.push(p);
  }
  return t;
}

const VARIANTS = ['layoutAFlex', 'layoutAFlexFlush', 'layoutAFlexFlushDeep', 'layoutCFlex', 'layoutBDagre'];
const trials = +(process.argv[2] || 4000);
const maxNodes = +(process.argv[3] || 24);
const rng = mulberry32(0xC0FFEE);
const stat = Object.create(null);
for (const v of VARIANTS) stat[v] = { worse: 0, tie: 0, better: 0, worst: { ratio: 0 }, ov: 0, sumRatio: 0, maxMs: 0 };
let ovCurrent = 0;

function time(fn) {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

for (let i = 0; i < trials; i++) {
  const n = 2 + Math.floor(rng() * (maxNodes - 1));
  const t = randomTree(rng, n, { wide: 0.25, maxW: 900, tall: 0.2 });
  const opts = { widths: t.widths };
  const rc = current.layoutTree(t.nodesById, 'n0', t.heights, opts);
  const mc = measure(rc, t);
  if (mc.overlaps) ovCurrent++;
  for (const v of VARIANTS) {
    let ra;
    try { ra = C[v](t.nodesById, 'n0', t.heights, opts); } catch (e) { stat[v].err = e.message; continue; }
    const ma = measure(ra, t);
    if (ma.overlaps) stat[v].ov++;
    const ratio = ma.area / mc.area;
    stat[v].sumRatio += ratio;
    if (ratio > 1.0005) {
      stat[v].worse++;
      if (ratio > stat[v].worst.ratio) stat[v].worst = { ratio, n, tree: t, mc, ma };
    } else if (ratio < 0.9995) stat[v].better++;
    else stat[v].tie++;
    const ms = time(() => C[v](t.nodesById, 'n0', t.heights, opts));
    if (ms > stat[v].maxMs) stat[v].maxMs = ms;
  }
}
console.log(`trials=${trials} nodes<=${maxNodes}; current overlaps>0 in ${ovCurrent} trees`);
console.log('variant              worse   tie  better  meanRatio  worst  ovl  maxMs');
for (const v of VARIANTS) {
  const s = stat[v];
  if (s.err) { console.log(v, 'ERROR', s.err); continue; }
  console.log(
    v.padEnd(20),
    String(s.worse).padStart(5), String(s.tie).padStart(5), String(s.better).padStart(6),
    (s.sumRatio / trials).toFixed(3).padStart(10), s.worst.ratio.toFixed(3).padStart(6),
    String(s.ov).padStart(4), s.maxMs.toFixed(1).padStart(6),
  );
}
const worstAny = VARIANTS.map((v) => ({ v, ...stat[v].worst })).filter((x) => x.tree).sort((a, b) => b.ratio - a.ratio)[0];
if (worstAny) {
  console.log('\nworst case:', worstAny.v, 'ratio', worstAny.ratio.toFixed(3), 'n=' + worstAny.n);
  require('fs').writeFileSync(require('path').join(__dirname, 'search-worst.json'), JSON.stringify(worstAny, null, 2));
}
const worstA = stat.layoutAFlex.worst;
if (worstA.tree) {
  console.log('worst A_flex: ratio', worstA.ratio.toFixed(3), 'n=' + worstA.n);
  require('fs').writeFileSync(
    require('path').join(__dirname, 'search-worst-aflex.json'),
    JSON.stringify({ v: 'layoutAFlex', ...worstA }, null, 2),
  );
}
