/*
 * rollover-acceptance — the context rollover's *runtime* half, as a dev-only
 * acceptance run (not a build guard, and not shipped in the `.vsix`).
 *
 * The build guards can only reach the pure modules (`tree.ts`, `models.ts`,
 * `compaction.ts`, `media/main.js`). Everything risky about a window change lives in
 * `SessionRuntime`:
 *
 *  - **the Simple handoff**: pressing Compress creates a compression card with the pointer
 *    handoff and **no turn at all**; the old window's leftover work is union-killed while
 *    another node's job is left alone, and the kill notices land in the old node's history
 *    *and* in its re-dumped transcript;
 *  - **the window a send opens**: a message sent below a ready card opens a fresh window that
 *    carries no ancestor history, leads with the card's handoff, then the user's message, and
 *    inherits **P's** envelope rather than the card's (several windows, numbered in order);
 *  - **the compression card (Agentic)**: C is a real turn with its own context base, its own
 *    compression envelope and only the read-only tools, and the click opens nothing — C stores
 *    the handoff it wrote and stays there;
 *  - **the card's own edges**: a Stop or an empty answer writes no handoff (so a send is
 *    refused), a missing section still stores one, a card that carries a handoff refuses ▶,
 *    and a resume window cannot be deleted on its own.
 *
 * To reach that without a window it stubs the `vscode` module (a `Module._load` hook) and
 * drives one runtime per case with an offline, scripted client, so nothing is sent to a
 * provider. It therefore reads a few private fields (`runs`, `writebacks`, `nodeWorkers`,
 * `post`, `setBusy`) — a refactor may break this file; the product is never affected by its
 * failure.
 *
 * Needs `out/` (run `npm run compile` first), no network, no window:
 *   node tools/rollover-acceptance.js [repo-root]
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const ROOT = process.argv[2] || path.resolve(__dirname, '..');
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
const C = require(path.join(ROOT, 'out', 'agent', 'compaction.js'));
const P = require(path.join(ROOT, 'out', 'chat', 'ChatViewProvider.js'));
const { ClientRegistry } = require(path.join(ROOT, 'out', 'agent', 'clients.js'));
const { BackgroundHub } = require(path.join(ROOT, 'out', 'chat', 'backgroundHub.js'));
const { ApiClient } = require(path.join(ROOT, 'out', 'agent', 'apiClient.js'));

// --- an offline client that records every request ------------------------------
const requests = [];
// What the next assistant turn answers. The compression chain needs a **real** turn to
// succeed (its answer is what the window below carries), so the stream is scripted rather
// than failing: a failing stream is the Stop / error half, which the cases below drive by
// switching this back to a throw.
let answerText = 'ok';
let failStream = false;
ApiClient.prototype.stream = async function* (request) {
  requests.push({
    messages: JSON.parse(JSON.stringify(request.messages ?? [])),
    tools: (request.tools ?? []).map((tool) => tool.function.name),
    model: request.model,
  });
  if (failStream) {
    throw new Error('offline (acceptance run)');
  }
  yield { choices: [{ delta: { content: answerText } }] };
  yield { choices: [{ delta: {} }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } };
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
      fs.writeFileSync(path.join(dir, node.id + '.jsonl'), node.messages.map((m) => JSON.stringify(m)).join('\n') + '\n');
    },
    writeSubAgentTranscript: () => undefined,
    getConfig: () => ({
      saveSessionTranscripts: saveTranscripts,
      saveSubAgentTranscripts: true,
      subAgentTranscriptDir: '',
      maxConcurrentSubagents: 4,
      maxLevel2Subagents: 4,
      autoSessionTitles: false,
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
    agentsMdSources: () => ({ global: null, workspace: null }),
  },
  {
    get(target, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (prop in target) return target[prop];
      return () => undefined;
    },
  },
);

/** The main chain's frozen envelope — P's window inherits it, and R must too. */
const mainEpoch = (id) => ({
  id,
  prompt: 'MAIN-SYSTEM-PROMPT',
  tools: [{ type: 'function', function: { name: 'read_file', description: 'x', parameters: { type: 'object', properties: {} } } }],
  cardId: TEST_CARD_ID,
  effort: 'medium',
  replyLanguage: 'English',
  providerId: 'test-provider',
  baseUrl: 'http://127.0.0.1:1',
  wireModel: 'test-model',
  vision: true,
  visionTransport: 'deepseek',
  agentsMdHash: 'main-agents-md-hash',
  templateHash: 'main-template-hash',
  toolsetHash: 'main-toolset-hash',
  frozenAt: 1,
});

