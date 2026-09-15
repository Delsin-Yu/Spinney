/*
 * check-context-rollover — the context-rollover feature's *pure* half, as a
 * build-time guard (`docs/agents/invariants/context-rollover.md` §1, §2, §3, §10).
 *
 * Protects the one semantic delta of a rollover: a branch's **API prefix** is cut
 * at its context base (the nearest ancestor-or-self whose `contextBaseId` is its own
 * id), while the **display** path (`pathIds`, the cards, the transcript meta) stays
 * the full chain. It also pins the trigger: `parseContextLengthError` reads the
 * provider's 400, and nothing else may start a rollover.
 *
 * Why it exists: both rules are invisible until a real window fills up. A wrong cut
 * silently sends either the whole dead history (the 1.28M-token bug of
 * `chat-tree.md`) or nothing at all, and `contextBaseId` is validated only by a
 * self-equality test — so a foreign/stale stored value must be a *provable* no-op
 * rather than a repair pass.
 *
 * Needs `out/` (run `npm run compile` first: it requires the compiled modules).
 *
 * Run: npm run check:rollover   /   node tools/check-context-rollover.js
 */
const path = require('path');
const T = require(path.join(__dirname, '..', 'out', 'chat', 'tree.js'));
const M = require(path.join(__dirname, '..', 'out', 'agent', 'models.js'));

const problems = [];
const ok = (label, cond, detail) => {
  if (cond) console.log(`  [ok  ] ${label}${detail ? '  (' + detail + ')' : ''}`);
  else {
    console.log(`  [FAIL] ${label}${detail ? '  (' + detail + ')' : ''}`);
    problems.push(label);
  }
};

const msg = (text) => ({ role: 'user', content: text });
const text = (messages) => messages.map((m) => String(m.content)).join('|');

const turnNode = (id, parentId, contents, extra = {}) => ({
  id,
  parentId,
  children: [],
  messages: contents.map(msg),
  displayItems: [],
  status: 'done',
  title: id,
  createdAt: 1,
  ...extra,
});

/** Build a session from nodes listed parent-first (children get linked for realism). */
const session = (nodes, rootId, activeNodeId) => {
  const map = {};
  const order = [];
  for (const node of nodes) {
    map[node.id] = node;
    order.push(node.id);
  }
  for (const id of order) {
    const node = map[id];
    if (node.parentId && map[node.parentId]) {
      map[node.parentId].children.push(id);
    }
  }
  return {
    id: 'sess-1',
    title: 'rollover',
    createdAt: 1,
    updatedAt: 2,
    nodes: map,
    rootId,
    activeNodeId: activeNodeId ?? null,
    orphanItems: [],
  };
};

/** root a → b → c → d, each node contributing one or two user messages. */
const chain = (marks = {}) =>
  session(
    [
      turnNode('a', null, ['a1', 'a2']),
      turnNode('b', 'a', ['b1'], marks.b),
      turnNode('c', 'b', ['c1'], marks.c),
      turnNode('d', 'c', ['d1'], marks.d),
    ],
    'a',
    'd',
  );

// ---- §1: the API prefix is cut at the context base, the display path is not ----

console.log('-- a branch with no window marker sends the whole chain --');
const plain = chain();
ok('every ancestor message is sent', text(T.pathMessages(plain, 'd')) === 'a1|a2|b1|c1|d1', text(T.pathMessages(plain, 'd')));
ok('contextBase() is undefined without a marker', T.contextBase(plain, 'd') === undefined, String(T.contextBase(plain, 'd')));

console.log('-- sidecars stay out of the prefix --');
const withSidecars = session(
  [
    turnNode('r', null, ['r1']),
    turnNode('sa', 'r', ['sub-agent-only'], { kind: 'agent', agentStatus: 'done' }),
    turnNode('k', 'sa', ['k1']),
  ],
  'r',
  'k',
);
ok(
  'a sidecar on the parent chain contributes nothing',
  text(T.pathMessages(withSidecars, 'k')) === 'r1|k1',
  text(T.pathMessages(withSidecars, 'k')),
);

