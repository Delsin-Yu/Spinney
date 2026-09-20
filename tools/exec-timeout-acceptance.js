/*
 * exec-timeout-acceptance — the `exec_command` timeout contract, as a build-time
 * guard.
 *
 * Same trick as `exec-cwd-acceptance.js` (a `Module._load` hook that stubs
 * `vscode`), same shape (check / PASS / FAIL / exit 1), but a different subject:
 * the *ceiling* on `timeout` and the *default* `timeout_behavior`. Both live in
 * the compiled tool and both decide what happens to work the agent cannot see
 * any more, so they are pinned here rather than argued about in a review.
 *
 * What it pins:
 *   1. A fast command is still a plain foreground call: `[exit 0 in …]`, nothing
 *      registered anywhere.
 *   2. With background access, a command that outlives `timeout` and no explicit
 *      `timeout_behavior` is **moved to the background**: the result leads with
 *      `[command moved to background: id 7]`, names `check_background_terminal(7)`
 *      and says the command was still running and nothing was killed. It must be
 *      registered with the hub under the *owner of the turn* (the node that
 *      spawned it) — a job registered under the wrong owner renders in the wrong
 *      branch and its completion notice is delivered to nobody.
 *      Regression it prevents: losing a 40-minute build to a timeout that used to
 *      kill it, which is the failure the agent cannot undo.
 *   3. Without background access (a bare `ToolRegistry`, exactly what
 *      `tools/exec-cwd-acceptance.js` constructs) the same call must behave as it
 *      always did: kill at the timeout, report `timed out`, register nothing — and
 *      it must never throw `Background terminals are not available`. The default
 *      is derived from what the session can actually do, not assumed.
 *   4. An explicit `"stop"` still kills, even where a background terminal was
 *      available.
 *   5. `timeout` is clamped to `spinney.commandTimeoutMax` (the stub answers 2 s):
 *      asking for 9999 s on a 3 s command must come back after ~2 s and *say*
 *      2000 ms — a model that asked for 9999 and reads an unexplained 2000 learns
 *      that `timeout` is ignored.
 *
 * The settings stub returns values **keyed by name** (`commandTimeoutMax` → 2,
 * `commandTimeout` → 600) because the clamp is only observable if the two keys can
 * differ; a stub that answers one value for every key would hide the bug.
 *
 * Needs `out/` (run `npm run compile` first: it requires the compiled tool).
 * Portable by construction: the "slow" command is `process.execPath -e …`, so it
 * needs no `sleep`, no shell builtin and no PATH lookup, and the assertions never
 * compare a path dialect.
 *
 * Run: node tools/exec-timeout-acceptance.js
 */
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'out');

/** The values the tools see for the two timeout keys (the clamp needs them to differ). */
const SETTINGS = { commandTimeoutMax: 2, commandTimeout: 600 };

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
 * program the shells run, so the driver does not depend on `sleep` (absent from
 * cmd.exe) or on `node` being on PATH.
 */
const slowCommand = (ms) => `"${process.execPath}" -e "setTimeout(()=>{},${ms})"`;
const SLOW = slowCommand(3000);

/** The fake background plumbing: one owner, one hub, ids all 7, registrations recorded. */
const owner = { sessionId: 's1', nodeId: 'n1' };
const registered = [];
const hub = {
  register: (o, handle, cmd, cwd) => {
    registered.push({ o, cmd, cwd, handle });
    return 7;
  },
};
const access = { currentOwner: () => owner, hub };
const withAccess = makeExecCommandTool(() => access);
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
const fold = (s) => String(s).replace(/\\/g, '/').toLowerCase();

