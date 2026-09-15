/*
 * modeltree-acceptance — the Model Card Tree page's **host** half, as a dev-only
 * acceptance run (not a build guard, and not shipped in the `.vsix`).
 *
 * `tools/check-modeltree.js` covers the webview side (does `media/modeltree.js`
 * survive the protocol?). This covers the other half: does the host half of the
 * page do the right thing with what the page sends —
 *
 *   - a `ready` produces exactly one snapshot (providers + cards + default + the
 *     parse errors of a hand-broken settings file),
 *   - an **invalid** save writes NOTHING (no setting, no key) and answers with the
 *     reasons, so a bad edit can never half-apply,
 *   - a valid save writes `spinney.providers` / `spinney.modelCards` / `spinney.model`
 *     at Global scope, stores/clears the per-provider API keys, calls back once, and
 *     answers `ok`,
 *   - the SecretStorage naming rule: the built-in provider keeps the historical
 *     `spinney.apiKey`, every other provider gets `spinney.apiKey.<id>`.
 *
 * It stubs the `vscode` module (a `Module._load` hook), so it needs `out/`
 * (`npm run compile`) and nothing else: no window, no network.
 *   node tools/modeltree-acceptance.js
 */
const path = require('path');
const Module = require('module');

const ROOT = process.argv[2] || 'd:/Repos/MinimalHost';
const problems = [];
const ok = (label, cond, detail) => {
  console.log(`  [${cond ? 'ok  ' : 'FAIL'}] ${label}${detail ? '  (' + detail + ')' : ''}`);
  if (!cond) problems.push(label);
};

// ---- the vscode stub --------------------------------------------------------

const written = []; // { key, value, target }
const keys = new Map(); // SecretStorage
const commandCalls = [];
const settingsValues = new Map(); // what `get` answers

const makeWebview = () => {
  const listeners = [];
  const posted = [];
  return {
    posted,
    listeners,
    html: '',
    cspSource: 'vscode-resource:',
    asWebviewUri: (uri) => ({ toString: () => String(uri), uri }),
    onDidReceiveMessage(handler) {
      listeners.push(handler);
      return { dispose() {} };
    },
    async postMessage(message) {
      posted.push(message);
      return true;
    },
  };
};

const makePanel = () => {
  const webview = makeWebview();
  let disposeHandler = null;
  const panel = {
    webview,
    title: '',
    reveal() {},
    dispose() {
      if (disposeHandler) disposeHandler();
    },
    onDidDispose(handler) {
      disposeHandler = handler;
      return { dispose() {} };
    },
  };
  return panel;
};

let lastPanel = null;

const vscodeStub = {
  l10n: { t: (s, ...args) => String(s).replace(/\{(\d+)\}/g, (_, i) => String(args[i] ?? '')) },
  env: { language: 'en' },
  ViewColumn: { Active: -1, One: 1 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  window: {
    createWebviewPanel: () => {
      lastPanel = makePanel();
      return lastPanel;
    },
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showInputBox: async () => undefined,
    createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, dispose() {}, clear() {} }),
  },
  workspace: {
    getConfiguration: () => ({
      get: (key) => settingsValues.get(key),
      has: (key) => settingsValues.has(key),
      update: async (key, value, target) => {
        written.push({ key, value, target });
        settingsValues.set(key, value);
      },
    }),
    workspaceFolders: [],
  },
  Uri: {
    file: (p) => ({ fsPath: p, scheme: 'file', toString: () => String(p) }),
    joinPath: (base, ...parts) => ({ fsPath: [base && base.fsPath, ...parts].join('/'), toString: () => [base && base.fsPath, ...parts].join('/') }),
  },
  commands: {
    registerCommand: () => ({ dispose() {} }),
    executeCommand: async (...args) => {
      commandCalls.push(args);
    },
  },
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} },
  Disposable: class { constructor(fn) { this.fn = fn; } dispose() { this.fn && this.fn(); } },
  extensions: { getExtension: () => undefined },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.call(this, request, parent, isMain);
};

const { ModelTreeController, apiKeySecretName } = require(path.join(ROOT, 'out', 'chat', 'modelTree.js'));
const M = require(path.join(ROOT, 'out', 'agent', 'models.js'));

// ---- helpers ----------------------------------------------------------------

