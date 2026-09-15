/*
 * model-switch-acceptance — the **per-node** model selection, as a dev-only
 * acceptance run (not a build guard, and not shipped in the `.vsix`).
 *
 * Why it exists: the model used to be a *session* property, so continuing from an
 * older node ran on whatever card the session last used, and switching the dropdown
 * back to the card that node was already using still warned about a model change.
 * The selection is a property of the **node** now (its own `model`/`effort`, else the
 * nearest ancestor's, else the session seed), an explicit dropdown pick is a *pending*
 * choice for the next send on the node in view, and a checkout forgets that pending.
 *
 * Everything here drives the real `SessionRuntime` with a stubbed `vscode` module and
 * an offline client that records the requests it is asked to send, so the assertions
 * are about what would actually go on the wire:
 *
 *   - a follow-up from a node runs on **that node's** card (and the new node records
 *     it, so the next one inherits),
 *   - a node with no card of its own inherits the nearest ancestor's,
 *   - picking a card is pending until the send, and a checkout drops it (so the
 *     dropdown follows the node you click),
 *   - picking the card the node already uses is a **no-op** — no "Model changed"
 *     notice at all,
 *   - a history's DeepSeek upload blocks are rewritten (hidden) when the card the
 *     request runs on is not `deepseek`, and passed through untouched when it is.
 *
 * Needs `out/` (`npm run compile` first), no window, no network:
 *   node tools/model-switch-acceptance.js
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

// A script that ends while an `await` is pending would exit 0 with no verdict — which
// is exactly how a hang looks. Refuse to pass quietly.
let finished = false;
process.on('exit', (code) => {
  if (!finished && code === 0) {
    console.log('\nFAIL model-switch-acceptance: the run ended early — something never resolved');
    process.exitCode = 1;
  }
});

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
const { ApiClient } = require(path.join(ROOT, 'out', 'agent', 'apiClient.js'));

// --- the catalog: three cards, two dialects -----------------------------------
const DS = 'deepseek-flash'; // the vendored card's id: `deepseek` transport
const GLM = 'glm-card'; // a `openai`-transport card on another endpoint
const OTHER = 'other-card'; // a third card, to tell a pending pick from a node's own
M.setCatalog(
  [
    { id: 'default', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', concurrency: 0 },
    { id: 'zhipu', name: 'Zhipu', baseUrl: 'https://open.bigmodel.cn', concurrency: 0 },
  ],
  [
    {
      id: DS, name: 'deepseek-flash', providerId: 'default', oaiModel: 'deepseek-flash',
      contextWindow: 1048576, concurrency: 2500,
      vision: { enabled: true, transport: 'deepseek' },
      efforts: ['none', 'low', 'medium', 'high'], defaultEffort: 'medium',
    },
    {
      id: GLM, name: 'GLM', providerId: 'zhipu', oaiModel: 'glm-4.6',
      contextWindow: 200000, concurrency: 0,
      vision: { enabled: true, transport: 'openai' },
      efforts: ['none', 'low', 'medium', 'high'], defaultEffort: 'medium',
    },
    {
      id: OTHER, name: 'Other', providerId: 'default', oaiModel: 'other-wire',
      contextWindow: 100000, concurrency: 0,
      vision: { enabled: false, transport: 'deepseek' },
      efforts: ['none', 'low'], defaultEffort: 'low',
    },
  ],
);

// --- an offline client that records every request ------------------------------
const requests = [];
ApiClient.prototype.stream = async function* (request) {
  requests.push({ model: request.model, messages: JSON.parse(JSON.stringify(request.messages ?? [])), thinkingEffort: request.thinkingEffort });
  yield { choices: [{ delta: { content: 'ok' } }] };
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'modelswitch-'));
const messages = [];
const host = new Proxy(
  {
    transcriptRoot: () => TMP,
    transcriptDir: (sid) => path.join(TMP, sid),
    dumpSessionTranscript: () => undefined,
    writeSubAgentTranscript: () => undefined,
    getConfig: () => ({
      saveSessionTranscripts: false,
      saveSubAgentTranscripts: false,
      subAgentTranscriptDir: '',
      maxConcurrentSubagents: 4,
      maxLevel2Subagents: 4,
      autoSessionTitles: false,
      foldToolCalls: true,
      foldThinking: true,
      defaultCardId: DS,
      replyLanguage: 'English',
    }),
    isHeld: () => false,
    disposed: false,
    output: { appendLine() {} },
    stateChanged: () => undefined,
    postTo: () => undefined,
    systemPrompt: () => 'SYSTEM-PROMPT-TEXT',
    resolveModel: (m) => (M.cardById(m) ? m : DS),
    getContextWindow: (id) => M.contextWindowFor(id),
    persistRuntimeConfig: () => undefined,
    persist: () => undefined,
  },
  {
    get(target, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (prop in target) return target[prop];
      return () => undefined;
    },
  },
);

// --- the session: `root` → `glm` (GLM) and `after` (no card of its own) ---------
// `root`'s history carries a DeepSeek **upload** block, so the same conversation has
// an image that only a `deepseek`-transport card can re-send.
const mkNode = (id, parentId, msgs, extra = {}) =>
  Object.assign(T.createNode(id, parentId, id, 'done'), { messages: msgs }, extra);

function makeSession() {
  const session = {
    id: 'sess-switch',
    title: 'model switch',
    createdAt: 1,
    updatedAt: 1,
    nodes: {},
    rootId: null,
    activeNodeId: null,
    orphanItems: [],
  };
  const root = mkNode(
    'root',
    null,
    [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'file', file_id: 'file-ds-1' },
        ],
      },
      { role: 'assistant', content: 'root answer' },
    ],
    {
      model: DS,
      effort: 'medium',
      displayItems: [
        { kind: 'user', text: 'look at this' },
        { kind: 'assistant', text: 'root answer' },
      ],
    },
  );
  T.attachNode(session, root);
  const glm = mkNode('glm', 'root', [{ role: 'user', content: 'and now on the other model' }], {
    model: GLM,
    effort: 'medium',
    displayItems: [{ kind: 'user', text: 'and now on the other model' }],
  });
  T.attachNode(session, glm);
  // No `model` of its own: it must inherit `root`'s.
  const after = mkNode('after', 'root', [], {});
  T.attachNode(session, after);
  // The first node is checked out by `attachNode`; put the view back on the root.
  session.activeNodeId = 'root';
  return session;
}

function makeRuntime(session) {
  const hub = new BackgroundHub();
  const rt = new R.SessionRuntime(
    host,
    session,
    new ClientRegistry({ apiKeyFor: async () => 'x' }),
    DS,
    'medium',
    hub,
  );
  rt.post = (msg) => messages.push(msg);
  rt.setBusy = (b) => {
    rt.busy = b;
  };
  rt.host = host;
  return rt;
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function settle(rt, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (rt.runs.size === 0 && !rt.busy) return true;
    await tick(20);
  }
  return false;
}
const notices = () => messages.filter((m) => m && m.type === 'notice').map((m) => String(m.text || ''));
const modelNotices = () => notices().filter((t) => /Model changed to/.test(t));
const latestRequest = () => requests[requests.length - 1];
const send = async (rt, text) => {
  const before = requests.length;
  await rt.onUserMessage(text);
  const settled = await settle(rt);
  if (!settled) problems.push(`the turn for ${JSON.stringify(text)} never finished`);
  if (requests.length === before) problems.push(`the turn for ${JSON.stringify(text)} sent no request`);
  return latestRequest();
};
/** The card a node's own history was produced under (not what the view reports). */
const nodeCard = (rt, id) => rt.session.nodes[id] && rt.session.nodes[id].model;