(async () => {
  console.log('== case 1: a fast command is an ordinary foreground call ==');
  let t0 = Date.now();
  const fast = await withAccess.execute({ command: 'echo hi' }, undefined);
  check('the result is a normal exit line', /^\[exit 0 in /.test(fast) && fast.includes('hi'), firstLine(fast));
  check('nothing was registered', registered.length === 0, `registered=${registered.length}`);
  measured('fast command', t0);

  console.log('== case 2: no timeout_behavior + access = moved to the background ==');
  t0 = Date.now();
  const moved = await withAccess.execute({ command: SLOW, timeout: 1 });
  check('the result leads with the background id', moved.startsWith('[command moved to background: id 7]'), firstLine(moved));
  check('the id is usable: check_background_terminal(7)', moved.includes('check_background_terminal(7)'));
  check('the message says the command was still running', moved.includes('was still running'), firstLine(moved));
  check('the message says nothing was killed', moved.includes('Nothing was killed'));
  check('the timeout that moved it is named', moved.includes('still running after 1000 ms'), firstLine(moved));
  check('it was registered exactly once', registered.length === 1, `registered=${registered.length}`);
  check('it is owned by the turn that spawned it', registered[0] && registered[0].o === owner);
  check('the registered command and cwd travelled with it',
    registered[0] && registered[0].cmd === SLOW && fold(registered[0].cwd) === fold(ROOT),
    registered[0] && `${registered[0].cmd.slice(0, 40)}… @ ${registered[0].cwd}`);
  measured('move to background', t0);

  console.log('== case 3: no background access = kill at the timeout (the old behaviour) ==');
  t0 = Date.now();
  const before3 = registered.length;
  let killed = '';
  let threw = null;
  try {
    killed = await withoutAccess.execute({ command: SLOW, timeout: 1 });
  } catch (err) {
    threw = String(err && err.message);
  }
  check('it did not throw "Background terminals are not available"', threw === null, threw || undefined);
  check('the result reports the timeout', /^\[command timed out after 1000 ms/.test(killed), firstLine(killed));
  check('nothing became a background terminal', registered.length === before3, `registered=${registered.length}`);
  check('the result advertises no background id', !killed.includes('moved to background'), firstLine(killed));
  measured('kill at the timeout', t0);

  console.log('== case 4: an explicit "stop" kills even where backgrounding was possible ==');
  t0 = Date.now();
  const before4 = registered.length;
  const stopped = await withAccess.execute({ command: SLOW, timeout: 1, timeout_behavior: 'stop' });
  check('the result reports the timeout', /^\[command timed out after 1000 ms/.test(stopped), firstLine(stopped));
  check('nothing became a background terminal', registered.length === before4, `registered=${registered.length}`);
  measured('explicit stop', t0);

  console.log('== case 5: timeout is clamped to spinney.commandTimeoutMax (2 s in the stub) ==');
  t0 = Date.now();
  const clamped = await withAccess.execute({ command: SLOW, timeout: 9999 });
  const took = Date.now() - t0;
  check('the result names the clamped value, not the request', clamped.includes('2000 ms'), firstLine(clamped));
  check('the result names the ceiling it was clamped to', clamped.includes('spinney.commandTimeoutMax=2s'), firstLine(clamped));
  check('the request is still visible, so the model can tell why', clamped.includes('9999s'));
  check('it really ran for the clamped time', took >= 1900 && took < 5000, `${took}ms`);
  measured('clamped timeout', t0);

  console.log('== the schema states the new default ==');
  const def = withAccess.definition.function;
  const desc = def.description;
  check('the default is "moved to the background"', /moved to the background/.test(desc));
  check('the clamp is stated', /commandTimeoutMax/.test(desc));
  check('the cwd rule survived', /instead of prefixing the command with "cd <dir> && "/.test(desc));
  check('the no-self-background rule survived', /Never put the command in the background yourself/.test(desc));

  console.log('');
  if (problems.length) {
    console.log(`FAIL exec-timeout: ${problems.length} of ${total} check(s) failed`);
    process.exit(1);
  }
  console.log(
    `PASS exec-timeout: ${total}/${total} checks — a still-running command is moved to the background under its owner and keeps running, ` +
      'a session without background access still kills at the timeout, and `timeout` is clamped to the configured ceiling',
  );
})();
