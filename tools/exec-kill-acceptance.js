/*
 * exec-kill-acceptance — the kill-confirmation contract, as a build-time guard.
 *
 * The bug it pins: a kill used to be fire-and-forget. `killChildProcess` returned
 * as soon as the signal had been *sent* (or `taskkill` had run), so Stop, the
 * terminal card and the tool result all claimed a clean ending while the process
 * tree could still be alive — the user's "commands do not end properly". The fix
 * is a kill that reports what it achieved (`'exited' | 'no-exit' | 'no-pid'`) and
 * a confirmation that waits for the child's **`exit`** event (never `close`: a
 * leftover grandchild holds the stdio pipes open, so `close` never arrives).
 *
 * What it pins — four facts, each of which was previously unobservable:
 *   1. `handle.kill()` resolves `'exited'` for a long-running command, and does so
 *      comfortably BEFORE the child would have ended on its own. The elapsed time
 *      is the proof: an 8 s command killed in well under 2 s really was killed, so
 *      the outcome is a measurement and not a restatement of the intent.
 *   2. A second `kill()` on the same handle is safe and still resolves `'exited'`.
 *   3. A command that has already finished (`echo ok`) resolves `'exited'` too — the
 *      "already gone" path, which is what keeps a Stop from hanging on the OS.
 *   4. `BackgroundRegistry.kill` keeps its synchronous transition (the task reads
 *      as finished immediately, so Stop and the card stay instant) and fires the
 *      confirmation detached: a kill that is not confirmed sets `killUnconfirmed`
 *      and writes one `bg kill id=… pid=… reason=… outcome=… ms=…` diagnostics line, while a
 *      confirmed one sets nothing and stays quiet.
 *
 * A handle with no pid (`'no-pid'`) is not constructible through the public API, so
 * instead EVERY outcome this script observes is asserted to be a member of
 * `{'exited','no-exit','no-pid'}`: the type is the contract, and a kill that
 * answers anything else (or never answers) is a failure here.
 *
 * It stubs `vscode` (a `Module._load` hook, the trick `exec-cwd-acceptance.js` and
 * `rollover-acceptance.js` use) so the compiled tools load exactly as the host
 * loads them. Needs `out/` (run `npm run compile` first — it requires the compiled
 * `out/tools/background.js`). Portable: the POSIX and Windows halves both exercise
 * the same public API.
 *
 * Run: node tools/exec-kill-acceptance.js
 * (There is no `check:kill` npm script yet — wiring one into `package.json` /
 * `vscode:prepublish` is a one-line change next to `check:cwd`, which gates the
 * same compiled tools, and is deliberately not part of this file's change.)
 */
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'out');

const vscodeStub = {
  env: {},
  workspace: {
    workspaceFolders: [{ uri: { fsPath: ROOT, toString: () => 'file:///' + ROOT.split(path.sep).join('/') } }],
    getConfiguration: () => ({ get: () => undefined }),
  },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.call(this, request, parent, isMain);
};

const { spawnShellCommand, BackgroundRegistry } = require(path.join(OUT, 'tools', 'background.js'));

/** The whole contract of a kill outcome, read from the module's own type. */
const OUTCOMES = ['exited', 'no-exit', 'no-pid'];
/** A kill that never answers is a failure, not a hang: every await is bounded. */
const ANSWER_BUDGET_MS = 6000;
/** The killed command runs 8 s; anything near that means the kill did nothing. */
const LONG_COMMAND_MS = 8000;
const PROOF_MS = 2000;

/** Diagnostics lines the registry writes through `perf()` (needs `out/perf.js`). */
const perfLines = [];
try {
  require(path.join(OUT, 'perf.js')).setPerfSink((line) => perfLines.push(line));
} catch {
  /* no perf build: the diagnostics-line checks are reported as skipped */
}

