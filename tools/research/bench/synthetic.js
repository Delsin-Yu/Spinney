'use strict';
/*
 * Synthetic session trees mimicking real MinimalHost chat trees.
 *
 * Model (same shape media/tree.js consumes):
 *   nodesById[id] = { id, children: [ids], kind: 'turn'|'agent' }
 *   heights[id], widths[id]  -> measured card size
 *
 * Real sessions mix: long turn chains, fan-out branches (2-6), sub-agent
 * sidecars at depth 1 and 2 (a sub-agent's own turns + nested sub-agents), and
 * cards of very different sizes (default 320x120, wide up to ~900, tall up to
 * ~2000).
 */

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEF_W = 320;
const DEF_H = 120;

function makeTree() {
  return { nodesById: Object.create(null), heights: {}, widths: {} };
}

function pickSize(rng, o) {
  let w = DEF_W;
  let h = DEF_H;
  if (rng() < (o.wideProb || 0)) w = 400 + Math.round((rng() * 500) / 20) * 20;      // 400..900
  if (rng() < (o.tallProb || 0)) h = 600 + Math.round((rng() * 1400) / 20) * 20;      // 600..2000
  else if (rng() < (o.medTallProb || 0)) h = 200 + Math.round((rng() * 320) / 20) * 20; // 200..520
  return { w, h };
}

/**
 * @param {number} n      exact node count
 * @param {number} seed
 * @param {object} o      profile knobs:
 *   chainProb      prob. of a single turn child instead of a fan-out
 *   maxFanout      max turn children when fanning out (2..maxFanout+1)
 *   agentProb      prob. a turn node spawns agent sidecars
 *   maxAgents      max depth-1 agent sidecars per turn node
 *   agentTurnProb  prob. an agent node has its own turn chain
 *   agentTurnMax   max turn children of an agent node
 *   nestedAgentProb prob. an agent node spawns depth-2 agent sidecars
 *   tallProb/medTallProb/wideProb  size distribution
 */
function buildSession(n, seed, o) {
  const rng = mulberry32(seed);
  const t = makeTree();
  let count = 0;
  const add = (kind) => {
    const id = 'n' + count;
    const s = pickSize(rng, o);
    t.nodesById[id] = { id, children: [], kind, parentId: '' };
    t.widths[id] = s.w;
    t.heights[id] = s.h;
    count++;
    return id;
  };
  const link = (p, c) => {
    t.nodesById[p].children.push(c);
    t.nodesById[c].parentId = p;
  };

  const root = add('turn');
  const q = [root];
  while (count < n) {
    const p = q.length ? q.shift() : root;
    // --- turn children (chain or fan-out) ---
    const fan = rng() < (o.chainProb || 0) ? 1 : 1 + Math.floor(rng() * (o.maxFanout || 1));
    for (let j = 0; j < fan && count < n; j++) {
      const id = add('turn');
      link(p, id);
      q.push(id);
    }
    // --- depth-1 agent sidecars ---
    if (count < n && rng() < (o.agentProb || 0)) {
      const na = 1 + Math.floor(rng() * (o.maxAgents || 1));
      for (let j = 0; j < na && count < n; j++) {
        const a = add('agent');
        link(p, a);
        // the sub-agent does its own turn work (hangs below the agent card)
        if (count < n && rng() < (o.agentTurnProb || 0)) {
          const k = 1 + Math.floor(rng() * (o.agentTurnMax || 1));
          let cur = a;
          for (let m = 0; m < k && count < n; m++) {
            const id = add('turn');
            link(cur, id);
            cur = id;
          }
        }
        // depth-2 nested sub-agent
        if (count < n && rng() < (o.nestedAgentProb || 0)) {
          const k = 1 + Math.floor(rng() * 2);
          for (let m = 0; m < k && count < n; m++) {
            const id = add('agent');
            link(a, id);
            if (count < n && rng() < 0.5) {
              const id2 = add('turn');
              link(id, id2);
            }
          }
        }
      }
    }
    if (!q.length && count < n) q.push(p); // keep growing even if the frontier drained
  }
  return t;
}

const PROFILES = {
  chain: { chainProb: 1, maxFanout: 0, agentProb: 0, tallProb: 0, wideProb: 0 },
  fanout: { chainProb: 0, maxFanout: 5, agentProb: 0, medTallProb: 0.15, wideProb: 0.1 },
  sidecars: {
    chainProb: 0.5, maxFanout: 2, agentProb: 0.8, maxAgents: 3,
    agentTurnProb: 0.6, agentTurnMax: 2, nestedAgentProb: 0.3,
    tallProb: 0.03, medTallProb: 0.15, wideProb: 0.1,
  },
  mixed: {
    chainProb: 0.35, maxFanout: 4, agentProb: 0.6, maxAgents: 3,
    agentTurnProb: 0.5, agentTurnMax: 3, nestedAgentProb: 0.35,
    tallProb: 0.07, medTallProb: 0.15, wideProb: 0.12,
  },
  tall: {
    chainProb: 0.5, maxFanout: 2, agentProb: 0.4, maxAgents: 2,
    agentTurnProb: 0.4, agentTurnMax: 2, nestedAgentProb: 0.2,
    tallProb: 0.3, medTallProb: 0.2, wideProb: 0.05,
  },
};

const SIZES = [10, 30, 100, 300];

function scenarios() {
  const out = [];
  for (const name of Object.keys(PROFILES)) {
    for (const n of SIZES) {
      out.push({ name, n, tree: buildSession(n, 0x9e3779b9 ^ (n * 7919) ^ name.length * 104729, PROFILES[name]) });
    }
  }
  return out;
}

module.exports = { buildSession, PROFILES, SIZES, scenarios, makeTree, DEF_W, DEF_H };
