/*
 * rollover-acceptance — the context rollover's *runtime* half, as a dev-only
 * acceptance run (not a build guard, and not shipped in the `.vsix`).
 *
 * The build guards can only reach the pure modules (`tree.ts`, `models.ts`,
 * `media/main.js`). Everything risky about a rollover lives in `SessionRuntime`:
 * that the new window's first request really carries no ancestor history, that the
 * node's leftover work is union-killed while another node's job is left alone, that
 * the kill notices land in the old node's history *and* in its re-dumped transcript,
 * that the carried-over tail / clip notes / attachment count are in the message, and
 * that a node which is not context-full falls back to an in-place continue.
 *
 * To reach that without a window it stubs the `vscode` module (a `Module._load`
 * hook) and drives one runtime per case with an offline client, so nothing is sent
 * to a provider. It therefore reads a few private fields (`runs`, `writebacks`,
 * `nodeWorkers`, `post`, `setBusy`) — a refactor may break this file; the product is
 * never affected by its failure.
 *
 * Needs `out/` (run `npm run compile` first), no network, no window:
 *   node tools/rollover-acceptance.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const ROOT = process.argv[2] || 'd:/Repos/MinimalHost';
const problems = [];
const ok = (label, cond, detail) => {
  console.log(`  [${cond ? 'ok  ' : 'FAIL'}] ${label}${detail ? '  (' + detail + ')' : ''}`);
  if (!cond) problems.push(label);
};

const vscodeStub = {
  l10n: { t: (s, ...args) => String(s).replace(/\{(\d+)\}/g, (_, i) => String(args[i] ?? '')) },
  env: { language: 'en' },
  window: {
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, dispose() {}, clear() {} }),
  },
  workspace: {
    getConfiguration: () => ({ get: () => undefined, update: async () => undefined, has: () => false }),
    workspaceFolders: [],
  },
  Uri: { file: (p) => ({ fsPath: p, scheme: 'file', toString: () => String(p) }) },
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} },
  Disposable: class { constructor(fn) { this.fn = fn; } dispose() { this.fn && this.fn(); } },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { One: 1, Active: -1, Beside: 2 },
  extensions: { getExtension: () => undefined },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => undefined },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.call(this, request, parent, isMain);
};

const R = require(path.join(ROOT, 'out', 'chat', 'runtime.js'));
const T = require(path.join(ROOT, 'out', 'chat', 'tree.js'));
const M = require(path.join(ROOT, 'out', 'agent', 'models.js'));
const { ClientRegistry } = require(path.join(ROOT, 'out', 'agent', 'clients.js'));
const { BackgroundHub } = require(path.join(ROOT, 'out', 'chat', 'backgroundHub.js'));
const { DeepSeekClient } = require(path.join(ROOT, 'out', 'agent', 'deepseek.js'));

DeepSeekClient.prototype.stream = async function* () {
  throw new Error('offline (acceptance run)');
};

// One deterministic provider + model card, so a runtime resolves to a known card
// instead of the built-in fallback (whose provider would be the real API host).
const TEST_CARD_ID = 'test-card';
M.setCatalog(
  [{ id: 'test-provider', name: 'test', baseUrl: 'http://127.0.0.1:1', concurrency: 0 }],
  [
    {
      id: TEST_CARD_ID,
      name: 'test-model',
      providerId: 'test-provider',
      oaiModel: 'test-model',
      contextWindow: 1048576,
      vision: { enabled: true, transport: 'deepseek' },
      efforts: ['none', 'low', 'medium', 'high'],
      defaultEffort: 'medium',
      concurrency: 0,
    },
  ],
);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rollover-'));
const dumps = [];
const messages = [];
let saveTranscripts = true;

const host = new Proxy(
  {
    transcriptRoot: () => TMP,
    transcriptDir: (sid) => path.join(TMP, sid),
    dumpSessionTranscript: (node, session, status) => {
      dumps.push({ nodeId: node.id, status, contextBaseId: node.contextBaseId, messages: node.messages.slice() });
      const dir = path.join(TMP, session.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, node.id + ".jsonl"), node.messages.map((m) => JSON.stringify(m)).join(String.fromCharCode(10)) + String.fromCharCode(10));
    },
    writeSubAgentTranscript: () => undefined,
    getConfig: () => ({
      saveSessionTranscripts: saveTranscripts,
      saveSubAgentTranscripts: true,
      subAgentTranscriptDir: '',
      maxConcurrentSubagents: 4,
      maxLevel2Subagents: 4,
      autoSessionTitles: false,
      foldToolCalls: true,
      foldThinking: true,
      defaultCardId: TEST_CARD_ID,
      replyLanguage: 'English',
    }),
    isHeld: () => false,
    disposed: false,
    output: { appendLine() {} },
    stateChanged: () => undefined,
    postTo: () => undefined,
    systemPrompt: () => 'SYSTEM-PROMPT-TEXT',
    resolveModel: (m) => m,
    getContextWindow: () => 1048576,
  },
  {
    get(target, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (prop in target) return target[prop];
      return () => undefined;
    },
  },
);

const mkNode = (id, parentId, msgs, extra = {}) =>
  Object.assign(T.createNode(id, parentId, id, 'done'), { messages: msgs }, extra);

function makeSession() {
  const session = {
    id: 'sess-live',
    title: 'live session',
    createdAt: 1,
    updatedAt: 1,
    nodes: {},
    rootId: null,
    activeNodeId: null,
    orphanItems: [],
  };
  const root = mkNode('root', null, [
    { role: 'user', content: 'ROOT-REQUEST-MARKER' },
    { role: 'assistant', content: 'root answer' },
  ]);
  T.attachNode(session, root);
  const overflow = mkNode(
    'p0',
    'root',
    [
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: 'half an answer' },
      { role: 'user', content: 'now FINISH-THE-JOB please' },
    ],
    {
      status: 'error',
      displayItems: [
        { kind: 'user', text: 'now FINISH-THE-JOB please' },
        {
          kind: 'assistant',
          error: true,
          text: "WARN This model's maximum context length is 1048576 tokens. However, you requested 1283056 tokens (1210000 in the messages).",
        },
      ],
    },
  );
  T.attachNode(session, overflow);
  session.activeNodeId = 'p0';
  return session;
}

function makeRuntime(session) {
  const hub = new BackgroundHub();
  const rt = new R.SessionRuntime(
    host,
    session,
    new ClientRegistry({ apiKeyFor: async () => 'x' }),
    TEST_CARD_ID,
    'medium',
    hub,
  );
  rt.post = (msg) => messages.push(msg);
  rt.setBusy = (b) => { rt.busy = b; };
  rt.host = host;
  return { rt, hub };
}

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('-- detection --');
  {
    const { rt } = makeRuntime(makeSession());
    ok('canRollover() is false for a node that did not fail', rt.canRollover('root') === false);
    ok('canRollover() is true for the overflowing node', rt.canRollover('p0') === true);
    const s2 = makeSession();
    s2.nodes.p0.displayItems[1].text = 'WARN DeepSeek stream stalled: first chunk.';
    const { rt: rt2 } = makeRuntime(s2);
    ok('an ordinary failure is NOT a rollover candidate', rt2.canRollover('p0') === false);
  }

  console.log('-- rollover: prefix, kill, record, message --');
  const session = makeSession();
  const { rt, hub } = makeRuntime(session);

  let childKilled = false;
  const handle = {
    child: { on() {} },
    kill() { childKilled = true; },
    getOutput: () => 'BUILD-OUTPUT-TAIL',
    isTruncated: () => false,
  };
  const jobId = hub.register({ sessionId: session.id, nodeId: 'p0' }, handle, 'npm run build', '.', false);
  let otherKilled = false;
  hub.register(
    { sessionId: session.id, nodeId: 'root' },
    { child: { on() {} }, kill() { otherKilled = true; }, getOutput: () => 'other', isTruncated: () => false },
    'sleep 100', '.', false,
  );
  ok('one job per node is registered', hub.listForNode(session.id, 'p0').length === 1 && hub.listForSession(session.id).length === 2);

  const handled = await rt.rolloverContext('p0');
  console.log('DEBUG p0 messages:', JSON.stringify(session.nodes.p0.messages.map((m) => m.role + ':' + (typeof m.content === 'string' ? m.content.slice(0, 110) : '[...]'))));
  console.log('DEBUG dumps:', dumps.map((d) => d.nodeId + '(' + d.messages.length + ')').join(' '));
  console.log('DEBUG internals:', JSON.stringify({ writebacks: [...rt.writebacks.keys()], dead: rt.dead, runP0: rt.runs.has('p0'), workerP0: rt.nodeWorkers.has('p0'), stopped: [...rt.stoppedLines], subs: [...rt.runningSubAgents.keys()] }));
  ok('rolloverContext() reports success', handled === true);

  const created = Object.values(session.nodes).filter((n) => n.parentId === 'p0');
  ok('exactly one new node was created', created.length === 1, created.map((n) => n.id).join(','));
  const roll = created[0];
  ok('the new node hangs BELOW the overflowing node', !!roll && roll.parentId === 'p0');
  ok('the new node starts its own context window', !!roll && roll.contextBaseId === roll.id, roll && roll.contextBaseId);
  ok('the title numbers the window', !!roll && roll.title === 'Context window 2', roll && roll.title);
  ok('the new node owns the view focus', session.activeNodeId === roll.id);
  ok('the overflowing node is no longer a candidate', rt.canRollover('p0') === false);
  ok('the tree payload marks the new node as a window start', messages.some((m) => m.type === 'tree' && m.nodes.some((n) => n.id === roll.id && n.contextBaseId === roll.id)));

  const run = rt.runs.get(roll.id);
  const sent = run && run.agent.getMessages();
  ok('a live run is bound to the new node', !!run);
  ok('the first request is [system, harness] only', !!sent && sent.length === 2, sent && sent.map((m) => m.role).join('+'));
  ok('  ... the ancestor history is NOT in it', !!sent && !JSON.stringify(sent).includes('ROOT-REQUEST-MARKER'));
  ok("  ... nor the overflowing node's earlier messages", !!sent && !JSON.stringify(sent).includes('do the thing'));
  ok('  ... only the harness message is a user message', !!sent && sent.filter((m) => m.role === 'user').length === 1);
  const text = sent && typeof sent[1].content === 'string' ? sent[1].content : '';
  ok('the message is the harness text', text.startsWith('[Harness: context window reset]'));
  ok('  ... it names the previous window', text.includes('Previous window: node p0 of session sess-live'));
  ok("  ... it points at the previous window's transcript", text.includes(path.join(TMP, 'sess-live', 'p0.jsonl')));
  ok("  ... it carries the user's last request verbatim", text.includes('now FINISH-THE-JOB please'));
  ok('  ... it carries the last answer verbatim (in the harness text only)', text.includes('half an answer'));
  ok('  ... it names the killed background terminal', text.includes('background terminal #' + jobId) && text.includes('npm run build'));
  ok('  ... and counts it', /\b1 background terminal\(s\)/.test(text));
  ok('  ... the system prompt is not stored in the node', !roll.messages.some((m) => m.role === 'system'));

  ok("the node's background terminal was killed", childKilled === true);
  ok("another node's job was left alone", otherKilled === false);
  ok('the job reads as stopped', hub.listForNode(session.id, 'p0')[0].killed === true);
  const lastMsg = session.nodes.p0.messages[session.nodes.p0.messages.length - 1];
  ok('the kill notice was written back into the overflowing node', lastMsg.role === 'user' && /Background command/.test(lastMsg.content));
  ok("  ... with the job's output tail (its only durable copy)", lastMsg.content.includes('BUILD-OUTPUT-TAIL'));

  const p0Dump = dumps.filter((d) => d.nodeId === 'p0').pop();
  ok('the overflowing node was re-dumped', !!p0Dump, dumps.map((d) => d.nodeId).join(','));
  ok('  ... and the dump holds the kill record', !!p0Dump && JSON.stringify(p0Dump.messages).includes('BUILD-OUTPUT-TAIL'));

  ok('the harness message was posted as a HARNESS block', messages.some((m) => m.type === 'harnessNote' && m.nodeId === roll.id));
  ok('the new node was panned to', messages.some((m) => m.type === 'panTo' && m.id === roll.id));

  await tick();
  const rollDump = dumps.filter((d) => d.nodeId === roll.id).pop();
  ok('the new node was dumped with its window marker', !!rollDump && rollDump.contextBaseId === roll.id);
  ok('  ... and its dump holds no ancestor message', !!rollDump && !JSON.stringify(rollDump.messages).includes('ROOT-REQUEST-MARKER'));

  console.log('-- degradation: no transcript on disk --');
  {
    saveTranscripts = false;
    const s = makeSession();
    const { rt: rt3 } = makeRuntime(s);
    await rt3.rolloverContext('p0');
    const r = Object.values(s.nodes).find((n) => n.parentId === 'p0');
    const t = rt3.runs.get(r.id).agent.getMessages()[1].content;
    ok('the pointer degrades to "not available on disk"', t.includes('not available on disk'));
    ok('  ... and the carried-over tail is still there', t.includes('now FINISH-THE-JOB please'));
    saveTranscripts = true;
  }

  console.log('-- fallback: not a context failure --');
  {
    const s = makeSession();
    s.nodes.p0.displayItems[1].text = 'WARN DeepSeek stream stalled.';
    const { rt: rt4 } = makeRuntime(s);
    const before = Object.keys(s.nodes).length;
    const marked = messages.length;
    const done = await rt4.rolloverContext('p0');
    ok('rolloverContext() still reports success (in-place continue)', done === true);
    ok('no new node was created', Object.keys(s.nodes).length === before, Object.keys(s.nodes).join(','));

    const note = messages.slice(marked).find((m) => m.type === 'harnessNote' && m.nodeId === 'p0');
    ok('the model got the retry note, not a window reset', !!note && note.text.includes('[Harness continue]') && !note.text.includes('context window reset'));
    await tick();
  }

  console.log('');
  if (problems.length === 0) {
    console.log('PASS rollover-acceptance: the new window sends no ancestor history, and the old line is union-killed and re-dumped');
  } else {
    console.log('FAIL ' + problems.length + ' problem(s):\n - ' + problems.join('\n - '));
  }
  process.exit(problems.length === 0 ? 0 : 1);
})().catch((err) => {
  console.error('ERROR', err);
  process.exit(2);
});
