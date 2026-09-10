'use strict';
// Dump one scenario's layouts side by side: node dump.js <profile> <n>
const { buildSession, PROFILES } = require('./synthetic');
const current = require('./current');
const C = require('./candidates');
const profile = process.argv[2] || 'fanout';
const n = +(process.argv[3] || 10);
const seed = 0x9e3779b9 ^ (n * 7919) ^ (profile.length * 104729);
const t = buildSession(n, seed, PROFILES[profile]);
const rc = current.layoutTree(t.nodesById, 'n0', t.heights, { widths: t.widths });
const ra = C.layoutAFlex(t.nodesById, 'n0', t.heights, { widths: t.widths });
console.log('current', rc.width + 'x' + rc.height, ' A_flex', ra.width + 'x' + ra.height);
for (const id of Object.keys(t.nodesById)) {
  const node = t.nodesById[id];
  console.log(
    id, node.kind.padEnd(5), (t.widths[id] + 'x' + t.heights[id]).padStart(9),
    'p=' + String(node.parentId).padEnd(4),
    'cur', JSON.stringify(rc.pos[id]).padEnd(22), 'A', JSON.stringify(ra.pos[id]),
  );
}
