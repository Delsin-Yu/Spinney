/*
 * check-tree-grid — the Chat Tree's *sidecar lattice* geometry, as a build-time
 * guard (`media/tree.js` `layoutTree` + the `relayout()` half in `media/main.js`).
 *
 * WHY IT EXISTS
 * A parent's sub-agent / background windows are packed into a column-major grid to
 * the right of the parent card, and the layout hands the webview exactly two answers
 * per window: the box the layout reserved (`cells`) and the height the card must be
 * rendered at (`stretch`). Nothing else guards them — no CSS, no test in the webview,
 * no host code reads them again:
 *   - the box decides where a connector may run and which y-band a turn child starts
 *     below, so a wrong box quietly draws an edge through a card or leaves a dead gap
 *     between a parent's windows;
 *   - `stretch` is the only reason a column holding a deep sub-agent ends flush with
 *     the block's bottom line, and it feeds back into the next frame (the webview
 *     re-measures the cards after clearing it — C11) — so a wrong stretch does not
 *     fail loudly, it creeps taller frame by frame until the canvas is nonsense.
 * Both are pure arithmetic over measured heights, so both are checkable here, on the
 * real pinned engine the webview ships, without a browser.
 *
 * WHAT IT ASSERTS (checks C1–C11 + R0/R1, per sidecar grid of a synthetic spec; the
 * 18 specs include the REAL session `mu2zn79jlv7b23` and its recorded golden numbers)
 *   C1  column stacks (agentTopPad + Σ extent + gaps) and every column's bottom line:
 *       each cell's box top equals its own column's stack top, the column's last cell's
 *       box bottom IS that column's bottom, and the columns are NOT required to be flush
 *       with each other (no fill, no stretch — a short column just ends earlier)
 *   C2  the RENDERED gap between two stacked cards is agentVGap plus the box space the
 *       card above left empty (a card is never stretched to its box)
 *   C3  the result carries NO `stretch` key: the contract is `{pos, cells, width, height}`
 *   C4  the row cap and the valve: every column holds <= agentMaxRows cells, every
 *       column's stack <= max(agentMaxBlockH, tallest cell + agentTopPad), the packing is
 *       greedy (a cell opens a column only because the previous one was full or the valve
 *       would have been crossed), and no card is taller than its own box
 *   C5  no two RENDERED card rects overlap (every card at its measured height) and no
 *       two sibling boxes overlap
 *   C6  every card/box stays inside the parent's reserved block, the column gap is
 *       agentColGap and the grid's left edge is parent card right + agentGap
 *   C7  col/row follow the greedy column model (child order, columns filled in order),
 *       and the index/count fields match the child order
 *   C8  routing corridors: `busX`/`chanX` are numbers and never sit inside *and*
 *       across a foreign card, `corrY` never crosses a rendered card
 *   C9  no height feedback at all: the same measured heights in, the same map and the
 *       same canvas out, on every pass (see "C9" below)
 *   C10 box accounting: `cells[id].h` == an independently rebuilt subtree bbox and the
 *       cell's own grid B matches the block its sub-grid holds
 *   R0  the retired clamp is provably gone: no card is taller than its own box
 *   R1  the REAL session's golden numbers (canvas, per-grid B, card tops, the C card's
 *       y, no card inset in its box)
 *   C11 the webview half of the same contract, read as text from `media/main.js`:
 *       `relayout()` measures the cards and applies NO rendered height — nothing writes
 *       an inline `height` / `max-height` for layout, and `agentMaxBlockH` is what it
 *       passes to the layout. A forced height is the one way this layout could creep
 *       every frame, so the guard forbids it outright.
 *
 * C9 (why "no feedback" replaces the old one-pass-fixpoint doctrine)
 * The old model was a feedback loop: `stretch` fed the webview's rendered heights, the
 * webview handed them back in as the next pass's measured heights, and the guard had to
 * prove that loop settled (strictly in one pass for reachable shapes, as a contracting
 * sequence for two unreachable specimens). A card is now rendered at exactly the height
 * it measured, so the loop is GONE: the layout's output depends only on the heights the
 * webview measured, and feeding the same heights in again must reproduce the same map
 * and the same canvas exactly. C9 asserts that on every spec (three passes, all equal),
 * and C11 asserts the webview side really does not write a height back. Those two
 * together are the whole anti-creep argument now — there is no pass cap left to tune,
 * because there is no pass-to-pass correction left to bound.
 *
 * The two specimens that used to be marked "exception" shapes (`X-nest3`: a turn child
 * hanging under a sidecar; `bigcard`: a single card taller than the budget) are kept as
 * ordinary specs: with the clamp retired they are handled by the same rules as every
 * other shape, and that uniformity is the point — there is no "in-domain" and
 * "exception" classification left to verify. They are still UNREACHABLE IN PRODUCTION
 * (`attachNode`, `src/chat/tree.ts`, appends a sidecar to its parent's `children` and
 * never under a sidecar; the runtime refuses a sidecar as a continuation/rollover target
 * — `continueFrom` / `canRollover` / `rolloverContext`, `src/chat/runtime.ts`), and they
 * stay in the list so a session file that carries such a shape cannot crash the layout.
 *
 * HOW: loads the vendored tidy-tree engine and `media/tree.js` into node's `vm` with
 * `window = ctx` (a sidecar-grid spec is a plain node map, so no DOM is needed), then
 * re-derives each grid's model — the greedy columns under the height budget, their
 * stacks, subtree boxes — from what the layout itself returned and cross-checks it.
 * Deterministic, no browser, no dependencies; every path is resolved from `__dirname`
 * (repo root = `path.join(__dirname, '..')`).
 *
 * Run: npm run check:grid   /   node tools/check-tree-grid.js [path/to/tree.js] [path/to/engine.js]
 *      (argv[2] lets the mutation test point the same guard at a mutated COPY outside
 *      the repo; argv[3] overrides the vendored engine.)
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const TREE_PATH = process.argv[2] || path.join(ROOT, 'media', 'tree.js');
const VENDOR_PATH =
  process.argv[3] ||
  path.join(ROOT, 'media', 'vendor', 'non-layered-tidy-tree-layout', 'dist', 'non-layered-tidy-tree-layout.js');
const MAIN_PATH = path.join(ROOT, 'media', 'main.js');

const EPS = 1e-6;
const DEF = {
  nodeW: 320, hGap: 48, vGap: 72, pad: 20,
  agentGap: 80, agentVGap: 24, agentColGap: 48, agentMaxRows: 3, agentMonitorH: 200, agentTopPad: 16,
};
/** Passes run for C9 (the same measured heights in must give the same output out). */
const C9_PASSES = 3;

// ---------------------------------------------------------------- report stream
const rows = [];        // { spec, check, ok, detail }
const problems = [];    // one line per failing check (label + detail)
const run = (spec, check, okFlag, detail) => {
  const line = { spec, check, ok: okFlag, detail: detail || '' };
  rows.push(line);
  if (!okFlag) problems.push(spec + ' -> ' + check + ': ' + (detail || '(no detail)'));
  return line;
};
const note = (label, detail) => console.log(`  [ok  ] ${label}${detail ? '  (' + detail + ')' : ''}`);
const failedLine = (label, detail) => console.log(`  [FAIL] ${label}${detail ? '  (' + detail + ')' : ''}`);

