/*
 * exec-timeout-acceptance — the `exec_command` foreground-limit contract, as a
 * build-time guard.
 *
 * Same trick as `exec-cwd-acceptance.js` (a `Module._load` hook that stubs
 * `vscode`) and the same shape (check / PASS / FAIL / exit 1), but a different
 * subject: how long one turn may hold the foreground, and what a `timeout` past
 * that may do. Both live in the compiled tool and both decide what happens to work
 * the agent cannot see any more, so they are pinned here rather than argued about
 * in a review.
 *
 * The model is one knob and three numbers:
 *   `spinney.commandMaxForegroundDuration` (seconds, default 300 = 5 minutes) —
 *     the longest one command may occupy a turn's foreground;
 *   `timeout` — the command's TOTAL budget (there is no ceiling any more); and
 *   the foreground slice — `min(timeout, the limit)`.
 * The default `timeout_behavior` is `stop`.
 *
 * What it pins:
 *   1. A fast command is still a plain foreground call: `[exit 0 in …]`, nothing
 *      registered anywhere.
 *   2. `timeout` at or below the limit, with no behavior or an explicit "stop", is
 *      killed at the timeout — even where a background terminal was available.
 *      (Regression: the default used to be "move it to the background", so a
 *      timeout that fits in the turn got promoted; the budget is spent, and
 *      promoting it would be "kill it immediately" in disguise.)
 *   3. `timeout` ABOVE the limit with no behavior, or with "stop", is refused
 *      BEFORE the spawn: the tool throws `timeout <n> s is longer than the <limit> s
 *      a turn may hold (spinney.commandMaxForegroundDuration). … Nothing was
 *      started.`, and neither a process nor a background job is created.
 *      (Regression: a model that asked for 30 minutes held the turn for 30 minutes.)
 *   4. `timeout` above the limit WITH "move_to_background" is promoted at the
 *      LIMIT (not at `timeout`) and carries only the REMAINING budget
 *      (`timeout − limit`); the message names both numbers. (Regression: the job
 *      used to get the whole `timeout` again once in the background, so "1 minute
 *      in the foreground + 30 minutes in the background" was really 30 minutes.)
 *   5. A background behavior with `timeout` omitted registers a job with NO
 *      deadline — `hub.register` gets an undefined (or absent) budget — and the
 *      message names no budget in ms.
 *   6. There is no ceiling: `timeout: 99999` with `start_in_background` is accepted,
 *      and the whole 99999 s travels to the background as that job's budget.
 *   7. A session without background access still kills at the timeout (the old
 *      behaviour) and never throws `Background terminals are not available`.
 *   8. The description keeps the two rules the model is given (never background the
 *      command yourself; use `cwd` instead of a `cd <dir> && …` prefix) and gains
 *      the new ones (5 minutes / `spinney.commandMaxForegroundDuration` / a
 *      background mode is required for a longer timeout), while the removed
 *      `spinney.commandTimeout` / `spinney.commandTimeoutMax` are gone from it.
 *
 * The settings stub answers **keyed by name** (`commandMaxForegroundDuration` → 1)
 * because the limit is only observable when the key can be wrong: a stub that
 * returns one value for every key would hide a leftover `commandTimeout` read. One
 * second keeps every case below at about a second instead of five minutes.
 *
 * Needs `out/` (run `npm run compile` first: it requires the compiled tool).
 * Portable by construction: the "slow" command is `process.execPath -e …`, so it
 * needs no `sleep`, no shell builtin and no PATH lookup.
 *
 * Run: npm run check:timeout   /   node tools/exec-timeout-acceptance.js
 */
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'out');

/** The limit the tools see, in seconds; 1 keeps the whole matrix at a few seconds. */
const LIMIT_SEC = 1;
const LIMIT_MS = LIMIT_SEC * 1000;
/** The `timeout` the promotion/refusal cases ask for: 1 s in the foreground, 4 s left. */
const OVER_SEC = 5;
const OVER_MS = OVER_SEC * 1000;

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

const { makeExecCommandTool } = require(path.join(OUT, 'tools', 'execCommand.js'));

/**
 * A command that runs for `ms` and exits: the node running this script is also the
 * program the shells run, so the driver needs no `sleep` (absent from cmd.exe) and
 * no PATH lookup.
 */
