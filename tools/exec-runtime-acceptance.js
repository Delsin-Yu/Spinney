/*
 * exec-runtime-acceptance — the `exec_command` **runtime** contract, as a build-time
 * guard.
 *
 * Same trick as the other windowless acceptance drivers (a `Module._load` hook that
 * stubs `vscode`) and the same shape (check / PASS / FAIL / exit 1). Its subject is
 * the one thing this tool promises and nothing else enforces: **a command is never
 * lost to a clock.** There are three run types, no per-call timeout, and no job has a
 * deadline; a foreground command that outlives its slice is handed to the background
 * with an id, and the agent gets three tools to read, wait for or end it.
 *
 * What it pins, in order:
 *   1. `run_type` omitted is `"foreground"`, and a fast command is an ordinary
 *      foreground call (`[exit 0 in …]`, nothing registered).
 *   2. The **removed arguments**: a call that still sends `timeout` or
 *      `timeout_behavior` is answered, as the model sees it, with exactly
 *      `Error: timeout_behavior was removed; pass run_type "foreground" |
 *      "background" | "detached". There is no per-call timeout any more. Nothing was
 *      started.` — before anything is spawned.
 *   3. The **promotion**: a foreground command still running after
 *      `spinney.execForegroundSeconds` is moved to the background — never killed,
 *      never refused — and the result carries the id, the slice it outlived and the
 *      three tools by name. The process is still alive afterwards.
 *   4. `run_type: "background"` registers a node job at once (detached false) and
 *      returns before any foreground time has passed; `run_type: "detached"`
 *      registers a detached job (no lock, no notice).
 *   5. **No deadline survives**: a registered job carries neither `timeoutMs` nor
 *      `deadlineAt`, the module exports no `remainingBudgetMs`, the registry keeps no
 *      budget timer, a `bg register` line names no budget, and a job is still running
 *      well past the foreground slice (the old model would have promoted or killed it).
 *   6. `wait_for_command` returns the moment the command ends (its result suppresses
 *      the completion notice) and, when the wait runs out first, answers a **normal**
 *      result (never `Error:`) that says the command is still running, that
 *      `check_command` is a status read, that the wait may be called again, and that
 *      `kill_command` plus a quieter command is the other way out — with the notice
 *      restored.
 *   7. The **abort path**: a Stop during the wait answers `[command wait was
 *      interrupted]`, restores the notice, and leaves the command running.
 *   8. `check_command` is a status read (a running job answers the same thing twice,
 *      and says what to do instead of polling); `kill_command` ends the tree.
 *   9. The schemas: `exec_command` takes exactly `command` / `cwd` / `run_type` (no
 *      `timeout`, no `timeout_behavior`), the description keeps the two rules a
 *      sub-agent reads (never background the command yourself; use `cwd` instead of a
 *      `cd <dir> && …` prefix) and the never-sleep/never-poll rule, and the three
 *      management tools are `check_command` / `wait_for_command` / `kill_command`.
 *  10. Sub-agent access: `src/chat/runtime.ts`'s `subAgentTools` exposes the three
 *      management tools to writable sub-agents (the depth-2 subset is the same list),
 *      and the prompt still says what they are for.
 *
 * The settings stub answers **keyed by name** with a 1 s slice, so the promotion and
 * the wait cases cost about a second each instead of the shipped 30 s. A stub that
 * answered every key with the same value would hide a leftover read of a deleted key.
 *
 * Needs `out/` (run `npm run compile` first: it requires the compiled tools).
 * Portable by construction: every "slow" command is `process.execPath -e …`, so it
 * needs no `sleep`, no shell builtin and no PATH lookup.
 *
 * Run: npm run check:exec   /   node tools/exec-runtime-acceptance.js
 */
const path = require('path');
const fs = require('fs');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'out');

/** The foreground slice the tools see, in seconds. 1 keeps the whole guard short. */
const SLICE_SEC = 1;
const SLICE_MS = SLICE_SEC * 1000;

const SETTINGS = { execForegroundSeconds: SLICE_SEC, subAgentSyncSeconds: 4 };

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

