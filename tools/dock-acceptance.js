/*
 * dock-acceptance — the two `ChatViewProvider` seams the webview depends on and no
 * other guard reached, as a build-time guard.
 *
 * Same trick as the other windowless acceptance drivers (a `Module._load` hook that
 * stubs `vscode`) and the same shape (check / PASS / FAIL / exit 1). Its subject is
 * the **window-global terminal dock** (`#term-dock`) and the pixels a `read_image`
 * viewer asks for. Both are methods that read only `this` — `globalBackgroundJobs`
 * reads `sessions`, `backgroundHub` and `bgDismissed` — so a plain object passed to
 * the prototype method is the whole fixture, and no window, panel or provider has to
 * exist.
 *
 * What it pins, in order:
 *   1. **Membership.** A live task with `detached: true` is listed; a live task with
 *      `detached: false` is not (a node job lives on its card, not here); a record
 *      (`kind:'bg'`) carrying `bgDetached: true` with no live task IS listed, because
 *      the hub is in-memory and the record is what survives a reload; a record without
 *      the flag is not; a dismissed `(sessionId, taskId)` is not; and after a
 *      registration clears that dismissal the same id is listed again — the bug this
 *      guard exists for, where a job that reused a dismissed id stayed invisible for
 *      good (dismissals persist, the minting counter restarts at 1 after a reload).
 *   2. **Identity and orphans.** The same numeric id in two sessions is two jobs (a
 *      task id is session-local, so the pair is the identity and the de-duplication
 *      key), and a live job whose card node is gone keeps its row with
 *      `cardNodeId: null` — the process is real and the dock is the only place left
 *      that can kill it.
 *   3. **The kill path keeps the record.** A real `SessionRuntime` + `BackgroundHub`,
 *      wired with the provider's own hook, registers a global job, and every ending —
 *      Stop (`rt.stop`, the union kill), the natural exit, and the window's own
 *      teardown (`rt.dispose()`, which disposes the runtime **before** it kills the
 *      jobs) — leaves `bgDetached` on the `kind:'bg'` record, so the dock draws the
 *      same row after a reload. The flag is written at registration for exactly that
 *      last case: a dead runtime's `onBackgroundFinished` returns before it could
 *      snapshot anything.
 *   4. **The image answer.** `answerImageUrl` is what a `read_image` viewer's
 *      `imageUrl` request gets: the file as a data URL **and its mtime** (the viewer
 *      compares it with the call's end), with the size cap, a directory and an empty
 *      path each answering a reason instead of throwing.
 *
 * What it can NOT see: the webview's own half of either subject. The dock's rows, the
 * `rect` clip and the "the file changed after this call" note are DOM and CSS — they
 * are pinned in `tools/check-webview.js` (with a sample per kind) and, for the real
 * pixels, by eye.
 *
 * Needs `out/` (run `npm run compile` first) and is portable: the fixture files live
 * in `os.tmpdir()`, and nothing here starts a process or touches a network.
 *
 * Run: npm run check:dock   /   node tools/dock-acceptance.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'out');

const vscodeStub = {
  l10n: { t: (s, ...args) => String(s).replace(/\{(\d+)\}/g, (_, i) => String(args[i] ?? '')) },
  env: { language: 'en' },
  window: {
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showTextDocument: async () => undefined,
    createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, dispose() {}, clear() {} }),
  },
  workspace: {
    getConfiguration: () => ({ get: () => undefined, update: async () => undefined, has: () => false }),
    workspaceFolders: [],
  },
  Uri: {
    file: (p) => ({ fsPath: p, scheme: 'file', toString: () => String(p) }),
    parse: (s) => ({ scheme: String(s).split(':')[0] }),
  },
  Range: class {
    constructor(sl, sc, el, ec) {
      this.start = { line: sl, character: sc };
      this.end = { line: el, character: ec };
    }
  },
  EventEmitter: class {
    constructor() {
      this.event = () => ({ dispose() {} });
    }
    fire() {}
    dispose() {}
  },
  Disposable: class {
    constructor(fn) {
      this.fn = fn;
    }
    dispose() {
      if (this.fn) this.fn();
    }
  },
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

const { ChatViewProvider } = require(path.join(OUT, 'chat', 'ChatViewProvider.js'));
const R = require(path.join(OUT, 'chat', 'runtime.js'));
const T = require(path.join(OUT, 'chat', 'tree.js'));
const M = require(path.join(OUT, 'agent', 'models.js'));
const { ClientRegistry } = require(path.join(OUT, 'agent', 'clients.js'));
const { BackgroundHub } = require(path.join(OUT, 'chat', 'backgroundHub.js'));
const { ApiClient } = require(path.join(OUT, 'agent', 'apiClient.js'));

// Nothing may leave this machine: every provider call is refused.
ApiClient.prototype.stream = async function* () {
  throw new Error('offline (acceptance run)');
};
ApiClient.prototype.complete = async () => {
  throw new Error('offline (acceptance run)');
};

// One deterministic card, so a runtime resolves a known model instead of the built-in
// fallback (whose provider is the real API host).
const CARD = 'dock-test-card';
M.setCatalog(
  [{ id: 'dock-test-provider', name: 'test', baseUrl: 'http://127.0.0.1:1', concurrency: 0 }],
  [
    {
      id: CARD,
      name: 'test-model',
      providerId: 'dock-test-provider',
      oaiModel: 'test-model',
      contextWindow: 1048576,
      vision: { enabled: true, transport: 'deepseek' },
      efforts: ['none', 'low', 'medium', 'high'],
      defaultEffort: 'medium',
      concurrency: 0,
    },
  ],
);

const problems = [];
let total = 0;
const check = (label, cond, detail) => {
  total += 1;
  console.log(`  [${cond ? 'ok  ' : 'FAIL'}] ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) problems.push(label);
};
const ids = (jobs) => jobs.map((job) => `${job.sessionId}#${job.id}`).join(',') || '(none)';

// ---- The fixtures: a fake `this`, shaped like the three fields the method reads ----

/** A live hub task; `detached` is the whole membership question. */
const task = (id, detached, extra = {}) =>
  Object.assign(
    {
      id,
      command: `cmd-${id}`,
      title: '',
      status: 'running',
      detached,
      startedAt: 1000,
      finishedAt: null,
      exitCode: null,
      killed: false,
      delivered: false,
      handle: { getOutput: () => `output-${id}` },
    },
    extra,
  );

