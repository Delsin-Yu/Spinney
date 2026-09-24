/*
 * bg-budget-acceptance — the background *budget* contract, as a build-time guard.
 *
 * The half of "a turn may not be held forever" that the foreground could not fix:
 * once a job leaves the foreground (`move_to_background` / `start_in_background`)
 * it used to run until the end of time, and `join_background` would happily block a
 * turn for as long as it took. This driver pins the two mechanisms that close that
 * hole — a deadline carried by the job itself, and a join gate that refuses to wait
 * longer than a turn is allowed to.
 *
 * It drives the COMPILED `out/tools/background.js` (which needs no `vscode`) and
 * `out/tools/backgroundTools.js` (which does, so a `Module._load` hook stubs it —
 * the trick `exec-cwd-acceptance.js` and `exec-kill-acceptance.js` use), and it
 * stubs the settings **keyed by name** (`commandMaxForegroundDuration` → 1) so the
 * gate below can be observed without waiting five minutes.
 *
 * The last section goes one layer up: the same stub is enough to build a **real
 * `SessionRuntime`** over a **real `BackgroundHub`** and drive it windowlessly (the
 * pattern `tools/model-switch-acceptance.js` uses), which is what makes the lock rule
 * assertable as behaviour — `lockedNodes()` is the list the composer turns into Stop,
 * so "is this node locked" is a question only the runtime can answer.
 *
 * What it pins:
 *   1. A job registered with a 500 ms budget is killed at roughly its deadline
 *      (not left to run its 8 s command), its `killReason` is `'timeout'`, its
 *      status is `'finished'`, the registry's `onFinish` hook fires exactly once,
 *      and `remainingBudgetMs(task)` reads **0** afterwards. (A budget that only
 *      changed the card's text, or that killed without saying why, would leave the
 *      agent unable to tell a budget kill from a Stop.)
 *   2. A job registered with no budget is not killed: after a second it still runs
 *      and `remainingBudgetMs(task)` is `null` (no deadline, not "0 left"), and a
 *      kill from outside is attributed to a non-timeout reason. (Regression: a
 *      deadline that is really "now" would kill every unbudgeted job at once.)
 *   3. `remainingBudgetMs` on a live budgeted job is a positive number that counts
 *      DOWN in real time — the number the agent reads has to mean something.
 *   4. `join_background`'s gate, through the real tool and a fake hub:
 *      a live job with more budget left than a turn may wait is refused — the
 *      result says `has <…> of its <…> budget left`, `this join was refused`, tells
 *      the agent to `End your turn`, names `kill_background(<id>)`, and returns at
 *      once (it must not block on the job it refused);
 *      a live job with NO deadline is refused too (`has no deadline`) — otherwise a
 *      job without a budget could hold a turn for hours, which is the whole bug;
 *      a live job with 800 ms left is ALLOWED and the join resolves when the job's
 *      budget ends it;
 *      an already finished job keeps today's wording (`finished with exit code …`).
 *   5. The **lock** rule, through a real `SessionRuntime` over a real `BackgroundHub`:
 *      `start_detached` is fire-and-forget, so a detached job must never lock its
 *      owner node — with only a detached job running, `lockedNodes()` is **empty**,
 *      `lockedWorkCount(owner)` is `0` and `hasRunningNodeBackground()` is `false`,
 *      i.e. that node's composer keeps offering **Send** (the exact failure the
 *      feature exists for: a dev server used to hold its owner on Stop until it
 *      ended). The same fixture with `detached: false` locks its owner, `lockedNodes()`
 *      naming that owner and nothing else — the positive control that keeps this
 *      guard from being vacuously green — and with **both** running only the node
 *      job's owner is listed. `lockedWorkCount` counts the node job and not the
 *      detached one. See the section itself for why `hasRunningNodeBackground()` and
 *      `hasRunningBackground()` differ on purpose, and how the fixture is reaped.
 *
 * Every await is bounded: a case that never settles FAILS the run instead of
 * hanging it, and the whole script settles in a few seconds.
 *
 * Needs `out/` (run `npm run compile` first: it requires the compiled tools).
 * Portable: the "slow" command is `process.execPath -e …`, so no `sleep`, no shell
 * builtin and no PATH lookup is needed on any platform.
 *
 * Run: npm run check:budget   /   node tools/bg-budget-acceptance.js
 */
