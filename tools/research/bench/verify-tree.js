'use strict';
/*
 * Regression test for the shipped layout:
 *   1. media/tree.js must reproduce the benchmarked candidate designG
 *      (non-layered-tidy-tree-layout with an engine-owned sidecar GRID — column
 *      major, `agentMaxRows` rows per column — plus the connector routing table),
 *      position-for-position,
 *   2. and it must have zero overlaps, zero direction violations, zero
 *      interpositions, zero grid-misalignments and zero connector crossings
 *      (including the parent's OWN other windows, which the corridor routing is
 *      there to avoid).
 *
 *   node verify-tree.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const N = require('./nlttl-candidates');
const { measure } = require('./metrics');
const { violations, descendants } = require('./violations');
const { scenarios } = require('./synthetic');

const MEDIA = path.resolve(__dirname, '..', '..', '..', 'media');
const ENGINE = path.join(MEDIA, 'vendor', 'non-layered-tidy-tree-layout', 'dist', 'non-layered-tidy-tree-layout.js');
const TREE = path.join(MEDIA, 'tree.js');

function loadShipped() {
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(ENGINE, 'utf8'), sandbox, { filename: ENGINE });
  vm.runInContext(fs.readFileSync(TREE, 'utf8'), sandbox, { filename: TREE });
  const g = sandbox.window.nonLayeredTidyTreeLayout;
  if (!g || typeof g.Layout !== 'function') throw new Error('engine did not expose Layout');
  if (!sandbox.window.treeLayout) throw new Error('tree.js did not expose window.treeLayout');
  return sandbox.window.treeLayout.layoutTree;
}

const shipped = loadShipped();
const R = N.GRID_DEFAULTS.agentMaxRows;
const OPTS = {
  nodeW: 320, hGap: 48, vGap: 72,
  agentGap: 80, agentVGap: 24, agentColGap: 48, agentMaxRows: R, agentTopPad: 16,
};

let bad = 0;
let checked = 0;
for (const sc of scenarios()) {
  const t = sc.tree;
  const o = Object.assign({}, OPTS, { widths: t.widths });
  const a = shipped(t.nodesById, 'n0', t.heights, o);
  const b = N.layoutEngineReserveGrid(t.nodesById, 'n0', t.heights, o);

  const ids = new Set([...Object.keys(a.pos), ...Object.keys(b.pos)]);
  let maxDelta = 0;
  for (const id of ids) {
    const p = a.pos[id];
    const q = b.pos[id];
    if (!p || !q) { maxDelta = Infinity; break; }
    maxDelta = Math.max(maxDelta, Math.abs(p.x - q.x), Math.abs(p.y - q.y));
  }

  const m = measure(a, t, null, { agentMaxRows: R });
  const v = violations(a, t);
  // A connector may pass through a card belonging to the parent's OWN other
  // sidecar windows (it runs inside the parent's reserved sidecar area). The
  // corridor routing is supposed to avoid even those, so both buckets are held
  // to zero.
  const ownGroup = new Set();
  for (const pid in t.nodesById) {
    const p = t.nodesById[pid];
    const ak = (p.children || []).filter((c) => t.nodesById[c] && t.nodesById[c].kind === 'agent');
    for (const x of ak) for (const d of descendants(t.nodesById, x)) ownGroup.add(d);
  }
  const foreignCross = v.crossings.filter((c) => c.crossed.some((id) => !ownGroup.has(id)));
  const ok =
    maxDelta === 0 &&
    m.overlaps === 0 &&
    m.agentNotRight === 0 &&
    m.turnNotBelow === 0 &&
    m.gridMisaligned === 0 &&
    v.interpositions.length === 0 &&
    foreignCross.length === 0 &&
    v.crossings.length === 0;
  if (!ok) bad++;
  checked++;
  console.log(
    `${ok ? 'OK  ' : 'FAIL'} ${sc.name.padEnd(8)} n=${String(sc.n).padStart(3)} ` +
      `maxDelta=${maxDelta} overlaps=${m.overlaps} notRight=${m.agentNotRight} notBelow=${m.turnNotBelow} ` +
      `gridBad=${m.gridMisaligned} interpose=${v.interpositions.length} ` +
      `crossForeign=${foreignCross.length} crossOwnGroup=${v.crossings.length - foreignCross.length} ` +
      `area=${m.area} (${m.maxW}x${m.maxH})`,
  );
  if (!ok && v.interpositions.length) {
    console.log('      e.g. ' + JSON.stringify(v.interpositions[0]));
  }
  if (foreignCross.length) {
    console.log('      FOREIGN CROSS: ' + JSON.stringify(foreignCross[0]));
  }
  if (v.crossings.length && !foreignCross.length) {
    console.log('      OWN-GROUP CROSS: ' + JSON.stringify(v.crossings[0]));
  }
}

console.log(`\n${checked - bad}/${checked} scenarios clean and identical to the benchmarked design`);
process.exit(bad ? 1 : 0);
