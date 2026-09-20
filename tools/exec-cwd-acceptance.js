/*
 * exec-cwd-acceptance — the working-directory / path-base contract, as a
 * build-time guard.
 *
 * It is the one acceptance driver that is part of the gate: the contract lives in
 * the *compiled* tools, so it stubs `vscode` (a `Module._load` hook, the trick
 * `rollover-acceptance.js` uses) and drives `ToolRegistry.execute` against a real
 * shell, exactly as the host does.
 *
 * What it pins — four regressions, each of which taught the model a lie:
 *   1. `resolvePath` maps an MSYS/Git-Bash drive path (`/d/Repos/x`) onto
 *      `D:\Repos\x` on Windows, where `/d/…` is "rooted at the current drive" and
 *      would otherwise be read as `D:\d\Repos\x`; on POSIX `/d` is an ordinary
 *      directory and must survive untouched.
 *   2. `exec_command` starts in the harness root and names that directory in the
 *      FIRST line of its result — the line that tells the model a `cd <root> && …`
 *      prefix is not needed (and that `limitInline`'s 8-line preview keeps).
 *   3. A `cwd` that cannot be used names the path — `does not exist` / `is not a
 *      directory`, plus the harness root — and never the shell. The spawn used to
 *      fail first, and Node blamed the shell (`spawn …\bash.exe ENOENT`), which
 *      reads as "the shell is missing" and hides the real cause.
 *   4. `read_file` reaches the file the model meant when it writes the `/d/...`
 *      form, and a miss reports the drive path rather than `D:\d\…`.
 * Finally it reads the `exec_command` schema: the two rules stated there (use
 * `cwd`, never `cd <dir> && …`; never put a command in the background itself) are
 * the only copy a sub-agent ever sees, since it gets no system prompt.
 *
 * Needs `out/` (run `npm run compile` first: it requires the compiled tools), and
 * therefore runs after `compile` in `vscode:prepublish`, like `check:signals`.
 * Portable by construction — every drive path is derived from this checkout, the
 * Windows-only half is skipped elsewhere, and the assertions compare the root's
 * *tail* so either path dialect satisfies them. The linux CI runs the same gate.
 *
 * Run: npm run check:cwd   /   node tools/exec-cwd-acceptance.js
 */
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'out');

const WIN = process.platform === 'win32';
const DRIVE = ROOT[0].toUpperCase(); // 'd:\Repos\x' -> 'D'
const WIN_ROOT = `${DRIVE}:${ROOT.slice(2)}`; // -> 'D:\Repos\x'
const MSYS_ROOT = `/${ROOT[0].toLowerCase()}${ROOT.slice(2).split(path.sep).join('/')}`; // -> '/d/Repos/x'

/** Slash-fold and lower case: one spelling for a path, whichever dialect wrote it. */
const fold = (s) => String(s).replace(/\\/g, '/').toLowerCase();
/**
 * The harness root without its anchor (`/repos/minimalhost`), which is the part a
 * command's output agrees on: `pwd` under Git Bash answers `/d/Repos/MinimalHost`
 * and the tool's own echo answers `d:\Repos\MinimalHost`. Comparing the tail keeps
 * the assertion about *where* the command ran rather than about either spelling.
 */
const ROOT_TAIL = fold(ROOT).replace(/^[a-z]:/, '');
const saysRoot = (text, child) => fold(text).includes(child ? `${ROOT_TAIL}/${child}` : ROOT_TAIL);

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

const { ToolRegistry, resolvePath, getAgentRoot } = require(path.join(OUT, 'tools', 'index.js'));