const { makeExecCommandTool, execForegroundSeconds, DEFAULT_EXEC_FOREGROUND_SEC } = require(
  path.join(OUT, 'tools', 'execCommand.js'),
);
const background = require(path.join(OUT, 'tools', 'background.js'));
const { makeCheckCommandTool, makeWaitForCommandTool, makeKillCommandTool } = require(
  path.join(OUT, 'tools', 'backgroundTools.js'),
);
const { ToolRegistry } = require(path.join(OUT, 'tools', 'index.js'));
const { setPerfSink } = require(path.join(OUT, 'perf.js'));

/** The diagnostics lines this run produced, so a removed field can be read off one. */
const perfLines = [];
setPerfSink((line) => perfLines.push(line));

/**
 * A command that runs for `ms` and exits: the node running this script is also the
 * program the shells run, so the driver needs no `sleep` (absent from cmd.exe) and
 * no PATH lookup.
 */
const slowCommand = (ms) => `"${process.execPath}" -e "setTimeout(()=>{},${ms})"`;

const problems = [];
let total = 0;
const check = (label, cond, detail) => {
  total += 1;
  console.log(`  [${cond ? 'ok  ' : 'FAIL'}] ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) problems.push(label);
};
const measured = (label, t0) => console.log(`  [time] ${label}: ${Date.now() - t0}ms`);
const firstLine = (s) => String(s).split('\n')[0];
const short = (s, needle) => {
  const text = String(s).replace(/\n/g, ' ');
  const at = needle ? text.toLowerCase().indexOf(String(needle).toLowerCase()) : -1;
  if (at < 0) return text.length > 240 ? `${text.slice(0, 240)}…` : text;
  const from = Math.max(0, at - 60);
  const window = text.slice(from, from + 220);
  return `${from > 0 ? '…' : ''}${window}${from + 220 < text.length ? '…' : ''}`;
};

const CASE_DEADLINE_MS = 15000;
const watchdog = setTimeout(() => {
  console.log('FAIL exec-runtime: no case settled within 90 s — the tools are blocked');
  process.exit(1);
}, 90_000);
watchdog.unref?.();

async function timed(label, promise) {
  const t0 = Date.now();
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve('__deadline__'), CASE_DEADLINE_MS);
  });
  try {
    const outcome = await Promise.race([
      promise.then(
        (text) => ({ text: String(text), threw: false }),
        (err) => ({ text: err instanceof Error ? err.message : String(err), threw: true }),
      ),
      deadline,
    ]);
    const ms = Date.now() - t0;
    if (outcome === '__deadline__') {
      check(`${label}: the call returned instead of blocking`, false, `no answer in ${CASE_DEADLINE_MS} ms`);
      return { text: '', threw: false, ms, timedOut: true };
    }
    return { text: outcome.text, threw: outcome.threw, ms, timedOut: false };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killJob = async (job) => {
  try {
    await job.handle.kill();
  } catch {
    /* already gone */
  }
};

/** The fake hub `exec_command` registers into: one owner, recorded registrations. */
const owner = { sessionId: 's1', nodeId: 'n1' };
const registered = [];
let nextId = 100;
const fakeHub = {
  register: (o, handle, cmd, cwd, detached) => {
    const id = nextId++;
    registered.push({ o, cmd, cwd, handle, detached, id });
    return id;
  },
};
const withAccess = makeExecCommandTool(() => ({ currentOwner: () => owner, hub: fakeHub }));
const withoutAccess = makeExecCommandTool(() => null);

/**
 * The real registry behind the three management tools: `check_command` /
 * `wait_for_command` / `kill_command` must read a **task**, not a stub, because the
 * notice suppression and the abort path are properties of it.
 */
const registry = new background.BackgroundRegistry();
let registryId = 0;
const tasks = new Map();
const realHub = {
  register: (o, handle, cmd, cwd, detached) => {
    const id = ++registryId;
    registry.register(handle, cmd, cwd, true, id, detached);
    tasks.set(id, registry.get(id));
    return id;
  },
  lookup: (sessionId, id) => (tasks.has(id) ? { owner, task: tasks.get(id) } : undefined),
  waitFor: (sessionId, id, signal) => registry.waitFor(id, signal),
  kill: (sessionId, id, opts) => registry.kill(id, opts),
};
const managementAccess = { currentOwner: () => owner, hub: realHub };
const checkTool = makeCheckCommandTool(() => managementAccess);
const waitTool = makeWaitForCommandTool(() => managementAccess);
const killTool = makeKillCommandTool(() => managementAccess);

/** Start a real command and register it as a job of this owner. */
const startJob = (ms, detached = false) => {
  const handle = background.spawnShellCommand(slowCommand(ms), ROOT, { killOnTruncate: true });
  const id = realHub.register(owner, handle, slowCommand(ms), ROOT, detached);
  return { id, task: tasks.get(id), handle };
};

(async () => {
  console.log('== case 1: run_type omitted is "foreground", and a fast command stays one ==');
  check(
    'the shipped default slice is 30 s',
    DEFAULT_EXEC_FOREGROUND_SEC === 30,
    `DEFAULT_EXEC_FOREGROUND_SEC=${DEFAULT_EXEC_FOREGROUND_SEC}`,
  );
  check(
    'the setting is read live (the stub answers it, nothing is hard-coded)',
    execForegroundSeconds() === SLICE_SEC,
    `execForegroundSeconds()=${execForegroundSeconds()}`,
  );
  let registeredBefore = registered.length;
  let r = await timed('case 1', withAccess.execute({ command: 'echo hi' }, undefined));
  check('the result is a normal exit line', /^\[exit 0 in /.test(r.text) && r.text.includes('hi'), firstLine(r.text));
  check('nothing was registered', registered.length === registeredBefore, `registered=${registered.length}`);
  check('no promotion, no run_type in the result', !/moved to background/.test(r.text));

  console.log('== case 2: the removed arguments are answered before anything is spawned ==');
  const removed = await timed(
    'case 2',
    withAccess.execute({ command: slowCommand(5000), timeout: 120, timeout_behavior: 'start_in_background' }),
  );
  const REMOVED =
    'timeout_behavior was removed; pass run_type "foreground" | "background" | "detached". ' +
    'There is no per-call timeout any more. Nothing was started.';
  check('the call is refused', removed.threw, removed.threw ? undefined : `returned: ${firstLine(removed.text)}`);
  check('the sentence is the frozen one', removed.text === REMOVED, short(removed.text, 'removed'));
  check('it says nothing was started', removed.text.includes('Nothing was started.'));
  check('it returned at once (nothing ran)', removed.ms < 700, `${removed.ms}ms`);
  check('nothing was registered', registered.length === registeredBefore, `registered=${registered.length}`);
  // The registry is what the model actually talks to: it owns the `Error: ` prefix.
  const registry2 = new ToolRegistry();
  registry2.setBackgroundAccess({ currentOwner: () => owner, hub: fakeHub });
  const viaRegistry = await registry2.execute(
    'exec_command',
    JSON.stringify({ command: slowCommand(5000), timeout_behavior: 'stop_when_timeout' }),
  );
  check(
    'as the model reads it, the answer is exactly the frozen sentence behind "Error: "',
    viaRegistry === `Error: ${REMOVED}`,
    short(viaRegistry, 'removed'),
  );
  const viaRegistryTimeout = await registry2.execute('exec_command', JSON.stringify({ command: 'echo x', timeout: 9 }));
  check(
    'a bare `timeout` is refused by the same sentence',
    viaRegistryTimeout === `Error: ${REMOVED}`,
    short(viaRegistryTimeout, 'removed'),
  );

  console.log('== case 3: a foreground command past the slice is MOVED to the background ==');
  let t0 = Date.now();
  registeredBefore = registered.length;
  r = await timed('case 3', withAccess.execute({ command: slowCommand(4000) }, undefined));
  check('the result leads with the background id', r.text.startsWith(`[command moved to background: id ${nextId - 1}]`), firstLine(r.text));
  check('it was promoted at the 1 s slice, not at the command’s end', r.ms >= 900 && r.ms <= 3000, `${r.ms}ms`);
  check('it was registered exactly once', registered.length === registeredBefore + 1, `registered=${registered.length}`);
  const promoted = registered[registered.length - 1];
  check('the job is a node job (not detached)', promoted && promoted.detached === false, `detached=${String(promoted && promoted.detached)}`);
  check('the job is owned by the turn that spawned it', promoted && promoted.o === owner);
  check(
    'the process was NOT killed by the move',
    promoted && promoted.handle.child.exitCode === null && promoted.handle.child.signalCode === null,
    `exitCode=${String(promoted && promoted.handle.child.exitCode)}`,
  );
  check('the move says nothing was killed', /Nothing was killed by the move/.test(r.text), short(r.text, 'Nothing was killed'));
  check('the move names the foreground slice it outlived', /1\s?s foreground slice/.test(r.text) && /execForegroundSeconds/.test(r.text), short(r.text, 'slice'));
  check('it names no budget', !/budget/i.test(r.text), short(r.text, 'budget'));
  check('it names the status read as a status read', /check_command\(\d+\) is a status read, not a wait/.test(r.text), short(r.text, 'status read'));
  check('it names the wait tool', /wait_for_command\(\d+\) waits for it/.test(r.text), short(r.text, 'wait_for_command'));
  check('it names the kill tool', /kill_command\(\d+\) stops it/.test(r.text), short(r.text, 'kill_command'));
  check('it tells the agent not to poll', /Do not poll it/.test(r.text), short(r.text, 'Do not poll'));
  if (promoted) await killJob(promoted);
  measured('promotion', t0);

  console.log('== case 4: the three run types ==');
  registeredBefore = registered.length;
  t0 = Date.now();
  const bgRun = await timed('case 4-background', withAccess.execute({ command: slowCommand(4000), run_type: 'background' }, undefined));
  check('"background" leads with the started id', /^\[command started in background: id \d+\]/.test(bgRun.text), firstLine(bgRun.text));
  check('"background" returns before any foreground time has passed', bgRun.ms < 700, `${bgRun.ms}ms`);
  const bgJob = registered[registered.length - 1];
  check('"background" registers a node job', bgJob && bgJob.detached === false, `detached=${String(bgJob && bgJob.detached)}`);
  check('"background" says the composer shows Stop through it', /composer|node/i.test(bgRun.text), short(bgRun.text, 'notice'));
  check('"background" names the completion notice', /completion notice/.test(bgRun.text), short(bgRun.text, 'completion notice'));
  if (bgJob) await killJob(bgJob);
  measured('background start', t0);

  registeredBefore = registered.length;
  const detachedRun = await timed('case 4-detached', withAccess.execute({ command: slowCommand(4000), run_type: 'detached' }, undefined));
  check('"detached" leads with the started id', /^\[command started detached: id \d+\]/.test(detachedRun.text), firstLine(detachedRun.text));
  check('"detached" returns at once', detachedRun.ms < 700, `${detachedRun.ms}ms`);
  const detachedJob = registered[registered.length - 1];
  check('"detached" registers a detached job', detachedJob && detachedJob.detached === true, `detached=${String(detachedJob && detachedJob.detached)}`);
  check('"detached" says it locks no node', /locks no node/.test(detachedRun.text), short(detachedRun.text, 'locks no node'));
  check('"detached" says no notice is sent', /no completion notice will be sent/.test(detachedRun.text), short(detachedRun.text, 'no completion notice'));
  check('"detached" says it has no deadline', /no deadline/.test(detachedRun.text), short(detachedRun.text, 'no deadline'));
  check('"detached" names wait_for_command and check_command', /wait_for_command\(\d+\)/.test(detachedRun.text) && /check_command\(\d+\)/.test(detachedRun.text));
  if (detachedJob) await killJob(detachedJob);

  const invalid = await timed('case 4-invalid', withAccess.execute({ command: 'echo x', run_type: 'stop_when_timeout' }, undefined));
  check(
    'an old behavior name as run_type is refused, naming the three values',
    invalid.threw && /Invalid run_type/.test(invalid.text) && /"foreground", "background", or "detached"/.test(invalid.text),
    short(invalid.text, 'Invalid run_type'),
  );

  console.log('== case 5: no job has a deadline any more ==');
  check('the module exports no remainingBudgetMs', background.remainingBudgetMs === undefined);
  const longJob = startJob(6000);
  check(
    'a registered job carries no timeoutMs and no deadlineAt',
    longJob.task.timeoutMs === undefined && longJob.task.deadlineAt === undefined,
    `timeoutMs=${String(longJob.task.timeoutMs)} deadlineAt=${String(longJob.task.deadlineAt)}`,
  );
  check('the registry keeps no budget timer', !('budgetTimers' in registry));
  check(
    'the registration line names no budget',
    (() => {
      const line = perfLines.filter((l) => / bg register /.test(l)).pop() ?? '';
      return / detached=(true|false)$/.test(line) && !/budget=/.test(line);
    })(),
    perfLines.filter((l) => / bg register /.test(l)).pop() ?? '(no bg register line)',
  );
  await sleep(SLICE_MS * 2 + 300);
  check(
    'the job is still running well past the foreground slice (nothing expires it)',
    longJob.task.status === 'running' && longJob.handle.child.exitCode === null,
    `status=${longJob.task.status}`,
  );
  check(
    'no `bg expire` line exists any more',
    !perfLines.some((l) => / bg expire /.test(l)),
    perfLines.filter((l) => / bg expire /.test(l)).join(' | ') || '(none)',
  );
  await killJob(longJob.handle);

  console.log('== case 6: wait_for_command — finishing early ==');
  const quick = startJob(300);
  t0 = Date.now();
  const early = await timed('case 6', waitTool.execute({ pid: quick.id, seconds: 8 }, undefined));
  check('the wait returns the moment the command ends', early.ms < 3000, `${early.ms}ms`);
  check('the result is the finished line', new RegExp(`^Command ${quick.id} finished with exit code 0 after `).test(early.text), firstLine(early.text));
  check('the result carries the output', !/\nOutput:\n/.test(early.text) || /Output:/.test(early.text));
  check('the completion notice is suppressed (the result IS the signal)', quick.task.notifyAgent === false, `notifyAgent=${String(quick.task.notifyAgent)}`);
  measured('wait, early finish', t0);

  console.log('== case 7: wait_for_command — the wait runs out ==');
  const stubborn = startJob(6000);
  t0 = Date.now();
  const timedOut = await timed('case 7', waitTool.execute({ pid: stubborn.id, seconds: 1 }, undefined));
  check('the call answered a normal result, not an Error:', !timedOut.threw && !/^Error:/.test(timedOut.text), firstLine(timedOut.text));
  check('it waited the seconds it was given, not the command’s end', timedOut.ms >= 900 && timedOut.ms <= 3000, `${timedOut.ms}ms`);
  check('it says the command is still running', new RegExp(`^Command ${stubborn.id} is still running after this 1 s wait`).test(timedOut.text), firstLine(timedOut.text));
  check('it says nothing changed', /nothing changed and the command keeps running/.test(timedOut.text), short(timedOut.text, 'nothing changed'));
  check('it names check_command as a status read', /check_command\(\d+\) is a status read, not a wait/.test(timedOut.text), short(timedOut.text, 'status read'));
  check('it says the wait may be called again', /may be called again/.test(timedOut.text), short(timedOut.text, 'called again'));
  check('it names kill_command and a quieter command', /kill_command\(\d+\) stops it/.test(timedOut.text) && /quieter command/.test(timedOut.text), short(timedOut.text, 'quieter command'));
  check('the notice is restored after a timed-out wait', stubborn.task.notifyAgent === true, `notifyAgent=${String(stubborn.task.notifyAgent)}`);
  check('the command keeps running', stubborn.task.status === 'running', `status=${stubborn.task.status}`);
  check(
    'no detached sentence on a node job',
    !/no completion notice will arrive/.test(timedOut.text),
    short(timedOut.text, 'notice'),
  );
  measured('wait, timeout', t0);

  console.log('== case 8: wait_for_command — the abort path (Stop) ==');
  t0 = Date.now();
  const controller = new AbortController();
  const aborting = waitTool.execute({ pid: stubborn.id, seconds: 20 }, controller.signal);
  setTimeout(() => controller.abort(), 300);
  const aborted = await timed('case 8', aborting);
  check('the wait is interrupted, not failed', aborted.text === '[command wait was interrupted]', firstLine(aborted.text));
  check('it returned at the Stop, not at the wait’s end', aborted.ms < 3000, `${aborted.ms}ms`);
  check('the notice is restored after an interrupted wait', stubborn.task.notifyAgent === true, `notifyAgent=${String(stubborn.task.notifyAgent)}`);
  check('the command is untouched by the Stop of the wait', stubborn.task.status === 'running', `status=${stubborn.task.status}`);
  measured('wait, abort', t0);

  console.log('== case 9: check_command is a status read, and a detached job says so ==');
  const first = await timed('case 9-a', checkTool.execute({ pid: stubborn.id }, undefined));
  const second = await timed('case 9-b', checkTool.execute({ pid: stubborn.id }, undefined));
  check('a running job is a status line', new RegExp(`^Command ${stubborn.id} is running\\.`).test(first.text), firstLine(first.text));
  check('asking twice answers the same status', / is running\./.test(second.text));
  check('the status read names the notice and wait_for_command', /completion notice/.test(first.text) && /wait_for_command\(\d+\)/.test(first.text), short(first.text, 'wait_for_command'));
  check('the status read says it is not a wait', /this is a status read, not a wait/.test(first.text), short(first.text, 'status read'));

  const detachedTask = startJob(6000, true);
  check('a detached job never notifies', detachedTask.task.notifyAgent === false);
  const detachedCheck = await timed('case 9-c', checkTool.execute({ pid: detachedTask.id }, undefined));
  check('a detached job’s status says it never notifies', /never notifies/.test(detachedCheck.text), short(detachedCheck.text, 'never notifies'));
  const detachedWait = await timed('case 9-d', waitTool.execute({ pid: detachedTask.id, seconds: 1 }, undefined));
  check('a wait on a detached job times out as a normal result', !detachedWait.threw && /is still running after this 1 s wait/.test(detachedWait.text), firstLine(detachedWait.text));
  check('the timeout text says no notice will arrive for a detached job', /no completion notice will arrive/.test(detachedWait.text), short(detachedWait.text, 'no completion notice'));
  check('a timed-out wait on a detached job keeps it silent', detachedTask.task.notifyAgent === false, `notifyAgent=${String(detachedTask.task.notifyAgent)}`);

  console.log('== case 10: kill_command ends the tree ==');
  const killed = await timed('case 10', killTool.execute({ pid: stubborn.id }, undefined));
  check('the kill confirms', new RegExp(`^Killed command ${stubborn.id} after `).test(killed.text), firstLine(killed.text));
  check('the job reads as finished', stubborn.task.status === 'finished', `status=${stubborn.task.status}`);
  check('the kill is recorded as a kill', stubborn.task.killed === true && stubborn.task.killReason === 'stop');
  check('the kill suppresses the notice', stubborn.task.notifyAgent === false, `notifyAgent=${String(stubborn.task.notifyAgent)}`);
  const already = await timed('case 10-b', killTool.execute({ pid: stubborn.id }, undefined));
  check('a finished job answers "not running" instead of killing twice', /is not running/.test(already.text), firstLine(already.text));
  const lateWait = await timed('case 10-c', waitTool.execute({ pid: stubborn.id }, undefined));
  check('a later wait on a finished job returns its result at once', new RegExp(`^Command ${stubborn.id} was killed after `).test(lateWait.text), firstLine(lateWait.text));
  await killJob(detachedTask.handle);
  await killJob(quick.handle);

  console.log('== case 11: the schemas ==');
  const schema = withAccess.definition.function;
  const props = Object.keys(schema.parameters.properties);
  check('exec_command takes command, cwd and run_type, and nothing else', props.join(',') === 'command,cwd,run_type', props.join(','));
  check('`timeout` is gone from the schema', !props.includes('timeout') && !props.includes('timeout_behavior'));
  check(
    'run_type is the three values, in order',
    (schema.parameters.properties.run_type.enum || []).join(',') === 'foreground,background,detached',
    (schema.parameters.properties.run_type.enum || []).join(','),
  );
  check('only `command` is required', (schema.parameters.required || []).join(',') === 'command');
  const desc = schema.description;
  check('the no-self-background rule survived', /Never put the command in the background yourself/.test(desc));
  check('the cwd rule survived', /instead of prefixing the command with "cd <dir> && "/.test(desc));
  check('the cwd argument still says "or an absolute path"', /or an absolute path/.test(schema.parameters.properties.cwd.description));
  check('the shell-is-not-a-search clause survived', /Do not use the shell for search/.test(desc));
  check('the description states there is no per-call timeout', /There is no per-call timeout/.test(desc), short(desc, 'no per-call timeout'));
  check('the description says never sleep to wait / never poll', /Never sleep to wait for a command/.test(desc) && /never poll/.test(desc), short(desc, 'Never sleep'));
  check('the description names all three management tools', /check_command/.test(desc) && /wait_for_command/.test(desc) && /kill_command/.test(desc));
  check('the description names the foreground setting', /spinney\.execForegroundSeconds/.test(desc));
  check('the description names no deleted setting', !/commandDefaultTimeout|commandMaxForegroundDuration/.test(desc), short(desc, 'commandMaxForegroundDuration'));
  check(
    'no old value name survives anywhere in the schema',
    !/stop_when_timeout|background_when_timeout|start_in_background|start_detached/.test(JSON.stringify(schema)),
    short(short(desc, 'timeout_behavior'), 'timeout'),
  );
  const checkSchema = checkTool.definition.function;
  const waitSchema = waitTool.definition.function;
  const killSchema = killTool.definition.function;
  check('check_command is a tool taking pid', checkSchema.name === 'check_command' && (checkSchema.parameters.required || []).join(',') === 'pid');
  check(
    'wait_for_command takes pid and an optional seconds',
    waitSchema.name === 'wait_for_command' &&
      Object.keys(waitSchema.parameters.properties).join(',') === 'pid,seconds' &&
      (waitSchema.parameters.required || []).join(',') === 'pid',
  );
  check('kill_command is a tool taking pid', killSchema.name === 'kill_command' && (killSchema.parameters.required || []).join(',') === 'pid');
  check(
    'check_command says it is a status read, not a wait',
    /status read, not a wait/.test(checkSchema.description),
    short(checkSchema.description, 'status read'),
  );
  check(
    'wait_for_command says it returns the moment the command ends and that the wait may be repeated',
    /returns the moment the command ends/.test(waitSchema.description) &&
      /call wait_for_command again/.test(waitSchema.description),
    short(waitSchema.description, 'wait'),
  );

  console.log('== case 12: sub-agents and the prompt ==');
  const runtimeSrc = fs.readFileSync(path.join(ROOT, 'src', 'chat', 'runtime.ts'), 'utf8');
  const writeTools = (() => {
    const at = runtimeSrc.indexOf('private subAgentTools(');
    const block = at >= 0 ? runtimeSrc.slice(at, at + 4000) : '';
    const m = block.match(/const writeTools = \[([\s\S]*?)\];/);
    return m ? m[1].replace(/['"\s]/g, '').split(',').filter(Boolean) : [];
  })();
  check(
    'subAgentTools gives writable sub-agents exec_command plus the three management tools',
    ['exec_command', 'check_command', 'wait_for_command', 'kill_command'].every((n) => writeTools.includes(n)),
    writeTools.join(',') || '(not found)',
  );
  check(
    'the read-only branch blocks and hides exactly that list (so it keeps none of the four)',
    /withBlocked\(writeTools\)\.withHidden\(writeTools\)/.test(runtimeSrc),
  );
  check(
    'the sync-wait setting is read from spinney.subAgentSyncSeconds',
    /get<number>\('subAgentSyncSeconds'\)/.test(runtimeSrc) && !/commandMaxForegroundDuration/.test(runtimeSrc),
  );
  const promptSrc = fs.readFileSync(path.join(ROOT, 'src', 'agent', 'prompt.ts'), 'utf8');
  check(
    'the prompt tells the model never to sleep for a command',
    /Never sleep to wait for a command/.test(promptSrc),
    short(promptSrc.slice(promptSrc.indexOf('Never sleep'), promptSrc.indexOf('Never sleep') + 120), 'Never sleep'),
  );
  check('the prompt names wait_for_command and check_command', /wait_for_command/.test(promptSrc) && /check_command/.test(promptSrc));
  check('the prompt keeps the never-background-it-yourself rule', /never hand the work to a process the harness does not own/.test(promptSrc));
  check('the prompt names spinney.execForegroundSeconds', /spinney\.execForegroundSeconds/.test(promptSrc));
  check(
    'the prompt names none of the removed arguments or settings',
    !/timeout_behavior/.test(promptSrc) && !/commandMaxForegroundDuration|commandDefaultTimeout/.test(promptSrc),
  );

  clearTimeout(watchdog);
  console.log('');
  if (problems.length) {
    console.log(`FAIL exec-runtime: ${problems.length} of ${total} check(s) failed`);
    process.exit(1);
  }
  console.log(
    `PASS exec-runtime: ${total}/${total} checks — run_type is foreground, background or detached, no job has a ` +
      'deadline, a foreground command past spinney.execForegroundSeconds is moved to the background instead of ' +
      'being killed, and wait_for_command / check_command / kill_command are how the id is used',
  );
  // Every job this guard started is killed above; the registry keeps no timer, so the
  // process exits on its own.
  process.exit(0);
})();