const path = require('path');
const os = require('os');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'out');

/** The limit the join gate sees, in seconds. 1 keeps every case here at ~1 s. */
const LIMIT_SEC = 1;
const SETTINGS = { commandMaxForegroundDuration: LIMIT_SEC };

const vscodeStub = {
  // The extra keys below are what `out/chat/runtime.js` (the lock section) reads while
  // it loads; the settings stub stays keyed by name, which is what the timeout gate needs.
  l10n: { t: (s, ...args) => String(s).replace(/\{(\d+)\}/g, (_, i) => String(args[i] ?? '')) },
  env: { language: 'en' },
  window: {
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, dispose() {}, clear() {} }),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: ROOT, toString: () => 'file:///' + ROOT.split(path.sep).join('/') } }],
    getConfiguration: () => ({ get: (key) => SETTINGS[key], update: async () => undefined, has: () => false }),
  },
  Uri: { file: (p) => ({ fsPath: p, scheme: 'file', toString: () => String(p) }) },
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
      this.fn && this.fn();
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

const bg = require(path.join(OUT, 'tools', 'background.js'));
const { spawnShellCommand, BackgroundRegistry } = bg;
const remainingBudgetMs = bg.remainingBudgetMs;
const { makeJoinBackgroundTool } = require(path.join(OUT, 'tools', 'backgroundTools.js'));
// The lock section (item 5) drives the real `SessionRuntime`: `lockedNodes` lives there,
// and "would the composer show Stop?" is not answerable from a hub alone.
const R = require(path.join(OUT, 'chat', 'runtime.js'));
const T = require(path.join(OUT, 'chat', 'tree.js'));
const { ClientRegistry } = require(path.join(OUT, 'agent', 'clients.js'));
const { BackgroundHub } = require(path.join(OUT, 'chat', 'backgroundHub.js'));

const owner = { sessionId: 's1', nodeId: 'n1' };

/**
 * A command that runs for `ms` and exits: the node running this script is also the
 * program the shells run, so the driver needs no `sleep` (absent from cmd.exe) and
 * no PATH lookup.
 */
const slowCommand = (ms) => `"${process.execPath}" -e "setTimeout(()=>{},${ms})"`;
/** The job every budget case registers: 8 s, i.e. far past any deadline used here. */
const SLOW_DESC = slowCommand(8000);