const controllerFor = ({ hasKey = async () => false, cards = {}, providers = {}, model = '' } = {}) => {
  settingsValues.clear();
  settingsValues.set('providers', providers);
  settingsValues.set('modelCards', cards);
  settingsValues.set('model', model);
  const events = { saved: 0, stored: [], cleared: [] };
  const controller = new ModelTreeController({
    extensionUri: { fsPath: ROOT, toString: () => ROOT },
    mediaVersion: 'test',
    hasKey,
    storeKey: async (providerId, key) => {
      events.stored.push({ providerId, key });
      keys.set(apiKeySecretName(providerId), key);
    },
    clearKey: async (providerId) => {
      events.cleared.push(providerId);
      keys.delete(apiKeySecretName(providerId));
    },
    onSaved: () => {
      events.saved += 1;
      // What `ChatViewProvider.onModelCardsSaved()` does with the result: re-read
      // the settings into the live catalog (this stub skips the push into the
      // running sessions, which the acceptance run cannot reach).
      const parsed = M.parseCatalog(settingsValues.get('providers'), settingsValues.get('modelCards'));
      M.setCatalog(parsed.providers, parsed.cards);
    },
    log: () => undefined,
  });
  return { controller, events };
};

// A stored settings row — `spinney.modelCards` / `spinney.providers` are objects
// **keyed** by the id, so the row itself never carries one (that is exactly what
// `parseCatalog` rejects, and what the parser error tells a hand-editor).
const card = (over = {}) => ({
  name: 'Card One',
  providerId: 'prov-1',
  oaiModel: 'wire-one',
  contextWindow: 128000,
  concurrency: 0,
  vision: { enabled: true, transport: 'deepseek' },
  efforts: ['none', 'low', 'high'],
  defaultEffort: 'low',
  ...over,
});

const provider = (over = {}) => ({
  name: 'Provider One',
  baseUrl: 'https://example.test',
  concurrency: 4,
  ...over,
});

// What the page posts: the same fields, plus the id it generated for the row.
const saveCard = (id, over = {}) => ({ id, ...card(over) });
const saveProvider = (id, over = {}) => ({ id, ...provider(over) });

const save = (controller, payload) => {
  // What the page does: it boots (`ready` — the panel holds everything until
  // then, exactly like a chat tab), then posts the whole desired state.
  controller.open();
  lastPanel.webview.listeners.forEach((handler) => handler({ type: 'ready' }));
  lastPanel.webview.listeners.forEach((handler) => handler({ type: 'save', payload }));
};

/**
 * Save a payload against a given stored state and report what the host answered.
 * Used by the built-in-protection checks, which need a *stored* row to protect (the
 * settings the controller reads are what `controllerFor` installs).
 */
const trySave = async (rows, payload) => {
  written.length = 0;
  const { controller } = controllerFor({
    providers: Object.fromEntries(rows.providers.map((p) => [p.id, { name: p.name, baseUrl: p.baseUrl, concurrency: p.concurrency }])),
    cards: Object.fromEntries(
      rows.cards.map((c) => [
        c.id,
        {
          name: c.name, providerId: c.providerId, oaiModel: c.oaiModel,
          contextWindow: c.contextWindow, concurrency: c.concurrency,
          vision: c.vision, efforts: c.efforts, defaultEffort: c.defaultEffort,
        },
      ]),
    ),
    model: rows.cards[0] ? rows.cards[0].id : '',
  });
  save(controller, payload);
  await new Promise((r) => setTimeout(r, 0));
  const result = lastResult() || { ok: false, errors: ['no answer'] };
  return { ok: result.ok === true, errors: result.errors || [], written: written.length };
};

const lastResult = () => lastPanel.webview.posted.filter((m) => m.type === 'modelTreeSaveResult').slice(-1)[0];
const snapshots = () => lastPanel.webview.posted.filter((m) => m.type === 'modelTree');

