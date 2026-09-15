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
 *   C1  column slot sums (agentTopPad + Σ slotH + gaps == B) + every column's slot
 *       stack ends flush at parentY + B + every cell's box top equals its slot-stack
 *       top (the layout really uses the model's slot stack, not some other line)
 *   C2  the RENDERED gap between two stacked cards is agentVGap — or agentVGap plus
 *       the slot space the card above left empty (the documented exception)
 *   C3  `stretch` covers exactly the sidecar cells (never a turn node), is >= the
 *       measured height, == the slot height in-domain, == the card's own extent in
 *       the exception
 *   C4  per-cell stretch rule: max(measured, room) with room = slotH in-domain or
 *       ownH in the exception; the box (x,y) is the card's (x,y); the rendered card
 *       covers its own sub-grid's boxes
 *   C5  no two RENDERED card rects overlap (sidecars at their stretch, turn nodes at
 *       their measured height) and no two sibling boxes overlap
 *   C6  every card/box stays inside the parent's reserved block, the column gap is
 *       agentColGap and the grid's left edge is parent card right + agentGap
 *   C7  <= agentMaxRows cells per column, col == floor(i/R), row == i%R, and the
 *       index/count fields match the child order
 *   C8  routing corridors: `busX`/`chanX` are numbers and never sit inside *and*
 *       across a foreign card, `corrY` never crosses a rendered card
 *   C9  the height feedback loop is stable (see "C9" below)
 *   C10 box accounting: `cells[id].h` == an independently rebuilt subtree bbox and
 *       the cell's classification (`tail`) matches the documented rule
 *   R0  no-op regression: no cell of a REACHABLE spec has `tail > 0`, i.e. the
 *       documented exception can never fire on a shape the app can build
 *   R1  the REAL session's golden numbers (canvas, per-grid B/S, card tops, stretches,
 *       the C card's y, no card inset in its box)
 *   C11 the webview half of the same contract, read as text from `media/main.js`:
 *       `relayout()` calls `clearStretchHeights()` BEFORE it measures the cards and
 *       applies `result.stretch` AFTER, setting both `style.height` and
 *       `style.maxHeight`. That clear-measure-apply order is what keeps the measured
 *       heights natural — the one way this layout can creep every frame.
 *
 * C9 (the two stability criteria, and why they differ)
 * The layout is a feedback loop: `stretch` feeds the webview's rendered heights, and
 * the webview hands those back in as the next pass's measured heights.
 *   - In-domain (no cell with `tail > 0`): the loop must be the STRICT one-pass
 *     fixpoint — feeding the `stretch` map back in must immediately reproduce the very
 *     same map (and the same canvas). Every reachable shape has this property.
 *   - Exception shapes (some cell has `tail > 0`, i.e. material below the card's own
 *     extent, which only a turn child under a sidecar produces): the loop is a
 *     CONTRACTING sequence that reaches a fixed point after a few passes — applying a
 *     clamped card height changes that cell's own extent, which re-opens the even-fill
 *     share for the cells that are in-domain — e.g. 632 -> 708 -> 727 -> 732 -> 733 ->
 *     734 -> 734 on a canvas that never moves (1128x3056). So for those shapes the
 *     honest criterion is: the map stops changing within a small pass cap (8 here —
 *     the measured sequence settles at pass 7) and the canvas (`width`/`height`) is
 *     invariant across every pass. Only a map that never settles within the cap, or a
 *     canvas that moves, is a failure.
 * Both exception specimens (`X-nest3`, `X-stretch-over-turnchild`) are
 * UNREACHABLE IN PRODUCTION and are kept only so the documented clamp stays covered:
 * `attachNode` (`src/chat/tree.ts`) appends a sidecar to its parent's `children` and
 * never under a sidecar, and the runtime refuses a sidecar as a continuation/rollover
 * target (`continueFrom` / `canRollover` / `rolloverContext`, `src/chat/runtime.ts`:
 * `if (!node || isSidecar(node)) return false`). R0/R1 prove the clamp is a no-op for
 * every reachable shape.
 *
 * HOW: loads the vendored tidy-tree engine and `media/tree.js` into node's `vm` with
 * `window = ctx` (a sidecar-grid spec is a plain node map, so no DOM is needed), then
 * re-derives each grid's model — column slots, even-fill shares, subtree boxes — from
 * what the layout itself returned and cross-checks it. Deterministic, no browser, no
 * dependencies; every path is resolved from `__dirname` (repo root = `path.join(__dirname, '..')`).
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
  agentGap: 80, agentVGap: 24, agentColGap: 48, agentMaxRows: 4, agentTopPad: 16,
};
/** Pass cap for the exception feedback loop (the measured sequence settles at 7). */
const C9_PASS_CAP = 8;
/** Passes run for in-domain specs (the harness's four; the assertion needs two). */
const C9_IN_DOMAIN_PASSES = 4;

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
  // EXCEPTION specimen A: turn child under an agent (unreachable today)
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
  // EXCEPTION specimen B: shallow column whose cell owns a turn child
  out.push(buildSpec('X-stretch-over-turnchild (a0 turn child, a4 huge card, unreachable)', [
    { id: 'r', kind: 'turn' },
    { id: 'a0', kind: 'agent', parent: 'r' }, { id: 'a1', kind: 'agent', parent: 'r' },
    { id: 'a2', kind: 'agent', parent: 'r' }, { id: 'a3', kind: 'agent', parent: 'r' },
    { id: 'a4', kind: 'agent', parent: 'r' },
    { id: 't0', kind: 'turn', parent: 'a0' },
  ], { a4: 3000 }));
  out.push(REAL);
  return out;
}