/** A persisted `kind:'bg'` record: what a reload has left when the hub is empty. */
const record = (id, fields) =>
  Object.assign({ id, kind: 'bg', bgTaskId: id, createdAt: 900, status: 'done' }, fields);

/** A session with the cards given; `live` is that session's hub listing. */
const session = (id, title, nodes, live) => ({
  id,
  title,
  nodes: nodes.reduce((acc, node) => Object.assign(acc, { [node.id]: node }), {}),
  rootIds: [],
  activeNodeId: null,
});

/** The `this` `globalBackgroundJobs` needs, and nothing else. */
const fakeThis = (sessions, bySession, dismissed = new Set(), runtimes = new Map()) => ({
  sessions,
  bgDismissed: dismissed,
  backgroundHub: { listForSession: (sessionId) => (bySession[sessionId] || []).map((t) => ({ task: t })) },
  runtimes,
});

console.log('-- the dock lists global jobs, and only global jobs --');
{
  // Session A holds: a global job (7) with a card, a node job (8) with a card, a
  // record-only global job (9, no live task), a record-only node job (10), and a
  // global job whose card is gone (11, live but no record node).
  const a = session('sess-a', 'first session', [
    record(7, { bgDetached: true, parentId: 'turn-a', bgCommand: 'npm run dev' }),
    record(8, { bgDetached: undefined, parentId: 'turn-a', bgCommand: 'npm test' }),
    record(9, { bgDetached: true, parentId: 'turn-a', bgCommand: 'watch', status: 'interrupted', bgKilled: true }),
    record(10, { bgDetached: undefined, parentId: 'turn-a', bgCommand: 'build' }),
  ]);
  const b = session('sess-b', 'second session', [record(7, { bgDetached: true, parentId: 'turn-b', bgCommand: 'serve' })]);
  const liveA = [task(7, true, { status: 'finished', finishedAt: 2000 }), task(8, false), task(11, true, { command: 'orphan' })];
  const ctx = fakeThis([a, b], { 'sess-a': liveA, 'sess-b': [] });
  const jobs = ChatViewProvider.prototype.globalBackgroundJobs.call(ctx);

  const listed = (sessionId, id) => jobs.find((job) => job.sessionId === sessionId && job.id === id);
  check('a live task with `detached: true` is listed', !!listed('sess-a', 7), ids(jobs));
  check('a live task with `detached: false` is not listed', !listed('sess-a', 8), 'a node job lives on its card');
  check(
    'a record carrying `bgDetached: true`, with no live task, IS listed',
    !!listed('sess-a', 9),
    'the hub is in-memory; the record is what a reload has',
  );
  check('a record without the flag is not listed', !listed('sess-a', 10), 'nothing says it was global');
  check(
    'a live job whose card is gone keeps its row, with no card node',
    !!listed('sess-a', 11) && listed('sess-a', 11).cardNodeId === null,
    'the process is real, and the dock is the only place left that can kill it',
  );
  check(
    'the same id in two sessions is two jobs',
    !!listed('sess-a', 7) && !!listed('sess-b', 7),
    'a task id is session-local, so (sessionId, id) is the job',
  );
  check(
    'a restored record never claims the live flag',
    listed('sess-a', 9).detached === false,
    "no task is left to ask, exactly like the card's own `bgDetached` rule",
  );
  check(
    'the record answers the row when no task is left',
    listed('sess-a', 9).command === 'watch' && listed('sess-a', 9).status === 'finished' && listed('sess-a', 9).killed === true,
    'command, status and the kill verdict all come off the record',
  );
  check(
    'order: running first, then finished, newest first inside each group',
    jobs[0].id === 11 && jobs.map((job) => job.status).join(',') === 'running,finished,finished,finished',
    ids(jobs),
  );

  // The dismissal, and the stale one a new job must clear.
  const dismissed = new Set(['sess-a\u00007']);
  const withDismissal = ChatViewProvider.prototype.globalBackgroundJobs.call(
    fakeThis([a, b], { 'sess-a': liveA, 'sess-b': [] }, dismissed),
  );
  check(
    'a dismissed id is not listed',
    !withDismissal.some((job) => job.sessionId === 'sess-a' && job.id === 7),
    ids(withDismissal),
  );

  // A **new** job that took the dismissed id, through the provider's own hook. The
  // runtime is faked: what this section pins is the dismissal bookkeeping, not the card.
  const created = [];
  const runtimes = new Map([['sess-a', { onBackgroundRegistered: (_owner, t) => created.push(t.id) }]]);
  const before = ChatViewProvider.prototype.globalBackgroundJobs.call(
    fakeThis([a, b], { 'sess-a': liveA, 'sess-b': [] }, dismissed),
  );
  ChatViewProvider.prototype.onBackgroundRegistered.call(
    fakeThis([a, b], { 'sess-a': liveA, 'sess-b': [] }, dismissed, runtimes),
    { sessionId: 'sess-a', nodeId: 'turn-a' },
    task(7, true),
  );
  const after = ChatViewProvider.prototype.globalBackgroundJobs.call(
    fakeThis([a, b], { 'sess-a': liveA, 'sess-b': [] }, dismissed),
  );
  check(
    'a registration clears the stale dismissal, so the reused id is listed again',
    !before.some((job) => job.sessionId === 'sess-a' && job.id === 7) &&
      after.some((job) => job.sessionId === 'sess-a' && job.id === 7),
    'dismissals persist, the minting counter does not',
  );
  check(
    "the same registration creates the job's own card",
    created.join(',') === '7',
    `the runtime was asked for ${JSON.stringify(created)}`,
  );
}