const problems = [];
let total = 0;
const check = (label, cond, detail) => {
  total += 1;
  console.log(`  [${cond ? 'ok  ' : 'FAIL'}] ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) problems.push(label);
};
const firstLine = (s) => String(s).split('\n')[0];
/** A refusal is a paragraph; the log line only needs enough of it to be recognised. */
const short = (s) => {
  const text = firstLine(s);
  return text.length > 180 ? `${text.slice(0, 180)}…` : text;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reads that must survive a case failing early (a missing API must FAIL, not throw). */
const budgetOf = (task) => (task && typeof remainingBudgetMs === 'function' ? remainingBudgetMs(task) : undefined);
const reasonOf = (task) => (task ? task.killReason : undefined);
const statusOf = (task) => (task ? task.status : undefined);

/**
 * A hang is a failure: every await goes through here. `label` is asserted as a
 * check, so a case that never settles (or throws when it should not) shows up as a
 * named FAIL instead of a stuck gate.
 */
async function bounded(label, promise, ms) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve('__deadline__'), ms);
  });
  try {
    const outcome = await Promise.race([
      Promise.resolve(promise).then(
        (value) => ({ value }),
        (error) => ({ error }),
      ),
      deadline,
    ]);
    if (outcome === '__deadline__') {
      check(`${label}: it settled instead of hanging`, false, `no answer in ${ms} ms`);
      return { ok: false, timeout: true };
    }
    if (outcome.error) {
      check(`${label}: it settled instead of throwing`, false, String(outcome.error.message || outcome.error));
      return { ok: false, error: outcome.error };
    }
    return { ok: true, value: outcome.value };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How the landed `BackgroundRegistry.register` takes the budget. The *shape* — a
 * positional argument, or a field of an options object — is an implementation
 * detail; what is frozen is that a job with a budget dies at its deadline. Reading
 * the declared parameter names keeps this driver honest without hard-coding one
 * shape, and every case below proves the budget really bound (via
 * `remainingBudgetMs`), so a wrong shape fails loudly instead of silently.
 */
function budgetParam() {
  const src = Function.prototype.toString.call(BackgroundRegistry.prototype.register);
  const inner = (String(src).match(/^[^(]*\(([^)]*)\)/) || [null, ''])[1];
  const names = String(inner)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const named = names.findIndex((n) => /timeoutMs|budgetMs|deadlineMs/.test(n));
  if (named >= 0) {
    return { index: named, object: names[named].startsWith('{') };
  }
  const bag = names.findIndex((n, i) => i >= 3 && /^(opts|options|o)$/.test(n));
  if (bag >= 0) {
    return { index: bag, object: true };
  }
  // No budget parameter at all: append it where it would go, so case 1 fails with a
  // clear "it was never killed" instead of a TypeError.
  return { index: Math.max(names.length, 5), object: false };
}
const BUDGET_PARAM = budgetParam();

/** Register a job, filling the earlier parameters (`notifyAgent` = true, no id). */
function registerJob(registry, handle, command, cwd, timeoutMs, detached) {
  const tail = [];
  for (let i = 3; i < BUDGET_PARAM.index; i++) {
    tail.push(i === 3 ? true : undefined);
  }
  if (BUDGET_PARAM.object) tail.push(timeoutMs === undefined ? {} : { timeoutMs });
  else tail.push(timeoutMs);
  // `detached` is the last parameter, after the budget: `budgetParam()` reads this
  // function's source text to find where the budget sits, so the flag has to stay behind
  // it. Passing `false` explicitly for the ordinary cases keeps them byte-for-byte the
  // same call shape as before.
  tail.push(detached === true);
  const id = registry.register(handle, command, cwd, ...tail);
  return { id, task: registry.get(id) };
}

/** Every handle this script spawns, so the run leaves no process behind. */
const live = [];
function spawnSlow(ms) {
  const handle = spawnShellCommand(slowCommand(ms), ROOT, { killOnTruncate: true });
  live.push(handle);
  return handle;
}

// ---- the lock fixture: a real SessionRuntime over a real BackgroundHub ----------
// `lockedNodes()` is what the composer turns into **Stop**, so "is a node locked" is a
// question only the runtime can answer. It is built here, windowlessly, the way
// `tools/model-switch-acceptance.js` does it: the `vscode` stub above plus a narrow host.

const LOCK_SESSION = 'sess-lock';
/** The node whose turn started the *node* job: it **must** be locked. */
const LOCK_NODE = 'n-node';
/** The node whose turn started the *detached* job: it must **never** be locked. */
const LOCK_DETACHED_NODE = 'n-det';
const lockOwner = (nodeId) => ({ sessionId: LOCK_SESSION, nodeId });

/**
 * The host a real `SessionRuntime` talks to. Only the members its construction and the
 * lock reads below touch are real values; anything else is an inert no-op (`persist`,
 * `postTo`, `stateChanged`…), so the run needs no window and writes nothing.
 */
const lockHost = new Proxy(
  {
    getConfig: () => ({
      saveSessionTranscripts: false,
      saveSubAgentTranscripts: false,
      subAgentTranscriptDir: '',
      maxConcurrentSubagents: 4,
      maxLevel2Subagents: 4,
      autoSessionTitles: false,
      foldToolCalls: true,
      foldThinking: true,
      defaultCardId: 'deepseek-flash',
      replyLanguage: 'English',
    }),
    getContextWindow: () => 1_048_576,
    transcriptRoot: () => os.tmpdir(),
    transcriptDir: (sessionId) => path.join(os.tmpdir(), sessionId),
    dumpSessionTranscript: () => undefined,
    writeSubAgentTranscript: () => undefined,
    systemPrompt: () => 'SYSTEM-PROMPT-TEXT',
    resolveModel: (candidate) => candidate,
    isHeld: () => false,
    isReadOnly: () => false,
    disposed: false,
    output: { appendLine() {} },
  },
  {
    get(target, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (prop in target) return target[prop];
      return () => undefined;
    },
  },
);

/**
 * A session with two sibling nodes that can each own a job: the detached job and the
 * node job have **different** owners, which is what makes "with both running, only the
 * node job's owner is listed" a real assertion and not a coincidence of one owner.
 */
function makeLockRuntime(hub) {
  const session = {
    id: LOCK_SESSION,
    title: 'lock',
    createdAt: 1,
    updatedAt: 1,
    nodes: {},
    rootIds: [],
    activeNodeId: null,
    orphanItems: [],
  };
  T.attachNode(session, T.createNode('root', null, 'root', 'done'));
  for (const id of [LOCK_NODE, LOCK_DETACHED_NODE]) {
    T.attachNode(session, T.createNode(id, 'root', id, 'done'));
  }
  session.activeNodeId = 'root';
  return new R.SessionRuntime(
    lockHost,
    session,
    new ClientRegistry({ apiKeyFor: async () => 'x' }),
    'deepseek-flash',
    'medium',
    hub,
  );
}

/**
 * Kill jobs through the hub's own path (the one Stop uses) and await each confirmation.
 * `'exited'` is the child's **own** `exit` event, so it is a measurement of the process
 * rather than a restatement of the registry's intent — which is what lets the lock
 * section claim it left nothing running.
 */
async function killThroughHub(hub, ids) {
  const outcomes = [];
  for (const id of ids) {
    const hit = hub.lookup(LOCK_SESSION, id);
    if (!hit) {
      outcomes.push('unknown-id');
      continue;
    }
    const task = hit.task.status === 'running' ? hub.kill(LOCK_SESSION, id) : hit.task;
    if (!task || !task.killConfirm) {
      outcomes.push('no-confirmation');
      continue;
    }
    const r = await bounded(`the kill of background job ${id}`, task.killConfirm, 4000);
    outcomes.push(r.ok ? r.value : 'no-answer');
  }
  return outcomes;
}

/**
 * A case that never settles (or a stray live child) must fail the gate rather than
 * hold it open: the watchdog is unref'd, so a normal run still exits by itself.
 */
const watchdog = setTimeout(() => {
  console.log('FAIL bg-budget: the run did not finish within 30 s — a case is stuck');
  process.exit(1);
}, 30_000);
watchdog.unref?.();

(async () => {
  console.log(
    `  [info] the landed register(…) takes the budget as parameter #${BUDGET_PARAM.index + 1}` +
      `${BUDGET_PARAM.object ? ' (an options object)' : ' (positional)'}`,
  );

  console.log('== a job with a 500 ms budget dies at its deadline ==');
  const registryA = new BackgroundRegistry();
  const finishesA = [];
  registryA.setOnFinish((t) => finishesA.push(t));
  const handleA = spawnSlow(8000);
  const t0A = Date.now();
  const jobA = registerJob(registryA, handleA, SLOW_DESC, ROOT, 500);
  check('the job is registered and running', statusOf(jobA.task) === 'running', `status=${String(statusOf(jobA.task))}`);
  check(
    'its budget starts at the deadline it was given',
    typeof budgetOf(jobA.task) === 'number' && budgetOf(jobA.task) > 0 && budgetOf(jobA.task) <= 500,
    `remainingBudgetMs=${String(budgetOf(jobA.task))}`,
  );
  await bounded('the budgeted job ends', registryA.waitFor(jobA.id), 4000);
  const msA = Date.now() - t0A;
  check('it was killed at roughly its deadline, not left to run its 8 s command', msA >= 400 && msA <= 1800, `${msA}ms`);
  check('the kill is attributed to the budget', reasonOf(jobA.task) === 'timeout', `killReason=${String(reasonOf(jobA.task))}`);
  check('the task reads as finished', statusOf(jobA.task) === 'finished', `status=${String(statusOf(jobA.task))}`);
  check(
    'onFinish fired exactly once',
    finishesA.filter((t) => t.id === jobA.id).length === 1,
    `${finishesA.length} hook call(s)`,
  );
  check('the budget is spent afterwards', budgetOf(jobA.task) === 0, `remainingBudgetMs=${String(budgetOf(jobA.task))}`);

  console.log('== a job with no budget is left alone ==');
  const registryB = new BackgroundRegistry();
  const handleB = spawnSlow(8000);
  const jobB = registerJob(registryB, handleB, SLOW_DESC, ROOT, undefined);
  await sleep(1000);
  check('it is still running a second later', statusOf(jobB.task) === 'running', `status=${String(statusOf(jobB.task))}`);
  check('it has no deadline (null, not 0)', budgetOf(jobB.task) === null, `remainingBudgetMs=${String(budgetOf(jobB.task))}`);
  const killedB = registryB.kill(jobB.id);
  check('an outside kill still works', !!killedB && statusOf(killedB) === 'finished', `status=${String(statusOf(killedB))}`);
  check('the reason is not "timeout"', reasonOf(killedB) !== 'timeout', `killReason=${String(reasonOf(killedB))}`);
  check(
    'the reason is a documented non-timeout value',
    ['user', 'stop', 'rollover'].includes(String(reasonOf(killedB))),
    `killReason=${String(reasonOf(killedB))}`,
  );
  if (killedB && killedB.killConfirm) await bounded('the outside kill confirms', killedB.killConfirm, 4000);

  console.log('== the remaining budget counts down ==');
  const registryC = new BackgroundRegistry();
  const handleC = spawnSlow(8000);
  const jobC = registerJob(registryC, handleC, SLOW_DESC, ROOT, 5000);
  const firstC = budgetOf(jobC.task);
  await sleep(400);
  const secondC = budgetOf(jobC.task);
  check('a live budgeted job reports a positive number', typeof firstC === 'number' && firstC > 0, String(firstC));
  check('and the number decreases as the job runs', typeof secondC === 'number' && secondC > 0 && secondC < firstC, `${String(firstC)} -> ${String(secondC)}`);
  check(
    'the countdown follows the clock (about the 400 ms that passed)',
    typeof firstC === 'number' && typeof secondC === 'number' && firstC - secondC >= 200 && firstC - secondC <= 1500,
    `Δ=${firstC - secondC}ms`,
  );
  registryC.kill(jobC.id);

  console.log(`== join_background's gate (a turn may wait ${LIMIT_SEC} s) ==`);
  const gate = new BackgroundRegistry();
  const hub = {
    lookup: (sessionId, id) =>
      sessionId === owner.sessionId && gate.get(id) ? { owner, task: gate.get(id) } : undefined,
    waitFor: (sessionId, id, signal) => gate.waitFor(id, signal),
    kill: (sessionId, id, opts) => gate.kill(id, opts),
  };
  const join = makeJoinBackgroundTool(() => ({ currentOwner: () => owner, hub }));

  const handleD1 = spawnSlow(8000);
  const jobD1 = registerJob(gate, handleD1, SLOW_DESC, ROOT, 5000);
  const t0D1 = Date.now();
  const r1 = await bounded('the refused join (5 s left)', join.execute({ pid: jobD1.id }, undefined), 4000);
  const msD1 = Date.now() - t0D1;
  const text1 = r1.ok ? String(r1.value) : '';
  check('a job with 5 s of budget left is refused', /has .+ of its .+ budget left/.test(text1), short(text1));
  check('the refusal says this join was refused', text1.includes('this join was refused'), short(text1));
  check('it tells the agent to end its turn', text1.includes('End your turn'), short(text1));
  check('it names kill_background(<id>) as the way out', text1.includes(`kill_background(${jobD1.id})`), short(text1));
  check('the refusal came back at once (it never waited on the job)', msD1 < 500, `${msD1}ms`);
  check('it is an instruction, not an "Error:" line', text1 !== '' && !/^Error:/.test(text1), short(text1));

  const handleD2 = spawnSlow(8000);
  const jobD2 = registerJob(gate, handleD2, SLOW_DESC, ROOT, undefined);
  const r2 = await bounded('the refused join (no deadline)', join.execute({ pid: jobD2.id }, undefined), 4000);
  const text2 = r2.ok ? String(r2.value) : '';
  check('a job with no deadline is refused', text2.includes('has no deadline'), short(text2));
  check('the no-deadline refusal also says the join was refused', text2.includes('this join was refused'), short(text2));
  check('it points at kill_background(<id>) too', text2.includes(`kill_background(${jobD2.id})`), short(text2));

  const handleD3 = spawnSlow(8000);
  const jobD3 = registerJob(gate, handleD3, SLOW_DESC, ROOT, 800);
  const t0D3 = Date.now();
  const r3 = await bounded('the allowed join (800 ms left)', join.execute({ pid: jobD3.id }, undefined), 5000);
  const msD3 = Date.now() - t0D3;
  const text3 = r3.ok ? String(r3.value) : '';
  check('a job with 800 ms left is joined, not refused', r3.ok && !/refused/.test(text3), short(text3));
  check('the join reports the terminal it waited for', text3.includes(`Background terminal ${jobD3.id}`), short(text3));
  check('the join resolved when the budget ended the job', msD3 >= 700 && msD3 <= 3000, `${msD3}ms`);

  const handleD4 = spawnShellCommand('echo hi', ROOT, { killOnTruncate: true });
  live.push(handleD4);
  const jobD4 = registerJob(gate, handleD4, 'echo hi', ROOT, undefined);
  await bounded('the quick job ends on its own', gate.waitFor(jobD4.id), 5000);
  const r4 = await bounded('the join of a finished job', join.execute({ pid: jobD4.id }, undefined), 4000);
  const text4 = r4.ok ? String(r4.value) : '';
  check('a finished job keeps today’s wording', /finished with exit code 0/.test(text4), short(text4));

  console.log('== join_background on a detached job: refused outright ==');
  const handleDet = spawnSlow(8000);
  const jobDet = registerJob(gate, handleDet, SLOW_DESC, ROOT, undefined, true);
  check('the detached flag reached the registry', jobDet.task.detached === true, `detached=${String(jobDet.task.detached)}`);
  const rDet = await bounded('the refused join (detached job)', join.execute({ pid: jobDet.id }, undefined), 4000);
  const textDet = rDet.ok ? String(rDet.value) : '';
  check('a detached job is refused outright', textDet.includes('is a detached job'), short(textDet));
  check(
    'the refusal says it never notices and that no turn ever waits for it',
    /never sends a completion notice/.test(textDet) && /no turn ever waits/.test(textDet),
    short(textDet),
  );
  check('it names check_background_terminal(<id>) as the way to read it', textDet.includes(`check_background_terminal(${jobDet.id})`), short(textDet));
  check('and kill_background(<id>) as the way to end it', textDet.includes(`kill_background(${jobDet.id})`), short(textDet));
  check('it is the detached refusal, not the budget one', !/budget left/.test(textDet) && !/has no deadline/.test(textDet), short(textDet));

  console.log('== the lock: a detached job never holds its node on Stop ==');
  // Why this section exists: a job that holds its owner's composer on Stop means the
  // owner cannot send a message there until the job ends — so a long-lived thing (a dev
  // server, an emulator, a watcher) could only be started by freezing the conversation.
  // `start_detached` is fire-and-forget: it never sends a completion notice, so there is
  // nothing for its owner to wait for, and the lock rule skips it. That rule lives in
  // three places (`SessionRuntime.lockedNodes`, `lockedWorkCount` and
  // `hasRunningNodeBackground`) and is asserted here as behaviour — `lockedNodes()` is
  // exactly the set the composer turns into Stop.
  //
  // `hasRunningNodeBackground()` and `hasRunningBackground()` deliberately differ, and a
  // future reader would otherwise 'fix' one into the other:
  //   - `hasRunningNodeBackground()` feeds the **idle gates**: the hop refusal, the
  //     session list's `busy` flag, `globallyIdle()` (which the queued session start, the
  //     hop return and the control plane's `POST /wait-for-finish` all wait on) and the
  //     reload refusal. Counting a detached job there would mean a dev server keeps the
  //     harness permanently "not idle", so the supervisor could never reload the window.
  //     It must ignore detached jobs.
  //   - `hasRunningBackground()` is the **factual readout** ("is a process running in
  //     this session?") behind `ControlState.runningBackgrounds`, and a detached job is a
  //     real process that a session/branch deletion really does kill. Hiding it would
  //     misreport the machine. It must count them.
  // Two true statements about two different questions; neither is a bug in the other.
  const lockHub = new BackgroundHub();
  const lockRt = makeLockRuntime(lockHub);

  check(
    'with no job at all, no node is locked',
    lockRt.lockedNodes().length === 0 && !lockRt.hasRunningNodeBackground() && !lockRt.hasRunningBackground(),
    `lockedNodes=${JSON.stringify(lockRt.lockedNodes())}`,
  );

  // (a) Only a detached job. This is the failure the feature exists for, stated as the
  // thing that must never come back: the owner keeps offering Send.
  const handleDetOnly = spawnSlow(8000);
  const detOnlyId = lockHub.register(lockOwner(LOCK_DETACHED_NODE), handleDetOnly, SLOW_DESC, ROOT, undefined, true);
  const detOnlyTask = lockHub.lookup(LOCK_SESSION, detOnlyId)?.task;
  check(
    'the detached job is really running, and flagged detached',
    statusOf(detOnlyTask) === 'running' && detOnlyTask.detached === true,
    `status=${String(statusOf(detOnlyTask))} detached=${String(detOnlyTask && detOnlyTask.detached)}`,
  );
  check(
    'with ONLY a detached job running, lockedNodes() is empty (its owner keeps offering Send)',
    lockRt.lockedNodes().length === 0,
    `lockedNodes=${JSON.stringify(lockRt.lockedNodes())}`,
  );
  check(
    '  … lockedWorkCount(its owner) is 0, so a send from that node is not refused either',
    lockRt.lockedWorkCount(LOCK_DETACHED_NODE) === 0,
    `count=${lockRt.lockedWorkCount(LOCK_DETACHED_NODE)}`,
  );
  check('  … hasRunningNodeBackground() is false, so the idle gates stay idle', lockRt.hasRunningNodeBackground() === false);
  check('  … hasRunningBackground() is still true: the process is a fact', lockRt.hasRunningBackground() === true);
  await killThroughHub(lockHub, [detOnlyId]);

  // (b) The positive control, in the same fixture with `detached` false. Without it an
  // implementation that locked nothing at all would sail through (a).
  const handleNodeOnly = spawnSlow(8000);
  const nodeOnlyId = lockHub.register(lockOwner(LOCK_NODE), handleNodeOnly, SLOW_DESC, ROOT, undefined, false);
  check(
    'a node job (detached false) locks its owner node — and nothing else',
    JSON.stringify(lockRt.lockedNodes()) === JSON.stringify([LOCK_NODE]),
    `lockedNodes=${JSON.stringify(lockRt.lockedNodes())}`,
  );
  check(
    '  … lockedWorkCount(that owner) counts it',
    lockRt.lockedWorkCount(LOCK_NODE) === 1,
    `count=${lockRt.lockedWorkCount(LOCK_NODE)}`,
  );
  check(
    '  … the jobless sibling node counts 0 (nothing is over-counted)',
    lockRt.lockedWorkCount(LOCK_DETACHED_NODE) === 0,
    `count=${lockRt.lockedWorkCount(LOCK_DETACHED_NODE)}`,
  );
  check('  … hasRunningNodeBackground() is true for a node job', lockRt.hasRunningNodeBackground() === true);
  check('  … and hasRunningBackground() is true here too', lockRt.hasRunningBackground() === true);

  // (c) Both at once: the detached job is still not a lock, and still not hidden.
  const handleBoth = spawnSlow(8000);
  const bothId = lockHub.register(lockOwner(LOCK_DETACHED_NODE), handleBoth, SLOW_DESC, ROOT, undefined, true);
  check(
    "with both running, only the node job's owner is listed",
    JSON.stringify(lockRt.lockedNodes()) === JSON.stringify([LOCK_NODE]),
    `lockedNodes=${JSON.stringify(lockRt.lockedNodes())}`,
  );
  check(
    "  … the detached job's owner still counts 0 work",
    lockRt.lockedWorkCount(LOCK_DETACHED_NODE) === 0,
    `count=${lockRt.lockedWorkCount(LOCK_DETACHED_NODE)}`,
  );
  check(
    '  … but the detached job is NOT hidden: both jobs are counted and their owners reported',
    lockRt.runningBackgroundCount() === 2 &&
      lockRt.backgroundNodes().includes(LOCK_NODE) &&
      lockRt.backgroundNodes().includes(LOCK_DETACHED_NODE),
    `runningBackgroundCount=${lockRt.runningBackgroundCount()} backgroundNodes=${JSON.stringify(lockRt.backgroundNodes())}`,
  );

  // (d) Reap, and prove the reap. The fixture's jobs go through the hub's own kill path
  // (the one Stop uses) and each confirmation is awaited: `'exited'` is the child's own
  // exit event, so "nothing is left running" is measured rather than claimed. Every other
  // handle this script spawned is killed by the `live` loop below; these are in it too,
  // and a second kill is idempotent.
  const lockOutcomes = await killThroughHub(lockHub, [nodeOnlyId, bothId]);
  check(
    'every job this section started was killed and the OS confirmed the exit',
    lockOutcomes.length === 2 && lockOutcomes.every((outcome) => outcome === 'exited'),
    lockOutcomes.join(', ') || '(no outcome)',
  );
  check(
    'nothing of the fixture is left running at the end of the section',
    lockHub.listForSession(LOCK_SESSION).every((hit) => hit.task.status === 'finished') &&
      !lockRt.hasRunningBackground() &&
      lockRt.lockedNodes().length === 0,
    `${lockHub.listForSession(LOCK_SESSION).length} job(s) tracked, all finished`,
  );

  for (const handle of live) {
    try {
      await handle.kill();
    } catch {
      /* already gone */
    }
  }
  clearTimeout(watchdog);

  // 6. Nothing is left running. How that is known rather than assumed: every handle this
  // script spawned goes through the loop above, and `handle.kill()` resolves only once the
  // child's own `exit` event arrived (or the OS refused to confirm it — which would show up
  // in the fixtures' kill assertions). The lock fixture's jobs were in that same set *and*
  // were killed through the hub's kill path with their `'exited'` confirmations asserted.
  check(
    'no job this script started is left running when it ends',
    !lockRt.hasRunningBackground() &&
      !lockRt.hasRunningNodeBackground() &&
      lockRt.lockedNodes().length === 0 &&
      lockHub.listForSession(LOCK_SESSION).every((hit) => hit.task.status === 'finished'),
    `${live.length} spawned handle(s) reaped through handle.kill()`,
  );

  console.log('');
  if (problems.length) {
    console.log(`FAIL bg-budget: ${problems.length} of ${total} check(s) failed`);
    process.exit(1);
  }
  console.log(
    `PASS bg-budget: ${total}/${total} checks — a background job with a budget is killed at its deadline and says why, ` +
      'an unbudgeted job is left alone, join_background refuses to hold a turn longer than the limit, and a detached ' +
      'job never locks its owner (that node keeps offering Send)',
  );
})();