const reg = new ToolRegistry();
const call = (name, args) => reg.execute(name, JSON.stringify(args));
const def = reg.definitions.find((d) => d.function.name === 'exec_command');
const problems = [];
let total = 0;
const check = (label, cond, detail) => {
  total += 1;
  console.log(`  [${cond ? 'ok  ' : 'FAIL'}] ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) problems.push(label);
};
const firstLine = (s) => s.split('\n')[0];
const cwdLine = (s) => fold(firstLine(s)).includes('· cwd ') && saysRoot(firstLine(s));

(async () => {
  console.log('== resolvePath / path base ==');
  check('agent root is the workspace folder', fold(getAgentRoot()) === fold(ROOT), getAgentRoot());
  check('a relative path resolves against the root', resolvePath('src') === path.join(ROOT, 'src'), resolvePath('src'));
  if (WIN) {
    check('resolvePath maps /d/Repos/x onto D:\\Repos\\x', resolvePath(MSYS_ROOT) === WIN_ROOT, resolvePath(MSYS_ROOT));
    check('resolvePath maps a bare /d onto the drive root', resolvePath('/d') === `${DRIVE}:\\`, resolvePath('/d'));
  } else {
    check(
      'an MSYS-looking path is left alone off Windows (a real directory there)',
      resolvePath('/d/Repos/x') === '/d/Repos/x',
      resolvePath('/d/Repos/x'),
    );
  }

  console.log('== exec_command: the first line names the directory ==');
  const plain = await call('exec_command', { command: 'pwd' });
  check('a default run starts in the harness root', saysRoot(plain), plain.trim());
  check('the first line carries the cwd', cwdLine(plain), firstLine(plain));
  const rel = await call('exec_command', { command: 'pwd', cwd: 'src' });
  check('cwd "src" runs there', saysRoot(rel, 'src'), rel.trim());
  check('the cwd line reports src', cwdLine(rel) && saysRoot(firstLine(rel), 'src'), firstLine(rel));
  if (WIN) {
    const msys = await call('exec_command', { command: 'pwd', cwd: MSYS_ROOT });
    check('cwd in the /d form no longer fails to spawn', saysRoot(msys) && !/ENOENT/.test(msys), msys.trim());
    check('the cwd line reports the drive form', cwdLine(msys), firstLine(msys));
    const win = await call('exec_command', { command: 'pwd', cwd: WIN_ROOT });
    check('cwd in the D:\\ form runs there', saysRoot(win) && !/ENOENT/.test(win), win.trim());
  }

  console.log('== exec_command: a broken cwd names the path ==');
  const missing = await call('exec_command', { command: 'echo hi', cwd: 'does-not-exist' });
  check('a missing cwd is reported as missing', /does not exist/.test(missing), missing.trim());
  check('the message names the requested path', missing.includes('"does-not-exist"'), missing.trim());
  check('the message names the harness root', saysRoot(missing), missing.trim());
  check('the shell is not blamed', !/ENOENT|bash\.exe/.test(missing), missing.trim());
  const file = await call('exec_command', { command: 'echo hi', cwd: 'package.json' });
  check('a file as cwd is reported as not-a-directory', /is not a directory/.test(file), file.trim());
  if (WIN) {
    const missingMsys = await call('exec_command', { command: 'echo hi', cwd: '/d/no-such-repo' });
    check(
      'a missing /d path is reported against the drive path',
      /does not exist/.test(missingMsys) &&
        missingMsys.includes('"/d/no-such-repo"') &&
        fold(missingMsys).includes(`${DRIVE.toLowerCase()}:/no-such-repo`) &&
        !/ENOENT/.test(missingMsys),
      missingMsys.trim(),
    );
  }

  console.log('== read_file: the same path form reaches the file ==');
  const read = await call('read_file', { path: path.join(ROOT, 'package.json'), startLine: 1, endLine: 3 });
  check('read_file on an absolute path reads the file', /"name": "spinney"/.test(read), firstLine(read));
  if (WIN) {
    const readMsys = await call('read_file', { path: `${MSYS_ROOT}/package.json`, startLine: 1, endLine: 3 });
    check('the /d form reads the same file', /"name": "spinney"/.test(readMsys), firstLine(readMsys));
    const noSuch = await call('read_file', { path: `${MSYS_ROOT}/nope.txt` });
    check(
      'a miss reports the drive path, not D:\\d\\…',
      fold(noSuch).includes(`${ROOT_TAIL}/nope.txt`) && !fold(noSuch).includes(`${DRIVE.toLowerCase()}:/d/`),
      noSuch.trim(),
    );
  }

  console.log('== the description carries the two rules ==');
  check('the cwd rule is in the description', /instead of prefixing the command with "cd <dir> && "/.test(def.function.description));
  check('the no-self-background rule is in the description', /Never put the command in the background yourself/.test(def.function.description));
  check('the cwd arg says "or an absolute path"', /or an absolute path/.test(def.function.parameters.properties.cwd.description));

  console.log('');
  if (problems.length) {
    console.log(`FAIL exec-cwd: ${problems.length} of ${total} check(s) failed (${WIN ? 'windows' : 'posix'})`);
    process.exit(1);
  }
  console.log(
    `PASS exec-cwd: ${total}/${total} checks (${WIN ? 'windows' : 'posix'}${WIN ? '' : ', windows half skipped'}) — ` +
      'a command runs in the harness root and says so, a broken cwd names the path instead of the shell, the /d form is understood',
  );
})();