const problems = [];
let total = 0;
const check = (label, cond, detail) => {
  total += 1;
  console.log(`  [${cond ? 'ok  ' : 'FAIL'}] ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) problems.push(label);
};

/** Resolve when the child's `exit` arrives (code, or the signal that ended it). */
const waitExit = (child, ms) =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

/**
 * Kill through the public API and measure it. Bounded by a deadline so a
 * confirmation that never arrives fails the run instead of hanging it.
 */
async function killAndMeasure(label, handle) {
  const t0 = Date.now();
  let outcome;
  let rejected = null;
  const timer = { id: null };
  const noAnswer = new Promise((resolve) => {
    timer.id = setTimeout(() => resolve('no-answer'), ANSWER_BUDGET_MS);
  });
  try {
    outcome = await Promise.race([
      handle.kill().then(
        (o) => o,
        (err) => {
          rejected = err;
          return 'rejected';
        },
      ),
      noAnswer,
    ]);
  } catch (err) {
    rejected = err;
    outcome = 'rejected';
  }
  clearTimeout(timer.id);
  const ms = Date.now() - t0;
  console.log(
    `  -> ${label}: outcome=${outcome} ms=${ms}${rejected ? ` rejected=${rejected && rejected.message}` : ''}`,
  );
  return { outcome, ms, rejected };
}

(async () => {
  console.log('== kill: a long-running command ends because we killed it ==');
  const long = spawnShellCommand(`node -e "setTimeout(()=>{},${LONG_COMMAND_MS})"`, process.cwd(), {
    killOnTruncate: true,
  });
  check('a live handle exposes a kill that returns something thenable', typeof long.kill === 'function' && !!long.child.pid, `pid=${long.child.pid}`);
  const first = await killAndMeasure('long command, killed immediately', long);
  check('the kill resolved (it never rejects)', !first.rejected, first.rejected ? String(first.rejected.message) : '');
  check('the kill outcome is one of exited/no-exit/no-pid', OUTCOMES.includes(first.outcome), first.outcome);
  check('the kill confirmed an exit', first.outcome === 'exited', first.outcome);
  check(
    `the confirmation came well before the ${LONG_COMMAND_MS / 1000} s child would have ended`,
    first.ms < PROOF_MS,
    `${first.ms}ms < ${PROOF_MS}ms`,
  );
  check(
    'the child really is gone (exit code or signal recorded)',
    long.child.exitCode !== null || long.child.signalCode !== null,
    `code=${long.child.exitCode} signal=${long.child.signalCode}`,
  );
  const again = await killAndMeasure('the same handle, killed a second time', long);
  check('a second kill is safe and still reports an exit', again.outcome === 'exited', again.outcome);
  check('the second kill does not hang (it returns at once)', again.ms < PROOF_MS, `${again.ms}ms`);

  console.log('== kill: a command that already finished ==');
  const quick = spawnShellCommand('echo ok', process.cwd(), { killOnTruncate: true });
  check('the quick command finishes on its own first', await waitExit(quick.child, 5000));
  const done = await killAndMeasure('already-finished command', quick);
  check('an already-finished command reports an exit', done.outcome === 'exited', done.outcome);
  check('the already-finished kill returns at once', done.ms < PROOF_MS, `${done.ms}ms`);

  console.log('== registry.kill: synchronous transition, detached confirmation ==');
  const registry = new BackgroundRegistry();
  // A fresh, live command: the registry half must confirm a real exit too, not just
  // re-read the already-dead handle from the section above.
  const live = spawnShellCommand(`node -e "setTimeout(()=>{},${LONG_COMMAND_MS})"`, process.cwd(), {
    killOnTruncate: true,
  });
  const killedTask = registry.register(live, 'node -e "setTimeout(()=>{},8000)"', process.cwd(), false, 7);
  check('register() keeps the id the hub minted', killedTask === 7, String(killedTask));
  const before = Date.now();
  const task = registry.kill(killedTask, { notifyAgent: false });
  check('kill() returns synchronously', !!task, task && `id=${task.id}`);
  check('the task reads as killed and finished the moment kill() returns', task.killed === true && task.status === 'finished', `killed=${task.killed} status=${task.status}`);
  check('kill() hands back a confirmation promise', !!task.killConfirm, typeof task.killConfirm);
  check('nothing is claimed unconfirmed before the confirmation lands', !task.killUnconfirmed, String(task.killUnconfirmed));
  const confirm = await task.killConfirm;
  await new Promise((resolve) => setTimeout(resolve, 20)); // let the detached half run
  check('the confirmed outcome is an exit', confirm === 'exited', String(confirm));
  check('a live process really ended here too', Date.now() - before < PROOF_MS, `${Date.now() - before}ms < ${PROOF_MS}ms`);
  check('a confirmed kill sets no killUnconfirmed flag', !task.killUnconfirmed, String(task.killUnconfirmed));
  check(
    'a confirmed kill writes no diagnostics line',
    !perfLines.some((l) => l.includes('bg kill')),
    perfLines.filter((l) => l.includes('bg kill')).join(' | ') || 'none',
  );
  console.log(`  -> registry kill: elapsed=${Date.now() - before}ms outcome=${confirm}`);

  console.log('== registry.kill: an unconfirmed kill is recorded, not hidden ==');
  const unconfirmedRegistry = new BackgroundRegistry();
  const fake = {
    child: { pid: 4242, on() {} },
    kill: () => Promise.resolve('no-exit'),
    getOutput: () => '',
    isTruncated: () => false,
  };
  const fakeId = unconfirmedRegistry.register(fake, 'a tree that would not die', process.cwd(), false, 3);
  const fakeTask = unconfirmedRegistry.kill(fakeId);
  check('the unconfirmed task transitions synchronously too', fakeTask.status === 'finished' && fakeTask.killed, fakeTask.status);
  const fakeOutcome = await fakeTask.killConfirm;
  await new Promise((resolve) => setTimeout(resolve, 20));
  check('the unconfirmed outcome is passed through', fakeOutcome === 'no-exit', String(fakeOutcome));
  check('an unconfirmed kill raises killUnconfirmed', fakeTask.killUnconfirmed === true, String(fakeTask.killUnconfirmed));
  const line = perfLines.find((l) => l.includes('bg kill')) || '';
  check('one diagnostics line names the outcome and elapsed ms', /bg kill id=3 pid=4242 reason=\w+ outcome=no-exit ms=\d+/.test(line), line || '(no line)');

  console.log('');
  if (problems.length) {
    console.log(`FAIL exec-kill: ${problems.length} of ${total} check(s) failed (${process.platform})`);
    process.exit(1);
  }
  console.log(
    `PASS exec-kill: ${total}/${total} checks (${process.platform}) — a kill reports what it achieved, an exit is confirmed ` +
      'before the deadline, and an unconfirmed kill is flagged and logged instead of claimed clean',
  );
})();
