'use strict';
/*
 * Grid sweep — pick and document `agentMaxRows` (R).
 *
 *   node grid-sweep.js            # synthetic profiles + every real session with agents
 *   node grid-sweep.js --syn      # synthetic only
 *   node grid-sweep.js --real     # persisted sessions only
 *   node grid-sweep.js --r 4      # single R (raw rows)
 *
 * For every R in {1,2,3,4,6,8} it lays the SHIPPED media/tree.js out and reports the
 * numbers that decide the trade-off:
 *   canvas     — WxH of the card bounding box (+ pad), and its area
 *   hPush      — the canvas height (the vertical cost the sidecar reservation adds,
 *                i.e. how far a node's turn children are pushed down)
 *   gridBad    — parents whose windows are not an aligned R-row lattice
 *   inter/crossForeign/crossOwn — visual defects (see violations.js); crossOwn is
 *                the bucket the corridor routing is supposed to empty.
 *
 * R=1 is the pre-grid design (one column), so it is the control column.
 *
 * Real sessions are read from the VS Code state DB (same source as
 * analyze-interposition.js): %TEMP%/hstate.vscdb, key
 * `minimal-host.minimal-agent-harness`, path `agentHarness.state.sessions`.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { DatabaseSync } = require('node:sqlite');
const { measure } = require('./metrics');
const { violations, descendants } = require('./violations');
const { scenarios } = require('./synthetic');

const MEDIA = path.resolve(__dirname, '..', '..', '..', 'media');
const ENGINE = path.join(MEDIA, 'vendor', 'non-layered-tidy-tree-layout', 'dist', 'non-layered-tidy-tree-layout.js');
const TREE = path.join(MEDIA, 'tree.js');
// `R` = rows per column. LEGACY_R is the pre-grid behaviour (one single column of
// everything, i.e. effectively unbounded rows per column).
const LEGACY_R = 1000000;
const RS = [LEGACY_R, 1, 2, 3, 4, 6, 8];
const label = (R) => (R === LEGACY_R ? 'legacy' : 'R=' + R);

function loadShipped() {
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(ENGINE, 'utf8'), sandbox, { filename: ENGINE });
  vm.runInContext(fs.readFileSync(TREE, 'utf8'), sandbox, { filename: TREE });
  return sandbox.window.treeLayout.layoutTree;
}

// ------------------------------------------------------------------ real sessions
function loadRealSessions() {
  const db = process.env.TEMP.split(path.sep).join('/') + '/hstate.vscdb';
  const out = [];
  let dbh;
  try {
    dbh = new DatabaseSync(db, { readOnly: true });
  } catch (e) {
    console.error('(no state DB at ' + db + ' — skipping real sessions)');
    return out;
  }
  const rows = dbh.prepare("SELECT key,value FROM ItemTable WHERE key LIKE '%minimal-agent-harness%'").all();
  dbh.close();
  let state = null;
  for (const r of rows) {
    try {
      const s = JSON.parse(r.value);
      if (s['agentHarness.state']) state = s;
    } catch (e) { /* not the state row */ }
  }
  if (!state) return out;
  const ss = state['agentHarness.state'].sessions;
  for (const s of Array.isArray(ss) ? ss : Object.values(ss || {})) {
    const raw = s.nodes;
    const arr = Array.isArray(raw) ? raw : Object.values(raw || {});
    if (!arr.length) continue;
    const nodesById = {};
    for (const n of arr) {
      nodesById[n.id] = {
        id: n.id,
        kind: n.kind || 'turn',
        children: Array.isArray(n.children) ? n.children.slice() : [],
        parentId: n.parentId || '',
        raw: n,
      };
    }
    for (const id in nodesById) {
      const n = nodesById[id];
      if (!n.children.length && n.parentId && nodesById[n.parentId] && !nodesById[n.parentId].children.includes(id)) {
        nodesById[n.parentId].children.push(id);
      }
    }
    const agents = Object.values(nodesById).filter((n) => n.kind === 'agent');
    if (!agents.length) continue;
    const heights = {};
    const widths = {};
    for (const id in nodesById) {
      const items = nodesById[id].raw.displayItems || [];
      let px = 56;
      for (const it of items) {
        const text = typeof it === 'string' ? it : String(it.text || it.content || '');
        const lines = Math.max(1, Math.ceil(text.length / 90));
        px += 26 + Math.min(lines, 22) * 18;
      }
      heights[id] = Math.max(96, Math.min(px, 600));
      widths[id] = 320;
    }
    const rootId = s.rootId || arr.find((n) => !n.parentId)?.id;
    out.push({ name: 'session:' + String(s.id).slice(0, 12), n: arr.length, agents: agents.length, nodesById, rootId, heights, widths });
  }
  return out;
}

