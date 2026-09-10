// scratch verification: @dagrejs/dagre v3 sidecar strategies
const dagre = require('C:/Users/DE-YU/AppData/Local/Temp/lab/node_modules/@dagrejs/dagre');

function run(name, opts) {
  try {
    const g = new dagre.graphlib.Graph({ compound: false });
    g.setGraph(Object.assign({ rankdir: 'TB', nodesep: 40, ranksep: 60, marginx: 0, marginy: 0 }, opts.graph || {}));
    g.setDefaultEdgeLabel(() => ({}));
    const N = {
      root: { width: 320, height: 120 },
      c1: { width: 320, height: 200 },
      c2: { width: 320, height: 150 },
      a1: { width: 320, height: 400 },
      a2: { width: 320, height: 300 },
    };
    for (const k in N) g.setNode(k, Object.assign({}, N[k], (opts.node || {})[k] || {}));
    g.setEdge('root', 'c1', opts.turnEdge || {});
    g.setEdge('root', 'c2', opts.turnEdge || {});
    g.setEdge('root', 'a1', opts.sideEdge || {});
    g.setEdge('c1', 'a2', opts.sideEdge || {});
    dagre.layout(g, opts.layout || {});
    console.log('###', name, '| size:', g.graph().width + 'x' + g.graph().height);
    for (const k in N) { const n = g.node(k); console.log('  ', k, 'x=' + n.x.toFixed(0), 'y=' + n.y.toFixed(0), 'rank=' + n.rank, 'w=' + n.width, 'h=' + n.height); }
  } catch (e) { console.log('###', name, 'FAILED:', e.message); }
}

run('A: baseline, all edges normal (ranksep 60)', {});
run('E: pin sidecar nodes minRank/maxRank to parent rank', {
  node: { a1: { minRank: 0, maxRank: 0 }, a2: { minRank: 2, maxRank: 2 } },
});
run('F: E + ordering constraints', {
  node: { a1: { minRank: 0, maxRank: 0 }, a2: { minRank: 2, maxRank: 2 } },
  layout: { constraints: [{ left: 'root', right: 'a1' }, { left: 'c1', right: 'a2' }] },
});
run('G: sidecar edges minlen 1 + high weight, sidecar pinned', {
  node: { a1: { minRank: 0, maxRank: 0 }, a2: { minRank: 2, maxRank: 2 } },
  sideEdge: { minlen: 1, weight: 100 },
  layout: { constraints: [{ left: 'root', right: 'a1' }, { left: 'c1', right: 'a2' }] },
});
run('H: minlen:0 on a 2-node graph only', { sideEdge: { minlen: 0 }, turnEdge: { minlen: 0 } });