(async () => {
  const session = makeSession();
  const rt = makeRuntime(session);

  console.log('-- the card follows the node in view --');
  rt.handleCheckout('glm');
  ok('a node with its own card reports it', rt.model === GLM, rt.model);
  rt.handleCheckout('after');
  ok('a node without one inherits the nearest ancestor', rt.model === DS, rt.model);
  rt.handleCheckout('root');
  ok('  … and the root reports its own', rt.model === DS, rt.model);

  console.log('-- picking a card is pending, and a checkout forgets it --');
  {
    rt.handleCheckout('glm');
    const before = modelNotices().length;
    rt.setModel(OTHER);
    ok('the pick is what the next request would use', rt.model === OTHER, rt.model);
    ok('  … and it warns, because it really is a change', modelNotices().length === before + 1, JSON.stringify(modelNotices().slice(before)));
    rt.handleCheckout('after');
    ok('a checkout drops the pending pick', rt.model === DS, rt.model);
    rt.handleCheckout('glm');
    ok('  … so the node you clicked shows its own card again', rt.model === GLM, rt.model);
  }

  console.log('-- picking the card the node already uses is a no-op --');
  {
    rt.handleCheckout('glm');
    const before = modelNotices().length;
    rt.setModel(GLM);
    ok('no "Model changed" notice for the same card', modelNotices().length === before, JSON.stringify(modelNotices().slice(before)));
    rt.setModel(GLM);
    ok('  … and repeating it stays silent', modelNotices().length === before);
    // The level notices must behave the same way (same per-node rule).
    const beforeEffort = notices().length;
    rt.setThinkingEffort('medium');
    ok('no "Thinking effort changed" notice for the same level', notices().length === beforeEffort, JSON.stringify(notices().slice(beforeEffort)));
  }

  console.log('-- a follow-up runs on the node\'s own card --');
  {
    rt.handleCheckout('glm');
    const onGlm = await send(rt, 'continue on glm');
    ok('the request names the GLM card\'s wire model', onGlm.model === 'glm-4.6', onGlm.model);
    const newNode = rt.session.activeNodeId;
    ok('the new node records the card it ran on', nodeCard(rt, newNode) === GLM, String(nodeCard(rt, newNode)));

    rt.handleCheckout('after');
    const onAfter = await send(rt, 'continue after glm');
    ok('a follow-up on another branch never inherits the other card', onAfter.model === 'deepseek-flash', onAfter.model);
    ok('  … and its new node records its own inherited card', nodeCard(rt, rt.session.activeNodeId) === DS, String(nodeCard(rt, rt.session.activeNodeId)));
  }

  console.log('-- a pending pick is consumed by its own send, and never broadcast --');
  {
    rt.handleCheckout('after');
    rt.setModel(GLM); // pending on `after`
    const picked = await send(rt, 'run this one on glm');
    ok('the send used the pending card', picked.model === 'glm-4.6', picked.model);
    ok('  … and the node keeps it from now on', nodeCard(rt, rt.session.activeNodeId) === GLM, String(nodeCard(rt, rt.session.activeNodeId)));

    rt.handleCheckout('glm');
    const stillGlm = await send(rt, 'glm again');
    ok('another branch is untouched by that pick', stillGlm.model === 'glm-4.6', stillGlm.model);

    rt.handleCheckout('root');
    const backOnDs = await send(rt, 'and back on deepseek');
    ok('the deepseek branch still runs deepseek', backOnDs.model === 'deepseek-flash', backOnDs.model);
  }

  console.log('-- an upload cannot cross providers (#2) --');
  {
    const hasUpload = (messages_) =>
      messages_.some(
        (m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((p) => p.type === 'file'),
      );
    const hasHidden = (messages_) =>
      messages_.some(
        (m) =>
          m.role === 'user' &&
          Array.isArray(m.content) &&
          m.content.some((p) => p.type === 'text' && /uploaded to a provider that this model cannot read from/.test(p.text)),
      );

    rt.handleCheckout('glm');
    const onGlm = await send(rt, 'glm sees the history with the upload');
    const kinds = (messages_) =>
      messages_.map((m) => (Array.isArray(m.content) ? m.content.map((p) => p.type).join('+') : typeof m.content));
    ok('a non-deepseek card never re-sends a DeepSeek upload', !hasUpload(onGlm.messages), kinds(onGlm.messages).join(' | '));
    ok('  … the image is hidden behind the placeholder instead', hasHidden(onGlm.messages));

    rt.handleCheckout('root');
    const onDs = await send(rt, 'deepseek sees the same history');
    ok('a deepseek card still sends the upload it owns', hasUpload(onDs.messages));
    ok('  … and shows no placeholder', !hasHidden(onDs.messages));
  }

  console.log('-- the level is per node too --');
  {
    // `other-card` offers only none/low; a node running on it must not keep a level
    // its card does not offer (the clamp is the card's).
    rt.handleCheckout('after');
    rt.setModel(OTHER);
    await send(rt, 'run on the two-level card');
    const node = rt.session.nodes[rt.session.activeNodeId];
    ok('the node recorded the card', node.model === OTHER, String(node.model));
    ok('  … and a level that card offers', M.effortsFor(M.cardById(OTHER)).includes(node.effort), String(node.effort));
  }

  console.log('');
  finished = true;
  if (problems.length) {
    console.log(`FAIL model-switch-acceptance: ${problems.length} check(s) failed`);
    process.exit(1);
  }
  console.log('PASS model-switch-acceptance: the card and level belong to the node, a pick is pending until its send, a checkout forgets it, and an upload is hidden from a provider that cannot read it');
})();
