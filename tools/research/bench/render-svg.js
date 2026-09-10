'use strict';
/*
 * Render a layout to SVG so it can be *looked at* (and rasterised with a headless
 * browser) without opening VS Code. Draws exactly what media/main.js draws: one
 * rounded card per node (coloured by kind/status) and the same connectors —
 * parent→sub-agent elbows through the layout's corridors, parent→turn splines.
 *
 *   node render-svg.js --syn parallel 60 [--r 4]
 *   node render-svg.js --session mtsu3t96x05msc [--r 4]
 *   node render-svg.js --session ALL --r 3
 *
 * Options: --out <file.svg>  --width <px>  (scaled to fit, default 1400)
 *          --no-edges  --h <heuristic|flat>
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { DatabaseSync } = require('node:sqlite');
const { connectorPoints } = require('./violations');
const { buildSession, PROFILES } = require('./synthetic');

const MEDIA = path.resolve(__dirname, '..', '..', '..', 'media');
const ENGINE = path.join(MEDIA, 'vendor', 'non-layered-tidy-tree-layout', 'dist', 'non-layered-tidy-tree-layout.js');
const TREE = path.join(MEDIA, 'tree.js');

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : def;
};

function loadShipped() {
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(ENGINE, 'utf8'), sandbox, { filename: ENGINE });
  vm.runInContext(fs.readFileSync(TREE, 'utf8'), sandbox, { filename: TREE });
  return sandbox.window.treeLayout.layoutTree;
}

function realSession(id) {
  const db = process.env.TEMP.split(path.sep).join('/') + '/hstate.vscdb';
  const dbh = new DatabaseSync(db, { readOnly: true });
  const rows = dbh.prepare("SELECT key,value FROM ItemTable WHERE key LIKE '%minimal-agent-harness%'").all();
  dbh.close();
  let state = null;
  for (const r of rows) {
    try {
      const s = JSON.parse(r.value);
      if (s['agentHarness.state']) state = s;
    } catch (e) { /* not the state row */ }
  }
  const ss = state['agentHarness.state'].sessions;
  const s = (Array.isArray(ss) ? ss : Object.values(ss)).find((x) => String(x.id).startsWith(id));
  if (!s) throw new Error('session not found: ' + id);
  const arr = Array.isArray(s.nodes) ? s.nodes : Object.values(s.nodes || {});
  const nodesById = {};
  for (const n of arr) {
    nodesById[n.id] = {
      id: n.id, kind: n.kind || 'turn',
      children: Array.isArray(n.children) ? n.children.slice() : [],
      parentId: n.parentId || '', title: String(n.title || '').slice(0, 60), raw: n,
    };
  }
  for (const nid in nodesById) {
    const n = nodesById[nid];
    if (!n.children.length && n.parentId && nodesById[n.parentId] && !nodesById[n.parentId].children.includes(nid)) {
      nodesById[n.parentId].children.push(nid);
    }
  }
  const heights = {};
  const widths = {};
  for (const nid in nodesById) {
    const its = nodesById[nid].raw.displayItems || [];
    let px = 56;
    for (const it of its) {
      const text = typeof it === 'string' ? it : String(it.text || it.content || '');
      px += 26 + Math.min(Math.max(1, Math.ceil(text.length / 90)), 22) * 18;
    }
    heights[nid] = Math.max(96, Math.min(px, 600));
    widths[nid] = 320;
  }
  return { name: 'session:' + String(s.id).slice(0, 12), nodesById, rootId: s.rootId || arr.find((n) => !n.parentId)?.id, heights, widths };
}

function syntheticCase(profile, n) {
  const t = buildSession(n, 0x9e3779b9 ^ (n * 7919) ^ String(profile).length * 104729, PROFILES[profile] || PROFILES.parallel);
  return { name: profile + ':' + n, nodesById: t.nodesById, rootId: 'n0', heights: t.heights, widths: t.widths };
}

const layoutTree = loadShipped();