// ------------------------------------------------------------------ one scenario
function runOne(layoutTree, tree, R) {
  const opts = {
    nodeW: 320, hGap: 48, vGap: 72, widths: tree.widths,
    agentGap: 80, agentVGap: 24, agentColGap: 48, agentMaxRows: R, agentTopPad: 16,
  };
  const t0 = process.hrtime.bigint();
  const res = layoutTree(tree.nodesById, tree.rootId, tree.heights, opts);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const m = measure(res, tree, null, { agentMaxRows: R });
  const v = violations(res, tree);
  const ownGroup = new Set();
  for (const pid in tree.nodesById) {
    const p = tree.nodesById[pid];
    const ak = (p.children || []).filter((c) => tree.nodesById[c] && tree.nodesById[c].kind === 'agent');
    for (const a of ak) for (const d of descendants(tree.nodesById, a)) ownGroup.add(d);
  }
  const crossForeign = v.crossings.filter((c) => c.crossed.some((id) => !ownGroup.has(id))).length;
  const crossOwn = v.crossings.length - crossForeign;
  // Worst sidecar block height: how far a node's turn children are pushed down.
  let worstBlock = 0;
  for (const pid in tree.nodesById) {
    const ak = (tree.nodesById[pid].children || []).filter((c) => tree.nodesById[c] && tree.nodesById[c].kind === 'agent');
    if (!ak.length) continue;
    let top = Infinity;
    let bottom = -Infinity;
    const kids = new Set();
    const q = ak.slice();
    while (q.length) {
      const id = q.shift();
      if (kids.has(id)) continue;
      kids.add(id);
      for (const c of (tree.nodesById[id].children || [])) q.push(c);
    }
    for (const id of kids) {
      if (!res.pos[id]) continue;
      top = Math.min(top, res.pos[id].y);
      bottom = Math.max(bottom, res.pos[id].y + (tree.heights[id] || 120));
    }
    if (bottom > top) worstBlock = Math.max(worstBlock, bottom - top);
  }
  return {
    ms, area: m.area, maxW: m.maxW, maxH: m.maxH, overlaps: m.overlaps,
    gridBad: m.gridMisaligned, inter: v.interpositions.length, crossForeign, crossOwn, worstBlock,
  };
}

const args = process.argv.slice(2);
const onlyR = args.includes('--r') ? Number(args[args.indexOf('--r') + 1]) : null;
const rs = onlyR ? [onlyR] : RS;
const syn = !args.includes('--real');
const real = !args.includes('--syn');

const layoutTree = loadShipped();
const cases = [];
if (syn) for (const sc of scenarios()) cases.push({ name: sc.name + ':' + sc.n, tree: { ...sc.tree, rootId: 'n0' } });
if (real) for (const r of loadRealSessions()) cases.push({ name: r.name, tree: r });

const all = {};
for (const R of rs) {
  const rows = [];
  for (const c of cases) rows.push({ case: c.name, ...runOne(layoutTree, c.tree, R) });
  all[R] = rows;
  console.log(`\n=== agentMaxRows = ${R} ===`);
  console.log(
    'case'.padEnd(22) + 'area'.padStart(12) + 'WxH'.padStart(16) +
    'ov'.padStart(5) + 'gridBad'.padStart(9) + 'inter'.padStart(7) + 'xFor'.padStart(6) + 'xOwn'.padStart(6) +
    'blockH'.padStart(9) + 'ms'.padStart(8),
  );
  for (const r of rows) {
    console.log(
      r.case.padEnd(22) + String(r.area).padStart(12) + (r.maxW + 'x' + r.maxH).padStart(16) +
      String(r.overlaps).padStart(5) + String(r.gridBad).padStart(9) + String(r.inter).padStart(7) +
      String(r.crossForeign).padStart(6) + String(r.crossOwn).padStart(6) +
      String(r.worstBlock).padStart(9) + r.ms.toFixed(1).padStart(8),
    );
  }
}

// ------------------------------------------------------------------ summary
const base = all[rs[0]];
console.log('\n=== summary (ratios vs the first R above) ===');
console.log('R'.padStart(9) + '  areaRatio   heightRatio  worstBlockH  sumDefects  worstGridBad  ms');
for (const R of rs) {
  const rows = all[R];
  let area = 0;
  let baseArea = 0;
  let h = 0;
  let baseH = 0;
  let worstBlock = 0;
  let defects = 0;
  let worstGrid = 0;
  let ms = 0;
  for (let i = 0; i < rows.length; i++) {
    area += rows[i].area;
    baseArea += base[i].area;
    h += rows[i].maxH;
    baseH += base[i].maxH;
    worstBlock = Math.max(worstBlock, rows[i].worstBlock);
    worstGrid = Math.max(worstGrid, rows[i].gridBad);
    defects += rows[i].overlaps + rows[i].inter + rows[i].crossForeign + rows[i].crossOwn;
    ms += rows[i].ms;
  }
  console.log(
    label(R).padStart(9) +
      (area / baseArea).toFixed(3).padStart(11) +
      (h / baseH).toFixed(3).padStart(12) +
      String(worstBlock).padStart(13) +
      String(defects).padStart(12) +
      String(worstGrid).padStart(14) +
      ms.toFixed(0).padStart(5),
  );
}

const out = path.join(__dirname, 'grid-sweep-results.json');
fs.writeFileSync(out, JSON.stringify({ cases: cases.map((c) => ({ name: c.name, n: c.n })), results: all }, null, 1));
console.log('\nwrote ' + out);