// ---------------------------------------------------------------- loader
function load(treePath, vendorPath) {
  const ctx = { console };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(vendorPath, 'utf8'), ctx, { filename: vendorPath });
  if (!ctx.window.nonLayeredTidyTreeLayout) {
    throw new Error('vendored engine did not define window.nonLayeredTidyTreeLayout: ' + vendorPath);
  }
  vm.runInContext(fs.readFileSync(treePath, 'utf8'), ctx, { filename: treePath });
  if (!ctx.window.treeLayout || typeof ctx.window.treeLayout.layoutTree !== 'function') {
    throw new Error('window.treeLayout.layoutTree is not a function: ' + treePath);
  }
  return ctx.window.treeLayout.layoutTree;
}

// ---------------------------------------------------------------- spec builders
function buildSpec(name, list, heights, opts) {
  const nodes = {};
  for (const d of list) nodes[d.id] = { id: d.id, kind: d.kind || 'turn', children: [] };
  for (const d of list) if (d.parent) nodes[d.parent].children.push(d.id);
  const hs = {};
  for (const d of list) hs[d.id] = (heights && heights[d.id] != null) ? heights[d.id] : 330;
  return { name, nodes, rootId: list[0].id, heights: hs, opts };
}

function flatGrid(n, opt) {
  opt = opt || {};
  const list = [{ id: 'r', kind: 'turn' }];
  for (let i = 0; i < n; i++) list.push({ id: 'a' + i, kind: opt.kind ? opt.kind(i) : 'agent', parent: 'r' });
  const hs = {};
  for (let i = 0; i < n; i++) hs['a' + i] = opt.h ? opt.h(i) : 330;
  return buildSpec('flat n=' + n + (opt.label ? ' [' + opt.label + ']' : ''), list, hs, opt.opts);
}

/** The REAL session `mu2zn79jlv7b23` (root `mu2zp7px3zsegz`, all cards 330). */
const REAL = (function realSpec() {
  const A = ['mu2zprz144bbh4', 'mu2zprz1szfyo6', 'mu2zprz1p3hrno', 'mu2zprz15gtrk6', 'mu2zprz19fpyip'];
  const B = ['mu2zquika60bv5', 'mu2zquikoxkhr4', 'mu2zquikm30yqw'];
  const D = ['mu3004pl0l971r', 'mu3004plsxfe8v', 'mu3004plyzeigu', 'mu3004plitr2cy',
             'mu3004plwd32s8', 'mu3004plte1wr1', 'mu3004pli6b76o', 'mu3004plyhs83j'];
  const list = [{ id: 'mu2zp7px3zsegz', kind: 'turn' }];                        // root
  list.push({ id: 'mu2zyi167efltd', kind: 'turn', parent: 'mu2zp7px3zsegz' });  // its turn child
  for (const id of A) list.push({ id, kind: 'agent', parent: 'mu2zp7px3zsegz' });
  for (const id of B) list.push({ id, kind: 'agent', parent: A[4] });
  for (const id of D) list.push({ id, kind: 'agent', parent: 'mu2zyi167efltd' });
  return buildSpec('REAL mu2zn79jlv7b23 (all cards 330)', list, {}, undefined);
})();

function allSpecs() {
  const out = [];
  for (const n of [1, 2, 3, 4, 5, 8, 9]) out.push(flatGrid(n));
  out.push(flatGrid(5, { label: 'varied heights 200..480', h: (i) => 200 + 70 * i }));
  out.push(flatGrid(8, { label: 'varied heights', h: (i) => [330, 520, 200, 800, 330, 520, 200, 800][i] }));
  // two levels deep: R -> a1(agent) -> b1,b2 ; R -> t(turn) -> a2
  out.push(buildSpec('nest2', [
    { id: 'r', kind: 'turn' }, { id: 'a1', kind: 'agent', parent: 'r' }, { id: 't', kind: 'turn', parent: 'r' },
    { id: 'b1', kind: 'agent', parent: 'a1' }, { id: 'b2', kind: 'agent', parent: 'a1' },
    { id: 'a2', kind: 'agent', parent: 't' },
  ]));
  // three levels deep, reachable shape (sidecar-only nesting)
  out.push(buildSpec('chain3 (agent>agent>agent, sidecar-only nesting)', [
    { id: 'r', kind: 'turn' }, { id: 'a1', kind: 'agent', parent: 'r' },
    { id: 'a2a', kind: 'agent', parent: 'a1' }, { id: 'a2b', kind: 'agent', parent: 'a1' },
    { id: 'a3a', kind: 'agent', parent: 'a2a' }, { id: 'a3b', kind: 'agent', parent: 'a2a' },
    { id: 'a3c', kind: 'agent', parent: 'a2a' },
  ]));
  // a turn child under an agent: unreachable today, handled by the same rules anyway
  out.push(buildSpec('X-nest3 (turn child under an agent, unreachable)', [
    { id: 'r', kind: 'turn' }, { id: 'a1', kind: 'agent', parent: 'r' },
    { id: 'a2', kind: 'agent', parent: 'a1' }, { id: 't1', kind: 'turn', parent: 'a1' },
    { id: 'a3', kind: 'agent', parent: 'a2' }, { id: 'a4', kind: 'agent', parent: 'a2' },
    { id: 'a5', kind: 'agent', parent: 't1' },
  ]));
  // a card taller than its own sub-grid (900 > 16+330+24+330 = 700)
  out.push(buildSpec('tallcard (900 card, 700 sub-grid)', [
    { id: 'r', kind: 'turn' },
    { id: 'x', kind: 'agent', parent: 'r' }, { id: 'y', kind: 'agent', parent: 'r' }, { id: 'z', kind: 'agent', parent: 'r' },
    { id: 'x1', kind: 'agent', parent: 'x' }, { id: 'x2', kind: 'agent', parent: 'x' },
  ], { x: 900 }));
  // dead-gap probes: tall CARD in a row (old code: shared row band)
  out.push(buildSpec('tallrow (a0 = 800 tall card, 8 cells)', [
    { id: 'r', kind: 'turn' }, ...Array.from({ length: 8 }, (_, i) => ({ id: 'a' + i, kind: 'agent', parent: 'r' })),
  ], { a0: 800 }));
  out.push(buildSpec('tallrow2 (a4 = 800 tall card, 8 cells)', [
    { id: 'r', kind: 'turn' }, ...Array.from({ length: 8 }, (_, i) => ({ id: 'a' + i, kind: 'agent', parent: 'r' })),
  ], { a4: 800 }));
  // mixed agent/bg, with a bg that owns a grid
  out.push(buildSpec('mixed agent+bg', [
    { id: 'r', kind: 'turn' },
    { id: 'm0', kind: 'bg', parent: 'r' }, { id: 'm1', kind: 'agent', parent: 'r' },
    { id: 'm2', kind: 'bg', parent: 'r' }, { id: 'm3', kind: 'agent', parent: 'r' },
    { id: 'm4', kind: 'bg', parent: 'r' }, { id: 'm5', kind: 'agent', parent: 'r' },
    { id: 'n0', kind: 'agent', parent: 'm2' }, { id: 'n1', kind: 'bg', parent: 'm2' },
  ]));
  // a single card far taller than the budget: it gets a column of its own
  out.push(buildSpec('bigcard (a0 turn child, a4 3000 card, unreachable)', [
    { id: 'r', kind: 'turn' },
    { id: 'a0', kind: 'agent', parent: 'r' }, { id: 'a1', kind: 'agent', parent: 'r' },
    { id: 'a2', kind: 'agent', parent: 'r' }, { id: 'a3', kind: 'agent', parent: 'r' },
    { id: 'a4', kind: 'agent', parent: 'r' },
    { id: 't0', kind: 'turn', parent: 'a0' },
  ], { a4: 3000 }));
  // a sidecar whose own turn spine BRANCHES (two turn children): the engine centres a
  // card over its children, so this is the shape that pins the box anchoring in
  // `layoutSub` — a cell anchored by its CARD instead of by its box drags those children
  // out to the left of the parent's reserved rectangle, onto the parent card. Unreachable
  // in production (`attachNode` never puts a turn node under a sidecar); kept because a
  // session file could carry it.
  out.push(buildSpec('branchunder (sidecar with two turn children, unreachable)', [
    { id: 'r', kind: 'turn' },
    { id: 's', kind: 'agent', parent: 'r' },
    { id: 't1', kind: 'turn', parent: 's' }, { id: 't2', kind: 'turn', parent: 's' },
  ], { s: 120, t1: 120, t2: 120 }));
  // One window is as wide as the FOCUSED card (`.node.expanded` is 560px while a monitor is
  // 320px): the column pitch has to follow the cards, or the wide cell overlaps the next
  // column of its own node and reaches out of the reserved box. Caught by review, pinned here.
  out.push(buildSpec('wideside (a0 is 560px wide, 4 windows)', [
    { id: 'r', kind: 'turn' },
    { id: 'a0', kind: 'agent', parent: 'r' }, { id: 'a1', kind: 'agent', parent: 'r' },
    { id: 'a2', kind: 'agent', parent: 'r' }, { id: 'a3', kind: 'agent', parent: 'r' },
  ], {}, { widths: { a0: 560 } }));
  out.push(REAL);
  return out;
}