console.log('-- a rollover cuts the prefix at its own node --');
const oneWindow = chain({ b: { contextBaseId: 'b' } });
ok('the prefix starts at the rollover node', text(T.pathMessages(oneWindow, 'd')) === 'b1|c1|d1', text(T.pathMessages(oneWindow, 'd')));
ok('  … with the rollover node\'s own messages included', text(T.pathMessages(oneWindow, 'b')) === 'b1');
ok('  … and the ancestors above the base dropped', !text(T.pathMessages(oneWindow, 'd')).includes('a1'));
ok('contextBase() names the window node', T.contextBase(oneWindow, 'd') === 'b', String(T.contextBase(oneWindow, 'd')));
ok('a descendant inherits the base', T.contextBase(oneWindow, 'c') === 'b' && text(T.pathMessages(oneWindow, 'c')) === 'b1|c1');
ok('the node above the base keeps its own history', text(T.pathMessages(oneWindow, 'a')) === 'a1|a2', text(T.pathMessages(oneWindow, 'a')));
ok('the graph below the base is untouched', text(T.pathMessages(oneWindow, 'd')).endsWith('d1'));

console.log('-- two windows: the nearest base wins --');
const twoWindows = chain({ b: { contextBaseId: 'b' }, c: { contextBaseId: 'c' } });
ok('a second rollover cuts at the nearest base only', text(T.pathMessages(twoWindows, 'd')) === 'c1|d1', text(T.pathMessages(twoWindows, 'd')));
ok('  … the outer window is not re-entered', !text(T.pathMessages(twoWindows, 'd')).includes('b1'));
ok('each window node is its own base', T.contextBase(twoWindows, 'b') === 'b' && T.contextBase(twoWindows, 'c') === 'c');
ok('the deepest node resolves to the inner window', T.contextBase(twoWindows, 'd') === 'c', String(T.contextBase(twoWindows, 'd')));

console.log('-- a marker that is not the node\'s own id has NO effect (read-time validation) --');
const foreign = chain({ b: { contextBaseId: 'a' } });
ok('naming another node on the chain is ignored', text(T.pathMessages(foreign, 'd')) === 'a1|a2|b1|c1|d1', text(T.pathMessages(foreign, 'd')));
ok('  … and contextBase() returns undefined', T.contextBase(foreign, 'd') === undefined);
const ghost = chain({ c: { contextBaseId: 'zzz-deleted' } });
ok('naming a node that is not on the chain is ignored', text(T.pathMessages(ghost, 'd')) === 'a1|a2|b1|c1|d1', text(T.pathMessages(ghost, 'd')));
const offChain = session(
  [
    turnNode('a', null, ['a1']),
    turnNode('b', 'a', ['b1'], { contextBaseId: 'b' }),
    turnNode('c', 'b', ['c1']),
    // a sibling branch that opens its own window must not cut the b → c chain
    turnNode('x', 'a', ['x1'], { contextBaseId: 'x' }),
  ],
  'a',
  'x',
);
ok('a window on another branch does not cut this one', text(T.pathMessages(offChain, 'c')) === 'b1|c1', text(T.pathMessages(offChain, 'c')));

console.log('-- contextBaseId never moves a card: pathIds() is the full chain --');
ok('pathIds() ignores the marker', T.pathIds(twoWindows, 'd').join(',') === 'a,b,c,d', T.pathIds(twoWindows, 'd').join(','));
ok('  … including at the window node itself', T.pathIds(oneWindow, 'b').join(',') === 'a,b', T.pathIds(oneWindow, 'b').join(','));
ok('leafOf() still walks the whole chain', T.leafOf(twoWindows, 'a') === 'd', String(T.leafOf(twoWindows, 'a')));

console.log('-- a window node whose own turn is only the harness message --');
const harnessOnly = session(
  [
    turnNode('p', null, ['the oversized turn']),
    turnNode('h', 'p', ['[Harness: context window reset] …'], { contextBaseId: 'h' }),
  ],
  'p',
  'h',
);
const harnessPath = T.pathMessages(harnessOnly, 'h');
ok(
  'the fresh window sends exactly its harness message',
  harnessPath.length === 1 && String(harnessPath[0].content).startsWith('[Harness: context window reset]'),
  `${harnessPath.length} message(s)`,
);
ok('  … and the overflowing ancestor is not sent', !JSON.stringify(harnessPath).includes('oversized'));

// ---- §2: the field is optional, string-only, and survives a load unchanged ----