console.log('-- the kill path keeps the record (real runtime, real hub) --');
{
  const host = new Proxy(
    {
      transcriptRoot: () => os.tmpdir(),
      transcriptDir: (sid) => path.join(os.tmpdir(), `dock-acceptance-${sid}`),
      dumpSessionTranscript: () => undefined,
      writeSubAgentTranscript: () => undefined,
      getConfig: () => ({
        saveSessionTranscripts: false,
        saveSubAgentTranscripts: false,
        subAgentTranscriptDir: '',
        maxConcurrentSubagents: 4,
        maxLevel2Subagents: 4,
        autoSessionTitles: false,
        defaultCardId: CARD,
        replyLanguage: 'English',
      }),
      isHeld: () => false,
      disposed: false,
      output: { appendLine() {} },
      stateChanged: () => undefined,
      postTo: () => undefined,
      systemPrompt: () => 'SYSTEM-PROMPT',
      resolveModel: (m) => m,
      getContextWindow: () => 1048576,
      agentsMdSources: () => ({ global: null, workspace: null }),
    },
    {
      get(target, prop) {
        if (typeof prop === 'symbol') return undefined;
        return prop in target ? target[prop] : () => undefined;
      },
    },
  );

  /** One session, one turn node, one runtime, and the provider's own hook wiring. */
  const build = () => {
    const s = {
      id: 'sess-kill',
      title: 'kill path',
      createdAt: 1,
      updatedAt: 1,
      nodes: {},
      rootIds: [],
      activeNodeId: null,
      orphanItems: [],
    };
    T.attachNode(s, Object.assign(T.createNode('turn', null, 'turn', 'done'), { messages: [{ role: 'user', content: 'go' }] }));
    s.activeNodeId = 'turn';
    const hub = new BackgroundHub();
    const rt = new R.SessionRuntime(host, s, new ClientRegistry({ apiKeyFor: async () => 'x' }), CARD, 'medium', hub);
    // The provider sends the registration to the dock first, then to the runtime
    // (`ChatViewProvider.onBackgroundRegistered`).
    hub.setHooks({
      onUpdated: () => undefined,
      onFinish: (owner, t) => rt.onBackgroundFinished(owner, t),
      onRegistered: (owner, t) => rt.onBackgroundRegistered(owner, t),
    });
    return { s, hub, rt };
  };

  /** A handle whose `close` the driver can fire, so the exit path is a real transition. */
  const handleFor = (output) => {
    const listeners = {};
    return {
      child: { on: (name, fn) => (listeners[name] = fn), pid: 4242 },
      fire: (name, code) => listeners[name] && listeners[name](code),
      kill: async () => 'exited',
      getOutput: () => output,
      isTruncated: () => false,
    };
  };

  const cardOf = (s) => Object.values(s.nodes).find((node) => node.kind === 'bg');

  // (a) Stop: the union kill. `stop()` kills the node jobs and writes the notices back.
  {
    const { s, hub, rt } = build();
    const handle = handleFor('GLOBAL-OUTPUT');
    const id = hub.register({ sessionId: s.id, nodeId: 'turn' }, handle, 'npm run dev', '.', true, 'dev server');
    const card = cardOf(s);
    check(
      'the card is born with `bgDetached`, not told at its end',
      !!card && card.bgDetached === true,
      'a runtime that dies before the kill would otherwise never write the flag',
    );
    rt.stop('turn');
    const after = s.nodes[card.id];
    check(
      'Stop records the job killed',
      after.status === 'interrupted' && after.bgKilled === true,
      `status=${after.status} killed=${after.bgKilled}`,
    );
    check('Stop keeps `bgDetached` on the record', after.bgDetached === true);
    check(
      'a killed job keeps its output tail on the record',
      after.bgOutputTail === 'GLOBAL-OUTPUT',
      JSON.stringify(after.bgOutputTail),
    );
    const dock = ChatViewProvider.prototype.globalBackgroundJobs.call(fakeThis([s], { [s.id]: hub.listForSession(s.id).map((h) => h.task) }));
    const reloaded = ChatViewProvider.prototype.globalBackgroundJobs.call(fakeThis([s], {}));
    check(
      'the killed job stays in the dock, live and after a reload',
      dock.some((job) => job.id === id) && reloaded.some((job) => job.id === id),
      `live=[${ids(dock)}] reloaded=[${ids(reloaded)}]`,
    );
    check(
      'the reloaded row still says it was a global job',
      reloaded.find((job) => job.id === id).status === 'finished' &&
        reloaded.find((job) => job.id === id).command === 'npm run dev',
      'the record carries the command too; the hub is gone',
    );
  }

  // (b) The window's own teardown: `dispose()` marks the runtime dead and only then
  // kills the jobs, so `onBackgroundFinished` returns before it could snapshot
  // anything. The flag written at registration is what keeps the record.
  {
    const { s, hub, rt } = build();
    hub.register({ sessionId: s.id, nodeId: 'turn' }, handleFor('SHUTDOWN-OUTPUT'), 'npm run build', '.', true, 'build');
    const card = cardOf(s);
    rt.dispose();
    check(
      'a window teardown leaves `bgDetached` on the record',
      s.nodes[card.id].bgDetached === true,
      'the record is all a restart has left',
    );
    check(
      'and the restarted dock still lists it',
      ChatViewProvider.prototype.globalBackgroundJobs.call(fakeThis([s], {})).some((job) => job.id === 1),
    );
  }

  // (c) The natural exit, the ending every non-killed job takes.
  {
    const { s, hub } = build();
    const handle = handleFor('NATURAL-OUTPUT');
    hub.register({ sessionId: s.id, nodeId: 'turn' }, handle, 'npm test', '.', true, 'tests');
    const card = cardOf(s);
    handle.fire('close', 0);
    const after = s.nodes[card.id];
    check(
      'a natural exit records the terminal state and keeps the flag',
      after.bgDetached === true && after.bgExitCode === 0 && after.status === 'done',
      `status=${after.status} exit=${after.bgExitCode}`,
    );
    check(
      'a delivered-or-not global job is listed after a reload either way',
      ChatViewProvider.prototype.globalBackgroundJobs.call(fakeThis([s], {})).some((job) => job.id === 1),
    );
  }

  // (d) The control: a node job must NOT reach the dock through the same paths.
  {
    const { s, hub, rt } = build();
    hub.register({ sessionId: s.id, nodeId: 'turn' }, handleFor('NODE-JOB'), 'npm test', '.', false);
    const card = cardOf(s);
    rt.stop('turn');
    check(
      'a node job never enters the dock, killed or reloaded',
      card.bgDetached === undefined &&
        ChatViewProvider.prototype.globalBackgroundJobs.call(fakeThis([s], {})).length === 0,
      'it lives on its card',
    );
  }
}