const slowCommand = (ms) => `"${process.execPath}" -e "setTimeout(()=>{},${ms})"`;
const SLOW = slowCommand(3000);

/** The fake background plumbing: one owner, one hub, ids all 7, registrations recorded. */
const owner = { sessionId: 's1', nodeId: 'n1' };
const registered = [];
const hub = {
  register: (o, handle, cmd, cwd, timeoutMs) => {
    registered.push({ o, cmd, cwd, handle, timeoutMs });
    return 7;
  },
};
const withAccess = makeExecCommandTool(() => ({ currentOwner: () => owner, hub }));
const withoutAccess = makeExecCommandTool(() => null);

const problems = [];
let total = 0;
const check = (label, cond, detail) => {
  total += 1;
  console.log(`  [${cond ? 'ok  ' : 'FAIL'}] ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) problems.push(label);
};
const measured = (label, t0) => console.log(`  [time] ${label}: ${Date.now() - t0}ms`);
const firstLine = (s) => String(s).split('\n')[0];
/** A refusal is a paragraph; the log line only needs a window around the phrase that matters. */
const short = (s, needle) => {
  const text = String(s).replace(/\n/g, ' ');
  const at = needle ? text.toLowerCase().indexOf(String(needle).toLowerCase()) : -1;
  if (at < 0) return text.length > 220 ? `${text.slice(0, 220)}…` : text;
  const from = Math.max(0, at - 60);
  const window = text.slice(from, from + 200);
  return `${from > 0 ? '…' : ''}${window}${from + 200 < text.length ? '…' : ''}`;
};

/**
 * A case that never settles must fail the gate rather than hang it: every tool call
 * is raced against a deadline, and the watchdog covers a hang no case is awaiting.
 * Neither timer is unref'd from the main path — the watchdog is, so a normal run
 * still exits on its own.
 */
const CASE_DEADLINE_MS = 8000;
const watchdog = setTimeout(() => {
  console.log(`FAIL exec-timeout: no case settled within 30 s — the tool is blocked`);
  process.exit(1);
}, 30_000);
watchdog.unref?.();

/**
 * Run one tool call and capture either its result or the error it threw (a thrown
 * error is what `ToolRegistry.execute` turns into the model's `Error: …`).
 */
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

/** Stop a job this script promoted, so the driver leaves no process behind. */
const killJob = async (job) => {
  try {
    await job.handle.kill();
  } catch {
    /* already gone */
  }
};

/** Does a message name a budget in milliseconds (the "no deadline" message must not)? */
const namesBudgetMs = (text) =>
  /budget[^.\n]{0,80}?\b\d[\d,]*\s*ms\b/i.test(text) || /\b\d[\d,]*\s*ms\b[^.\n]{0,40}?\bbudget\b/i.test(text);

(async () => {
  console.log('== case 1: a fast command is an ordinary foreground call ==');
  let t0 = Date.now();
  let r = await timed('case 1', withAccess.execute({ command: 'echo hi' }, undefined));
  check('the result is a normal exit line', /^\[exit 0 in /.test(r.text) && r.text.includes('hi'), firstLine(r.text));
  check('nothing was registered', registered.length === 0, `registered=${registered.length}`);
  measured('fast command', t0);

  console.log('== case 2: timeout within the limit + no behavior = killed at the timeout ==');
  t0 = Date.now();
  let before = registered.length;
  r = await timed('case 2', withAccess.execute({ command: SLOW, timeout: LIMIT_SEC }));
  check('the result reports the timeout', /timed out/i.test(r.text) && /1000 ms/.test(firstLine(r.text)), firstLine(r.text));
  check('it settled at the timeout, not at the command’s own end', r.ms >= 900 && r.ms <= 2500, `${r.ms}ms`);
  check('the command was not moved to the background', !/moved to background/.test(r.text), firstLine(r.text));
  check('nothing was registered', registered.length === before, `registered=${registered.length}`);
  measured('kill at the timeout', t0);

  console.log(`== case 3: timeout above the limit + no behavior = refused before spawning ==`);
  before = registered.length;
  r = await timed('case 3', withAccess.execute({ command: SLOW, timeout: OVER_SEC }));
  let bare = r.text.replace(/^Error: /, '');
  check('the tool throws (a returned value would be a silent clamp)', r.threw, r.threw ? undefined : `returned: ${firstLine(r.text)}`);
  check(
    'the message is the frozen refusal sentence',
    /^timeout 5\s?s is longer than the 1\s?s a turn may hold \(spinney\.commandMaxForegroundDuration\)\./.test(bare),
    short(bare, 'longer than'),
  );
  check('it names both numbers (the request and the limit)', /\b5\s?s\b/.test(bare) && /\b1\s?s\b/.test(bare), short(bare, 'longer than'));
  check('it says nothing was started', bare.includes('Nothing was started'), short(bare, 'Nothing was started'));
  check('it returned at once (the 3 s command never ran)', r.ms < 700, `${r.ms}ms`);
  check('nothing was registered', registered.length === before, `registered=${registered.length}`);

  console.log(`== case 4: timeout above the limit + "stop" = the same refusal ==`);
  before = registered.length;
  r = await timed('case 4', withAccess.execute({ command: SLOW, timeout: OVER_SEC, timeout_behavior: 'stop' }));
  bare = r.text.replace(/^Error: /, '');
  check('"stop" is refused the same way', r.threw && bare.includes('is longer than') && bare.includes('Nothing was started'), short(bare, 'longer than'));
  check('it returned at once too', r.ms < 700, `${r.ms}ms`);
  check('nothing was registered', registered.length === before, `registered=${registered.length}`);

  console.log(`== case 5: timeout above the limit + move_to_background = promoted at the limit ==`);
  t0 = Date.now();
  before = registered.length;
  r = await timed('case 5', withAccess.execute({ command: SLOW, timeout: OVER_SEC, timeout_behavior: 'move_to_background' }));
  check('the result leads with the background id', r.text.startsWith('[command moved to background: id 7]'), firstLine(r.text));
  check(`it was promoted at the ${LIMIT_MS} ms limit, not at the ${OVER_MS} ms budget`, r.ms >= 900 && r.ms <= 2500, `${r.ms}ms`);
  check('it was registered exactly once', registered.length === before + 1, `registered=${registered.length}`);
  const job5 = registered[registered.length - 1];
  check(
    `the job carries the remaining budget (${OVER_MS} − ${LIMIT_MS} ms)`,
    job5 && Math.abs((job5.timeoutMs ?? -1) - (OVER_MS - LIMIT_MS)) <= 200,
    `timeoutMs=${String(job5 && job5.timeoutMs)}`,
  );
  check(
    'the message names the 1 s slice it was promoted at',
    /(1000 ms|\b1 s\b)/.test(r.text) && /(budget|remaining|rest)/i.test(r.text),
    short(r.text, 'budget'),
  );
  // The 5 s the call asked for can be named either whole or as the 4 s it handed
  // over (which is what the job actually carries); both are the same budget story.
  check(
    'the message names the budget that left the foreground (5000 ms, as 4000 ms left)',
    /(\b5 s\b|5000 ms|4000 ms|\b4 s\b)/.test(r.text),
    short(r.text, 'budget'),
  );
  check('it is owned by the turn that spawned it', job5 && job5.o === owner);
  if (job5) await killJob(job5);
  measured('move to background at the limit', t0);

  console.log('== case 6: timeout within the limit + move_to_background = killed, not promoted ==');
  t0 = Date.now();
  before = registered.length;
  r = await timed('case 6', withAccess.execute({ command: SLOW, timeout: LIMIT_SEC, timeout_behavior: 'move_to_background' }));
  check('the result reports the timeout', /timed out/i.test(r.text), firstLine(r.text));
  check('it was NOT promoted (the budget was already spent)', !/moved to background/.test(r.text), firstLine(r.text));
  check('nothing was registered', registered.length === before, `registered=${registered.length}`);
  check('it settled at the timeout', r.ms >= 900 && r.ms <= 2500, `${r.ms}ms`);
  measured('kill, not promote', t0);

  console.log('== case 7: a background behavior + no timeout = a job with no deadline ==');
  t0 = Date.now();
  before = registered.length;
  r = await timed('case 7', withAccess.execute({ command: SLOW, timeout_behavior: 'move_to_background' }));
  check('the result leads with the background id', r.text.startsWith('[command moved to background: id 7]'), firstLine(r.text));
  check('it was promoted at the limit', r.ms >= 900 && r.ms <= 2500, `${r.ms}ms`);
  check('it was registered exactly once', registered.length === before + 1, `registered=${registered.length}`);
  const job7 = registered[registered.length - 1];
  check('the job carries no deadline', job7 && job7.timeoutMs === undefined, `timeoutMs=${String(job7 && job7.timeoutMs)}`);
  check(
    'the message says the job has no deadline (what join_background would refuse on)',
    /(no deadline|no budget|runs until it finishes)/i.test(r.text),
    short(r.text, 'deadline'),
  );
  check('the message names no budget in ms', !namesBudgetMs(r.text), short(r.text, 'budget'));
  if (job7) await killJob(job7);
  measured('move to background, no deadline', t0);

  console.log('== case 8: there is no ceiling any more ==');
  t0 = Date.now();
  before = registered.length;
  r = await timed('case 8', withAccess.execute({ command: SLOW, timeout: 99999, timeout_behavior: 'start_in_background' }));
  check('a 99999 s timeout is accepted', !r.threw, r.threw ? firstLine(r.text) : undefined);
  check('the result leads with the background id', r.text.startsWith('[command started in background: id 7]'), firstLine(r.text));
  check('it returned at once (nothing ran in the foreground)', r.ms < 700, `${r.ms}ms`);
  const job8 = registered.length > before ? registered[registered.length - 1] : null;
  check(
    'the whole budget travelled to the background',
    !!job8 && job8.timeoutMs === 99999000,
    `timeoutMs=${String(job8 && job8.timeoutMs)}`,
  );
  if (job8) await killJob(job8);
  measured('start in background', t0);

  console.log('== case 9: no background access = kill at the timeout, never throw ==');
  t0 = Date.now();
  before = registered.length;
  r = await timed('case 9', withoutAccess.execute({ command: SLOW, timeout: LIMIT_SEC }));
  check('it did not throw "Background terminals are not available"', !r.threw, r.threw ? firstLine(r.text) : undefined);
  check('the result reports the timeout', /timed out/i.test(r.text), firstLine(r.text));
  check('nothing was registered', registered.length === before, `registered=${registered.length}`);
  check('it settled at the timeout', r.ms >= 900 && r.ms <= 2500, `${r.ms}ms`);
  measured('no access, kill', t0);

  console.log('== the schema states the new rules ==');
  const def = withAccess.definition.function;
  const desc = def.description;
  check('the no-self-background rule survived', /Never put the command in the background yourself/.test(desc));
  check('the cwd rule survived', /instead of prefixing the command with "cd <dir> && "/.test(desc));
  check('the cwd argument still says "or an absolute path"', /or an absolute path/.test(def.parameters.properties.cwd.description));
  check(
    'the 5-minute limit is stated',
    /5 minutes/.test(desc) || /300 s/.test(desc),
    `limit words: ${(desc.match(/[^.]*5 minutes[^.]*\./) || desc.match(/[^.]*300 s[^.]*\./) || ['(none)'])[0].slice(0, 160)}`,
  );
  check('the limit setting is named', /commandMaxForegroundDuration/.test(desc), `setting mentions: ${(desc.match(/commandMaxForegroundDuration/g) || []).length}`);
  check(
    'a longer timeout must use a background mode',
    /longer than/i.test(desc) &&
      /(refused|must not hold|may not hold)/i.test(desc) &&
      /move_to_background/.test(desc) &&
      /start_in_background/.test(desc),
    `rule sentence: ${(desc.match(/[^.]*longer than[^.]*\./i) || ['(none)'])[0].slice(0, 200)}`,
  );
  check(
    'the removed knobs are gone from what the model reads',
    !/commandTimeout/.test(desc) && !/commandTimeout/.test(def.parameters.properties.timeout.description),
    `description hits: ${(desc.match(/commandTimeout\w*/g) || []).join(',') || 'none'}; timeout hits: ` +
      `${(def.parameters.properties.timeout.description.match(/commandTimeout\w*/g) || []).join(',') || 'none'}`,
  );

  clearTimeout(watchdog);
  console.log('');
  if (problems.length) {
    console.log(`FAIL exec-timeout: ${problems.length} of ${total} check(s) failed`);
    process.exit(1);
  }
  console.log(
    `PASS exec-timeout: ${total}/${total} checks — a turn holds the foreground for at most ` +
      'spinney.commandMaxForegroundDuration: a timeout beyond it is refused unless a background mode is asked ' +
      'for, and then only the remaining budget leaves the foreground',
  );
})();