const mkNode = (id, parentId, msgs, extra = {}) =>
  Object.assign(T.createNode(id, parentId, id, 'done'), { messages: msgs }, extra);

function makeSession() {
  const session = {
    id: 'sess-live',
    title: 'live session',
    createdAt: 1,
    updatedAt: 1,
    nodes: {},
    rootIds: [],
    activeNodeId: null,
    orphanItems: [],
  };
  // A real session's first window carries the frozen envelope and **no** `contextBaseId`
  // (`beginTurn` marks a node as a window only for a rollover), so the fixture does too: the
  // window numbers below are the ones a real session produces.
  const root = mkNode(
    'root',
    null,
    [
      { role: 'user', content: 'ROOT-REQUEST-MARKER' },
      { role: 'assistant', content: 'root answer' },
    ],
    { epoch: mainEpoch('epoch-main') },
  );
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
        { kind: 'user', text: 'do the thing' },
        { kind: 'tool', name: 'write_file', args: '{"path":"src/a.ts","content":"x"}' },
        { kind: 'tool', name: 'read_file', args: '{"path":"src/read-only.ts"}' },
        { kind: 'assistant', text: 'half an answer' },
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

/** The one node hanging below `parentId`, optionally of a role. */
const childOf = (session, parentId, role) =>
  Object.values(session.nodes).find((n) => n.parentId === parentId && (!role || n.role === role));

const HANDFF = C.COMPRESS_SECTIONS.map((heading) => `## ${heading}\n- a fact`).join('\n');

(async () => {
  console.log('-- detection --');
  {
    const { rt } = makeRuntime(makeSession());
    ok('canRollover() is false for a node that did not fail', rt.canRollover('root') === false);
    ok('canRollover() is true for the overflowing node', rt.canRollover('p0') === true);
    // `canCompress` is the structural rule only — no fill condition — so a card that already
    // continues below it is still a legitimate place to start another window (that is how the
    // two handoffs get compared).
    ok('canCompress() is true for the tip of the branch', rt.canCompress('p0') === true);
    ok('  … and a card that already continued is NOT refused (attempts are repeatable)', rt.canCompress('root') === true);
    ok('  … the tip has no blocker', rt.windowStartBlocker('p0') === null);
    ok('  … nor does the card with a window below it', rt.windowStartBlocker('root') === null);
    ok('  … a missing node is "missing"', rt.windowStartBlocker('nope') === 'missing');
    const s2 = makeSession();
    s2.nodes.p0.displayItems[5].text = 'WARN DeepSeek stream stalled: first chunk.';
    const { rt: rt2 } = makeRuntime(s2);
    ok('an ordinary failure is NOT a rollover candidate', rt2.canRollover('p0') === false);
    ok('  … though a deliberate compression still may be asked for', rt2.canCompress('p0') === true);
  }

  console.log('-- the Simple handoff: a ready card, no turn at all --');
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

  const cardId = await rt.startPointerHandoff('p0');
  ok('startPointerHandoff() returns the card', typeof cardId === 'string' && !!session.nodes[cardId], String(cardId));

  const created = Object.values(session.nodes).filter((n) => n.parentId === 'p0');
  ok('exactly one new node was created', created.length === 1, created.map((n) => n.id).join(','));
  const card = created[0];
  ok('the card hangs BELOW the overflowing window', !!card && card.parentId === 'p0');
  ok('the card starts its own context window', !!card && card.contextBaseId === card.id, card && card.contextBaseId);
  ok('  … and wears the compression role', !!card && card.role === 'compress', card && card.role);
  ok('  … still recording the window it compressed', !!card && card.compressedFrom === 'p0', card && card.compressedFrom);
  ok('the card is titled after the window it compresses', !!card && card.title === 'Compression of window 1', card && card.title);
  ok('the card is done and owns the view focus', !!card && card.status === 'done' && session.activeNodeId === card.id);
  // The whole point of the Simple answer: **no turn**. The card carries the harness note and
  // nothing runs after the click.
  ok('no turn was started by the click', rt.runs.size === 0, String(rt.runs.size));
  ok('  … the card has no messages of its own', !!card && card.messages.length === 0);
  ok('the card is ready', !!card && T.hasHandoff(card) && rt.handoffReady(card.id) === true);
  ok('  … and it has no compression answer to claim', !!card && card.handoffSummary === undefined);
  ok(
    'the tree payload marks the card ready and green',
    messages.some((m) => m.type === 'tree' && m.nodes.some((n) => n.id === card.id && n.handoffReady === true)),
  );
  ok('the card shows its handoff as a HARNESS block', !!card && card.displayItems.some((i) => i.kind === 'harness' && String(i.text).startsWith('[Harness')));
  ok('  … and it was posted as one', messages.some((m) => m.type === 'harnessNote' && m.nodeId === card.id));

  // The pointer text itself, read off the card (that is what the window below will lead with).
  const pointer = (card && card.handoffNote) || '';
  ok('the pointer text starts as a window reset', pointer.startsWith('[Harness: context window reset]'));
  ok('  ... it names the previous window', pointer.includes('Previous window: node p0 of session sess-live'));
  ok("  ... it points at the previous window's transcript", pointer.includes(path.join(TMP, 'sess-live', 'p0.jsonl')));
  ok('  ... it quotes the ORIGINAL task verbatim', pointer.includes("The user's first request in that window, verbatim: ROOT-REQUEST-MARKER"));
  ok("  ... it carries the user's last request verbatim", pointer.includes('now FINISH-THE-JOB please'));
  ok('  ... it carries the last answer verbatim', pointer.includes('half an answer'));
  ok('  ... it lists the files the window changed, and only those', pointer.includes('- src/a.ts') && !pointer.includes('src/read-only.ts'));
  ok('  ... it names the killed background terminal', pointer.includes('background terminal #' + jobId) && pointer.includes('npm run build'));
  ok('  ... and counts it', /\b1 background terminal\(s\)/.test(pointer));

  ok("the node's background terminal was killed", childKilled === true);
  ok("another node's job was left alone", otherKilled === false);
  ok('the job reads as stopped', hub.listForNode(session.id, 'p0')[0].killed === true);
  const lastMsg = session.nodes.p0.messages[session.nodes.p0.messages.length - 1];
  ok('the kill notice was written back into the overflowing node', lastMsg.role === 'user' && /Background command/.test(lastMsg.content));
  ok("  ... with the job's output tail (its only durable copy)", lastMsg.content.includes('BUILD-OUTPUT-TAIL'));
  const p0Dump = dumps.filter((d) => d.nodeId === 'p0').pop();
  ok('the overflowing node was re-dumped', !!p0Dump, dumps.map((d) => d.nodeId).join(','));
  ok('  ... and the dump holds the kill record', !!p0Dump && JSON.stringify(p0Dump.messages).includes('BUILD-OUTPUT-TAIL'));

  console.log('-- the window a send below the card opens --');
  requests.length = 0;
  const sent = await rt.onUserMessage('now do THIS-INSTEAD', [], { basisNodeId: card.id });
  ok('a send below a ready card is accepted', sent.ok === true, JSON.stringify(sent));
  const win = sent.ok ? session.nodes[sent.nodeId] : undefined;
  ok('it opened a window below the card', !!win && win.parentId === card.id);
  ok('  … with the resume role and its own context base', !!win && win.role === 'resume' && win.contextBaseId === win.id);
  ok('  … titled as the next window', !!win && win.title === 'Context window 2', win && win.title);
  ok(
    '  … it carries the card\'s pointer handoff, not a summary claim',
    !!win && win.handoff === undefined && win.handoffSummary === undefined,
  );
  ok('  … and inherits P\'s frozen envelope (never the card\'s)', !!win && !!win.epoch && win.epoch.prompt === 'MAIN-SYSTEM-PROMPT');
  ok('  … with P\'s tool set', !!win && !!win.epoch && win.epoch.toolsetHash === 'main-toolset-hash');
  ok('the window is the view focus', session.activeNodeId === (win && win.id));
  ok('the handoff block is on the card', !!win && win.displayItems.some((i) => i.kind === 'harness' && i.text === pointer));

  for (let i = 0; i < 50 && requests.length < 1; i++) {
    await tick(20);
  }
  const winReq = requests[0] || {};
  const winRoles = (winReq.messages || []).map((m) => m.role).join(',');
  ok('the window\'s request is [system, handoff, user]', winRoles === 'system,user,user', winRoles);
  ok('  ... the system message is P\'s envelope', (winReq.messages || [])[0] && winReq.messages[0].content === 'MAIN-SYSTEM-PROMPT');
  const winLead = String(((winReq.messages || [])[1] || {}).content || '');
  ok('  ... the handoff comes FIRST', winLead === pointer);
  ok('  ... and the user\'s message is its own message after it', ((winReq.messages || [])[2] || {}).content === 'now do THIS-INSTEAD');
  ok(
    '  ... no ancestor message rides along',
    !JSON.stringify((winReq.messages || []).filter((m) => !String(m.content).startsWith('[Harness'))).includes('ROOT-REQUEST-MARKER'),
  );

  // Several windows from one card: every send is a sibling, numbered in order.
  const secondSend = await rt.onUserMessage('and ANOTHER-THING', [], { basisNodeId: card.id });
  const win2 = secondSend.ok ? session.nodes[secondSend.nodeId] : undefined;
  ok('a second send below the same card opens a second window', !!win2 && win2.parentId === card.id && win2.role === 'resume');
  ok('  … numbered after the first one', !!win2 && win2.title === 'Context window 3', win2 && win2.title);
  ok(
    '  … and both windows carry the same handoff block',
    !!win && !!win2 && win2.displayItems.some((i) => i.kind === 'harness' && i.text === pointer),
  );
  // Both sends are fire-and-forget: let their requests land before the next section resets the
  // recorder, or the late one would be read as that section's first request.
  for (let i = 0; i < 50 && requests.length < 2; i++) {
    await tick(20);
  }

  console.log('-- the compression card (Agentic): P -> C, and no window from the click --');
  {
    answerText = HANDFF;
    requests.length = 0;
    const s = makeSession();
    s.nodes.p0.displayItems.push({ kind: 'notice', text: 'usage', usage: { prompt_tokens: 996147, completion_tokens: 10, total_tokens: 996157 } });
    const { rt: crt } = makeRuntime(s);
    const ready = await crt.compressHandoff('p0');
    ok('compressHandoff() returns the ready card', typeof ready === 'string' && !!s.nodes[ready], String(ready));

    const c = childOf(s, 'p0', 'compress');
    ok('one compression card hangs below P', !!c, Object.values(s.nodes).filter((n) => n.parentId === 'p0').map((n) => n.id).join(','));
    ok('  ... it records the window it compressed', !!c && c.compressedFrom === 'p0', c && c.compressedFrom);
    ok('  ... it starts its own context window', !!c && c.contextBaseId === c.id);
    ok('  ... it froze an envelope of its own', !!c && !!c.epoch && c.epoch.kind === 'compress', c && c.epoch && String(c.epoch.kind));
    ok('  ... whose prompt is the compression template, not the main one', !!c && !!c.epoch && c.epoch.prompt !== 'MAIN-SYSTEM-PROMPT' && /compression node/.test(c.epoch.prompt || ''));
    ok('  ... and it is titled after the window it compresses', !!c && c.title === 'Compression of window 1', c && c.title);

    const first = requests[0] || {};
    const roles = (first.messages || []).map((m) => m.role).join(',');
    ok('C\'s first request is [system, user] only', roles === 'system,user', roles);
    ok('  ... the system message is the compression envelope', !!c && first.messages[0].content === c.epoch.prompt);
    ok(
      '  ... no ancestor or sibling message is in it',
      !JSON.stringify(first.messages.filter((m) => !String(m.content).startsWith('[Harness'))).includes('ROOT-REQUEST-MARKER') &&
        !JSON.stringify(first.messages.filter((m) => m.role === 'assistant')).includes('half an answer'),
    );
    const instruction = String((first.messages[1] || {}).content || '');
    ok('  ... the user message is the harness instruction', instruction.startsWith('[Harness: compression turn]'));
    ok('  ... it carries the window source', instruction.includes('First user message (verbatim)') && instruction.includes('do the thing'));
    ok('  ... the transcript pointer', instruction.includes(path.join(TMP, 'sess-live', 'p0.jsonl')));
    ok('  ... the changed files', instruction.includes('- src/a.ts') && !instruction.includes('src/read-only.ts'));
    ok('  ... the size line', /The previous window used 996147 of this model's 1048576-token context \(95%\)\./.test(instruction));
    ok('  ... and the fixed instruction verbatim at the end', instruction.endsWith(C.COMPRESS_INSTRUCTION));
    const toolNames = (first.tools || []).slice().sort().join(',');
    ok('  ... C carries only the read-only four tools', toolNames === ['read_file', 'list_dir', 'search_files', 'search_transcripts'].sort().join(','), toolNames);
    ok('  ... never a write or a shell', !/(^|,)(write_file|append_file|replace_in_file|exec_command|spawn_agents|create_session)(,|$)/.test(toolNames));
    ok('C is a done turn', !!c && c.status === 'done', c && c.status);
    ok('  ... and its answer is stored', !!c && (c.messages || []).some((m) => m.role === 'assistant' && String(m.content).includes('## Objective')));

    // The handoff is stored **on the card**, and the click opened nothing.
    ok('the card carries the handoff text', !!c && T.hasHandoff(c));
    const note = (c && c.handoffNote) || '';
    ok('  ... it starts with the compression title', note.startsWith(C.COMPACTION_HARNESS_TITLE), note.slice(0, 48));
    ok('  ... it carries the answer', note.includes('## Objective'));
    ok('  ... the pointer facts follow it', note.includes('Previous window: node p0') && note.includes(path.join(TMP, 'sess-live', 'p0.jsonl')));
    ok('  ... the last request verbatim', note.includes('now FINISH-THE-JOB please'));
    ok('  ... the changed files', note.includes('- src/a.ts'));
    ok('  ... and the answer as data', !!c && c.handoffSummary === HANDFF);
    ok('no window hangs below the card yet', !!c && !childOf(s, c.id, 'resume'));
    ok('  ... and exactly one request was made (the compression)', requests.length === 1, String(requests.length));
    ok('the card is the view focus', s.activeNodeId === (c && c.id));

    console.log('-- the window the send opens: envelope, handoff first, user message second --');
    requests.length = 0;
    const sent = await crt.onUserMessage('now do THIS-INSTEAD', [], { basisNodeId: c.id });
    const r = sent.ok ? s.nodes[sent.nodeId] : undefined;
    ok('a send below the ready card opens the window', !!r && r.parentId === c.id, JSON.stringify(sent));
    ok('  ... it starts its own context window', !!r && r.contextBaseId === r.id);
    ok('  ... it is titled as the next window', !!r && r.title === 'Context window 2', r && r.title);
    ok('  ... it records the summary handoff', !!r && r.handoff === 'summary');
    ok('  ... and stores the summary text', !!r && r.handoffSummary === HANDFF);
    ok('  ... it inherits P\'s envelope, not C\'s', !!r && !!r.epoch && r.epoch.prompt === 'MAIN-SYSTEM-PROMPT', r && r.epoch && String(r.epoch.prompt).slice(0, 40));
    ok('  ... its envelope carries no compression kind', !!r && !!r.epoch && r.epoch.kind !== 'compress');
    ok('  ... and P\'s tool set', !!r && !!r.epoch && r.epoch.toolsetHash === 'main-toolset-hash');

    for (let i = 0; i < 50 && requests.length < 1; i++) {
      await tick(20);
    }
    const resumeSent = ((requests[0] || {}).messages || []);
    ok('R\'s request is [system, harness, user]', resumeSent.map((m) => m.role).join(',') === 'system,user,user', resumeSent.map((m) => m.role).join(','));
    ok('  ... its system message is P\'s envelope', resumeSent[0] && resumeSent[0].content === 'MAIN-SYSTEM-PROMPT');
    const harness = String((resumeSent[1] || {}).content || '');
    ok('  ... its first message is the card\'s handoff', harness === note);
    ok('  ... the composer text is R\'s own user message', (resumeSent[2] || {}).content === 'now do THIS-INSTEAD');
    ok('  ... and it is shown on R\'s card', !!r && r.displayItems.some((i) => i.kind === 'user' && i.text === 'now do THIS-INSTEAD'));

    console.log('-- a card with a handoff refuses ▶ (a send is the way on) --');
    const before = Object.keys(s.nodes).length;
    const continued = await crt.continueFrom(c.id);
    ok('continueFrom(C) is refused once the handoff exists', continued === false);
    ok('  ... no node was created', Object.keys(s.nodes).length === before);
    ok('  ... and the refusal is a sentence', messages.some((m) => m.type === 'notice' && /already wrote its handoff/.test(String(m.text))));

    console.log('-- deletion rules: R is refused, C is allowed --');
    {
      // An idle fixture: `branchDeletionBlocked` refuses any running agent first, so the
      // role rule has to be asked of a session where nothing streams.
      const idle = makeSession();
      const ic = mkNode('c1', 'p0', [], { role: 'compress', compressedFrom: 'p0', contextBaseId: 'c1', handoffNote: 'note' });
      T.attachNode(idle, ic);
      const ir = mkNode('r1', 'c1', [], { role: 'resume', contextBaseId: 'r1' });
      T.attachNode(idle, ir);
      const { rt: irt } = makeRuntime(idle);
      const calls = (nodeId) =>
        P.ChatViewProvider.prototype.branchDeletionBlocked.call({}, idle, irt, nodeId);
      const resumeBlocked = calls(ir.id);
      ok('deleting the resume window is refused', typeof resumeBlocked === 'string' && resumeBlocked.length > 0, resumeBlocked);
      ok('  ... and the sentence points at the compression card', /compression node above it/.test(String(resumeBlocked)));
      ok('deleting the compression card is allowed', calls(ic.id) === '', calls(ic.id));
      ok('  … and its branch contains the window it produced', T.branchIds(idle, ic.id).includes(ir.id));
      ok('  … while another window of the same card goes with it too', T.branchIds(idle, ic.id).length === 2);
    }
  }

  console.log('-- the setup question is answered when the window is opened --');
  {
    // `current` plants a *copy* of P's envelope: same bytes, same freeze time, a new identity.
    // `latest` freezes the live setup instead — a new envelope, frozen now — which is the
    // answer to "stop sending this conversation on the old model", at one cache miss.
    answerText = HANDFF;
    requests.length = 0;
    const s = makeSession();
    const { rt: crt } = makeRuntime(s);
    const pEpoch = s.nodes.root.epoch;
    const card = await crt.compressHandoff('p0');
    const sent = await crt.onUserMessage('go on', [], { basisNodeId: card });
    const inherited = sent.ok ? s.nodes[sent.nodeId] : undefined;
    ok(
      'by default the window inherits the frozen envelope of the window it continues',
      !!inherited && !!inherited.epoch && inherited.epoch.frozenAt === pEpoch.frozenAt,
      inherited && inherited.epoch ? `${inherited.epoch.frozenAt} vs ${pEpoch.frozenAt}` : 'no envelope',
    );
    const s2 = makeSession();
    const { rt: rt2 } = makeRuntime(s2);
    const p2 = s2.nodes.root.epoch;
    const card2 = await rt2.compressHandoff('p0');
    const sent2 = await rt2.onUserMessage('go on', [], { basisNodeId: card2, handoffSetup: 'latest' });
    const fresh = sent2.ok ? s2.nodes[sent2.nodeId] : undefined;
    ok('with `latest` the window freezes a new envelope', !!fresh && !!fresh.epoch && fresh.epoch.frozenAt !== p2.frozenAt);
    ok('  … of the main kind (never the compression template)', !!fresh && !!fresh.epoch && fresh.epoch.kind !== 'compress');
    ok('  … and its first request sends it', !!fresh && !!fresh.epoch && String(fresh.epoch.prompt).length > 0);
  }

  console.log('-- two attempts from the same card: compare the two handoffs --');
  {
    answerText = HANDFF;
    requests.length = 0;
    const s = makeSession();
    const { rt: crt } = makeRuntime(s);
    const first = await crt.compressHandoff('p0');
    ok('the first attempt ends on a ready card', typeof first === 'string' && !!s.nodes[first]);
    // One attempt at a time: a card this window started that is **still being written** refuses
    // the click. The driver's stub answers instantly, so the run map is seeded rather than
    // waited on — the predicate under test is `windowStartBlocker`, not the stub's timing.
    const written = childOf(s, 'p0', 'compress');
    crt.runs.set(written.id, { nodeId: written.id });
    ok(
      '  … a second attempt waits while the first card is still being written',
      crt.windowStartBlocker('p0') === 'running',
      String(crt.windowStartBlocker('p0')),
    );
    crt.runs.delete(written.id);
    ok('  … and once it is idle the same card may start another', crt.windowStartBlocker('p0') === null);
    const second = await crt.compressHandoff('p0');
    ok('a second attempt from the same window is allowed', typeof second === 'string' && second !== first);
    const cards = Object.values(s.nodes).filter((n) => n.parentId === 'p0' && n.role === 'compress');
    ok('  … two compression cards hang below the one window', cards.length === 2, String(cards.length));
    ok('  … and each carries its own handoff', cards.every((n) => T.hasHandoff(n)));
  }

  console.log('-- a compression that answers nothing writes no handoff --');
  {
    answerText = '   ';
    requests.length = 0;
    const s = makeSession();
    const { rt: crt } = makeRuntime(s);
    const ready = await crt.compressHandoff('p0');
    ok('compressHandoff() reports no handoff', ready === null);
    const c = childOf(s, 'p0', 'compress');
    ok('the compression card is kept as the record', !!c);
    ok('  ... and it is not ready', !!c && !T.hasHandoff(c) && crt.handoffReady(c.id) === false);
    ok('  ... one notice on its own card explains why', messages.some((m) => m.type === 'notice' && m.nodeId === (c && c.id) && /returned no answer/.test(String(m.text))));
    // A send from it is refused: there is nothing to lead the window with.
    const refused = await crt.onUserMessage('go on', [], { basisNodeId: c.id, quiet: true });
    ok('  ... and a send from it is refused', refused.ok === false && refused.code === 'refused', JSON.stringify(refused));
    ok('  ... which created no node', !childOf(s, c.id, 'resume'));
  }

  console.log('-- a compression missing a section still stores its handoff --');
  {
    answerText = '## Objective\nthe task\n## Remaining plan\nfinish it';
    requests.length = 0;
    const s = makeSession();
    const { rt: crt } = makeRuntime(s);
    const ready = await crt.compressHandoff('p0');
    ok('compressHandoff() still stores the card', typeof ready === 'string');
    const c = childOf(s, 'p0', 'compress');
    ok('the card carries the incomplete answer anyway', !!c && T.hasHandoff(c) && (c.handoffSummary || '').startsWith('## Objective'));
    ok('  ... and no window was opened by the compression', !!c && !childOf(s, c.id, 'resume'));
    ok('  ... the card lists the missing sections', messages.some((m) => m.type === 'notice' && m.nodeId === (c && c.id) && /required section\(s\)/.test(String(m.text))));
  }

  console.log('-- Stop on the compression card: no handoff, and ▶ is the way out --');
  {
    answerText = HANDFF;
    requests.length = 0;
    const s = makeSession();
    const { rt: crt } = makeRuntime(s);
    // A stream that never answers: the turn stays live until it is stopped.
    let release = null;
    const gate = new Promise((resolve) => { release = resolve; });
    ApiClient.prototype.stream = async function* (request) {
      requests.push({ messages: JSON.parse(JSON.stringify(request.messages ?? [])), tools: [], model: request.model });
      await gate;
      if (request.signal && request.signal.aborted) {
        throw new Error('aborted');
      }
      yield { choices: [{ delta: { content: HANDFF } }] };
    };
    const chain = crt.compressHandoff('p0');
    // Wait for the compression turn to exist, then stop it the way the composer does.
    for (let i = 0; i < 50 && !childOf(s, 'p0', 'compress'); i++) {
      await tick(20);
    }
    const c = childOf(s, 'p0', 'compress');
    ok('the compression turn started', !!c);
    crt.stop(c.id);
    release();
    const ready = await chain;
    ok('the chain reports no handoff', ready === null);
    ok('  ... the compression card is kept, interrupted', !!c && c.status !== 'done', c && c.status);
    ok('  ... it carries no handoff', !!c && !T.hasHandoff(c));
    ok('  ... and nothing hangs below it', !childOf(s, c.id, 'resume'));
    ok('  ... one notice on its card says so', messages.some((m) => m.type === 'notice' && m.nodeId === (c && c.id) && /Compression stopped/.test(String(m.text))));
    ok('  ... but ▶ Continue is still its own way out', !!c && c.children.filter((id) => s.nodes[id] && s.nodes[id].role === 'resume').length === 0);
    // Restore the scripted, succeeding stream for anything after this.
    ApiClient.prototype.stream = async function* (request) {
      requests.push({ messages: JSON.parse(JSON.stringify(request.messages ?? [])), tools: [], model: request.model });
      yield { choices: [{ delta: { content: answerText } }] };
    };
  }

  console.log('-- degradation: no transcript on disk --');
  {
    saveTranscripts = false;
    const s = makeSession();
    const { rt: rt3 } = makeRuntime(s);
    const card = await rt3.startPointerHandoff('p0');
    const t = (s.nodes[card] && s.nodes[card].handoffNote) || '';
    ok('the pointer degrades to "not available on disk"', t.includes('not available on disk'));
    ok('  ... and the carried-over tail is still there', t.includes('now FINISH-THE-JOB please'));
    saveTranscripts = true;
  }

  console.log('-- a deliberate entry needs no fill level --');
  {
    const s = makeSession();
    s.nodes.p0.displayItems[5].text = 'WARN DeepSeek stream stalled.';
    s.nodes.p0.status = 'done';
    const { rt: rt4 } = makeRuntime(s);
    const card = await rt4.startPointerHandoff('p0');
    ok('a window with room left still gets a card (the click is the request)', typeof card === 'string');
    ok('  ... and no turn runs', rt4.runs.size === 0, String(rt4.runs.size));
    ok('  ... so the button never dead-ends in an in-place continue', !Object.values(s.nodes).some((n) => n.parentId === 'p0' && n.title === 'Context window 2'));
  }

  console.log('');
  if (problems.length === 0) {
    console.log('PASS rollover-acceptance: a compression card is created up front and carries the handoff, a send below it opens the window with no ancestor history, the old line is union-killed and re-dumped, and the compression keeps the read-only tools and P\'s envelope');
  } else {
    console.log('FAIL ' + problems.length + ' problem(s):\n - ' + problems.join('\n - '));
  }
  process.exit(problems.length === 0 ? 0 : 1);
})().catch((err) => {
  console.error('ERROR', err);
  process.exit(2);
});
