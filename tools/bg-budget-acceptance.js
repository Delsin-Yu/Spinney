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
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'out');

/** The limit the join gate sees, in seconds. 1 keeps every case here at ~1 s. */
const LIMIT_SEC = 1;
const SETTINGS = { commandMaxForegroundDuration: LIMIT_SEC };

const vscodeStub = {
  env: {},
  workspace: {
    workspaceFolders: [{ uri: { fsPath: ROOT, toString: () => 'file:///' + ROOT.split(path.sep).join('/') } }],
    getConfiguration: () => ({ get: (key) => SETTINGS[key] }),
  },
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
function registerJob(registry, handle, command, cwd, timeoutMs) {
  const tail = [];
  for (let i = 3; i < BUDGET_PARAM.index; i++) {
    tail.push(i === 3 ? true : undefined);
  }
  if (BUDGET_PARAM.object) tail.push(timeoutMs === undefined ? {} : { timeoutMs });
  else tail.push(timeoutMs);
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

  for (const handle of live) {
    try {
      await handle.kill();
    } catch {
      /* already gone */
    }
  }
  clearTimeout(watchdog);

  console.log('');
  if (problems.length) {
    console.log(`FAIL bg-budget: ${problems.length} of ${total} check(s) failed`);
    process.exit(1);
  }
  console.log(
    `PASS bg-budget: ${total}/${total} checks — a background job with a budget is killed at its deadline and says why, ` +
      'an unbudgeted job is left alone, and join_background refuses to hold a turn longer than the limit',
  );
})();