// ---------------------------------------------------------------- helpers
const num = (v) => (typeof v === 'number' && isFinite(v)) ? String(Math.round(v * 1000) / 1000) : String(v);
const eq = (a, b, eps) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= (eps == null ? 1e-6 : eps);
const overX = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
const overY = (a, b) => Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
const clip = (arr, k) => arr.length <= k ? arr.join(' ; ') : arr.slice(0, k).join(' ; ') + ' ; ...(+' + (arr.length - k) + ' more)';

// ---------------------------------------------------------------- one spec: C1..C10, R0
function verifySpec(spec, layoutTree, run) {
  const o = Object.assign({}, DEF, spec.opts || {});
  const nodes = spec.nodes, rootId = spec.rootId, heights = spec.heights;
  const GAP = o.agentVGap, TPAD = o.agentTopPad, COLGAP = o.agentColGap;
  const ROWS = Math.max(1, o.agentMaxRows | 0);
  const MON = o.agentMonitorH;
  const NW = o.nodeW;
  const isSide = (id) => !!nodes[id] && (nodes[id].kind === 'agent' || nodes[id].kind === 'bg');
  const kidsOf = (id) => (nodes[id] && nodes[id].children) || [];
  const size = (id) => ({ w: (o.widths && o.widths[id]) || o.nodeW, h: heights[id] || 120 });
  const sideIds = Object.keys(nodes).filter(isSide);

  let L1;
  try {
    L1 = layoutTree(nodes, rootId, heights, spec.opts);
  } catch (e) {
    run(spec.name, 'C0 layout call', false, 'layoutTree threw: ' + e.message);
    return null;
  }

  const cells = L1.cells || {}, pos = L1.pos || {};

  // ---- grids + model (extent = the layout's own cells.h)
  // A node's sub-agent FOREST: every sidecar BELOW it (depth-first: depth 1 is its own
  // sidecar children, depth 2 theirs), because that whole forest is what one block holds.
  const forestOf = (pid) => {
    const out = [];
    (function walk(id) {
      for (const c of kidsOf(id).filter(isSide)) { out.push(c); walk(c); }
    })(pid);
    return out;
  };
  // A node owns a forest only if one of its OWN sidecar children is a depth-1 cell. A
  // sidecar's own sidecar children belong to the nearest turn ancestor's forest — that is
  // exactly what makes them a new band instead of a box nested inside a cell — so they are
  // not a second model.
  const grids = [];
  for (const pid of Object.keys(nodes)) {
    const own = kidsOf(pid).filter(isSide);
    if (!own.some((k) => cells[k] && cells[k].depth === 1)) continue;
    const ks = forestOf(pid);
    if (ks.length) grids.push({ pid, ks });
  }
  const models = grids.map((g) => {
    // The model re-derives the FOREST from the layout's own answers — each cell's slot
    // (`cells[k].h`) and each card's own width — by running the SAME packing rule: a group of
    // cells fills columns of `ROWS`, and directly AFTER EACH COLUMN comes the group formed by
    // that column's cells' own windows. That order is the whole point (a window's own windows
    // stand one column hop from it), so the model mirrors it instead of grouping by depth.
    const ext = {}, wid = {};
    for (const k of g.ks) { ext[k] = cells[k] ? cells[k].h : NaN; wid[k] = size(k).w || NW; }
    const colSizes = [];        // one entry per column, in placement order
    const rec = new Map();      // cell id -> its model record
    let x = 0, B = 0;
    const place = (list, depth) => {
      for (let start = 0; start < list.length; start += ROWS) {
        const col = list.slice(start, start + ROWS);
        let colW = 0;
        for (const id of col) colW = Math.max(colW, wid[id] || NW);
        const cs = { depth, col: Math.floor(start / ROWS), cnt: 0, sum: 0, x, w: colW, cells: [] };
        x += colW + COLGAP;
        colSizes.push(cs);
        let y = TPAD;
        const kids = [];
        for (let r = 0; r < col.length; r++) {
          const id = col[r];
          const slot = ext[id];
          cs.cells.push(id);
          rec.set(id, { depth, col: cs.col, row: r, index: start + r, count: list.length, x: cs.x, y, slot });
          cs.cnt++;
          cs.sum += (cs.cnt > 1 ? GAP : 0) + slot;
          if (y + slot > B) B = y + slot;
          y += slot + GAP;
          for (const k of kidsOf(id).filter(isSide)) kids.push(k);
        }
        if (kids.length) place(kids, depth + 1);
      }
    };
    place(kidsOf(g.pid).filter(isSide), 1);
    const W = x ? x - COLGAP : 0;
    const at = (k, key) => (rec.get(k) ? rec.get(k)[key] : NaN);
    const model = {
      pid: g.pid, ks: g.ks, n: g.ks.length, nCols: colSizes.length, W,
      colOf: (i) => at(g.ks[i], 'col'),
      rowOf: (i) => at(g.ks[i], 'row'),
      dep: g.ks.map((k) => at(k, 'depth')),
      ext: g.ks.map((k) => ext[k]),
      bandOf: g.ks.map((k) => at(k, 'depth')),
      idxInBand: g.ks.map((k) => at(k, 'index')),
      cntInBand: g.ks.map((k) => at(k, 'count')),
      top: g.ks.map((k) => at(k, 'y')),
      S: colSizes.map((cs) => TPAD + cs.sum),
      B, colSizes,
    };
    model.index = {};
    g.ks.forEach((k, i) => { model.index[k] = i; });
    return model;
  });
  const modelOf = {};
  for (const m of models) modelOf[m.pid] = m;

  // ---- independent rebuild of a node's subtree box (bbox of everything it holds)
  const boxMemo = {};
  const boxOf = (id) => {
    if (boxMemo[id] != null) return boxMemo[id];
    boxMemo[id] = 0;                                  // cycle guard
    let h = size(id).h;
    if (modelOf[id]) h = Math.max(h, modelOf[id].B);   // its own grid block
    for (const c of kidsOf(id)) {
      if (isSide(c) || !pos[c] || !pos[id]) continue;  // sidecars are inside the block
      h = Math.max(h, (pos[c].y - pos[id].y) + boxOf(c));
    }
    boxMemo[id] = h;
    return h;
  };

  // ---- RENDERED CARD rects (a sidecar card is rendered at exactly the height it
  // measured: the layout no longer hands out any rendered height)
  const rects = [], boxes = [];
  for (const id of Object.keys(nodes)) {
    if (!pos[id]) continue;
    const s = size(id);
    if (isSide(id)) {
      const c = cells[id];
      rects.push({
        id, kind: nodes[id].kind, sidecar: true, x: pos[id].x, y: pos[id].y, w: s.w, h: s.h,
        boxH: c ? c.h : NaN,
      });
      if (c) boxes.push({ id, x: c.x, y: c.y, w: c.w, h: c.h });
    } else {
      rects.push({ id, kind: 'turn', sidecar: false, x: pos[id].x, y: pos[id].y, w: s.w, h: s.h });
    }
  }
  const rectById = {}, boxById = {};
  for (const r of rects) rectById[r.id] = r;
  for (const b of boxes) boxById[b.id] = b;

  // ---- per-cell classification under the documented card-height rule
  const info = {};
  for (const m of models) {
    for (let i = 0; i < m.n; i++) {
      const id = m.ks[i], c = cells[id], p = pos[id];
      const measured = size(id).h;
      const cardTopInBox = (c && p) ? (p.y - c.y) : 0;
      info[id] = {
        parent: m.pid, i, depth: m.dep[i], col: m.colOf(i), row: m.rowOf(i),
        idxInBand: m.idxInBand[i], bandCols: m.cntInBand[i],
        measured, cardTopInBox,
        slot: c ? c.h : NaN,
        ext: m.ext[i],
        boxSpare: c ? (c.h - measured) : NaN,
      };
    }
  }

  // ================================================================ C1
  {
    const bad = [];
    if (!models.length) bad.push('no forest found in spec (spec problem)');
    for (const m of models) {
      const py = pos[m.pid] ? pos[m.pid].y : NaN;
      for (const cs of m.colSizes) {
        const idx = cs.cells.map((id) => m.index[id]);
        let sum = 0;
        for (const i of idx) sum += m.ext[i];
        const stack = TPAD + sum + (idx.length - 1) * GAP;
        const want = TPAD + cs.sum;
        if (!eq(stack, want, 0.001)) bad.push(m.pid + ' d' + cs.depth + ' col' + cs.col + ': topPad+sum(slots)+gaps=' + num(stack) + ' vs model stack=' + num(want));
        // every cell sits at its own column's stack top, and the column's bottom line IS its
        // last cell's box bottom — the columns are NOT made flush with each other.
        for (const i of idx) {
          const id = m.ks[i], cell = cells[id];
          if (!cell) { bad.push(id + ': no cells entry'); continue; }
          if (!eq(cell.y - py, m.top[i], 0.001)) bad.push(id + ' d' + cs.depth + ' col' + cs.col + ' row' + m.rowOf(i) + ': box top=' + num(cell.y - py) + ' want stack top ' + num(m.top[i]) + ' (delta ' + num(cell.y - py - m.top[i]) + ')');
        }
        const lastI = idx[idx.length - 1], last = cells[m.ks[lastI]];
        if (last) {
          const bottom = last.y + m.ext[lastI] - py;
          if (!eq(bottom, stack, 0.001)) bad.push(m.pid + ' d' + cs.depth + ' col' + cs.col + ': last cell box bottom=' + num(bottom) + ' vs column stack=' + num(stack) + ' (delta ' + num(bottom - stack) + ')');
        }
      }
      const tallest = Math.max.apply(null, m.S.concat([0]));
      if (!eq(m.B, tallest, 0.001)) bad.push(m.pid + ': B=' + num(m.B) + ' != the tallest column stack=' + num(tallest));
    }
    run(spec.name, 'C1 band/column stacks (columns not flush)', bad.length === 0, clip(bad, 4));
  }

  // ================================================================ C2
  {
    const bad = [];
    for (const m of models) {
      for (const cs of m.colSizes) {
        const idx = cs.cells.map((id) => m.index[id]);
        for (let k = 1; k < idx.length; k++) {
          const i0 = idx[k - 1], i1 = idx[k];
          const p = rectById[m.ks[i0]], q = rectById[m.ks[i1]];
          if (!p || !q) continue;
          const gap = q.y - (p.y + p.h);
          const spare = (cells[m.ks[i0]] ? cells[m.ks[i0]].h : p.h) - p.h;   // slot space the card left empty
          const want = GAP + Math.max(0, spare);
          if (!eq(gap, want, 0.001)) {
            bad.push(m.pid + ' d' + cs.depth + ' col' + cs.col + ' row' + (k - 1) + '->' + k + ': rendered gap=' + num(gap) + ' want ' + num(want) + ' (agentVGap ' + num(GAP) + ' + slot spare ' + num(spare) + ' of ' + m.ks[i0] + ')');
          }
        }
      }
    }
    run(spec.name, 'C2 rendered gap == agentVGap + slot spare', bad.length === 0, clip(bad, 4));
  }

  // ================================================================ C3
  {
    const bad = [];
    const keys = Object.keys(L1).sort().join(',');
    if ('stretch' in L1) bad.push('the result still carries a `stretch` key: ' + String(L1.stretch));
    if (keys !== 'cells,height,pos,width') bad.push('result keys are [' + keys + '] want [cells,height,pos,width]');
    const missing = sideIds.filter((id) => !(id in cells));
    if (missing.length) bad.push('cells is missing ' + missing.length + ' sidecar cells: ' + clip(missing, 4));
    run(spec.name, 'C3 no stretch: {pos, cells, width, height}', bad.length === 0, bad.join(' ; '));
  }

  // ================================================================ C4
  {
    const bad = [];
    for (const m of models) {
      for (const cs of m.colSizes) {
        const idx = cs.cells.map((id) => m.index[id]);
        if (!eq(m.S[m.colSizes.indexOf(cs)], TPAD + cs.sum, 0.001)) bad.push(m.pid + ' d' + cs.depth + ' col' + cs.col + ': stack accounting is off');
        if (idx.length > ROWS) bad.push(m.pid + ' d' + cs.depth + ' col' + cs.col + ': ' + idx.length + ' cells > agentMaxRows=' + ROWS);
        for (let j = 0; j < idx.length; j++) {
          const i = idx[j], id = m.ks[i], nfo = info[id], r = rectById[id], cell = cells[id];
          if (!cell || !nfo) { bad.push(id + ': no cells entry'); continue; }
          if (m.rowOf(i) !== j) bad.push(id + ': the model row is not its position in the column');
          if (!r) { bad.push(id + ': no rendered rect'); continue; }
          if (!eq(cell.x, r.x, 0.001) || !eq(cell.y, r.y, 0.001)) bad.push(id + ': cells box (x,y) != card pos');
          if (!eq(nfo.cardTopInBox, 0, 0.001)) bad.push(id + ': card is inset ' + num(nfo.cardTopInBox) + 'px below its box top');
          // The slot rule: a monitor card is `agentMonitorH` tall even when its card measures
          // less, and the one card that measures MORE (the window the user has open) grows its
          // own slot. A cell that carries a turn child — a shape no live path builds — adds
          // that room, so its slot is only bounded from below.
          const own = Math.max(MON, nfo.measured);
          const turn = kidsOf(id).filter((c) => !isSide(c));
          if (!turn.length) {
            if (!eq(cell.h, own, 0.001)) bad.push(id + ': slot ' + num(cell.h) + ' != max(agentMonitorH ' + MON + ', measured ' + num(nfo.measured) + ')=' + num(own));
          } else if (cell.h < own - 0.001) {
            bad.push(id + ': slot ' + num(cell.h) + ' < the card own extent ' + num(own));
          }
          if (nfo.measured > cell.h + 0.001) bad.push(id + ': measured card ' + num(nfo.measured) + ' exceeds its own slot ' + num(cell.h));
        }
      }
    }
    run(spec.name, 'C4 row cap + slot rule + card in its slot', bad.length === 0, clip(bad, 4));
  }

  // ================================================================ C5
  {
    const bad = [], sibBad = [];
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        const ix = overX(a, b), iy = overY(a, b);
        if (ix > EPS && iy > EPS) {
          bad.push(a.id + '(' + a.kind + ') card [' + num(a.x) + ',' + num(a.x + a.w) + ']x[' + num(a.y) + ',' + num(a.y + a.h) + '] vs ' + b.id + '(' + b.kind + ') [' + num(b.x) + ',' + num(b.x + b.w) + ']x[' + num(b.y) + ',' + num(b.y + b.h) + '] overlap ' + num(ix) + 'x' + num(iy));
        }
      }
    }
    for (const m of models) {
      const bs = m.ks.map((k) => boxById[k]).filter(Boolean);
      for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
        const ix = overX(bs[i], bs[j]), iy = overY(bs[i], bs[j]);
        if (ix > EPS && iy > EPS) sibBad.push(m.pid + ' siblings ' + bs[i].id + ' vs ' + bs[j].id + ': box overlap ' + num(ix) + 'x' + num(iy));
      }
    }
    const det = [];
    if (bad.length) det.push(clip(bad, 3));
    if (sibBad.length) det.push('sibling box overlaps: ' + clip(sibBad, 3));
    run(spec.name, 'C5 no rendered card overlap', bad.length === 0 && sibBad.length === 0, det.join(' ; '));
  }

  // ================================================================ C6
  {
    const bad = [];
    for (const m of models) {
      const p = pos[m.pid], ps = size(m.pid);
      if (!p) { bad.push(m.pid + ': parent not positioned'); continue; }
      const rs = m.ks.map((k) => rectById[k]).filter(Boolean);
      const bs = m.ks.map((k) => boxById[k]).filter(Boolean);
      const blockLeft = p.x + ps.w + o.agentGap;
      // The reserved rectangle is the model's own: W columns wide (`m.W`) and `B` tall.
      const resX2 = blockLeft + m.W, resY2 = p.y + Math.max(ps.h, m.B);
      for (const r of rs) {
        if (r.x < blockLeft - 0.001 || r.x + r.w > resX2 + 0.001 || r.y < p.y - 0.001 || r.y + r.h > resY2 + 0.001) {
          bad.push(m.pid + ': card ' + r.id + ' [x ' + num(r.x) + '..' + num(r.x + r.w) + ', y ' + num(r.y) + '..' + num(r.y + r.h) + '] outside the reserved forest [' + num(blockLeft) + '..' + num(resX2) + ', ' + num(p.y) + '..' + num(resY2) + ']');
        }
      }
      for (const b of bs) {
        if (b.x < blockLeft - 0.001 || b.x + b.w > resX2 + 0.001 || b.y < p.y - 0.001 || b.y + b.h > resY2 + 0.001) {
          bad.push(m.pid + ': cell ' + b.id + ' [x ' + num(b.x) + '..' + num(b.x + b.w) + ', y ' + num(b.y) + '..' + num(b.y + b.h) + '] outside the reserved forest [' + num(blockLeft) + '..' + num(resX2) + ', ' + num(p.y) + '..' + num(resY2) + ']');
        }
      }
      // A column's cards share its x, and that x is the model's. The bands are ordered by
      // depth: a deeper band's first column starts right of the shallower band's last.
      for (const cs of m.colSizes) {
        const cur = bs.filter((b) => m.bandOf[m.index[b.id]] === cs.depth && m.colOf(m.index[b.id]) === cs.col);
        if (!cur.length) continue;
        if (!eq(cur[0].x, blockLeft + cs.x, 0.001)) bad.push(m.pid + ' d' + cs.depth + ' col' + cs.col + ': column x=' + num(cur[0].x) + ' want ' + num(blockLeft + cs.x));
        const xs = new Set(cur.map((b) => num(rectById[b.id].x)));
        if (xs.size > 1) bad.push(m.pid + ' d' + cs.depth + ' col' + cs.col + ': cards do not share x: ' + Array.from(xs).join(','));
      }
      // The family hop, which is the whole point of the per-column order: the windows a window
      // spawned stand in the columns DIRECTLY right of its own column (its own column's right
      // edge + `agentColGap`), so a connector crosses at most one sibling column to reach them.
      for (const cs of m.colSizes) {
        for (const id of cs.cells) {
          const kids = kidsOf(id).filter(isSide);
          if (!kids.length) continue;
          const kidCol = m.colSizes.filter((c2) => c2.cells.indexOf(kids[0]) >= 0)[0];
          if (!kidCol) { bad.push(m.pid + ': no column holds the windows of ' + id); continue; }
          if (!eq(kidCol.x, cs.x + cs.w + COLGAP, 0.001)) {
            bad.push(m.pid + ': the windows of ' + id + ' start at x=' + num(kidCol.x) + ' want its own column right edge + agentColGap=' + num(cs.x + cs.w + COLGAP));
          }
        }
      }
    }
    run(spec.name, 'C6 forest containment + band order + column x', bad.length === 0, clip(bad, 4));
  }

  // ================================================================ C7
  {
    const bad = [];
    for (const m of models) {
      const extra = Object.keys(cells).filter((id) => !sideIds.includes(id));
      if (extra.length) bad.push('cells has entries for non-sidecar ids: ' + clip(extra, 3));
      const missing = sideIds.filter((id) => !(id in cells));
      if (missing.length) bad.push('cells missing entries: ' + clip(missing, 3));
      for (let i = 0; i < m.n; i++) {
        const id = m.ks[i], e = cells[id];
        if (!e) { bad.push(id + ': no cells entry'); continue; }
        if (e.depth !== m.dep[i]) bad.push(id + ': cell.depth=' + e.depth + ' want its band ' + m.dep[i] + ' (i=' + i + ')');
        if (e.col !== m.colOf(i)) bad.push(id + ': cell.col=' + e.col + ' want its column inside that band ' + m.colOf(i) + ' (i=' + i + ')');
        if (e.row !== m.rowOf(i)) bad.push(id + ': cell.row=' + e.row + ' want its row inside that column ' + m.rowOf(i) + ' (i=' + i + ')');
        if (e.index !== m.idxInBand[i]) bad.push(id + ': cell.index=' + e.index + ' want its index inside the band ' + m.idxInBand[i]);
        if (e.count !== m.cntInBand[i]) bad.push(id + ': cell.count=' + e.count + ' want the band size ' + m.cntInBand[i]);
      }
      // The depth-1 cells are exactly the node's own sidecar children (the forest is grown
      // from them), and every deeper cell's spawner is a sidecar cell of the band before it.
      const d1 = m.ks.filter((k, i) => m.dep[i] === 1);
      const own = kidsOf(m.pid).filter(isSide);
      if (d1.length !== own.length || d1.some((k) => own.indexOf(k) < 0)) bad.push(m.pid + ': depth 1 is not exactly its sidecar children (' + d1.length + ' vs ' + own.length + ')');
    }
    run(spec.name, 'C7 band/column/row fields + depth-1 membership', bad.length === 0, clip(bad, 4));
  }

  // ================================================================ C8
  {
    const bad = [], soft = [];
    for (const m of models) {
      const p = pos[m.pid];
      if (!p) continue;
      for (let i = 0; i < m.n; i++) {
        const id = m.ks[i], e = cells[id], r = rectById[id];
        if (!e) { bad.push(id + ': no cells entry (no corridors)'); continue; }
        for (const key of ['busX', 'chanX', 'corrY']) {
          if (typeof e[key] !== 'number' || !isFinite(e[key])) bad.push(id + ': ' + key + '=' + String(e[key]));
        }
        for (const xk of ['busX', 'chanX']) {
          const X = e[xk];
          if (typeof X !== 'number') continue;
          const ySpan = xk === 'busX' ? [p.y, Math.max(p.y, e.corrY)] : [Math.min(p.y, r ? r.y : p.y), Math.max(p.y, r ? r.y : p.y)];
          for (const q of rects) {
            if (q.id === id) continue;
            if (X > q.x + EPS && X < q.x + q.w - EPS) {
              const yHit = overY({ x: X, y: ySpan[0], w: 0, h: ySpan[1] - ySpan[0] }, q) > EPS;
              const msg = id + ' ' + xk + '=' + num(X) + ' inside ' + q.id + '(' + q.kind + ') x-range [' + num(q.x) + ',' + num(q.x + q.w) + ']' + (yHit ? ' AND crosses it (y ' + num(q.y) + '..' + num(q.y + q.h) + ')' : ' (y-disjoint: benign)');
              (yHit ? bad : soft).push(msg);
            }
          }
        }
        const Y = e.corrY;
        if (typeof Y !== 'number') continue;
        const x1 = Math.min(e.busX, e.chanX), x2 = Math.max(e.busX, e.chanX);
        for (const q of rects) {
          if (q.id === id) continue;
          const xo = Math.min(x2, q.x + q.w) - Math.max(x1, q.x);
          if (xo > EPS && Y > q.y + EPS && Y < q.y + q.h - EPS) {
            bad.push(id + ' corrY=' + num(Y) + ' passes through ' + q.id + '(' + q.kind + ') y [' + num(q.y) + ',' + num(q.y + q.h) + '] over x-span [' + num(x1) + ',' + num(x2) + '] (overlap ' + num(xo) + 'px)');
          }
        }
      }
    }
    const det = [];
    if (bad.length) det.push(clip(bad, 3));
    if (soft.length) det.push('x-range-only (y-disjoint) notes: ' + clip(soft, 3));
    run(spec.name, 'C8 corridor sanity (busX/chanX/corrY card-free)', bad.length === 0, det.join(' ; '));
  }

  // ================================================================ C9
  // NO FEEDBACK. The layout's output depends only on the heights the webview measured:
  // a card is rendered at exactly its own measured height, so nothing is fed back and
  // the very same input must give the very same map and canvas on every pass. The old
  // model applied a `stretch` map as the next pass's measured heights and had to prove
  // that loop settled; there is no loop left to bound. See the header.
  const passes = [L1];
  {
    for (let k = 2; k <= C9_PASSES; k++) {
      let L;
      try { L = layoutTree(nodes, rootId, heights, spec.opts); } catch (e) { break; }
      passes.push(L);
    }
  }
  {
    const bad = [], notes = [];
    const canvasText = (L) => num(L.width) + 'x' + num(L.height);
    const canvasSeq = passes.map(canvasText);
    for (let k = 1; k < passes.length; k++) {
      const Ak = passes[k];
      if (!eq(Ak.width, L1.width, 1e-6) || !eq(Ak.height, L1.height, 1e-6)) {
        bad.push('pass ' + (k + 1) + ' canvas ' + canvasSeq[k] + ' but pass 1 had ' + canvasSeq[0] + ' — the layout must not depend on anything a pass produces');
      }
      const diffs = [];
      for (const id of Object.keys(pos)) {
        const a = pos[id], b = (Ak.pos || {})[id];
        if (!a || !b) { diffs.push(id + ': missing pos'); continue; }
        if (!eq(a.x, b.x, 1e-6) || !eq(a.y, b.y, 1e-6)) diffs.push(id + ' pos ' + num(a.x) + ',' + num(a.y) + ' -> ' + num(b.x) + ',' + num(b.y));
      }
      for (const id of Object.keys(cells)) {
        const a = cells[id], b = (Ak.cells || {})[id];
        if (!a || !b) { diffs.push(id + ': missing cells entry'); continue; }
        if (!eq(a.x, b.x, 1e-6) || !eq(a.y, b.y, 1e-6) || !eq(a.corrY, b.corrY, 1e-6) || a.col !== b.col || a.row !== b.row) {
          diffs.push(id + ' cell ' + num(a.y) + '/' + num(a.corrY) + '/col' + a.col + ' -> ' + num(b.y) + '/' + num(b.corrY) + '/col' + b.col);
        }
      }
      if (diffs.length) bad.push('pass ' + (k + 1) + ' differs from pass 1: ' + clip(diffs, 5));
    }
    notes.push('canvas ' + canvasSeq.join(' = ') + ' over ' + passes.length + ' passes on the same measured heights');
    run(spec.name, 'C9 no feedback: same heights, same output', bad.length === 0, bad.concat(notes).join(' ; '));
  }

  // ================================================================ C10
  {
    const bad = [];
    for (const id of sideIds) {
      const c = cells[id], nfo = info[id];
      if (!c || !nfo) { bad.push(id + ': no cells entry'); continue; }
      // The slot is the card's OWN height — a monitor's `agentMonitorH`, or the measured
      // height of the one card the user has open — and never another cell's forest: that is
      // the whole point of the depth bands, so a cell whose node owns a forest must not
      // reserve it.
      const own = Math.max(MON, nfo.measured);
      if (c.h < own - 0.001) bad.push(id + ': slot ' + num(c.h) + ' < its own card extent max(agentMonitorH ' + MON + ', measured ' + num(nfo.measured) + ')=' + num(own));
    }
    // The redesign's point, proved directly: a node's turn child starts at
    // `parent.y + max(parentCardHeight, B) + vGap` — a bounded forest pushes it no further.
    for (const m of models) {
      const p = pos[m.pid];
      if (!p) continue;
      const turns = kidsOf(m.pid).filter((c) => !isSide(c) && pos[c]);
      if (!turns.length) continue;
      const height = Math.max(size(m.pid).h, m.B);
      if (!eq(pos[turns[0]].y, p.y + height + o.vGap, 0.001)) {
        bad.push(m.pid + ': its turn child starts at +' + num(pos[turns[0]].y - p.y) + ' want max(card ' + size(m.pid).h + ', B ' + num(m.B) + ') + vGap = ' + num(height + o.vGap));
      }
    }
    run(spec.name, 'C10 slot accounting + bounded block cost', bad.length === 0, clip(bad, 4));
  }

  // ================================================================ R0 (clamp retired)
  {
    const bad = [];
    if ('stretch' in L1) bad.push('the result still carries a `stretch` key');
    for (const id of sideIds) {
      const c = cells[id], nfo = info[id];
      if (!c || !nfo) continue;
      if (nfo.measured > c.h + 0.001) bad.push(id + ': measured card ' + num(nfo.measured) + ' > its own box ' + num(c.h));
    }
    run(spec.name, 'R0 retired clamp: no card taller than its box', bad.length === 0,
      bad.length ? clip(bad, 4) : 'all ' + sideIds.length + ' sidecar cards fit inside their own boxes');
  }

  return { L1, models, info, rects, boxes, cells, pos, o, passes };
}

