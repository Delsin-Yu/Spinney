'use strict';
// Scan every workspace-storage DB for harness sessions, so we can find the real
// session the user is looking at (the one with many sub-agent nodes).
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const KEY = 'minimal-host.minimal-agent-harness';
const base = process.env.APPDATA.replace(/\\/g, '/') + '/Code/User/workspaceStorage';

function readState(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let row;
  try {
    row = db.prepare('SELECT value FROM ItemTable WHERE key=?').get(KEY);
  } catch (e) {
    db.close();
    return null;
  }
  db.close();
  return row ? JSON.parse(row.value) : null;
}

const needle = (process.argv[2] || '').toLowerCase();

for (const dir of fs.readdirSync(base)) {
  const dbPath = path.join(base, dir, 'state.vscdb');
  if (!fs.existsSync(dbPath)) continue;
  let ws = '';
  try {
    ws = JSON.parse(fs.readFileSync(path.join(base, dir, 'workspace.json'), 'utf8')).folder || '';
  } catch (e) {
    /* ignore */
  }
  let state;
  try {
    state = readState(dbPath);
  } catch (e) {
    console.log('SKIP', dir, e.message);
    continue;
  }
  if (!state) continue;
  const inner = state['agentHarness.state'] || state;
  const sessions = inner.sessions || {};
  const list = Array.isArray(sessions) ? sessions : Object.values(sessions);
  const interesting = list
    .map((s) => {
      const nodes = Array.isArray(s.nodes) ? s.nodes : Object.values(s.nodes || {});
      const agents = nodes.filter((n) => n.kind === 'agent').length;
      return { s, nodes: nodes.length, agents };
    })
    .filter((x) => x.nodes > 0);
  if (!interesting.length) continue;
  console.log(`\n=== ${dir}  ${decodeURIComponent(ws)}`);
  for (const x of interesting) {
    const title = String(x.s.title || x.s.name || '').slice(0, 60);
    const hit = needle && title.toLowerCase().includes(needle) ? '  <<< MATCH' : '';
    console.log(
      `  id=${String(x.s.id || '').slice(0, 12)} nodes=${String(x.nodes).padStart(3)} agents=${String(x.agents).padStart(3)} | ${title}${hit}`,
    );
  }
}
