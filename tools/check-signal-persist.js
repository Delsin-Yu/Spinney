/*
 * check-signal-persist — the completion-signal work's *persistence* half, as a
 * build-time guard (the completion-signal plan, §0.1 / D1).
 *
 * Round-trips a persisted session through `migrateState` (the exact load path
 * `ChatViewProvider.loadSessions` uses) and asserts that a `kind:'bg'` card
 * survives a restart with its `delivered` flag and terminal-state snapshot
 * intact, that a `bg` card never claims to be running after a restart, and that
 * both sidecar kinds stay out of the API path / checkout chain.
 *
 * Needs `out/` (run `npm run compile` first: it requires the compiled tree module).
 *
 * Run: npm run check:signals   /   node tools/check-signal-persist.js
 */
const path = require('path');
const T = require(path.join(__dirname, '..', 'out', 'chat', 'tree.js'));

const problems = [];
const ok = (label, cond, detail) => {
  if (cond) console.log(`  [ok  ] ${label}${detail ? '  (' + detail + ')' : ''}`);
  else {
    console.log(`  [FAIL] ${label}${detail ? '  (' + detail + ')' : ''}`);
    problems.push(label);
  }
};

const turnNode = (id, parentId, title) => ({
  id, parentId, children: [], messages: [{ role: 'user', content: title }], displayItems: [],
  status: 'done', title, createdAt: 1,
});
const bgNode = (id, parentId, status, extra = {}) => ({
  id, parentId, children: [], messages: [], displayItems: [{ kind: 'background', name: 'sleep 5', doneText: 'exit 0' }],
  status, title: 'sleep 5', createdAt: 2, kind: 'bg', bgTaskId: 7, bgCommand: 'sleep 5', bgExitCode: 0,
  bgKilled: false, bgElapsedMs: 5000, bgOutputTail: 'tail text', ...extra,
});

const raw = {
  activeSessionId: 'sess-1',
  sessions: [
    {
      id: 'sess-1',
      title: 'persistence round trip',
      createdAt: 1,
      updatedAt: 2,
      rootId: 'root',
      activeNodeId: 'bg-done',
      orphanItems: [],
      nodes: {
        root: {
          ...turnNode('root', null, 'root turn'),
          children: ['bg-done', 'bg-running', 'agent', 'next'],
        },
        'bg-done': { ...bgNode('bg-done', 'root', 'done'), delivered: true },
        'bg-running': bgNode('bg-running', 'root', 'running'),
        agent: {
          ...turnNode('agent', 'root', 'sub-agent'),
          kind: 'agent', agentStatus: 'done', agentSummary: 'summary', delivered: true,
          messages: [{ role: 'user', content: 'sidecar-only history' }],
        },
        next: {
          ...turnNode('next', 'root', 'next turn'),
          messages: [{ role: 'user', content: 'next' }],
        },
      },
    },
  ],
};

const { sessions } = T.migrateState(raw);
const s = sessions[0];
const n = s.nodes;

console.log('-- the bg card survives a restart as a record (D1) --');
ok('the delivered card is still there', !!n['bg-done']);
ok('  … and is still kind:bg', n['bg-done'] && n['bg-done'].kind === 'bg');
ok('  … and still delivered', n['bg-done'] && n['bg-done'].delivered === true);
ok(
  '  … with its terminal snapshot intact',
  n['bg-done'] &&
    n['bg-done'].bgTaskId === 7 &&
    n['bg-done'].bgExitCode === 0 &&
    n['bg-done'].bgElapsedMs === 5000 &&
    n['bg-done'].bgOutputTail === 'tail text' &&
    n['bg-done'].bgCommand === 'sleep 5',
  n['bg-done'] && `${n['bg-done'].bgCommand} · exit ${n['bg-done'].bgExitCode} · ${n['bg-done'].bgOutputTail}`,
);
ok('  … and the .bgnotify block is still in its transcript', (n['bg-done'].displayItems || []).some((i) => i.kind === 'background'));

console.log('-- a card that was mid-flight when the host died --');
ok('a still-running bg card stops claiming to run', n['bg-running'] && n['bg-running'].status !== 'running', n['bg-running'] && n['bg-running'].status);
ok('  … and is marked delivered (its notice can never arrive)', n['bg-running'] && n['bg-running'].delivered === true);

console.log('-- sidecars stay out of the API path and the checkout chain --');
ok('the sub-agent card keeps delivered', n.agent && n.agent.delivered === true);
ok('isSidecar() covers both kinds', T.isSidecar(n['bg-done']) && T.isSidecar(n.agent) && !T.isSidecar(n.next));
const path2 = T.pathMessages(s, 'next').map((m) => String(m.content));
ok('pathMessages() skips the sidecars', path2.join('|') === 'root turn|next', path2.join('|'));
ok('leafOf() never lands on a sidecar', T.leafOf(s, 'root') === 'next', String(T.leafOf(s, 'root')));
ok('branchIds() still includes the cards (they die with the branch)', T.branchIds(s, 'root').includes('bg-done'));

console.log('');
if (problems.length) {
  console.log(`FAIL signal-persist: ${problems.length} check(s) failed`);
  process.exit(1);
}
console.log('PASS signal-persist: the bg card + delivered flag survive a restart; sidecars stay off the API path');