// ---------------------------------------------------------------- C11: the webview half
/** Text of a function body: from the `{` after `sigIndex` to its matching `}`. */
function bodyOf(text, sigIndex) {
  const open = text.indexOf('{', sigIndex);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') { i = text.indexOf('\n', i); if (i < 0) break; continue; }
    if (ch === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); if (e < 0) break; i = e + 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === quote) break;
        i++;
      }
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(open + 1, i); }
  }
  return text.slice(open + 1);
}

/**
 * C11 — the same contract, webview side, read as text (the only file this guard reads
 * besides `media/tree.js`): `relayout()` must MEASURE the cards and must never write a
 * rendered height back onto one. A forced height is what a feedback loop needs, and the
 * unstretched lattice has no loop: a card is rendered at the height it measured, and the
 * only inline size a card may carry is one the user's own drag-resize wrote (never in
 * `relayout()`). It must also pass `agentMaxRows` — the row cap is the option the forest
 * packing reads.
 */
function webviewWiring() {
  const where = 'media/main.js relayout()';
  if (!fs.existsSync(MAIN_PATH)) return { ok: false, detail: 'media/main.js is missing (' + MAIN_PATH + ')' };
  const text = fs.readFileSync(MAIN_PATH, 'utf8');
  const at = text.indexOf('function relayout(');
  if (at < 0) return { ok: false, detail: 'no `function relayout(` in media/main.js — look at ' + where };
  const body = bodyOf(text, at);
  if (!body.trim()) return { ok: false, detail: 'could not read the body of relayout() — look at ' + where };

  // The measuring step: the statement that takes the cards' heights from the DOM.
  const measure = /heights\s*\[[^\]]*\]\s*=\s*card\s*\.\s*offsetHeight/.exec(body) || /offsetHeight/.exec(body);
  if (!measure) {
    return { ok: false, detail: 'relayout() never measures the cards (`card.offsetHeight`) — look at ' + where };
  }

  // Nothing may write a height back: that is the feedback loop the old model had.
  const banned = [
    ['clearStretchHeights()', /clearStretchHeights/],
    ['`layoutStretch`', /layoutStretch/],
    ['`result.stretch`', /result\s*\.\s*stretch/],
    ['an inline `card.style.height` write', /card\s*\.\s*style\s*\.\s*height\s*=/],
    ['an inline `card.style.maxHeight` write', /card\s*\.\s*style\s*\.\s*maxHeight\s*=/],
  ];
  for (const [label, re] of banned) {
    if (re.test(body)) {
      return { ok: false, detail: 'relayout() still contains ' + label + ' — a card is rendered at the height it measured, so the layout pass must not write a height back (that is the loop that used to creep every frame) (' + where + ')' };
    }
  }

  const from = /agentMaxRows\s*:/.exec(body);
  if (!from) {
    return { ok: false, detail: 'relayout() does not pass `agentMaxRows` to the layout — the row cap is the option the forest packing reads (' + where + ')' };
  }
  if (!/window\s*\.\s*treeLayout\s*\.\s*layoutTree\s*\(/.exec(body)) {
    return { ok: false, detail: 'relayout() never calls `window.treeLayout.layoutTree(...)` — look at ' + where };
  }
  return {
    ok: true,
    detail: 'relayout() measures `card.offsetHeight`, passes `agentMaxRows`, and writes no inline height/max-height (no feedback loop)',
  };
}

