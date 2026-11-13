/*
 * rollover-acceptance — the context rollover's *runtime* half, as a dev-only
 * acceptance run (not a build guard, and not shipped in the `.vsix`).
 *
 * The build guards can only reach the pure modules (`tree.ts`, `models.ts`,
 * `compaction.ts`, `media/main.js`). Everything risky about a window change lives in
 * `SessionRuntime`:
 *
 *  - **the pointer rollover (Simple)**: the new window's first request carries no ancestor
 *    history, the node's leftover work is union-killed while another node's job is left
 *    alone, the kill notices land in the old node's history *and* in its re-dumped
 *    transcript, and the message carries the original task, the clipped tail, the changed
 *    files and the attachment count;
 *  - **the compression chain (Agentic)**: P ──> C ──> R, where C is a real turn with its own
 *    context base, its own compression envelope and only the read-only tools, and R is a
 *    window that inherits **P's** envelope rather than C's and starts from C's answer;
 *  - **the chain's own edges**: a Stop on C opens no window, an empty answer opens no
 *    window, a sealed C refuses ▶, and a resume window cannot be deleted on its own.
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
    // `canCompress` is the structural rule only — no fill condition — but it still refuses a
    // node that already has a conversational child.
    ok('canCompress() is true for the tip of the branch', rt.canCompress('p0') === true);
    ok('  … and false for a node that already continued', rt.canCompress('root') === false);
    // The **reason** is what the refusal sentence is built from (`windowStartBlocker`): a
    // card that already continues below must not tell the reader to wait for a turn.
    ok('  … and it is named as "continued", not "running"', rt.windowStartBlocker('root') === 'continued');
    ok('  … the tip has no blocker', rt.windowStartBlocker('p0') === null);
    ok('  … a missing node is "missing"', rt.windowStartBlocker('nope') === 'missing');
    const s2 = makeSession();
    s2.nodes.p0.displayItems[5].text = 'WARN DeepSeek stream stalled: first chunk.';
    const { rt: rt2 } = makeRuntime(s2);
    ok('an ordinary failure is NOT a rollover candidate', rt2.canRollover('p0') === false);
    ok('  … though a deliberate compression still may be asked for', rt2.canCompress('p0') === true);
  }

  console.log('-- the Simple rollover: prefix, kill, record, message --');
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
  ok('rolloverContext() reports success', handled === true);

  const created = Object.values(session.nodes).filter((n) => n.parentId === 'p0');
  ok('exactly one new node was created', created.length === 1, created.map((n) => n.id).join(','));
  const roll = created[0];
  ok('the new node hangs BELOW the overflowing node', !!roll && roll.parentId === 'p0');
  ok('the new node starts its own context window', !!roll && roll.contextBaseId === roll.id, roll && roll.contextBaseId);
  ok('the new node is not a compression node', !!roll && roll.role === undefined);
  ok('the title numbers the window', !!roll && roll.title === 'Context window 2', roll && roll.title);
  ok('the new node owns the view focus', session.activeNodeId === roll.id);
  ok('the overflowing node is no longer a candidate', rt.canRollover('p0') === false);
  ok('the tree payload marks the new node as a window start', messages.some((m) => m.type === 'tree' && m.nodes.some((n) => n.id === roll.id && n.contextBaseId === roll.id)));

  const run = rt.runs.get(roll.id);
  const sent = run && run.agent.getMessages();
  ok('a live run is bound to the new node', !!run);
  ok('the first request is [system, harness] only', !!sent && sent.length === 2, sent && sent.map((m) => m.role).join('+'));
  ok(
    '  ... the ancestor history is NOT in it (outside the harness quotation)',
    !!sent && !JSON.stringify(sent.filter((m) => !String(m.content).startsWith('[Harness'))).includes('ROOT-REQUEST-MARKER'),
  );
  // The window's own earlier work is **not sent as messages** either; the harness block is
  // the one place it appears, as the quoted last answer.
  ok(
    "  ... nor the overflowing node's earlier messages",
    !!sent && !JSON.stringify(sent.filter((m) => !String(m.content).startsWith('[Harness'))).includes('half an answer'),
  );
  ok('  ... only the harness message is a user message', !!sent && sent.filter((m) => m.role === 'user').length === 1);
  const text = sent && typeof sent[1].content === 'string' ? sent[1].content : '';
  ok('the message is the harness text', text.startsWith('[Harness: context window reset]'));
  ok('  ... it names the previous window', text.includes('Previous window: node p0 of session sess-live'));
  ok("  ... it points at the previous window's transcript", text.includes(path.join(TMP, 'sess-live', 'p0.jsonl')));
  ok('  ... it quotes the ORIGINAL task verbatim', text.includes("The user's first request in that window, verbatim: ROOT-REQUEST-MARKER"));
  ok("  ... it carries the user's last request verbatim", text.includes('now FINISH-THE-JOB please'));
  ok('  ... it carries the last answer verbatim (in the harness text only)', text.includes('half an answer'));
  ok('  ... it lists the files the window changed, and only those', text.includes('- src/a.ts') && !text.includes('src/read-only.ts'));
  ok('  ... it names the killed background terminal', text.includes('background terminal #' + jobId) && text.includes('npm run build'));
  ok('  ... and counts it', /\b1 background terminal\(s\)/.test(text));
  ok('  ... the system prompt is not stored in the node', !roll.messages.some((m) => m.role === 'system'));
  ok(
    'the new window names its own provider conversation (never the previous window)',
    !!run && run.agent.conversationId === roll.id && run.agent.conversationId !== 'root',
    run && run.agent.conversationId,
  );

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
  ok('  ... and its dump holds no ancestor message', !!rollDump && !JSON.stringify(rollDump.messages.filter((m) => !String(m.content).startsWith('[Harness'))).includes('ROOT-REQUEST-MARKER'));

  console.log('-- the compression chain: P -> C -> R --');
  {
    answerText = HANDFF;
    requests.length = 0;
    const s = makeSession();
    // The user's text travels to the window below, never to the compression turn.
    s.nodes.p0.displayItems.push({ kind: 'notice', text: 'usage', usage: { prompt_tokens: 996147, completion_tokens: 10, total_tokens: 996157 } });
    const { rt: crt } = makeRuntime(s);
    const delivered = await crt.compressAndContinue('p0', { text: 'now do THIS-INSTEAD' });
    ok('compressAndContinue() reports the handoff was delivered', delivered === true);

    const c = childOf(s, 'p0', 'compress');
    ok('one compression node hangs below P', !!c, Object.values(s.nodes).filter((n) => n.parentId === 'p0').map((n) => n.id).join(','));
    ok('  ... it records the window it compressed', !!c && c.compressedFrom === 'p0', c && c.compressedFrom);
    ok('  ... it starts its own context window', !!c && c.contextBaseId === c.id);
    ok('  ... it froze an envelope of its own', !!c && !!c.epoch && c.epoch.kind === 'compress', c && c.epoch && String(c.epoch.kind));
    ok('  ... whose prompt is the compression template, not the main one', !!c && !!c.epoch && c.epoch.prompt !== 'MAIN-SYSTEM-PROMPT' && /compression node/.test(c.epoch.prompt || ''));
    ok('  ... and it is titled after the window it compresses', !!c && c.title === 'Compression of window 1', c && c.title);

    const first = requests[0] || {};
    const roles = (first.messages || []).map((m) => m.role).join(',');
    ok('C\'s first request is [system, user] only', roles === 'system,user', roles);
    ok('  ... the system message is the compression envelope', !!c && first.messages[0].content === c.epoch.prompt);
    // The source block legitimately quotes the window's own work; what must not be there is
    // a **message** from above it.
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
    ok('  ... the composer\'s text is NOT in the compression turn', !instruction.includes('now do THIS-INSTEAD'));
    const toolNames = (first.tools || []).slice().sort().join(',');
    ok('  ... C carries only the read-only four tools', toolNames === ['read_file', 'list_dir', 'search_files', 'search_transcripts'].sort().join(','), toolNames);
    ok('  ... never a write or a shell', !/(^|,)(write_file|append_file|replace_in_file|exec_command|spawn_agents|create_session)(,|$)/.test(toolNames));
    ok('C is a done turn', !!c && c.status === 'done', c && c.status);
    ok('  ... and its answer is stored', !!c && (c.messages || []).some((m) => m.role === 'assistant' && String(m.content).includes('## Objective')));

    const r = childOf(s, c && c.id, 'resume');
    ok('one resume window hangs below C', !!r, Object.values(s.nodes).filter((n) => n.parentId === (c && c.id)).map((n) => n.id).join(','));
    ok('  ... it starts its own context window', !!r && r.contextBaseId === r.id);
    ok('  ... it is titled as the next window', !!r && r.title === 'Context window 2', r && r.title);
    ok('  ... it records the summary handoff', !!r && r.handoff === 'summary');
    ok('  ... and stores the summary text', !!r && r.handoffSummary === HANDFF);
    ok('  ... it inherits P\'s envelope, not C\'s', !!r && !!r.epoch && r.epoch.prompt === 'MAIN-SYSTEM-PROMPT', r && r.epoch && String(r.epoch.prompt).slice(0, 40));
    ok('  ... its envelope carries no compression kind', !!r && !!r.epoch && r.epoch.kind !== 'compress');
    ok('  ... and P\'s tool set', !!r && !!r.epoch && r.epoch.toolsetHash === 'main-toolset-hash');

    const resumeRun = r && crt.runs.get(r.id);
    const resumeSent = (resumeRun && resumeRun.agent.getMessages()) || [];
    ok('R\'s request is [system, harness, user]', resumeSent.map((m) => m.role).join(',') === 'system,user,user', resumeSent.map((m) => m.role).join(','));
    ok('  ... its system message is P\'s envelope', resumeSent[0] && resumeSent[0].content === 'MAIN-SYSTEM-PROMPT');
    const harness = String((resumeSent[1] || {}).content || '');
    ok('  ... its first message starts with the compression result', harness.startsWith(C.COMPACTION_HARNESS_TITLE) && harness.includes('## Objective'));
    ok('  ... the pointer facts follow it', harness.includes('Previous window: node p0') && harness.includes(path.join(TMP, 'sess-live', 'p0.jsonl')));
    ok('  ... the last request verbatim', harness.includes('now FINISH-THE-JOB please'));
    ok('  ... the changed files', harness.includes('- src/a.ts'));
    ok(
      '  ... and no ancestor message rides along',
      !JSON.stringify(resumeSent.filter((m) => !String(m.content).startsWith('[Harness'))).includes('ROOT-REQUEST-MARKER'),
    );
    ok('  ... the composer text is R\'s own user message', resumeSent[2] && resumeSent[2].role === 'user' && resumeSent[2].content === 'now do THIS-INSTEAD');
    ok('  ... and it is shown on R\'s card', !!r && r.displayItems.some((i) => i.kind === 'user' && i.text === 'now do THIS-INSTEAD'));
    ok('R is the view focus', s.activeNodeId === (r && r.id));
    // R's turn is fire-and-forget (`void sendUserMessage(...)`), so its request lands on a
    // later tick: wait for it before counting.
    for (let i = 0; i < 50 && requests.length < 2; i++) {
      await tick(20);
    }
    ok('the chain made exactly two more requests', requests.length === 2, String(requests.length));

    console.log('-- the seal: a delivered compression node does not continue again --');
    const before = Object.keys(s.nodes).length;
    const continued = await crt.continueFrom(c.id);
    ok('continueFrom(C) is refused once its window exists', continued === false);
    ok('  ... no node was created', Object.keys(s.nodes).length === before);
    ok('  ... and the refusal is a sentence', messages.some((m) => m.type === 'notice' && /already been delivered/.test(String(m.text))));
    // The other door into the same node: an inter-session prompt lands on the checked-out
    // node, so a sealed compression node must refuse a *new turn* under it too, not only a
    // continue (`onUserMessage`, the one gate every entry shares).
    const sealedSend = await crt.onUserMessage('a second line under the compression', [], {
      basisNodeId: c.id,
      quiet: true,
    });
    ok(
      'a message into a sealed compression node is refused',
      sealedSend.ok === false && sealedSend.code === 'refused',
      JSON.stringify(sealedSend),
    );
    ok('  ... and it created no node either', Object.keys(s.nodes).length === before);

    console.log('-- deletion rules: R is refused, C is allowed --');
    {
      // An idle fixture: `branchDeletionBlocked` refuses any running agent first, so the
      // role rule has to be asked of a session where nothing streams.
      const idle = makeSession();
      const ic = mkNode('c1', 'p0', [], { role: 'compress', compressedFrom: 'p0', contextBaseId: 'c1' });
      T.attachNode(idle, ic);
      const ir = mkNode('r1', 'c1', [], { role: 'resume', contextBaseId: 'r1' });
      T.attachNode(idle, ir);
      const { rt: irt } = makeRuntime(idle);
      const calls = (nodeId) =>
        P.ChatViewProvider.prototype.branchDeletionBlocked.call({}, idle, irt, nodeId);
      const resumeBlocked = calls(ir.id);
      ok('deleting the resume window is refused', typeof resumeBlocked === 'string' && resumeBlocked.length > 0, resumeBlocked);
      ok('  ... and the sentence points at the compression node', /compression node above it/.test(String(resumeBlocked)));
      ok('deleting the compression node is allowed', calls(ic.id) === '', calls(ic.id));
      ok('  … and its branch contains the resume window it produced', T.branchIds(idle, ic.id).includes(ir.id));
      ok('the compression node keeps its 🗑 in the payload (role only)', messages.some((m) => m.type === 'tree' && m.nodes.some((n) => n.id === c.id && n.role === 'compress')));
    }
  }

  console.log('-- a compression that answers nothing opens no window --');
  {
    answerText = '   ';
    requests.length = 0;
    const s = makeSession();
    const { rt: crt } = makeRuntime(s);
    const delivered = await crt.compressAndContinue('p0', { text: 'go on' });
    ok('compressAndContinue() reports no window', delivered === false);
    const c = childOf(s, 'p0', 'compress');
    ok('the compression node is kept as the record', !!c);
    ok('  ... and no window hangs below it', !!c && !childOf(s, c.id, 'resume'));
    ok('  ... one notice on its own card explains why', messages.some((m) => m.type === 'notice' && m.nodeId === (c && c.id) && /returned no answer/.test(String(m.text))));
    ok('  ... and the composer text was not consumed', true);
  }

  console.log('-- a compression missing a section still opens the window --');
  {
    answerText = '## Objective\nthe task\n## Remaining plan\nfinish it';
    requests.length = 0;
    const s = makeSession();
    const { rt: crt } = makeRuntime(s);
    const delivered = await crt.compressAndContinue('p0');
    ok('compressAndContinue() still delivers', delivered === true);
    const c = childOf(s, 'p0', 'compress');
    const r = c && childOf(s, c.id, 'resume');
    ok('the window was opened anyway', !!r);
    ok('  ... carrying the incomplete answer', !!r && (r.handoffSummary || '').startsWith('## Objective'));
    ok('  ... the card lists the missing sections', messages.some((m) => m.type === 'notice' && m.nodeId === (c && c.id) && /required section\(s\)/.test(String(m.text))));
  }

  console.log('-- Stop on the compression node cancels the chain --');
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
    const chain = crt.compressAndContinue('p0', { text: 'go on' });
    // Wait for the compression turn to exist, then stop it the way the composer does.
    for (let i = 0; i < 50 && !childOf(s, 'p0', 'compress'); i++) {
      await tick(20);
    }
    const c = childOf(s, 'p0', 'compress');
    ok('the compression turn started', !!c);
    crt.stop(c.id);
    release();
    const delivered = await chain;
    ok('the chain reports no window', delivered === false);
    ok('  ... the compression node is kept, interrupted', !!c && c.status !== 'done', c && c.status);
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
    s.nodes.p0.displayItems[5].text = 'WARN DeepSeek stream stalled.';
    const { rt: rt4 } = makeRuntime(s);
    const before = Object.keys(s.nodes).length;
    const marked = messages.length;
    const done = await rt4.rolloverContext('p0');
    ok('rolloverContext() still reports success (in-place continue)', done === true);
    ok('no new node was created', Object.keys(s.nodes).length === before, Object.keys(s.nodes).join(','));

    // The resume's turn is fire-and-forget (`void run.agent.resumeTurn()`), so its
    // first request has to actually fail before the card can carry anything.
    await tick();
    const notes = messages.slice(marked).filter((m) => m.type === 'harnessNote' && m.nodeId === 'p0');
    ok('the resume says nothing to the model (no retry note)', notes.length === 0, notes.map((n) => n.text).join(' | '));
    ok('  ... never as a window reset', !messages.slice(marked).some((m) => String(m.text || '').includes('context window reset')));
  }

  console.log('-- the empty box: R gets the handoff alone --');
  {
    answerText = HANDFF;
    const s = makeSession();
    const { rt: rt6 } = makeRuntime(s);
    await rt6.compressAndContinue('p0', { text: '   ' });
    const c = childOf(s, 'p0', 'compress');
    const r = c && childOf(s, c.id, 'resume');
    const sent6 = (r && rt6.runs.get(r.id).agent.getMessages()) || [];
    ok('an empty box sends the handoff alone', sent6.map((m) => m.role).join(',') === 'system,user', sent6.map((m) => m.role).join(','));
    ok('  ... and no fake user bubble is invented', !!r && r.displayItems.filter((i) => i.kind === 'user').length === 0);
  }

  console.log('');
  if (problems.length === 0) {
    console.log('PASS rollover-acceptance: the new window sends no ancestor history, the old line is union-killed and re-dumped, and the compression chain keeps the read-only tools and P\'s envelope');
  } else {
    console.log('FAIL ' + problems.length + ' problem(s):\n - ' + problems.join('\n - '));
  }
  process.exit(problems.length === 0 ? 0 : 1);
})().catch((err) => {
  console.error('ERROR', err);
  process.exit(2);
});
