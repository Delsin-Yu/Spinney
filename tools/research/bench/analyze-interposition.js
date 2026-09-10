'use strict';
/*
 * Interposition / connector-crossing analysis on a REAL persisted session.
 *
 *   node analyze-interposition.js fields <sessionId>
 *   node analyze-interposition.js check  <sessionId> [heights=flat|heuristic]
 *
 * "Interposition" = a card that sits horizontally between a parent card and one
 * of its agent windows (inside the window's y-band), i.e. the reported defect
 * "Node B placed between Node A and its sub-agents".
 * "Crossing" = the parent->agent bezier (same geometry as media/main.js
 * drawEdges) passing through some other card's rectangle.
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DB = process.env.TEMP.split('\\').join('/') + '/hstate.vscdb';
const KEY = 'minimal-host.minimal-agent-harness';
const MEDIA = path.resolve(__dirname, '..', '..', '..', 'media');

function loadState() {
  const db = new DatabaseSync(DB, { readOnly: true });
  const row = db.prepare('SELECT value FROM ItemTable WHERE key=?').get(KEY);
  db.close();
  const state = JSON.parse(row.value);
  const ss = state['agentHarness.state'].sessions;
  return Array.isArray(ss) ? ss : Object.values(ss);
}

function loadSession(id) {
  const list = loadState();
  const s = id ? list.find((x) => x.id === id || String(x.id).startsWith(id)) : list[0];
  if (!s) throw new Error('session not found: ' + id);
  return s;
}

function buildTree(session) {
  const raw = session.nodes;
  const arr = Array.isArray(raw) ? raw : Object.values(raw || {});
  const nodesById = {};
  for (const n of arr) {
    nodesById[n.id] = {
      id: n.id,
      kind: n.kind || 'turn',
      children: Array.isArray(n.children) ? n.children.slice() : [],
      parentId: n.parentId || '',
      title: String(n.title || '').slice(0, 40),
      raw: n,
    };
  }
  // derive children from parentId when the array form is not populated
  for (const id in nodesById) {
    const n = nodesById[id];
    if (!n.children.length && n.parentId && nodesById[n.parentId]) {
      const p = nodesById[n.parentId];
      if (!p.children.includes(id)) p.children.push(id);
    }
  }
  const rootId = session.rootId || arr.find((n) => !n.parentId)?.id;
  return { nodesById, rootId };
}

function estimateHeights(nodesById, mode) {
  const heights = {};
  for (const id in nodesById) {
    const n = nodesById[id];
    if (mode === 'flat') {
      heights[id] = 120;
      continue;
    }
    // heuristic: card header + rendered display items (main.js renders the UI
    // transcript), clamped to the range the webview can actually produce.
    const items = n.raw.displayItems || [];
    let px = 56; // header + padding
    for (const it of items) {
      const text = typeof it === 'string' ? it : String(it.text || it.content || '');
      const lines = Math.max(1, Math.ceil(text.length / 90));
      px += 26 + Math.min(lines, 22) * 18;
    }
    heights[id] = Math.max(96, Math.min(px, 600));
  }
  return heights;
}

function loadShipped() {
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(MEDIA, 'vendor/non-layered-tidy-tree-layout/dist/non-layered-tidy-tree-layout.js'), 'utf8'),
    sandbox,
  );
  vm.runInContext(fs.readFileSync(path.join(MEDIA, 'tree.js'), 'utf8'), sandbox);
  return sandbox.window.treeLayout.layoutTree;
}

function loadLegacy() {
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'legacy-tree.js'), 'utf8'), sandbox);
  return sandbox.window.treeLayout.layoutTree;
}

function engineFn(name) {
  if (name === 'legacy') return loadLegacy();
  if (name === 'designN') return require('./nlttl-candidates').layoutEngineReserve;
  if (name === 'designN2') return (n, r, h, o) => require('./nlttl-candidates').layoutEngineReserveWrapped(n, r, h, o, 2);
  if (name === 'designN3') return (n, r, h, o) => require('./nlttl-candidates').layoutEngineReserveWrapped(n, r, h, o, 3);
  return loadShipped();
}

const cmd = process.argv[2] || 'fields';
const session = cmd === 'check' && process.argv[3] === 'ALL' ? null : loadSession(process.argv[3]);

if (cmd === 'fields') {
  const { nodesById } = buildTree(session);
  const arr = Object.values(nodesById);
  const sample = arr.find((n) => n.kind === 'agent') || arr[0];
  const keys = Object.keys(sample.raw);
  console.log('node fields:', keys.join(', '));
  console.log('nodes:', arr.length, 'agents:', arr.filter((n) => n.kind === 'agent').length);
  console.log(
    'sample:',
    JSON.stringify({ ...sample.raw, messages: undefined, displayItems: (sample.raw.displayItems || []).length }, null, 1).slice(0, 1200),
  );
  const withItems = arr.filter((n) => (n.raw.displayItems || []).length);
  console.log('nodes with displayItems:', withItems.length, 'max items:', Math.max(0, ...arr.map((n) => (n.raw.displayItems || []).length)));
  process.exit(0);
}

// ------------------------------------------------------------------ check mode
const mode = (process.argv[4] || 'heights=heuristic').split('=')[1];
const engineName = (process.argv[5] || 'engine=shipped').split('=')[1];
const sweep = process.argv[3] === 'ALL';

function analyze(session, engineName, mode, verbose) {
const { nodesById, rootId } = buildTree(session);
const heights = estimateHeights(nodesById, mode);
const widths = {};
for (const id in nodesById) widths[id] = 320;

const layoutTree = engineFn(engineName);
const res = layoutTree(nodesById, rootId, heights, { nodeW: 320, hGap: 48, vGap: 72, agentGap: 80, agentVGap: 24, widths });

const rect = (id) => ({ id, x: res.pos[id].x, y: res.pos[id].y, w: widths[id], h: heights[id] });
const cards = Object.keys(res.pos).map(rect);
const descendants = (id) => {
  const out = new Set();
  const q = [id];
  while (q.length) {
    const n = q.shift();
    out.add(n);
    for (const c of nodesById[n].children) q.push(c);
  }
  return out;
};

// cubic bezier as drawn by main.js
function bezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}
const inRect = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

let interpositions = 0;
let crossings = 0;
const details = [];

for (const pid in nodesById) {
  const p = nodesById[pid];
  if (!p.kind || !res.pos[pid]) continue;
  const agentKids = p.children.filter((c) => nodesById[c] && nodesById[c].kind === 'agent');
  if (!agentKids.length) continue;
  const pr = rect(pid);
  for (const aid of agentKids) {
    if (!res.pos[aid]) continue;
    const w = rect(aid);
    const own = descendants(aid);
    // The parent's OTHER agent windows are part of the same visual group — they
    // are not "a foreign node inserted between A and its sub-agents".
    const siblingsOwn = new Set();
    for (const other of agentKids) {
      if (other === aid) continue;
      for (const d of descendants(other)) siblingsOwn.add(d);
    }
    // cards whose y-band overlaps the window and that start left of it but end right of the parent card
    const band = cards.filter(
      (c) =>
        c.id !== pid &&
        !own.has(c.id) &&
        !siblingsOwn.has(c.id) &&
        c.y < w.y + w.h &&
        c.y + c.h > w.y &&
        c.x + c.w > pr.x + pr.w &&
        c.x < w.x,
    );
    if (band.length) {
      interpositions++;
      details.push(
        `INTERPOSE parent=${pid}(${p.title}) window=${aid} at x=${Math.round(w.x)} — between: ` +
          band.slice(0, 4).map((c) => `${c.id}(${nodesById[c.id].kind},${nodesById[c.id].title})x=${Math.round(c.x)}`).join(', '),
      );
    }
    // connector crossing
    const p0 = { x: pr.x + pr.w, y: pr.y + pr.h / 2 };
    const p3 = { x: w.x, y: w.y + w.h / 2 };
    const mx = (p0.x + p3.x) / 2;
    const p1 = { x: mx, y: p0.y };
    const p2 = { x: mx, y: p3.y };
    const hit = new Set();
    for (let i = 0; i <= 60; i++) {
      const pt = bezier(p0, p1, p2, p3, i / 60);
      for (const c of cards) {
        if (c.id === pid || own.has(c.id)) continue;
        if (inRect(pt, c)) hit.add(c.id);
      }
    }
    if (hit.size) {
      crossings++;
      details.push(`CROSS parent=${pid}(${p.title}) window=${aid} crosses: ` + [...hit].slice(0, 4).join(', '));
    }
  }
}

if (verbose) {
  console.log(`session ${session.id} "${String(session.title || '').slice(0, 50)}" nodes=${Object.keys(nodesById).length} agents=${Object.values(nodesById).filter((n) => n.kind === 'agent').length} heights=${mode} engine=${engineName}`);
  console.log(`canvas ${Math.round(res.width)}x${Math.round(res.height)}  interpositions=${interpositions}  connector-crossings=${crossings}`);
  for (const d of details.slice(0, 25)) console.log('  ' + d);
  if (details.length > 25) console.log(`  … ${details.length - 25} more`);
}
return { w: Math.round(res.width), h: Math.round(res.height), inter: interpositions, cross: crossings, nodes: Object.keys(nodesById).length };
}

if (sweep) {
  const all = loadState();
  const withAgents = all.filter((s) => {
    const arr = Array.isArray(s.nodes) ? s.nodes : Object.values(s.nodes || {});
    return arr.some((n) => n.kind === 'agent');
  });
  console.log(`sweeping ${withAgents.length} sessions with agent nodes, heights=${mode}`);
  console.log('session                      nodes agents | shipped WxH int/cross | legacy WxH int/cross | designN WxH int/cross');
  for (const s of withAgents) {
    const arr = Array.isArray(s.nodes) ? s.nodes : Object.values(s.nodes || {});
    const agents = arr.filter((n) => n.kind === 'agent').length;
    const cells = [];
    for (const e of ['shipped', 'legacy', 'designN']) {
      try {
        const r = analyze(s, e, mode, false);
        cells.push(`${r.w}x${r.h} ${r.inter}/${r.cross}`);
      } catch (err) {
        cells.push('ERR ' + String(err.message).slice(0, 30));
      }
    }
    console.log(`${String(s.id).slice(0, 12).padEnd(28)} ${String(arr.length).padStart(4)} ${String(agents).padStart(5)} | ${cells.join(' | ')}`);
  }
  process.exit(0);
}

analyze(session, engineName, mode, true);