// ---------------------------------------------------------------- main
function main() {
  console.log('check-tree-grid: Chat Tree sidecar lattice geometry + webview wiring');
  console.log('  tree.js : ' + TREE_PATH);
  console.log('  engine  : ' + VENDOR_PATH);

  let layoutTree;
  try {
    layoutTree = load(TREE_PATH, VENDOR_PATH);
  } catch (e) {
    console.log('');
    console.log('FAIL check-tree-grid: could not load the layout (' + e.message + ')');
    process.exit(1);
  }
  if (TREE_PATH.indexOf(ROOT) === 0) {
    const st = fs.statSync(TREE_PATH);
    const md5 = crypto.createHash('md5').update(fs.readFileSync(TREE_PATH)).digest('hex');
    console.log('            size ' + st.size + '  md5 ' + md5);
  } else {
    console.log('            (outside the repo: a mutation-test copy)');
  }

  // probe: the return shape is the whole contract with the webview
  let probe = null, probeErr = '';
  try {
    probe = layoutTree({ r: { id: 'r', children: ['a'], kind: 'turn' }, a: { id: 'a', children: [], kind: 'agent' } }, 'r', { r: 330, a: 330 }, {});
  } catch (e) { probeErr = e.message; }
  if (probeErr) failedLine('probe layoutTree returns {pos, cells, width, height}', 'threw: ' + probeErr);
  else {
    const keys = Object.keys(probe).sort().join(',');
    if (keys !== 'cells,height,pos,width') failedLine('probe layoutTree returns {pos, cells, width, height}', 'keys: ' + keys);
    else note('probe layoutTree returns {pos, cells, width, height}', 'canvas ' + probe.width + 'x' + probe.height + ', a.col=' + probe.cells.a.col);
  }

  const specs = allSpecs();
  const runs = {};
  for (const s of specs) runs[s.name] = verifySpec(s, layoutTree, run);

  // ---- per spec
  console.log('');
  console.log('-- per spec --');
  let sideCells = 0, specRows = 0;
  for (const s of specs) {
    const rs = rows.filter((r) => r.spec === s.name);
    specRows += rs.length;
    const failed = rs.filter((r) => !r.ok);
    const res = runs[s.name];
    const nCells = res ? Object.keys(res.info).length : 0;
    sideCells += nCells;
    const label = s.name + ': ' + (rs.length - failed.length) + '/' + rs.length + ' checks  (sidecar cells ' + nCells + ')';
    if (failed.length) failedLine(label);
    else note(label);
    for (const r of failed) console.log('         · ' + r.check + ': ' + r.detail);
  }

  // ---- R1 REAL golden numbers (re-baselined for the DEPTH-BAND forest: 3 rows per column,
  // every card the fixture's uniform 330px, so every number below is arithmetic)
  const res = runs[REAL.name];
  const golden = { canvas: null, colTops: null, a4Box: null, cY: null };
  {
    const bad = [];
    const R = 'mu2zp7px3zsegz', C = 'mu2zyi167efltd', A4 = 'mu2zprz19fpyip';
    const A = ['mu2zprz144bbh4', 'mu2zprz1szfyo6', 'mu2zprz1p3hrno', 'mu2zprz15gtrk6'];
    const D = ['mu3004pl0l971r', 'mu3004plsxfe8v', 'mu3004plyzeigu', 'mu3004plitr2cy',
               'mu3004plwd32s8', 'mu3004plte1wr1', 'mu3004pli6b76o', 'mu3004plyhs83j'];
    const Bk = ['mu2zquika60bv5', 'mu2zquikoxkhr4', 'mu2zquikm30yqw'];
    const mR = res.models.find((m) => m.pid === R), mC = res.models.find((m) => m.pid === C), mB = res.models.find((m) => m.pid === A4);
    const want = (label, got, wantV) => { if (!eq(got, wantV, 0.001)) bad.push(label + ' = ' + num(got) + ' want ' + num(wantV)); };
    // These numbers follow from arithmetic, not from a run. Every card is 330 tall, so a
    // leaf cell's slot is `max(agentMonitorH 200, 330) = 330`, and a column takes up to 3 of
    // them: the root's 5 agent children fill two columns of 3 + 2 — 16 + 3*330 + 2*24 = 1054
    // and 16 + 2*330 + 1*24 = 700 — and A[4]'s own 3 windows, because A[4] is a cell and not a
    // box, occupy their OWN band one column further right (another 1054, so the root's B is
    // still 1054 and nothing about A[4] grew any cell). C (the turn child) therefore lands at
    // max(330, 1054) + vGap(72) = 1126. C's own 8 agent children fill three columns of
    // 3 + 3 + 2 (1054 / 1054 / 700), so C's B is 1054 as well, and the canvas is
    // card(320) + agentGap(80) + W(1056) wide and 1126 + 1054 tall, plus the layout's pad.
    want('canvas.width', res.L1.width, 1496);
    want('canvas.height', res.L1.height, 2220);
    want('R forest columns (2 for depth 1, 1 for depth 2)', mR.nCols, 3);
    want('R forest B (bounded: 3 rows, not the subtree)', mR.B, 1054);
    want('R forest S[0] (depth 1 col 0: three 330 cells)', mR.S[0], 1054);
    want('R forest S[1] (depth 1 col 1: two 330 cells)', mR.S[1], 700);
    want('R forest S[2] (depth 2 col 0: A[4]\'s three windows)', mR.S[2], 1054);
    A.forEach((id, i) => {
      want('A[' + i + '] cardTop', res.cells[id].y - res.pos[R].y, 16 + (i % 3) * (330 + 24));
      want('A[' + i + '] col (3 cells per column)', res.cells[id].col, Math.floor(i / 3));
      want('A[' + i + '] depth', res.cells[id].depth, 1);
      want('A[' + i + '] slot (cells.h)', res.cells[id].h, 330);
    });
    want('A[4] col (still depth 1, second column of it)', res.cells[A4].col, 1);
    want('A[4] cardTop', res.cells[A4].y - res.pos[R].y, 16 + (330 + 24));
    // A[4] owns a forest of its own, and its own slot does NOT grow for it: that forest is
    // the root's depth-2 band.
    want('A[4] slot (cells.h, its forest is NOT in here)', res.cells[A4].h, 330);
    want('C y (rel R)', res.pos[C].y - res.pos[R].y, 1126);
    // A[4] is a CELL, not a forest owner: its own 3 windows are the ROOT's depth-2 band, so
    // there is no model for A[4] at all — that absence IS the redesign, because nothing about
    // A[4] reserves the windows it spawned.
    want('models built for the sidecar A[4] (must be none)', mB ? 1 : 0, 0);
    Bk.forEach((id, i) => {
      // A[4]'s windows are the ROOT's depth-2 cells: their y is measured from the root, and
      // they start at the band's own top pad, not below A[4].
      want('A[4] window cardTop[' + i + ']', res.cells[id].y - res.pos[R].y, 16 + i * (330 + 24));
      want('A[4] window col[' + i + ']', res.cells[id].col, 0);
      want('A[4] window depth[' + i + ']', res.cells[id].depth, 2);
    });
    want("C's forest columns (8 windows, 3 per column)", mC.nCols, 3);
    want("C's forest B", mC.B, 1054);
    D.forEach((id, i) => {
      const col = Math.floor(i / 3), row = i % 3;
      want('C window col[' + i + ']', res.cells[id].col, col);
      want('C window depth[' + i + ']', res.cells[id].depth, 1);
      want('C window cardTop[' + i + ']', res.cells[id].y - res.pos[C].y, 16 + row * (330 + 24));
    });
    let inset = 0;
    for (const id in res.cells) {
      if (!eq(res.cells[id].x, res.pos[id].x, 0.001) || !eq(res.cells[id].y, res.pos[id].y, 0.001)) inset++;
    }
    if (inset) bad.push(inset + ' cells have cells.(x,y) != pos (card inset in its box)');
    if ('stretch' in res.L1) bad.push('the REAL layout still returns a `stretch` map');
    golden.canvas = num(res.L1.width) + 'x' + num(res.L1.height);
    golden.colTops = A.map((id) => num(res.cells[id].y - res.pos[R].y)).join('/');
    golden.a4Box = num(res.cells[A4].h);
    golden.cY = num(res.pos[C].y - res.pos[R].y);
    run(REAL.name, 'R1 REAL golden numbers', bad.length === 0,
      bad.length ? bad.join(' ; ') : 'canvas ' + golden.canvas + ', R grid B=' + num(mR.B) + ' S=[' + mR.S.map(num).join(',') + '], col0 card tops ' + golden.colTops +
        ', A[4] box ' + golden.a4Box + ', C y=' + golden.cY + ', every cells.(x,y) == pos, no `stretch` key');
  }

  // ---- C11
  const wiring = webviewWiring();
  run('media/main.js', 'C11 relayout(): measure, no forced height, budget passed', wiring.ok, wiring.detail);

  // ---- per check verdict
  console.log('');
  console.log('-- per check --');
  const checks = [];
  for (const r of rows) if (!checks.includes(r.check)) checks.push(r.check);
  checks.sort();
  for (const c of checks) {
    const rs = rows.filter((r) => r.check === c);
    const failed = rs.filter((r) => !r.ok);
    const label = c + ': ' + (failed.length ? failed.length + '/' + rs.length + ' specs fail [' + clip(failed.map((r) => r.spec), 4) + ']' : rs.length + '/' + rs.length + ' specs');
    if (failed.length) failedLine(label);
    else note(label);
  }
  // per-spec lines already printed; repeat only the failures in one place
  const fails = rows.filter((r) => !r.ok);
  if (fails.length) {
    console.log('');
    console.log('-- failures --');
    for (const r of fails) console.log('   · ' + r.spec + ' · ' + r.check + '\n       ' + r.detail);
  }

  const totalChecks = rows.length;
  const passCount = totalChecks - fails.length;
  console.log('');
  console.log('summary : ' + specs.length + ' specs · ' + totalChecks + ' check-instances (' + passCount + ' pass) · ' +
    sideCells + ' sidecar cells');
  console.log('golden  : ' + REAL.name + ' — canvas ' + golden.canvas + ' · col0 card tops ' + golden.colTops +
    ' · A[4] box ' + golden.a4Box + ' · C y=' + golden.cY);
  console.log('');

  if (fails.length) {
    const first = fails[0];
    console.log('FAIL check-tree-grid: ' + fails.length + '/' + totalChecks + ' checks failed — first: ' + first.spec + ' · ' + first.check + ': ' + first.detail);
    process.exit(1);
  }
  console.log('PASS check-tree-grid: ' + specs.length + ' specs, ' + totalChecks + '/' + totalChecks + ' checks, ' + sideCells +
    ' sidecar cells — REAL canvas ' + golden.canvas + ', col0 card tops ' + golden.colTops +
    ', A[4] box ' + golden.a4Box + ', C y=' + golden.cY);
  process.exit(0);
}

try {
  main();
} catch (e) {
  console.log('');
  console.log('FAIL check-tree-grid: harness error — ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)));
  process.exit(1);
}