// ---------------------------------------------------------------- helpers
const num = (v) => (typeof v === 'number' && isFinite(v)) ? String(Math.round(v * 1000) / 1000) : String(v);
const eq = (a, b, eps) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= (eps == null ? 1e-6 : eps);
const overX = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
const overY = (a, b) => Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
const clip = (arr, k) => arr.length <= k ? arr.join(' ; ') : arr.slice(0, k).join(' ; ') + ' ; ...(+' + (arr.length - k) + ' more)';
const mapOf = (layout) => (layout && layout.stretch && typeof layout.stretch === 'object') ? layout.stretch : null;
const mapDiff = (a, b, ids) => {
  const out = [];
  for (const id of ids) {
    const x = a ? a[id] : undefined, y = b ? b[id] : undefined;
    if (x == null || y == null) { out.push(id + ': ' + num(x) + ' -> ' + num(y)); continue; }
    if (Math.abs(y - x) > 0.001) out.push(id + ': ' + num(x) + ' -> ' + num(y) + ' (delta ' + num(y - x) + ')');
  }
  return out;
};

// ---------------------------------------------------------------- one spec: C1..C10, R0
function verifySpec(spec, layoutTree, run) {
  const o = Object.assign({}, DEF, spec.opts || {});
  const nodes = spec.nodes, rootId = spec.rootId, heights = spec.heights;
  const R = Math.max(1, o.agentMaxRows | 0), GAP = o.agentVGap, TPAD = o.agentTopPad, COLGAP = o.agentColGap;
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
  const stretch = mapOf(L1);

  // ---- grids + model (extent = the layout's own cells.h)
  const grids = [];
  for (const pid of Object.keys(nodes)) {
    const ks = kidsOf(pid).filter(isSide);
    if (ks.length) grids.push({ pid, ks });
  }
  const models = grids.map((g) => {
    const n = g.ks.length, nCols = Math.ceil(n / R);
    const colOf = (i) => Math.floor(i / R), rowOf = (i) => i % R;
    const ext = g.ks.map((k) => (cells[k] ? cells[k].h : NaN));
    const S = [];
    for (let c = 0; c < nCols; c++) {
      let cnt = 0, sum = 0;
      for (let i = 0; i < n; i++) if (colOf(i) === c) { cnt++; sum += ext[i]; }
      S.push(TPAD + sum + (cnt - 1) * GAP);
    }
    const B = Math.max.apply(null, S);
    const share = new Array(n).fill(0);
    for (let c = 0; c < nCols; c++) {
      let cnt = 0;
      for (let i = 0; i < n; i++) if (colOf(i) === c) cnt++;
      const Lc = B - S[c], q = Math.floor(Lc / cnt), rem = Lc % cnt;
      for (let i = 0; i < n; i++) if (colOf(i) === c) share[i] = q + (rowOf(i) < rem ? 1 : 0);
    }
    const slotH = g.ks.map((k, i) => ext[i] + share[i]);
    const top = [];
    for (let i = 0; i < n; i++) {
      let y = TPAD;
      for (let j = 0; j < i; j++) if (colOf(j) === colOf(i)) y += slotH[j] + GAP;
      top.push(y);
    }
    const model = { pid: g.pid, ks: g.ks, n, nCols, colOf, rowOf, ext, S, B, share, slotH, top };
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

  // ---- RENDERED CARD rects (sidecar: card pos, measured width, height = stretch)
  const rects = [], boxes = [];
  for (const id of Object.keys(nodes)) {
    if (!pos[id]) continue;
    const s = size(id);
    if (isSide(id)) {
      const c = cells[id];
      const h = (stretch && stretch[id] != null) ? stretch[id] : s.h;
      rects.push({
        id, kind: nodes[id].kind, sidecar: true, x: pos[id].x, y: pos[id].y, w: s.w, h,
        boxH: c ? c.h : NaN, stretch: stretch ? stretch[id] : undefined,
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
      const ownBlock = modelOf[id] ? modelOf[id].B : 0;
      const ownH = Math.max(measured, ownBlock);
      const cardTopInBox = (c && p) ? (p.y - c.y) : 0;
      const box = boxOf(id);
      const tail = c ? (c.h - (cardTopInBox + ownH)) : NaN;
      const room = tail > EPS ? (ownH - cardTopInBox) : m.slotH[i];
      info[id] = {
        parent: m.pid, i, col: m.colOf(i), row: m.rowOf(i),
        measured, ownBlock, ownH, cardTopInBox, box, tail,
        ext: m.ext[i], share: m.share[i], slotH: m.slotH[i],
        room, expectedStretch: Math.max(measured, room),
        domain: tail > EPS ? 'exception' : 'in-domain',
      };
    }
  }
  const excIds = sideIds.filter((id) => info[id] && info[id].domain === 'exception');
  const specHasException = excIds.length > 0;

  // ================================================================ C1
  {
    const bad = [];
    if (!stretch) bad.push('layoutTree returned no `stretch` map (typeof=' + typeof L1.stretch + ')');
    for (const m of models) {
      const py = pos[m.pid] ? pos[m.pid].y : NaN;
      const bots = [];
      for (let c = 0; c < m.nCols; c++) {
        const idx = [];
        for (let i = 0; i < m.n; i++) if (m.colOf(i) === c) idx.push(i);
        let sumSlot = 0;
        for (const i of idx) sumSlot += m.slotH[i];
        const lhs = TPAD + sumSlot + (idx.length - 1) * GAP;
        if (!eq(lhs, m.B, 0.001)) bad.push(m.pid + ' col' + c + ': topPad+sum(slotH)+gaps=' + num(lhs) + ' vs B=' + num(m.B) + ' (delta ' + num(lhs - m.B) + ')');
        // slot-stack flush bottom + cell top from the slot stack
        for (const i of idx) {
          const id = m.ks[i], c2 = cells[id];
          if (!c2) { bad.push(id + ': no cells entry'); continue; }
          if (!eq(c2.y - py, m.top[i], 0.001)) bad.push(id + ' col' + c + ' row' + m.rowOf(i) + ': box top=' + num(c2.y - py) + ' want slot-stack top ' + num(m.top[i]) + ' (delta ' + num(c2.y - py - m.top[i]) + ')');
        }
        const lastI = idx[idx.length - 1], last = cells[m.ks[lastI]];
        const slotBottom = last.y + m.slotH[lastI];
        bots.push(num(slotBottom - py));
        if (!eq(slotBottom - py, m.B, 0.001)) bad.push(m.pid + ' col' + c + ': SLOT bottom=' + num(slotBottom - py) + ' vs parentY+B=' + num(m.B) + ' (delta ' + num(slotBottom - py - m.B) + ')');
      }
      if (new Set(bots).size > 1) bad.push(m.pid + ' columns end at different slot lines: [' + bots.join(', ') + ']');
    }
    if (!models.length) bad.push('no grid found in spec (spec problem)');
    run(spec.name, 'C1 column slot sums + slot-flush bottom', bad.length === 0, bad.join(' ; '));
  }

  // ================================================================ C2
  {
    const bad = [];
    if (!stretch) bad.push('no `stretch` map: cannot measure the gap between RENDERED card rects');
    for (const m of models) {
      for (let c = 0; c < m.nCols; c++) {
        const idx = [];
        for (let i = 0; i < m.n; i++) if (m.colOf(i) === c) idx.push(i);
        for (let k = 1; k < idx.length; k++) {
          const i0 = idx[k - 1], i1 = idx[k];
          const p = rectById[m.ks[i0]], q = rectById[m.ks[i1]];
          if (!p || !q) continue;
          const gap = q.y - (p.y + p.h);
          const spare = m.slotH[i0] - p.h;                 // slot space the card left empty
          const want = GAP + Math.max(0, spare);
          if (!eq(gap, want, 0.001)) {
            const dom = info[m.ks[i0]] ? info[m.ks[i0]].domain : '?';
            bad.push(m.pid + ' col' + c + ' row' + (k - 1) + '->' + k + ': rendered gap=' + num(gap) + ' want ' + num(want) + ' (agentVGap ' + num(GAP) + ' + slot spare ' + num(spare) + '; cell ' + m.ks[i0] + ' is ' + dom + ')');
          }
        }
      }
    }
    run(spec.name, 'C2 rendered gap == agentVGap(+slot spare)', bad.length === 0, clip(bad, 4));
  }

  // ================================================================ C3
  {
    const bad = [];
    if (!stretch) bad.push('no `stretch` map at all');
    else {
      const missing = sideIds.filter((id) => !(id in stretch));
      const extra = Object.keys(stretch).filter((id) => !nodes[id] || !isSide(id));
      if (missing.length) bad.push('missing entries for ' + missing.length + ' sidecar cells: ' + clip(missing, 4));
      if (extra.length) bad.push('entries for non-sidecar ids (turn nodes!): ' + clip(extra, 4));
      const low = [];
      for (const id of sideIds) {
        if (!(id in stretch)) continue;
        const nfo = info[id];
        if (stretch[id] < size(id).h - 1e-6) low.push(id + ': stretch=' + num(stretch[id]) + ' < measuredH=' + num(size(id).h));
        else if (nfo && nfo.domain === 'in-domain' && stretch[id] < cells[id].h - 1e-6) low.push(id + ': stretch=' + num(stretch[id]) + ' < own subtree box=' + num(cells[id].h) + ' (in-domain cell must cover its box)');
        else if (nfo && nfo.domain === 'exception' && stretch[id] < nfo.ownH - 1e-6) low.push(id + ': stretch=' + num(stretch[id]) + ' < ownH=' + num(nfo.ownH) + ' (exception must still cover the card extent)');
      }
      if (low.length) bad.push(clip(low, 4));
    }
    run(spec.name, 'C3 stretch coverage + values', bad.length === 0, bad.join(' ; '));
  }

  // ================================================================ C4
  {
    const bad = [];
    if (!stretch) bad.push('no `stretch` map: the stretch rule cannot be checked');
    else {
      for (const id of Object.keys(info)) {
        const nfo = info[id], c = cells[id], r = rectById[id];
        if (!c || !r) { bad.push(id + ': no cells entry'); continue; }
        if (!eq(stretch[id], nfo.expectedStretch, 0.001)) {
          bad.push(id + ' [' + nfo.domain + ']: stretch=' + num(stretch[id]) + ' want max(measured ' + num(nfo.measured) + ', room ' + num(nfo.room) + ')=' + num(nfo.expectedStretch) +
            '  (extent=' + num(nfo.ext) + ' share=' + num(nfo.share) + ' slotH=' + num(nfo.slotH) + ' ownBlock=' + num(nfo.ownBlock) + ' ownH=' + num(nfo.ownH) + ' tail=' + num(nfo.tail) + ')');
        }
        if (!eq(c.y, r.y, 0.001) || !eq(c.x, r.x, 0.001)) bad.push(id + ': cells box (x,y) != card pos (box ' + num(c.x) + ',' + num(c.y) + ' vs card ' + num(r.x) + ',' + num(r.y) + ')');
        if (!eq(nfo.cardTopInBox, 0, 0.001)) bad.push(id + ': card is inset ' + num(nfo.cardTopInBox) + 'px below its box top (the rule assumes 0)');
        if (nfo.domain === 'exception' && stretch[id] > nfo.slotH + 0.001) bad.push(id + ': exception card ' + num(stretch[id]) + ' exceeds its slot ' + num(nfo.slotH));
        // its own sub-grid: the rendered card must reach that grid's boxes
        const own = kidsOf(id).filter(isSide).map((k) => boxById[k]).filter(Boolean);
        if (own.length) {
          const ownBottom = Math.max.apply(null, own.map((k) => k.y + k.h));
          if (r.y + stretch[id] < ownBottom - 0.001) {
            bad.push(id + ': card bottom ' + num(r.y + stretch[id]) + ' short of its own sub-grid box bottom ' + num(ownBottom) + ' (by ' + num(ownBottom - r.y - stretch[id]) + ')');
          }
        }
      }
    }
    run(spec.name, 'C4 per-cell stretch rule + card covers own grid', bad.length === 0, clip(bad, 3));
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
    if (stretch) {
      for (const m of models) {
        const bs = m.ks.map((k) => boxById[k]).filter(Boolean).map((b) => ({ id: b.id, x: b.x, y: b.y, w: b.w, h: Math.max(b.h, stretch[b.id] != null ? stretch[b.id] : b.h) }));
        for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
          const ix = overX(bs[i], bs[j]), iy = overY(bs[i], bs[j]);
          if (ix > EPS && iy > EPS) sibBad.push(m.pid + ' siblings ' + bs[i].id + ' vs ' + bs[j].id + ': box overlap ' + num(ix) + 'x' + num(iy));
        }
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
      const minLeft = Math.min.apply(null, bs.map((r) => r.x));
      const maxRight = Math.max.apply(null, bs.map((r) => r.x + r.w));
      const blockLeft = p.x + ps.w + o.agentGap;
      if (!eq(minLeft, blockLeft, 0.001)) bad.push(m.pid + ': grid left edge=' + num(minLeft) + ' want parentCardRight+agentGap=' + num(blockLeft) + ' (delta ' + num(minLeft - blockLeft) + ')');
      const blockW = maxRight - minLeft;
      const resX2 = p.x + ps.w + o.agentGap + blockW, resY2 = p.y + Math.max(ps.h, m.B);
      for (const r of rs) {
        const h = (stretch && stretch[r.id] != null) ? stretch[r.id] : r.h;
        if (r.x < p.x - 0.001 || r.x + r.w > resX2 + 0.001 || r.y < p.y - 0.001 || r.y + h > resY2 + 0.001) {
          bad.push(m.pid + ': card ' + r.id + ' [x ' + num(r.x) + '..' + num(r.x + r.w) + ', y ' + num(r.y) + '..' + num(r.y + h) + '] outside reserved block [' + num(p.x) + '..' + num(resX2) + ', ' + num(p.y) + '..' + num(resY2) + ']');
        }
      }
      for (const b of bs) {
        if (b.x < p.x - 0.001 || b.x + b.w > resX2 + 0.001 || b.y < p.y - 0.001 || b.y + b.h > resY2 + 0.001) {
          bad.push(m.pid + ': box ' + b.id + ' [x ' + num(b.x) + '..' + num(b.x + b.w) + ', y ' + num(b.y) + '..' + num(b.y + b.h) + '] outside reserved block [' + num(p.x) + '..' + num(resX2) + ', ' + num(p.y) + '..' + num(resY2) + ']');
        }
      }
      for (let c = 1; c < m.nCols; c++) {
        const prev = bs.filter((r) => m.colOf(m.index[r.id]) === c - 1);
        const cur = bs.filter((r) => m.colOf(m.index[r.id]) === c);
        const prevR = Math.max.apply(null, prev.map((r) => r.x + r.w));
        const curL = Math.min.apply(null, cur.map((r) => r.x));
        if (!eq(curL - prevR, COLGAP, 0.001)) bad.push(m.pid + ': column gap ' + (c - 1) + '->' + c + '=' + num(curL - prevR) + ' want agentColGap=' + num(COLGAP));
      }
      for (let c = 0; c < m.nCols; c++) {
        const cur = bs.filter((r) => m.colOf(m.index[r.id]) === c);
        const w = Math.max.apply(null, cur.map((r) => r.x + r.w)) - Math.min.apply(null, cur.map((r) => r.x));
        const widest = Math.max.apply(null, cur.map((r) => r.w));
        if (!eq(w, widest, 0.001)) bad.push(m.pid + ' col' + c + ': column extent ' + num(w) + ' != widest subtree box ' + num(widest));
        const xs = new Set(cur.map((r) => num(rectById[r.id].x)));
        if (xs.size > 1) bad.push(m.pid + ' col' + c + ': cards do not share x: ' + Array.from(xs).join(','));
      }
    }
    run(spec.name, 'C6 block containment + column gaps', bad.length === 0, clip(bad, 4));
  }

  // ================================================================ C7
  {
    const bad = [];
    for (const m of models) {
      const counts = new Array(m.nCols).fill(0);
      for (let i = 0; i < m.n; i++) counts[m.colOf(i)]++;
      for (let c = 0; c < m.nCols; c++) if (counts[c] > R) bad.push(m.pid + ' col' + c + ': ' + counts[c] + ' cells > agentMaxRows=' + R);
      const extra = Object.keys(cells).filter((id) => !sideIds.includes(id));
      if (extra.length) bad.push('cells has entries for non-sidecar ids: ' + clip(extra, 3));
      const missing = sideIds.filter((id) => !(id in cells));
      if (missing.length) bad.push('cells missing entries: ' + clip(missing, 3));
      for (let i = 0; i < m.n; i++) {
        const id = m.ks[i], e = cells[id];
        if (!e) { bad.push(id + ': no cells entry'); continue; }
        if (e.col !== m.colOf(i)) bad.push(id + ': cell.col=' + e.col + ' want floor(i/R)=' + m.colOf(i) + ' (i=' + i + ', R=' + R + ')');
        if (e.row !== m.rowOf(i)) bad.push(id + ': cell.row=' + e.row + ' want i%R=' + m.rowOf(i) + ' (i=' + i + ')');
        if (e.index !== i) bad.push(id + ': cell.index=' + e.index + ' want child order index ' + i);
        if (e.count !== m.n) bad.push(id + ': cell.count=' + e.count + ' want ' + m.n);
      }
    }
    run(spec.name, 'C7 rows<=R, col=floor(i/R), fields', bad.length === 0, clip(bad, 4));
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
  // In-domain: apply `stretch` as the measured heights and the very same map must
  // come straight back (strict one-pass fixpoint). Exception shapes: the loop is a
  // contracting sequence — it must stop changing within C9_PASS_CAP passes and the
  // canvas must not move anywhere along the way. See the header.
  const passes = [L1];
  {
    const cap = specHasException ? C9_PASS_CAP : C9_IN_DOMAIN_PASSES;
    let map = stretch;
    for (let k = 2; k <= cap; k++) {
      if (!map) break;
      const h2 = Object.assign({}, heights);
      for (const id in map) h2[id] = map[id];
      let L;
      try { L = layoutTree(nodes, rootId, h2, spec.opts); } catch (e) { break; }
      passes.push(L);
      map = mapOf(L);
    }
  }
  {
    const bad = [], notes = [];
    const maps = passes.map(mapOf);
    const S0 = maps[0];
    const canv = passes.map((L) => ({ w: L.width, h: L.height }));
    const canvasText = (c) => num(c.w) + 'x' + num(c.h);
    const canvasSeq = canv.map(canvasText);
    const firstMoved = (() => {
      for (let k = 1; k < canv.length; k++) if (!eq(canv[k].w, canv[0].w, 1e-6) || !eq(canv[k].h, canv[0].h, 1e-6)) return k + 1;
      return -1;
    })();
    if (!S0) bad.push('layoutTree returned no `stretch` map = the feedback loop cannot be tested');
    else if (specHasException) {
      // Bounded convergence: does the map stop changing inside the cap?
      let settled = -1;
      for (let k = 1; k < maps.length; k++) {
        if (!maps[k]) { bad.push('pass ' + (k + 1) + ' returned no `stretch` map'); break; }
        if (mapDiff(maps[k - 1], maps[k], sideIds).length === 0) { settled = k + 1; break; }
      }
      if (settled < 0 && !bad.length) {
        bad.push('NOT BOUNDED: the stretch map never stopped changing within ' + C9_PASS_CAP +
          ' passes, and this exception shape must reach a fixed point quickly (it is a contracting sequence, not a divergent one). ' +
          'Criterion: exception shapes are bounded, not one-pass fixpoints — a shape that never settles means the clamp of the card above the turn child is now feeding its own share back into the map. ' +
          'Pass maps: ' + maps.map((mm, k) => 'p' + (k + 1) + '=' + JSON.stringify(mm)).join(' '));
      }
      if (firstMoved > 0) {
        bad.push('CANVAS MOVED: pass ' + firstMoved + ' has canvas ' + canvasSeq[firstMoved - 1] + ' but pass 1 had ' + canvasSeq[0] +
          ' — the rendered heights must not change the canvas while the loop settles. Canvas: ' + canvasSeq.join(' -> '));
      }
      if (!bad.length) {
        const tracks = [];
        for (const id of sideIds) {
          const vals = maps.map((mm) => (mm ? mm[id] : undefined));
          if (vals.some((v) => v == null)) continue;
          if (new Set(vals.map(num)).size > 1) tracks.push(id + ': ' + vals.map(num).join(' -> '));
        }
        notes.push('bounded: pass' + settled + ' == pass' + (settled - 1) + ' (<=' + C9_PASS_CAP + ' passes; the documented exception is a contracting feedback sequence, not a one-pass fixpoint)');
        notes.push('canvas ' + canvasSeq[0] + ' invariant across ' + passes.length + ' passes');
        notes.push(tracks.length ? 'settling values — ' + clip(tracks, 4) : 'no correction was needed (pass1 == pass2)');
      }
    } else {
      const S1 = maps[1], S2 = maps[2];
      if (!S1) bad.push('pass 2 returned no `stretch` map');
      else {
        const d = mapDiff(S0, S1, sideIds);
        if (d.length) {
          bad.push('NOT A FIXPOINT: feeding `stretch` back in as the measured heights changed the map: ' + clip(d, 5) +
            ' (criterion: in-domain shapes must be the strict one-pass fixpoint `measured := stretch => the same map`, immediately)');
        }
        if (S2) {
          const d2 = mapDiff(S1, S2, sideIds);
          if (d2.length) bad.push('pass2 -> pass3 differs: ' + clip(d2, 4));
        }
      }
      if (firstMoved > 0) bad.push('CANVAS MOVED: canvas ' + canvasSeq.join(' -> '));
      notes.push('strict one-pass fixpoint; canvas ' + canvasSeq.join(' -> '));
    }
    run(spec.name, specHasException ? 'C9 bounded convergence (exception, unreachable shape)' : 'C9 strict one-pass fixpoint', bad.length === 0, bad.concat(notes).join(' ; '));
  }

  // ================================================================ C10
  {
    const bad = [];
    if (!stretch) bad.push('no `stretch` map: box accounting not verifiable');
    else {
      for (const id of sideIds) {
        const c = cells[id], nfo = info[id];
        if (!c) { bad.push(id + ': no cells entry'); continue; }
        if (!eq(c.h, nfo.box, 0.001)) bad.push(id + ': cells.h=' + num(c.h) + ' != rebuilt subtree box=' + num(nfo.box) + ' (measured ' + num(nfo.measured) + ' + ownBlock ' + num(nfo.ownBlock) + ')');
        if (nfo.tail < -0.001) bad.push(id + ': negative tail ' + num(nfo.tail) + ' (cell box smaller than the card extent+inset)');
        const mo = modelOf[id];
        if (mo) { if (!eq(nfo.ownBlock, mo.B, 0.001)) bad.push(id + ': ownBlock ' + num(nfo.ownBlock) + ' != own grid B ' + num(mo.B)); }
        else if (!eq(nfo.ownBlock, 0, 0.001)) bad.push(id + ': ownBlock ' + num(nfo.ownBlock) + ' but the cell has no grid');
      }
    }
    run(spec.name, 'C10 box accounting + classification', bad.length === 0, clip(bad, 4));
  }

  // ================================================================ R0 (no-op regression)
  {
    const bad = [];
    if (specHasException) {
      const list = excIds.map((id) => id + '(tail ' + num(info[id].tail) + ', slotH ' + num(info[id].slotH) + ', stretch ' + num(stretch ? stretch[id] : NaN) + ')');
      run(spec.name, 'R0 no-op regression (tail==0)', true,
        'N/A: this spec is an EXCEPTION specimen on purpose — ' + excIds.length + '/' + sideIds.length + ' cells have tail>0: ' + clip(list, 5) +
        ' ; in-domain cells here: ' + num(sideIds.length - excIds.length));
    } else {
      const tails = sideIds.filter((id) => info[id] && info[id].tail > EPS);
      if (tails.length) bad.push(tails.length + ' cells have tail>0 in a reachable spec: ' + clip(tails.map((id) => id + '(tail ' + num(info[id].tail) + ')'), 4));
      if (!bad.length) {
        const doms = new Set(sideIds.map((id) => info[id] ? info[id].domain : '?'));
        if (doms.size !== 1 || !doms.has('in-domain')) bad.push('domain classification is not uniformly in-domain: ' + Array.from(doms).join(','));
      }
      run(spec.name, 'R0 no-op regression (tail==0)', bad.length === 0,
        bad.length ? bad.join(' ; ') : 'all ' + sideIds.length + ' sidecar cells: tail == 0 (the clamp is inactive, the strict slot rule applies)');
    }
  }

  return { L1, models, info, rects, boxes, cells, pos, stretch, o, excIds, specHasException, passes };
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
 * besides `media/tree.js`): `relayout()` must clear the previously applied stretch
 * BEFORE it measures the cards' natural heights and apply `result.stretch` AFTER the
 * measurement, setting both `style.height` and `style.maxHeight` from the same value.
 */
function webviewWiring() {
  const where = 'media/main.js relayout()';
  if (!fs.existsSync(MAIN_PATH)) return { ok: false, detail: 'media/main.js is missing (' + MAIN_PATH + ')' };
  const text = fs.readFileSync(MAIN_PATH, 'utf8');
  const at = text.indexOf('function relayout(');
  if (at < 0) return { ok: false, detail: 'no `function relayout(` in media/main.js — look at ' + where };
  const body = bodyOf(text, at);
  if (!body.trim()) return { ok: false, detail: 'could not read the body of relayout() — look at ' + where };

  const clear = /clearStretchHeights\s*\(\s*\)/.exec(body);
  // The measuring step: the statement that takes the cards' heights from the DOM.
  const measure = /heights\s*\[[^\]]*\]\s*=\s*card\s*\.\s*offsetHeight/.exec(body) || /offsetHeight/.exec(body);
  if (!measure) {
    return { ok: false, detail: 'relayout() never measures the cards (`card.offsetHeight`) — look at ' + where };
  }
  if (!clear) {
    return { ok: false, detail: 'relayout() never calls clearStretchHeights() — a card still carrying the previous pass\'s inline height would be measured as its natural height and stretched again (' + where + ')' };
  }
  if (clear.index > measure.index) {
    return { ok: false, detail: 'clearStretchHeights() runs AFTER the card-height measurement at offset ' + measure.index + ' (offset ' + clear.index + '): the clear-measure-apply order must be clear -> measure -> apply, or the measured heights are stretched ones and the layout creeps every frame (' + where + ')' };
  }

  const after = body.slice(measure.index);
  const useAt = after.search(/result\s*\.\s*stretch/);
  if (useAt < 0) {
    return { ok: false, detail: 'relayout() measures the cards but never consumes `result.stretch` after the measurement — the reserved slot heights would never be rendered (' + where + ')' };
  }
  const loopRel = after.slice(useAt).search(/\bfor\s*\(/);
  if (loopRel < 0) {
    return { ok: false, detail: '`result.stretch` is read but never applied (no `for` loop after it) — look at ' + where };
  }
  const loopAt = useAt + loopRel;
  const applyBlock = bodyOf(after, loopAt);
  if (!applyBlock.trim()) return { ok: false, detail: 'could not read the `result.stretch` application loop — look at ' + where };

  const hSet = /style\s*\.\s*height\s*=\s*([^;]+)/.exec(applyBlock);
  const mhSet = /style\s*\.\s*maxHeight\s*=\s*([^;]+)/.exec(applyBlock);
  if (!hSet) return { ok: false, detail: 'the `result.stretch` application never sets `style.height` — look at ' + where };
  if (!mhSet) return { ok: false, detail: 'the `result.stretch` application never sets `style.maxHeight`: `.node` caps every card at 600px, so an inline `height` alone leaves the card clipped and its column short again (' + where + ')' };
  const rhs = (m) => m[1].replace(/\s+/g, ' ').trim();
  if (rhs(hSet) !== rhs(mhSet)) {
    return { ok: false, detail: '`style.height` and `style.maxHeight` are set from different values ("' + rhs(hSet) + '" vs "' + rhs(mhSet) + '") — the inline cap has to be lifted to exactly the same height (' + where + ')' };
  }
  return {
    ok: true,
    detail: 'clearStretchHeights() before the offsetHeight measurement, `result.stretch` applied after it (`style.height` and `style.maxHeight` both = ' + rhs(hSet) + ')',
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

  // probe: the `stretch` map is the whole contract with the webview
  let probe = null, probeErr = '';
  try {
    probe = layoutTree({ r: { id: 'r', children: ['a'], kind: 'turn' }, a: { id: 'a', children: [], kind: 'agent' } }, 'r', { r: 330, a: 330 }, {});
  } catch (e) { probeErr = e.message; }
  if (probeErr) failedLine('probe layoutTree returns a `stretch` map', 'threw: ' + probeErr);
  else if (!mapOf(probe)) failedLine('probe layoutTree returns a `stretch` map', 'keys: ' + (probe ? Object.keys(probe).join(',') : '-'));
  else note('probe layoutTree returns a `stretch` map', JSON.stringify(probe.stretch));

  const specs = allSpecs();
  const runs = {};
  for (const s of specs) runs[s.name] = verifySpec(s, layoutTree, run);

  // ---- per spec
  console.log('');
  console.log('-- per spec --');
  let sideCells = 0, excCells = 0, specRows = 0, excSpecs = 0;
  for (const s of specs) {
    const rs = rows.filter((r) => r.spec === s.name);
    specRows += rs.length;
    const failed = rs.filter((r) => !r.ok);
    const res = runs[s.name];
    const nCells = res ? Object.keys(res.info).length : 0;
    const nExc = res ? res.excIds.length : 0;
    sideCells += nCells;
    excCells += nExc;
    if (nExc) excSpecs++;
    const label = s.name + ': ' + (rs.length - failed.length) + '/' + rs.length + ' checks  (sidecar cells ' + nCells + ', exception cells ' + nExc + ')';
    if (failed.length) failedLine(label);
    else note(label);
    for (const r of failed) console.log('         · ' + r.check + ': ' + r.detail);
    if (nExc) {
      const c9 = rs.find((r) => /^C9/.test(r.check));
      if (c9) console.log('         · ' + c9.check + ' => ' + c9.detail);
    }
  }

  // ---- R1 REAL golden numbers (recorded from the verified pre-clamp run)
  const res = runs[REAL.name];
  const golden = { canvas: null, col0Tops: null, a4Stretch: null, cY: null };
  {
    const bad = [];
    const R = 'mu2zp7px3zsegz', C = 'mu2zyi167efltd', A4 = 'mu2zprz19fpyip';
    const A = ['mu2zprz144bbh4', 'mu2zprz1szfyo6', 'mu2zprz1p3hrno', 'mu2zprz15gtrk6'];
    const D = ['mu3004pl0l971r', 'mu3004plsxfe8v', 'mu3004plyzeigu', 'mu3004plitr2cy',
               'mu3004plwd32s8', 'mu3004plte1wr1', 'mu3004pli6b76o', 'mu3004plyhs83j'];
    const Bk = ['mu2zquika60bv5', 'mu2zquikoxkhr4', 'mu2zquikm30yqw'];
    const mR = res.models.find((m) => m.pid === R), mC = res.models.find((m) => m.pid === C), mB = res.models.find((m) => m.pid === A4);
    const want = (label, got, wantV) => { if (!eq(got, wantV, 0.001)) bad.push(label + ' = ' + num(got) + ' want ' + num(wantV)); };
    want('canvas.width', res.L1.width, 1528);
    want('canvas.height', res.L1.height, 2928);
    want('R grid B', mR.B, 1408);
    want('R grid S[0]', mR.S[0], 1408);
    want('R grid S[1]', mR.S[1], 1070);
    [16, 370, 724, 1078].forEach((t, i) => want('col0 top[' + i + '] ' + A[i], res.cells[A[i]].y - res.pos[R].y, t));
    A.forEach((id) => want('stretch[' + id + ']', res.stretch[id], 330));
    want('A[4] cardTop', res.cells[A4].y - res.pos[R].y, 16);
    want('A[4] stretch', res.stretch[A4], 1392);
    want('A[4] cardBottom', res.cells[A4].y + res.stretch[A4] - res.pos[R].y, 1408);
    want('A[4] extent (cells.h)', res.cells[A4].h, 1054);
    want('C y (rel R)', res.pos[C].y - res.pos[R].y, 1480);
    want("A[4]'s grid B", mB.B, 1054);
    [16, 370, 724].forEach((t, i) => want('A[4] grid top[' + i + ']', res.cells[Bk[i]].y - res.pos[A4].y, t));
    Bk.forEach((id) => want('stretch[' + id + ']', res.stretch[id], 330));
    want("C's grid B", mC.B, 1408);
    [16, 370, 724, 1078].forEach((t, i) => {
      want('C grid col0 top[' + i + ']', res.cells[D[i]].y - res.pos[C].y, t);
      want('C grid col1 top[' + i + ']', res.cells[D[i + 4]].y - res.pos[C].y, t);
    });
    D.forEach((id) => want('stretch[' + id + ']', res.stretch[id], 330));
    let inset = 0, out = 0;
    for (const id in res.cells) {
      if (!eq(res.cells[id].x, res.pos[id].x, 0.001) || !eq(res.cells[id].y, res.pos[id].y, 0.001)) inset++;
      if (res.info[id] && res.info[id].tail > EPS) out++;
    }
    if (inset) bad.push(inset + ' cells have cells.(x,y) != pos (card inset in its box)');
    if (out) bad.push(out + ' REAL cells are out-of-domain (tail>0) — the clamp is NOT a no-op here');
    golden.canvas = num(res.L1.width) + 'x' + num(res.L1.height);
    golden.col0Tops = [0, 1, 2, 3].map((i) => num(res.cells[A[i]].y - res.pos[R].y)).join('/');
    golden.a4Stretch = num(res.stretch[A4]);
    golden.cY = num(res.pos[C].y - res.pos[R].y);
    run(REAL.name, 'R1 REAL golden numbers', bad.length === 0,
      bad.length ? bad.join(' ; ') : 'canvas ' + golden.canvas + ', R grid B=' + num(mR.B) + ' S=[' + mR.S.map(num).join(',') + '], col0 card tops ' + golden.col0Tops +
        ', A[4] stretch ' + golden.a4Stretch + ' (extent ' + num(res.cells[A4].h) + ', bottom ' + num(res.cells[A4].y + res.stretch[A4] - res.pos[R].y) + '), C y=' + golden.cY +
        ', every cells.(x,y) == pos, 0 exception cells');
  }

  // ---- C11
  const wiring = webviewWiring();
  run('media/main.js', 'C11 relayout(): clear -> measure -> apply', wiring.ok, wiring.detail);

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
    sideCells + ' sidecar cells (' + (sideCells - excCells) + ' in-domain, ' + excCells + ' exception cells in ' + excSpecs + ' unreachable specimens)');
  console.log('golden  : ' + REAL.name + ' — canvas ' + golden.canvas + ' · col0 card tops ' + golden.col0Tops +
    ' · A[4] stretch ' + golden.a4Stretch + ' · C y=' + golden.cY);
  console.log('');

  if (fails.length) {
    const first = fails[0];
    console.log('FAIL check-tree-grid: ' + fails.length + '/' + totalChecks + ' checks failed — first: ' + first.spec + ' · ' + first.check + ': ' + first.detail);
    process.exit(1);
  }
  console.log('PASS check-tree-grid: ' + specs.length + ' specs, ' + totalChecks + '/' + totalChecks + ' checks, ' + sideCells +
    ' sidecar cells (' + (sideCells - excCells) + ' in-domain, ' + excCells + ' exception cells in ' + excSpecs + ' unreachable specimens) — REAL canvas ' + golden.canvas + ', col0 card tops ' + golden.col0Tops +
    ', A[4] stretch ' + golden.a4Stretch + ', C y=' + golden.cY);
  process.exit(0);
}

try {
  main();
} catch (e) {
  console.log('');
  console.log('FAIL check-tree-grid: harness error — ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)));
  process.exit(1);
}
