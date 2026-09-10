'use strict';
// Wall-clock scaling: current media/tree.js vs candidate A.  node timing.js
const current = require('./current');
const C = require('./candidates');
const { buildSession, PROFILES } = require('./synthetic');

function median(fn, reps) {
  const s = [];
  for (let i = 0; i < reps; i++) {
    const a = process.hrtime.bigint();
    fn();
    s.push(Number(process.hrtime.bigint() - a) / 1e6);
  }
  s.sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

console.log('profile    n     current ms   A_flex ms   A_flex/current');
for (const name of ['chain', 'fanout', 'sidecars', 'mixed', 'tall']) {
  for (const n of [30, 100, 300, 1000]) {
    const seed = 0x9e3779b9 ^ (n * 7919) ^ (name.length * 104729);
    const t = buildSession(n, seed, PROFILES[name]);
    const o = { widths: t.widths };
    for (let i = 0; i < 3; i++) { current.layoutTree(t.nodesById, 'n0', t.heights, o); C.layoutAFlex(t.nodesById, 'n0', t.heights, o); }
    const reps = n >= 1000 ? 5 : n >= 300 ? 9 : 21;
    const c = median(() => current.layoutTree(t.nodesById, 'n0', t.heights, o), reps);
    const a = median(() => C.layoutAFlex(t.nodesById, 'n0', t.heights, o), reps);
    console.log(
      name.padEnd(10), String(n).padStart(4),
      c.toFixed(2).padStart(11), a.toFixed(2).padStart(11), (a / c).toFixed(2).padStart(15),
    );
  }
}
