'use strict';
/*
 * Load the live harness state (workspace storage sqlite) and inspect the real
 * chat-tree geometry that users actually see.
 *
 *   node analyze-session.js list
 *   node analyze-session.js dump <sessionIndex>
 *   node analyze-session.js check <sessionIndex> [--heights=flat|heuristic]
 */
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB = process.env.TEMP.replace(/\\/g, '/') + '/hstate.vscdb';
const KEY = 'minimal-host.minimal-agent-harness';

function loadState() {
  const db = new DatabaseSync(DB, { readOnly: true });
  const row = db.prepare('SELECT value FROM ItemTable WHERE key=?').get(KEY);
  db.close();
  return JSON.parse(row.value);
}

function sessionsOf(state) {
  const inner = state['agentHarness.state'] || state;
  const s = inner.sessions || inner.chatSessions || inner;
  return Array.isArray(s) ? s : Object.keys(s).map((k) => s[k]);
}

function innerState(state) {
  return state['agentHarness.state'] || state;
}

function nodesOf(session) {
  const raw = session.nodes || session.nodesById || {};
  return Array.isArray(raw) ? raw : Object.values(raw);
}

const cmd = process.argv[2] || 'list';
const state = loadState();
const sessions = sessionsOf(state);

if (cmd === 'list') {
  console.log('top-level keys:', Object.keys(state).join(', '));
  console.log('inner keys:', Object.keys(innerState(state)).join(', '));
  sessions.forEach((s, i) => {
    const nodes = nodesOf(s);
    const kinds = {};
    for (const n of nodes) kinds[n.kind || 'turn'] = (kinds[n.kind || 'turn'] || 0) + 1;
    const title = String(s.title || s.name || '').slice(0, 70);
    console.log(
      `[${i}] id=${String(s.id || '').slice(0, 10)} nodes=${nodes.length} ` +
        `kinds=${JSON.stringify(kinds)} msgs=${(s.messages || []).length} | ${title}`,
    );
  });
  process.exit(0);
}

const idx = Number(process.argv[3] || 0);
const session = sessions[idx];
if (!session) {
  console.error('no session at index', idx);
  process.exit(1);
}

const nodes = nodesOf(session);
console.log('session nodes:', nodes.length);
console.log('sample node:', JSON.stringify(nodes.find((n) => n.kind === 'agent') || nodes[0], null, 1).slice(0, 900));

if (cmd === 'dump') {
  const fs = require('fs');
  fs.writeFileSync(path.join(__dirname, 'session-dump.json'), JSON.stringify(session, null, 1));
  console.log('wrote session-dump.json');
}
