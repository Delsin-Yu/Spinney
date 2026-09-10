'use strict';
/*
 * Benchmark: current media/tree.js vs candidates, on synthetic session trees.
 *   node bench.js            -> table on stdout + results.json + results.md
 *   node bench.js --quick    -> 10/30/100 nodes only
 *
 * Metrics per scenario (identical measurement for all engines, see metrics.js):
 *   area (canvas = card bbox + 20px pad), maxW, maxH, overlap pair count,
 *   fill = sum(card areas) / canvas area, direction violations, wall-clock ms.
 */
const fs = require('fs');
const path = require('path');
const current = require('./current');
const C = require('./candidates');
const { measure } = require('./metrics');
const { scenarios, PROFILES, SIZES } = require('./synthetic');

const OUT_DIR = __dirname;
const quick = process.argv.includes('--quick');
const sizes = quick ? SIZES.filter((n) => n <= 100) : SIZES;
const reps = (n) => (n >= 300 ? 3 : 7);

function timeLayout(fn, n) {
  const samples = [];
  for (let i = 0; i < reps(n); i++) {
    const t0 = process.hrtime.bigint();
    fn();
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

const ENGINES = [
  { key: 'current', label: 'current', fn: (t, o) => current.layoutTree(t.nodesById, 'n0', t.heights, o) },
  { key: 'A_flex', label: 'A: flextree+pack', fn: (t, o) => C.layoutAFlex(t.nodesById, 'n0', t.heights, o) },
  { key: 'A_flex_flush', label: 'A: flextree+pack+flush/deep', fn: (t, o) => C.layoutAFlexFlushDeep(t.nodesById, 'n0', t.heights, o) },
  { key: 'A_dagre', label: 'A: dagre+pack', fn: (t, o) => C.layoutADagre(t.nodesById, 'n0', t.heights, o) },
  { key: 'C_flex', label: 'C: 1-pass shift', fn: (t, o) => C.layoutCFlex(t.nodesById, 'n0', t.heights, o) },
  { key: 'B_dagre', label: 'B: dagre compound', fn: (t, o) => C.layoutBDagre(t.nodesById, 'n0', t.heights, o) },
];

const OPTS = { nodeW: 320, hGap: 48, vGap: 72, widths: null, agentGap: 80, agentVGap: 24 };

const rows = [];
for (const sc of scenarios()) {
  if (!sizes.includes(sc.n)) continue;
  const tree = sc.tree;
  const opts = Object.assign({}, OPTS, { widths: tree.widths });
  const row = { scenario: sc.name, n: sc.n, engines: {} };
  for (const e of ENGINES) {
    let result;
    let ms = null;
    try {
      result = e.fn(tree, opts);
      ms = timeLayout(() => e.fn(tree, opts), sc.n);
    } catch (err) {
      row.engines[e.key] = { error: String(err.message).slice(0, 80) };
      continue;
    }
    const m = measure(result, tree, ms);
    if (result.rawOverlaps !== undefined) m.rawOverlaps = result.rawOverlaps;
    row.engines[e.key] = m;
  }
  rows.push(row);
  const cur = row.engines.current;
  console.log(
    `${sc.name.padEnd(8)} n=${String(sc.n).padStart(3)} ` +
    `current area=${String(cur.area).padStart(9)} (${cur.maxW}x${cur.maxH}) fill=${cur.fill} ov=${cur.overlaps} | ` +
    ENGINES.slice(1).map((e) => {
      const m = row.engines[e.key];
      if (!m || m.error) return `${e.key}=ERR`;
      return `${e.key} x${(m.area / cur.area).toFixed(2)} ov=${m.overlaps} v=${m.agentNotRight}/${m.turnNotBelow} ${m.ms}ms`;
    }).join(' | '),
  );
}

// ---------------------------------------------------------------- report tables
const areaTable = [];
const detailTable = [];
for (const row of rows) {
  const cur = row.engines.current;
  const cells = { scenario: row.scenario, n: row.n, current: cur.area };
  for (const e of ENGINES.slice(1)) {
    const m = row.engines[e.key];
    cells[e.key] = m && !m.error ? +(m.area / cur.area).toFixed(2) : null;
  }
  areaTable.push(cells);

  for (const e of ENGINES) {
    const m = row.engines[e.key];
    if (!m || m.error) continue;
    detailTable.push({
      scenario: row.scenario, n: row.n, engine: e.key,
      area: m.area, maxW: m.maxW, maxH: m.maxH, fill: m.fill,
      overlaps: m.overlaps, rawOverlaps: m.rawOverlaps,
      agentNotRight: m.agentNotRight, agentNotCentered: m.agentNotCentered, turnNotBelow: m.turnNotBelow,
      ms: m.ms,
    });
  }
}

const results = { generatedAt: new Date().toISOString(), profiles: PROFILES, areaRatio: areaTable, detail: detailTable };
fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2));

// markdown fragments (assembled by layout-benchmark.md)
const md = [];
md.push('| scenario | n | current area | A flextree+pack | A flextree+pack+flush/deep | A dagre+pack | C 1-pass shift | B dagre compound |');
md.push('|---|---:|---:|---:|---:|---:|---:|---:|');
for (const r of areaTable) {
  const f = (v) => (v == null ? 'n/a' : v.toFixed(2) + 'x');
  md.push(`| ${r.scenario} | ${r.n} | ${r.current} | ${f(r.A_flex)} | ${f(r.A_flex_flush)} | ${f(r.A_dagre)} | ${f(r.C_flex)} | ${f(r.B_dagre)} |`);
}
md.push('');
md.push('| scenario | n | engine | area | W x H | fill | overlaps | raw ovl | agent-left | turn-not-below | ms |');
md.push('|---|---:|---|---:|---|---:|---:|---:|---:|---:|---:|');
for (const d of detailTable) {
  md.push(`| ${d.scenario} | ${d.n} | ${d.engine} | ${d.area} | ${d.maxW}x${d.maxH} | ${d.fill} | ${d.overlaps} | ${d.rawOverlaps == null ? '' : d.rawOverlaps} | ${d.agentNotRight} | ${d.turnNotBelow} | ${d.ms} |`);
}
fs.writeFileSync(path.join(OUT_DIR, 'results.md'), md.join('\n'));

console.log('\nwrote results.json + results.md');