console.log('-- the image answer: a data URL, the mtime, and a reason when there is none --');

/**
 * `answerImageUrl` is the host half of the image viewer: the webview cannot read a file,
 * so it asks, and the answer is the pixels plus the file's mtime (which the viewer
 * compares with the call's own end). It reads only `this.postTo`, so the fixture is one
 * object with one method.
 */
async function imageAnswers() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dock-image-'));
  try {
    // A one-pixel PNG: the type comes from the extension, the bytes from the file.
    const png = path.join(dir, 'pixel.png');
    fs.writeFileSync(
      png,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    // The cap is 4 MiB (`IMAGE_VIEW_MAX_BYTES`); a sparse file is all it takes to cross it.
    const big = path.join(dir, 'too-large.png');
    fs.writeFileSync(big, Buffer.alloc(16));
    fs.truncateSync(big, 5 * 1024 * 1024);

    const answered = [];
    const answerFor = async (message) => {
      answered.length = 0;
      await ChatViewProvider.prototype.answerImageUrl.call({ postTo: (_sid, m) => answered.push(m) }, 'sess-img', message);
      return answered[0] || {};
    };
    const stat = fs.statSync(png);

    const ok = await answerFor({ requestId: 'r1', path: png });
    check(
      'a file answers with a data URL of its own type',
      String(ok.url || '').startsWith('data:image/png;base64,') && String(ok.url).length > 40,
      String(ok.url || '').slice(0, 32),
    );
    check(
      "the answer carries the file's own mtime, in host milliseconds",
      Math.abs(Number(ok.mtime) - stat.mtimeMs) < 1,
      `${ok.mtime} vs ${stat.mtimeMs}`,
    );
    check('the requestId comes back, so the viewer can match its request', ok.requestId === 'r1');
    check('the answer names the size it inlined', ok.bytes === stat.size, String(ok.bytes));

    const tooLarge = await answerFor({ requestId: 'r2', path: big });
    check(
      'a file over the cap answers the reason, never the bytes',
      tooLarge.error === 'too large' && !tooLarge.url && typeof tooLarge.mtime === 'number',
      JSON.stringify({ error: tooLarge.error, url: !!tooLarge.url }),
    );
    const folder = await answerFor({ requestId: 'r3', path: dir });
    check('a directory is answered as "not a file"', folder.error === 'not a file', JSON.stringify(folder.error));
    const blank = await answerFor({ requestId: 'r4', path: '' });
    check('an empty path is answered, not thrown', blank.error === 'no path', JSON.stringify(blank.error));
    const missing = await answerFor({ requestId: 'r5', path: path.join(dir, 'gone.png') });
    check(
      'a missing file answers its reason, not an unhandled rejection',
      typeof missing.error === 'string' && missing.error.length > 0 && !missing.url,
      missing.error,
    );

    // The path a viewer sends is the **call's own argument**, i.e. usually workspace-relative
    // (`assets/hero.png`), so the answer has to resolve it against the agent root the way the
    // tool did. A host that stats the raw argument answers "could not read" for every
    // relative `read_image` — the viewer keeps a blank card for a file the model did see.
    const hadFolders = vscodeStub.workspace.workspaceFolders;
    vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: dir, toString: () => `file:///${dir.split(path.sep).join('/')}` } }];
    try {
      const relative = await answerFor({ requestId: 'r6', path: 'pixel.png' });
      check(
        'a workspace-relative path is resolved, so the viewer gets the pixels',
        String(relative.url || '').startsWith('data:image/png;base64,'),
        relative.error || String(relative.url || '').slice(0, 32),
      );
      check(
        'and an empty path is still answered as one, not resolved to the workspace root',
        (await answerFor({ requestId: 'r7', path: '' })).error === 'no path',
      );
    } finally {
      vscodeStub.workspace.workspaceFolders = hadFolders;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

imageAnswers()
  .then(() => {
    console.log('');
    if (problems.length) {
      console.log(`dock-acceptance: ${problems.length} of ${total} checks failed`);
      for (const problem of problems) console.log(`  - ${problem}`);
      process.exit(1);
    }
    console.log(`dock-acceptance: OK — ${total} checks`);
  })
  .catch((err) => {
    console.log(`dock-acceptance: crashed — ${err && err.stack ? err.stack : String(err)}`);
    process.exit(1);
  });
