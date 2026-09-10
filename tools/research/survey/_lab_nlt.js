const { Layout, BoundingBox } = require('C:/Users/DE-YU/AppData/Local/Temp/lab/node_modules/non-layered-tidy-tree-layout');
const bb = new BoundingBox(20, 40);
const L = new Layout(bb);
const tree = { id: 'root', width: 320, height: 120, children: [
  { id: 'c1', width: 320, height: 200, children: [{ id: 'g1', width: 320, height: 900 }, { id: 'g2', width: 320, height: 120 }] },
  { id: 'c2', width: 320, height: 150 },
] };
const { result, boundingBox } = L.layout(tree);
const walk = (n) => { console.log(n.id, 'x=' + n.x.toFixed(0), 'y=' + n.y.toFixed(0), 'w=' + n.width, 'h=' + n.height); (n.children || []).forEach(walk); };
walk(result);
console.log('bbox:', JSON.stringify(boundingBox));