(async () => {
  console.log('-- the SecretStorage naming rule --');
  ok('the built-in provider keeps the historical name', apiKeySecretName('default') === 'spinney.apiKey', apiKeySecretName('default'));
  ok('any other provider gets its own entry', apiKeySecretName('prov-1') === 'spinney.apiKey.prov-1', apiKeySecretName('prov-1'));
  ok('two providers never share one entry', apiKeySecretName('a') !== apiKeySecretName('b'));

  console.log('-- ready: one snapshot, and it shows what the settings hold --');
  {
    written.length = 0;
    const { controller } = controllerFor({
      providers: { 'prov-1': { name: 'Provider One', baseUrl: 'https://example.test', concurrency: 4 } },
      cards: { 'card-1': card() },
      model: 'card-1',
      hasKey: async () => true,
    });
    controller.open();
    ok('the shell was written into the webview', typeof lastPanel.webview.html === 'string' && lastPanel.webview.html.includes('modeltree.js'));
    ok('the l10n catalog is injected', lastPanel.webview.html.includes('__spinneyL10n'));
    lastPanel.webview.listeners.forEach((handler) => handler({ type: 'ready' }));
    await new Promise((r) => setTimeout(r, 0));
    const posts = snapshots();
    ok('`ready` produced exactly one snapshot', posts.length === 1, String(posts.length));
    const snap = posts[0] && posts[0].snapshot;
    ok('the snapshot lists the provider', !!snap && snap.providers.length === 1 && snap.providers[0].id === 'prov-1');
    ok('  … with its live key badge', !!snap && snap.providers[0].hasKey === true);
    ok('the snapshot lists the card', !!snap && snap.cards.length === 1 && snap.cards[0].oaiModel === 'wire-one');
    ok('  … with its own levels', !!snap && snap.cards[0].efforts.join(',') === 'none,low,high');
    ok('the default card id is the card', !!snap && snap.defaultCardId === 'card-1');
    ok('a clean settings file reports no errors', !!snap && snap.errors.length === 0);
    ok('the snapshot carries the reset defaults', !!snap && !!snap.defaults && !!snap.defaults.builtin && !!snap.defaults.fresh);
    ok('  … the built-in card resets to the 2500 cap it ships with', !!snap && snap.defaults.builtin.card.concurrency === 2500, String(snap.defaults && snap.defaults.builtin.card.concurrency));
    ok('  … and a fresh card resets to no cap and the openai transport',
      !!snap && snap.defaults.fresh.card.concurrency === 0 && snap.defaults.fresh.card.vision.transport === 'openai');
    ok('the built-in provider resets to the DeepSeek URL', !!snap && snap.defaults.builtin.provider.baseUrl === 'https://api.deepseek.com');
    ok('a user row is not built-in', !!snap && snap.cards.every((c) => c.isBuiltin === false));
  }

  console.log('-- a hand-broken settings file is reported, not hidden --');
  {
    const { controller } = controllerFor({
      providers: { 'prov-1': { name: 'P', baseUrl: 'https://example.test', concurrency: 0 } },
      cards: { 'card-1': { oaiModel: 'wire-one', efforts: ['low'], defaultEffort: 'nope' } },
      model: 'card-1',
    });
    controller.open();
    lastPanel.webview.listeners.forEach((handler) => handler({ type: 'ready' }));
    await new Promise((r) => setTimeout(r, 0));
    const snap = snapshots().slice(-1)[0].snapshot;
    ok('the unusable default level is reported', snap.errors.some((e) => e.includes('defaultEffort')), snap.errors.join(' | '));
    ok('  … and the card is still usable on level "low"', snap.cards[0].defaultEffort === 'low', snap.cards[0].defaultEffort);
  }

  console.log('-- an invalid save writes nothing at all --');
  {
    written.length = 0;
    const { controller, events } = controllerFor();
    save(controller, {
      providers: [saveProvider('prov-1', { baseUrl: '   ' })],
      cards: [saveCard('card-1')],
      defaultCardId: 'card-1',
      apiKeys: [{ providerId: 'prov-1', key: 'sk-should-not-land' }],
      clearedKeys: [],
    });
    await new Promise((r) => setTimeout(r, 0));
    const result = lastResult();
    ok('the save is refused', !!result && result.ok === false);
    ok('  … with a reason naming the base URL', !!result && result.errors.some((e) => e.includes('Provider One')));
    ok('no setting was written', written.length === 0, JSON.stringify(written));
    ok('no API key was stored', events.stored.length === 0);
    ok('the live sessions were not told to reload', events.saved === 0);
  }

  console.log('-- a valid save writes settings, keys and tells the host --');
  {
    written.length = 0;
    const { controller, events } = controllerFor();
    save(controller, {
      providers: [
        saveProvider('prov-1'),
        saveProvider('prov-2', { name: 'Provider Two', baseUrl: 'https://two.test', concurrency: 0 }),
      ],
      cards: [
        saveCard('card-1', { efforts: ['none', 'low', 'high'], defaultEffort: 'high' }),
        saveCard('card-2', { name: 'Card Two', providerId: 'prov-2', oaiModel: 'wire-two' }),
      ],
      defaultCardId: 'card-2',
      apiKeys: [
        { providerId: 'prov-2', key: 'sk-two' },
        { providerId: 'prov-1', key: '   ' }, // blank = nothing to store
      ],
      clearedKeys: ['default'],
    });
    await new Promise((r) => setTimeout(r, 0));
    const result = lastResult();
    ok('the save is accepted', !!result && result.ok === true, JSON.stringify(result && result.errors));
    const byKey = Object.fromEntries(written.map((w) => [w.key, w.value]));
    ok('the provider table is written as structured data', byKey.providers && byKey.providers['prov-2'].baseUrl === 'https://two.test');
    ok('  … with the concurrency the page sent', byKey.providers && byKey.providers['prov-2'].concurrency === 0);
    ok('the card table is written as structured data', byKey.modelCards && byKey.modelCards['card-2'].oaiModel === 'wire-two');
    ok('  … carrying the card\u2019s own effort menu and default', byKey.modelCards && byKey.modelCards['card-1'].defaultEffort === 'high');
    ok('  … carrying the vision transport', byKey.modelCards && byKey.modelCards['card-1'].vision.transport === 'deepseek');
    ok('the default card is written', byKey.model === 'card-2');
    ok('every write targets the user\u2019s profile', written.every((w) => w.target === vscodeStub.ConfigurationTarget.Global));
    ok('only the non-blank key is stored', events.stored.length === 1 && events.stored[0].key === 'sk-two', JSON.stringify(events.stored));
    ok('the built-in provider\u2019s key was cleared', events.cleared.length === 1 && events.cleared[0] === 'default');
    ok('the host was told exactly once', events.saved === 1, String(events.saved));
    const after = snapshots().slice(-1)[0];
    ok('a fresh snapshot follows the save', after.snapshot.cards.length === 2);
  }

  console.log('-- the catalog the host installs is the saved one --');
  {
    const { controller } = controllerFor();
    save(controller, {
      providers: [saveProvider('prov-1')],
      cards: [saveCard('card-1', { name: 'Only Card', oaiModel: 'only-wire' })],
      defaultCardId: 'card-1',
      apiKeys: [],
      clearedKeys: [],
    });
    await new Promise((r) => setTimeout(r, 0));
    ok('the saved card is in the live catalog', M.cards().length === 1 && M.cards()[0].oaiModel === 'only-wire', JSON.stringify(M.cardIds()));
    ok('  … and a name resolves to it', (M.resolveCard('Only Card') || {}).id === 'card-1');
    ok('  … and the wire name does too', (M.resolveCard('only-wire') || {}).id === 'card-1');
    ok('a level the card does not offer is clamped to its default', M.normalizeEffort(M.cards()[0], 'nonsense') === 'low');
  }

  console.log('-- the built-in rows are marked, and cannot be removed --');
  {
    const rows = M.parseCatalog(
      { 'default': { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', concurrency: 0 } },
      {
        'deepseek-flash': {
          name: 'deepseek-flash', providerId: 'default', oaiModel: 'deepseek-flash',
          contextWindow: 1048576, concurrency: 2500,
          vision: { enabled: true, transport: 'deepseek' },
          efforts: ['none', 'low', 'medium', 'high'], defaultEffort: 'medium',
        },
        'user-card': {
          name: 'mine', providerId: 'default', oaiModel: 'mine',
          contextWindow: 1000, vision: { enabled: false, transport: 'openai' },
        },
      },
    );
    ok('the vendored card id is the built-in one', M.defaultsForCard('deepseek-flash') === M.BUILTIN_CARD_DEFAULTS);
    ok('  … and any other id resets to the fresh values', M.defaultsForCard('user-card') === M.FRESH_CARD_DEFAULTS);
    ok('the built-in provider id is the built-in one', M.defaultsForProvider('default') === M.BUILTIN_PROVIDER_DEFAULTS);
    ok('a derived provider name uses the host, except the known endpoint',
      M.providerNameFromUrl('https://api.deepseek.com') === 'DeepSeek' &&
        M.providerNameFromUrl('https://vllm.local:8000/v1') === 'vllm.local:8000',
      M.providerNameFromUrl('https://vllm.local:8000/v1'));

    // A save that drops a built-in row is refused; dropping a user row is not. The
    // payloads below are otherwise *well formed* on purpose: the only thing wrong with
    // the first two is the missing built-in row, so a pass cannot come from elsewhere.
    const builtinProvider = saveProvider('default', { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', concurrency: 0 });
    const builtinCard = saveCard('deepseek-flash', {
      name: 'deepseek-flash', providerId: 'default', oaiModel: 'deepseek-flash',
      contextWindow: 1048576, concurrency: 2500,
      vision: { enabled: true, transport: 'deepseek' },
      efforts: ['none', 'low', 'medium', 'high'], defaultEffort: 'medium',
    });
    const userCard = saveCard('user-card', { name: 'mine', providerId: 'default', oaiModel: 'mine' });

    const dropBuiltinCard = await trySave(rows, {
      providers: [builtinProvider],
      cards: [userCard],
      defaultCardId: 'user-card',
      apiKeys: [],
      clearedKeys: [],
    });
    ok('a save that drops the built-in card is refused', dropBuiltinCard.ok === false && dropBuiltinCard.errors.some((e) => /built-in model card/i.test(e)), JSON.stringify(dropBuiltinCard.errors));
    ok('  … and nothing was written', dropBuiltinCard.written === 0);

    const dropBuiltinProvider = await trySave(rows, {
      providers: [saveProvider('other', { baseUrl: 'https://other.test' })],
      cards: [saveCard('deepseek-flash', { providerId: 'other', oaiModel: 'deepseek-flash' })],
      defaultCardId: 'deepseek-flash',
      apiKeys: [],
      clearedKeys: [],
    });
    ok('a save that drops the built-in provider is refused', dropBuiltinProvider.ok === false && dropBuiltinProvider.errors.some((e) => /built-in provider/i.test(e)), JSON.stringify(dropBuiltinProvider.errors));
    ok('  … and nothing was written', dropBuiltinProvider.written === 0);

    const keepBoth = await trySave(rows, {
      providers: [builtinProvider],
      cards: [builtinCard, userCard],
      defaultCardId: 'deepseek-flash',
      apiKeys: [],
      clearedKeys: [],
    });
    ok('keeping both built-ins saves fine', keepBoth.ok === true, JSON.stringify(keepBoth.errors));

    const dropUserRow = await trySave(rows, {
      providers: [builtinProvider],
      cards: [builtinCard],
      defaultCardId: 'deepseek-flash',
      apiKeys: [],
      clearedKeys: [],
    });
    ok('dropping a user row is allowed (only the built-ins are protected)', dropUserRow.ok === true, JSON.stringify(dropUserRow.errors));
  }
  console.log('-- the transport field is one of the two vendor names --');
  {
    const spelled = M.parseCatalog(null, {
      'card-new': { name: 'n', providerId: 'p', oaiModel: 'w', vision: { enabled: true, transport: 'NONSENSE' } },
    });
    ok('an unknown transport is a rejected row', spelled.cards.length === 0 && spelled.errors.length > 0, JSON.stringify(spelled.errors));
    // A row that leaves the field out takes the default, which is the standard shape:
    // the Files API is one provider's extension, so it is the one you opt into.
    const bare = M.parseCatalog(null, { 'card-bare': { name: 'n', providerId: 'p', oaiModel: 'w' } });
    ok('a row without a transport defaults to openai', bare.cards[0] && bare.cards[0].vision.transport === 'openai', JSON.stringify(bare.cards[0] && bare.cards[0].vision));
    const bareBool = M.parseCatalog(null, { 'card-bool': { name: 'n', providerId: 'p', oaiModel: 'w', vision: true } });
    ok('  … and so does the shorthand `vision: true`', bareBool.cards[0] && bareBool.cards[0].vision.transport === 'openai', JSON.stringify(bareBool.cards[0] && bareBool.cards[0].vision));
    ok('  … while the vendored card stays pinned to deepseek', M.cards()[0].vision.transport === 'deepseek', M.cards()[0].vision.transport);
  }

  console.log('-- the gear/host coupling: opening twice is one tab --');
  {
    const { controller } = controllerFor();
    controller.open();
    const first = lastPanel;
    controller.open();
    ok('a second open focuses the same panel', lastPanel === first);
  }

  console.log('-- the settings-JSON escape hatch --');
  {
    const { controller } = controllerFor();
    controller.open();
    lastPanel.webview.listeners.forEach((handler) => handler({ type: 'openSettingsJson' }));
    await new Promise((r) => setTimeout(r, 0));
    ok('the page can open settings.json on the card key', commandCalls.some((c) => c[0] === 'workbench.action.openSettingsJson'));
  }

  console.log('');
  if (problems.length) {
    console.log(`FAIL modeltree-acceptance: ${problems.length} check(s) failed`);
    process.exit(1);
  }
  console.log('PASS modeltree-acceptance: the page\u2019s host half answers `ready` with one snapshot, refuses a bad save without writing anything, and writes a good one as structured settings + per-provider keys');
})();