function render(tree, R, out) {
  const res = layoutTree(tree.nodesById, tree.rootId, tree.heights, {
    widths: tree.widths, agentGap: 80, agentVGap: 24, agentColGap: 48, agentMaxRows: R, agentTopPad: 16,
  });
  const W = res.width;
  const H = res.height;
  const scale = Math.min(1, Number(flag('width', 1400)) / W, 4000 / H);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(W * scale)}" height="${Math.round(H * scale)}" viewBox="0 0 ${Math.ceil(W)} ${Math.ceil(H)}">`);
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#1e1e1e"/>`);
  if (!flag('no-edges', false)) {
    for (const id in tree.nodesById) {
      const n = tree.nodesById[id];
      if (!n.parentId || !res.pos[id] || !res.pos[n.parentId]) continue;
      const p = res.pos[n.parentId];
      const c = res.pos[id];
      const pw = tree.widths[n.parentId] || 320;
      const ph = tree.heights[n.parentId] || 120;
      const cw = tree.widths[id] || 320;
      const ch = tree.heights[id] || 120;
      if (n.kind === 'agent') {
        const pts = connectorPoints(res, n.parentId, id, { x: p.x, y: p.y, w: pw, h: ph }, { x: c.x, y: c.y, w: cw, h: ch });
        parts.push(`<polyline points="${pts.map((q) => Math.round(q.x) + ',' + Math.round(q.y)).join(' ')}" fill="none" stroke="#7a7a7a" stroke-width="1.5"/>`);
      } else {
        const x0 = p.x + pw / 2;
        const y0 = p.y + ph;
        const x1 = c.x + cw / 2;
        const y1 = c.y;
        const mx = (x0 + x1) / 2;
        parts.push(`<path d="M ${x0} ${y0} C ${mx} ${y0}, ${mx} ${y1}, ${x1} ${y1}" fill="none" stroke="#5a5a5a" stroke-width="1.5"/>`);
      }
    }
  }
  for (const id in tree.nodesById) {
    const n = tree.nodesById[id];
    const p = res.pos[id];
    if (!p) continue;
    const w = tree.widths[id] || 320;
    const h = tree.heights[id] || 120;
    const agent = n.kind === 'agent';
    const cell = res.cells && res.cells[id];
    parts.push(
      `<rect x="${p.x}" y="${p.y}" width="${w}" height="${h}" rx="8" fill="${agent ? '#2d2d3f' : '#252526'}" ` +
        `stroke="${agent ? (cell ? '#4e9eff' : '#ff9e4e') : '#3c3c3c'}" stroke-width="1.5"/>`,
    );
    if (agent && cell) {
      // Mark the grid cell box so the lattice/gaps are visible in the picture.
      parts.push(
        `<rect x="${cell.x}" y="${cell.y}" width="${cell.w}" height="${cell.h}" fill="none" ` +
          `stroke="#4e9eff" stroke-width="0.5" stroke-dasharray="4 4" opacity="0.35"/>`,
      );
    }
    const label = (n.title || id) + (agent && cell ? ` [${cell.col},${cell.row}]` : '');
    parts.push(`<text x="${p.x + 6}" y="${p.y + 18}" fill="#d4d4d4" font-family="monospace" font-size="13">${esc(label.slice(0, 34))}</text>`);
    parts.push(`<text x="${p.x + 6}" y="${p.y + 34}" fill="#8a8a8a" font-family="monospace" font-size="11">${esc(id)} ${Math.round(w)}x${Math.round(h)}</text>`);
  }
  parts.push('</svg>');
  fs.writeFileSync(out, parts.join('\n'));
  console.log(`${out}  canvas ${Math.round(W)}x${Math.round(H)}  scale ${scale.toFixed(3)}  nodes ${Object.keys(res.pos).length}`);
}

const R = Number(flag('r', 4));
if (flag('session', null)) {
  const want = String(flag('session'));
  if (want === 'ALL') {
    const db = process.env.TEMP.split(path.sep).join('/') + '/hstate.vscdb';
    const dbh = new DatabaseSync(db, { readOnly: true });
    const rows = dbh.prepare("SELECT value FROM ItemTable WHERE key LIKE '%minimal-agent-harness%'").all();
    dbh.close();
    let state = null;
    for (const r of rows) {
      try {
        const s = JSON.parse(r.value);
        if (s['agentHarness.state']) state = s;
      } catch (e) { /* ignore */ }
    }
    const ss = state['agentHarness.state'].sessions;
    for (const s of Array.isArray(ss) ? ss : Object.values(ss)) {
      const arr = Array.isArray(s.nodes) ? s.nodes : Object.values(s.nodes || {});
      if (!arr.some((n) => n.kind === 'agent')) continue;
      const t = realSession(String(s.id).slice(0, 12));
      render(t, R, path.join(__dirname, 'preview-' + s.id + '.svg'));
    }
  } else {
    const t = realSession(want);
    render(t, R, String(flag('out', path.join(__dirname, 'preview-' + want + '.svg'))));
  }
} else {
  const t = syntheticCase(String(flag('syn', 'parallel')).split(' ')[0], Number(args[args.indexOf('--syn') + 2] || 60));
  render(t, R, String(flag('out', path.join(__dirname, 'preview-syn.svg'))));
}
