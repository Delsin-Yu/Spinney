/*
 * shell-argv-acceptance — the argv a *native* child actually receives under the
 * shell we spawn, as a build-time guard.
 *
 * It exists because of one incident: the model ran `taskkill /PID 67188 /T /F`
 * through `exec_command` (Git Bash on Windows) and three stuck Godot processes
 * were never killed. MSYS had rewritten `/PID` into `C:/Program Files/Git/PID`,
 * so taskkill answered `invalid argument/option - 'C:/Program Files/Git/PID'`.
 * Nothing about that failure is visible in the source of the tool: the only way
 * to catch it is to look at the argv that reaches a native program, which is
 * what this driver does. `MSYS_NO_PATHCONV=1` in the Git Bash env is the fix
 * (see the docstring of `src/tools/shell.ts`); this script pins it.
 *
 * What it pins:
 *   1. every probe argument survives verbatim — no argument may carry a
 *      Git/MSYS installation prefix (`C:/Program Files/Git/`, `/Git/`);
 *   2. `/PID` arrives as `/PID` — the exact regression from the incident;
 *   3. `MSYS_NO_PATHCONV` is `'1'` on Windows and absent off Windows (the switch
 *      is meaningless to a POSIX bash, so it must not leak there).
 * It also *prints* what `//F` and `//IM` arrive as. That is a measurement, not an
 * assertion: those two spellings are the MSYS double-slash escape, and their fate
 * depends on a rule we do not own — printing them makes a future change to it
 * visible in the output instead of silently changing behaviour.
 *
 * Technique: it drives the *compiled* shell selection (`out/tools/shell.js`) the
 * way `spawnShellCommand` does — `shell.file` + `shell.buildArgs(cmd)` +
 * `env: shell.env` — and makes the child print its own argv as JSON, so the
 * measurement is the child's, not ours. Needs `out/` (run `npm run compile`
 * first). The Windows half is skipped on POSIX, so the linux CI runs the same
 * gate.
 *
 * Run: node tools/shell-argv-acceptance.js   (not wired into `package.json` yet)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'out');

const WIN = process.platform === 'win32';

/**
 * The probe line: the incident's own arguments (`/PID 1234 /T /F`), the two
 * MSYS-escape spellings whose arrival we merely measure (`//F //IM`), and one
 * ordinary option so the list is not only switches.
 */
const PROBE = ['/PID', '1234', '/T', '/F', '//F', '//IM', '--component=x'];

const problems = [];
let total = 0;
const check = (label, cond, detail) => {
  total += 1;
  console.log(`  [${cond ? 'ok  ' : 'FAIL'}] ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) problems.push(label);
};

let shell;
try {
  shell = require(path.join(OUT, 'tools', 'shell.js')).getShell();
} catch (err) {
  console.log(`FAIL shell-argv: cannot load ${path.join(OUT, 'tools', 'shell.js')} — run \`npm run compile\` first`);
  console.log(`     ${err && err.message}`);
  process.exit(1);
}

console.log(`== shell: ${shell.kind} (${shell.label}) ==`);
console.log(`   ${shell.file}`);
console.log(`   MSYS_NO_PATHCONV=${JSON.stringify(shell.env.MSYS_NO_PATHCONV)}  platform=${process.platform}`);

// The child is a real native program (this very node), handed a script that
// prints the argv it got — the only witness that cannot be fooled by our own
// quoting. Paths go in single quotes: `process.execPath` lives under
// "C:\Program Files\…", whose space bash would otherwise split.
const tmp = path.join(os.tmpdir(), `shell-argv-probe-${process.pid}.js`);
fs.writeFileSync(tmp, 'console.log(JSON.stringify(process.argv.slice(1)))\n');

let argv = [];
try {
  const slashed = (p) => p.replace(/\\/g, '/');
  const cmd = [process.execPath, tmp, ...PROBE].map((a) => `'${slashed(a)}'`).join(' ');
  // Slashes are Windows syntax; bash must not rewrite them into MSYS paths.
  const r = spawnSync(shell.file, shell.buildArgs(cmd), { env: shell.env, encoding: 'utf8' });
  const stdout = (r.stdout || '').trim();
  if (r.status !== 0 || !stdout.startsWith('[')) {
    check('the probe child runs and prints its argv', false, `status=${r.status} stdout=${stdout} stderr=${(r.stderr || '').trim()}`);
  } else {
    argv = JSON.parse(stdout);
    check('the probe child runs and prints its argv', true, `${argv.length} args`);
  }
} finally {
  fs.rmSync(tmp, { force: true });
}

// argv[0] is the probe script itself (whose path we chose); the probe arguments
// are exactly what follows it, in order.
const got = argv.slice(1);
check('every probe argument arrives verbatim', JSON.stringify(got) === JSON.stringify(PROBE), JSON.stringify(got));
for (const bad of [/Git\//i, /Program Files[\\/]Git/i, /[A-Za-z]:\//]) {
  check(
    `no argument carries an MSYS/Git install prefix (${bad})`,
    !got.some((a) => bad.test(a)),
    JSON.stringify(got.filter((a) => bad.test(a))),
  );
}
check('"/PID" arrives as "/PID"', got[0] === '/PID', JSON.stringify(got[0]));

console.log('== measured, not asserted: the MSYS double-slash escape ==');
console.log(`   //F  -> ${JSON.stringify(got[4])}`);
console.log(`   //IM -> ${JSON.stringify(got[5])}`);

console.log('== the switch itself ==');
if (WIN) {
  check("MSYS_NO_PATHCONV is '1' on Windows", shell.env.MSYS_NO_PATHCONV === '1', JSON.stringify(shell.env.MSYS_NO_PATHCONV));
} else {
  check('MSYS_NO_PATHCONV is not added off Windows', shell.env.MSYS_NO_PATHCONV === undefined, JSON.stringify(shell.env.MSYS_NO_PATHCONV));
}
// The switch is only correct if the locale overrides it sits next to are intact.
if (WIN && shell.kind === 'bash') {
  check("LANG is untouched ('zh_CN.UTF-8')", shell.env.LANG === 'zh_CN.UTF-8', String(shell.env.LANG));
}

console.log('');
if (problems.length) {
  console.log(`FAIL shell-argv: ${problems.length} of ${total} check(s) failed (${WIN ? 'windows' : 'posix'})`);
  process.exit(1);
}
console.log(
  `PASS shell-argv: ${total}/${total} checks (${WIN ? 'windows' : 'posix'}${WIN ? '' : ', windows half skipped'}) — ` +
    `a native child under ${shell.label} receives the arguments the command line wrote`,
);
