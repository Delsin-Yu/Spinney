const d3dag = require('C:/Users/DE-YU/AppData/Local/Temp/lab/node_modules/d3-dag');
const { graphStratify, sugiyama, decrossTwoLayer, coordSimplex, layeringSimplex } = d3dag;
const data = [
  { id: 'root', parentIds: [] },
  { id: 'c1', parentIds: ['root'] },
  { id: 'c2', parentIds: ['root'] },
  { id: 'a1', parentIds: ['root'] },
  { id: 'a2', parentIds: ['c1'] },
];
const sizes = { root: [320, 120], c1: [320, 200], c2: [320, 150], a1: [320, 400], a2: [320, 300] };
const dag = graphStratify()(data);
const layout = sugiyama()
  .nodeSize((n) => sizes[n.data.id])
  .gap([40, 60])
  .layering(layeringSimplex())
  .decross(decrossTwoLayer())
  .coord(coordSimplex());
const res = layout(dag);
console.log('d3-dag sugiyama result:', JSON.stringify(res));
for (const n of dag.nodes()) console.log(' ', n.data.id, 'x=' + n.x.toFixed(0), 'y=' + n.y.toFixed(0));
// determinism
const dag2 = graphStratify()(data);
const res2 = layout(dag2);
let same = true;
for (const n of dag2.nodes()) { const o = [...dag.nodes()].find((m) => m.data.id === n.data.id); if (o.x !== n.x || o.y !== n.y) same = false; }
console.log('d3-dag deterministic:', same, '| sizes equal:', res.width === res2.width && res.height === res2.height);
