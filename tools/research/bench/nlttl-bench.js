'use strict';
/*
 * Engine bake-off: current media/tree.js vs
 *   A_flex   = d3-flextree (WTFPL) + sidecar packing   [validated in layout-benchmark.md]
 *   A_nlttl  = non-layered-tidy-tree-layout (MIT) + sidecar packing
 *   N_nlttl  = non-layered-tidy-tree-layout, engine-owned sidecar reservation
 *              (inflate box; zero collision code)
 *
 *   node nlttl-bench.js
 */
const fs = require('fs');
const path = require('path');
const current = require('./current');
const C = require('./candidates');
const N = require('./nlttl-candidates');
const { measure } = require('./metrics');
const { scenarios } = require('./synthetic');

// A realistic session shape: 12-turn chain; each turn spawns 1-4 sub-agents,
// some with their own turn work and depth-2 sub-agents.
function realistic() {
  const nodesById = {};
  const heights = {};
  const widths = {};
  let k = 0;
  const add = (kind, h) => {
    const id = 'r' + k++;
    nodesById[id] = { id, children: [], kind, parentId: '' };
    heights[id] = h;
    widths[id] = 320;
    return id;
  };
  let prev = add('turn', 300);
  const root = prev;
  for (let t = 0; t < 12; t++) {
    const turn = add('turn', 200 + (t % 3) * 150);
    nodesById[prev].children.push(turn);
    nodesById[turn].parentId = prev;
    const na = 1 + (t % 4);
    for (let j = 0; j < na; j++) {
      const a = add('agent', [140, 260, 500, 820][(t + j) % 4]);
      nodesById[turn].children.push(a);
      nodesById[a].parentId = turn;
      if ((t + j) % 3 === 0) {
        const a2 = add('agent', 300);
        nodesById[a].children.push(a2);
        nodesById[a2].parentId = a;
      }
      if ((t + j) % 2 === 0) {
        const t2 = add('turn', 180);
        nodesById[a].children.push(t2);
        nodesById[t2].parentId = a;
      }
    }
    prev = turn;
  }
  return { nodesById, heights, widths, rootId: root };
}

const ENGINES = [
  { key: 'current', fn: (t, o) => current.layoutTree(t.nodesById, t.rootId || 'n0', t.heights, o) },
  { key: 'A_flex', fn: (t, o) => C.layoutAFlex(t.nodesById, t.rootId || 'n0', t.heights, o) },
  { key: 'A_nlttl', fn: (t, o) => C.layoutANlttl(t.nodesById, t.rootId || 'n0', t.heights, o) },
  { key: 'N_nlttl', fn: (t, o) => N.layoutEngineReserve(t.nodesById, t.rootId || 'n0', t.heights, o) },
];

const OPTS = { nodeW: 320, hGap: 48, vGap: 72, agentGap: 80, agentVGap: 24 };
const reps = (n) => (n >= 300 ? 3 : 7);

function timeLayout(fn, n) {
  const s = [];
  for (let i = 0; i < reps(n); i++) {
    const t0 = process.hrtime.bigint();
    fn();
    const t1 = process.hrtime.bigint();
    s.push(Number(t1 - t0) / 1e6);
  }
  s.sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const cases = scenarios().map((sc) => ({ name: sc.name, n: sc.n, tree: sc.tree }));
cases.push({ name: 'REALISTIC', n: Object.keys(realistic().nodesById).length, tree: realistic() });

const rows = [];
for (const sc of cases) {
  const t = sc.tree;
  const o = Object.assign({}, OPTS, { widths: t.widths });
  const row = { scenario: sc.name, n: sc.n, engines: {} };
  for (const e of ENGINES) {
    try {
      const r = e.fn(t, o);
      const ms = timeLayout(() => e.fn(t, o), sc.n);
      row.engines[e.key] = measure(r, t, ms);
    } catch (err) {
      row.engines[e.key] = { error: String(err && err.message).slice(0, 120) };
    }
  }
  rows.push(row);
  const cur = row.engines.current;
  console.log(
    `${sc.name.padEnd(9)} n=${String(sc.n).padStart(3)} current ${String(cur.area).padStart(9)} ${String(cur.maxW).padStart(6)}x${String(cur.maxH).padStart(5)} fill=${cur.fill} ov=${cur.overlaps} ${cur.ms}ms | ` +
      ENGINES.slice(1)
        .map((e) => {
          const m = row.engines[e.key];
          if (!m || m.error) return `${e.key}=ERR(${m ? m.error : '?'})`;
          return `${e.key} x${(m.area / cur.area).toFixed(2)} ${m.maxW}x${m.maxH} f=${m.fill} ov=${m.overlaps} v=${m.agentNotRight}/${m.turnNotBelow} ${m.ms}ms`;
        })
        .join(' | '),
  );
}

// summary
console.log('\n--- mean area ratio vs current (20 synthetic scenarios) ---');
const synth = rows.filter((r) => r.scenario !== 'REALISTIC');
for (const e of ENGINES.slice(1)) {
  const rs = synth.map((r) => r.engines[e.key].area / r.engines.current.area);
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  const worst = Math.max(...rs);
  const best = Math.min(...rs);
  console.log(`${e.key.padEnd(9)} mean ${mean.toFixed(3)}x  best ${best.toFixed(2)}x  worst ${worst.toFixed(2)}x`);
}
const real = rows.find((r) => r.scenario === 'REALISTIC');
console.log('\n--- REALISTIC (12-turn chain, sub-agents per turn) ---');
for (const e of ENGINES) {
  const m = real.engines[e.key];
  console.log(
    `${e.key.padEnd(9)} area ${String(m.area).padStart(8)} (${m.maxW}x${m.maxH}) fill ${m.fill} ov ${m.overlaps} notRight ${m.agentNotRight} notBelow ${m.turnNotBelow} ${m.ms}ms`,
  );
}

fs.writeFileSync(path.join(__dirname, 'nlttl-results.json'), JSON.stringify({ rows }, null, 2));
console.log('\nwrote nlttl-results.json');
