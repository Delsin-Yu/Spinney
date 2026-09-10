const R = 'C:/Users/DE-YU/AppData/Local/Temp/lab/node_modules/';
const { flextree } = require(R + 'd3-flextree');
const dagre = require(R + '@dagrejs/dagre');
const d3dag = require(R + 'd3-dag');

// deterministic pseudo-random 200-node tree, widths 280..480, heights 120..2000
let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const N = 200;
const nodes = [{ id: 'n0', w: 320, h: 120 + rnd() * 1880, parent: null }];
for (let i = 1; i < N; i++) nodes.push({ id: 'n' + i, w: 280 + rnd() * 200, h: 120 + rnd() * 1880, parent: 'n' + Math.floor(rnd() * i) });
const sizeOf = {}; const kids = {}; nodes.forEach(n => { sizeOf[n.id] = [n.w, n.h]; (kids[n.parent] = kids[n.parent] || []).push(n.id); });

// build nested data for flextree
const byId = {}; nodes.forEach(n => (byId[n.id] = { id: n.id, w: n.w, h: n.h }));
nodes.forEach(n => { if (n.parent) (byId[n.parent].children = byId[n.parent].children || []).push(byId[n.id]); });

function bench(label, fn, iters) {
  fn(); // warm
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / iters;
  console.log(label.padEnd(34), ms.toFixed(2) + ' ms/layout');
}

const flex = flextree({ nodeSize: n => [n.data.w, n.data.h], spacing: 24 });
bench('d3-flextree (' + N + ' nodes)', () => { const t = flex.hierarchy(byId.n0); flex(t); return t.extents; }, 30);

const g = new dagre.graphlib.Graph();
g.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 72 });
g.setDefaultEdgeLabel(() => ({}));
nodes.forEach(n => g.setNode(n.id, { width: n.w, height: n.h }));
nodes.forEach(n => { if (n.parent) g.setEdge(n.parent, n.id); });
bench('@dagrejs/dagre (' + N + ' nodes)', () => { dagre.layout(g); return g.graph().width; }, 10);

const data = nodes.map(n => ({ id: n.id, parentIds: n.parent ? [n.parent] : [] }));
const sugi = d3dag.sugiyama().nodeSize(n => sizeOf[n.data.id]).gap([40, 72]);
bench('d3-dag sugiyama (' + N + ' nodes)', () => { const d = d3dag.graphStratify()(data); return sugi(d); }, 10);
