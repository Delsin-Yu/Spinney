// Independent baseline for the CURRENT algorithm in media/tree.js.
// Loads the file with a fake `window` and measures canvas area + overlaps
// for a few shapes that mimic real sessions.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'media', 'tree.js'), 'utf8');
const win = {};
new Function('window', src)(win);
const { layoutTree } = win.treeLayout;

const W = 320;
function mk(spec) {
  // spec: nested arrays. [id, kind, [children...]] ; kind 'a' = agent
  const nodes = {};
  let root = null;
  function walk(node, parent) {
    const [id, kind, kids] = node;
    nodes[id] = { id, parentId: parent, children: [], kind: kind === 'a' ? 'agent' : 'turn' };
    if (parent) nodes[parent].children.push(id);
    else root = id;
    (kids || []).forEach((k) => walk(k, id));
  }
  walk(spec, null);
  return { nodes, root };
}

function measure(label, spec, heights) {
  const { nodes, root } = mk(spec);
  const hs = heights || {};
  const t0 = process.hrtime.bigint();
  const r = layoutTree(nodes, root, hs, { nodeW: W, widths: {} });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  // overlap check
  let overlaps = 0;
  const ids = Object.keys(r.pos);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = r.pos[ids[i]], b = r.pos[ids[j]];
      const aw = W, ah = hs[ids[i]] || 120, bw = W, bh = hs[ids[j]] || 120;
      const ix = Math.min(a.x + aw, b.x + bw) - Math.max(a.x, b.x);
      const iy = Math.min(a.y + ah, b.y + bh) - Math.max(a.y, b.y);
      if (ix > 0 && iy > 0) overlaps++;
    }
  }
  console.log(
    `${label.padEnd(26)} nodes=${String(ids.length).padStart(3)} ` +
      `canvas=${Math.round(r.width)}x${Math.round(r.height)} ` +
      `area=${(r.width * r.height / 1e6).toFixed(2)}M ` +
      `overlaps=${overlaps} ${ms.toFixed(1)}ms`,
  );
  return { label, w: r.width, h: r.height, area: r.width * r.height, overlaps };
}

// 1. long chain (10 turns)
let chain = ['t9', 't'];
for (let i = 8; i >= 0; i--) chain = [`t${i}`, 't', [chain]];
// 2. fan-out: root -> 5 branches -> 3 each
const fan = ['r', 't', Array.from({ length: 5 }, (_, i) => [`r${i}`, 't', Array.from({ length: 3 }, (_, j) => [`r${i}${j}`, 't'])])];
// 3. chain with one sub-agent per turn (the common harness shape)
let agentChain = ['a0', 't'];
let cur = agentChain;
for (let i = 1; i < 6; i++) {
  const next = [`a${i}`, 't', [[`a${i}s`, 'a']]];
  cur[2] = [next];
  cur = next;
}
// 4. deep agent: turn -> agent -> agent (depth 2)
const deepAgent = ['d0', 't', [['d0a', 'a', [['d0aa', 'a']]], ['d1', 't', [['d1a', 'a']]]]];
// 5. wide + tall mixed (tall cards)
const tall = ['m0', 't', [['m1', 't', [['m2', 't']]], ['m1a', 'a', [['m1a1', 'a']]]]];

const res = [];
res.push(measure('chain-10', chain));
res.push(measure('fan-5x3', fan));
res.push(measure('chain+subagent-6', agentChain));
res.push(measure('deep-agent', deepAgent));
res.push(measure('tall-cards', tall, { m1: 900, m2: 1400, m1a: 700 }));
console.log('\nbaseline written to baseline.json');
fs.writeFileSync(path.join(__dirname, 'baseline.json'), JSON.stringify(res, null, 2));