console.log('-- the field round-trips through a restart (no version bump) --');
const raw = {
  activeSessionId: 'sess-1',
  sessions: [
    {
      id: 'sess-1',
      title: 'rollover persistence',
      createdAt: 1,
      updatedAt: 2,
      rootId: 'a',
      activeNodeId: 'g',
      orphanItems: [],
      nodes: {
        a: turnNode('a', null, ['a1']),
        b: { ...turnNode('b', 'a', ['b1']), contextBaseId: 'b' },
        g: { ...turnNode('g', 'b', ['g1']), contextBaseId: 42 },
      },
    },
  ],
};
const { sessions } = T.migrateState(raw);
const loaded = sessions[0];
ok('a string contextBaseId is kept', loaded.nodes.b && loaded.nodes.b.contextBaseId === 'b', String(loaded.nodes.b && loaded.nodes.b.contextBaseId));
ok('a non-string contextBaseId is dropped', loaded.nodes.g && loaded.nodes.g.contextBaseId === undefined);
ok('  … and the loaded session still cuts at the base', text(T.pathMessages(loaded, 'b')) === 'b1', text(T.pathMessages(loaded, 'b')));
ok('  … so the marker is read, never repaired', T.contextBase(loaded, 'g') === 'b', String(T.contextBase(loaded, 'g')));

// ---- §3: the provider's 400 is the only trigger ----

console.log('-- parseContextLengthError reads the real provider sentence --');
const P = M.parseContextLengthError;
const real =
  "This model's maximum context length is 1,048,576 tokens. However, you requested 1,283,056 tokens (1,223,056 in the messages, 60,000 in the completion).";
const parsed = P(real);
ok('the window is read', !!parsed && parsed.window === 1048576, parsed && String(parsed.window));
ok('the refused size is read', !!parsed && parsed.requested === 1283056, parsed && String(parsed.requested));
ok('thousands separators are stripped', JSON.stringify(parsed) === '{"window":1048576,"requested":1283056}', JSON.stringify(parsed));
ok('  … and the 400\'s window matches the vendored catalog', !!parsed && parsed.window === M.VENDORED_MODEL.contextWindow);
ok('casing and whitespace are tolerated', (() => {
  const p = P("THIS MODEL'S MAXIMUM\n   CONTEXT LENGTH IS 1048576 TOKENS.\nHOWEVER, YOU REQUESTED 2097152");
  return !!p && p.window === 1048576 && p.requested === 2097152;
})());

console.log('-- a reworded provider still rolls over --');
const rewordedNumbers = '{"error":{"code":"context_length_exceeded","message":"context length 131072 exceeded by requested 150000 tokens"}}';
const p1 = P(rewordedNumbers);
ok('context_length_exceeded: the numbers are read', !!p1 && p1.window === 131072 && p1.requested === 150000, JSON.stringify(p1));
const rewordedProse = 'Error: too many tokens in the request — please reduce the length of the input.';
const p2 = P(rewordedProse);
ok('reworded prose is still a trigger', p2 !== undefined, rewordedProse);
ok('  … exposing both fields as undefined (no numbers to read)', !!p2 && p2.window === undefined && p2.requested === undefined);
ok('the parsed window never leaks into the model table', M.contextWindowFor('deepseek-flash') === M.DEFAULT_CONTEXT_WINDOW, String(M.contextWindowFor('deepseek-flash')));
ok('  … and nothing was installed as an override', M.modelIds().length === M.MODEL_CATALOG.length, M.modelIds().join(','));

console.log('-- an ordinary failure is never a context-length error --');
ok('a stalled stream is not', P('DeepSeek stream stalled') === undefined);
ok('a 401 body is not', P('{"error":{"message":"Authentication Fails, Your api key is invalid","type":"authentication_error","code":"invalid_api_key"}}') === undefined);
ok('the max_tokens 400 is not', P('Invalid max_tokens value, the valid range of max_tokens is [1, 393216]') === undefined);
ok('empty text is not', P('') === undefined);

console.log('');
if (problems.length) {
  console.log(`FAIL context-rollover: ${problems.length} check(s) failed`);
  process.exit(1);
}
console.log('PASS context-rollover: the prefix cuts at the context base (display path unchanged), and only the provider 400 triggers a rollover');
