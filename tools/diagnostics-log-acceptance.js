/*
 * diagnostics-log-acceptance — the diagnostics log's bounds, driven directly against the
 * COMPILED module (dev-only; not a build guard, and never shipped).
 *
 * Why it exists: the log is written on **every** user's machine now, so "it cannot grow without
 * end" and "it holds no conversation" are promises the product makes. Both are the kind that
 * fail silently — a folder filling up over months, or a line of user text nobody noticed —
 * so the rules are pinned here: one file per window, rotate at 2 MiB keeping one generation,
 * keep only the newest five windows (with their generations), and never carry content.
 *
 *   npx tsc -p ./ && node tools/diagnostics-log-acceptance.js [<outDir>]
 *
 * No window, no provider, no tokens; everything happens under `.spinney/` (gitignored).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(
  process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(ROOT, 'out'),
);
const {
  DIAGNOSTICS_KEEP,
  DIAGNOSTICS_MAX_BYTES,
  diagnosticsFileName,
  diagnosticsHeader,
  newestDiagnosticsLog,
  prepareDiagnosticsLog,
} = require(path.join(OUT, 'chat', 'diagnosticsLog.js'));

const problems = [];
const check = (label, ok, detail) => {
  console.log(`  [${ok ? 'ok  ' : 'FAIL'}] ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) problems.push(label);
};

const SANDBOX = path.join(ROOT, '.spinney', 'diagnostics-log');
const logs = (dir) => fs.readdirSync(dir).filter((f) => f.startsWith('perf-')).sort();

(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX, { recursive: true });

  console.log('== one file per window, and the folder is created on demand ==');
  const mine = prepareDiagnosticsLog(path.join(SANDBOX, 'fresh', 'nested'), 111);
  check('the path is the window’s own file', path.basename(mine) === diagnosticsFileName(111), path.basename(mine));
  check('  … and its folder was created', fs.existsSync(path.dirname(mine)));
  check('a header names the build and says how to turn the log off', (() => {
    const header = diagnosticsHeader(mine, '0.0.3');
    return header.includes('send this whole file back') && header.includes('build 0.0.3') && header.includes('spinney.diagnostics.log');
  })());

  console.log('\n== it rotates at the limit, keeping one generation ==');
  const dir = path.join(SANDBOX, 'rotate');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, diagnosticsFileName(222));
  fs.writeFileSync(file, 'x'.repeat(DIAGNOSTICS_MAX_BYTES + 1));
  fs.writeFileSync(`${file}.prev`, 'older');
  const afterRotate = prepareDiagnosticsLog(dir, 222);
  check('the file is the same path (rotation is in place)', afterRotate === file);
  check('  … the oversized file became the previous generation', fs.readFileSync(`${file}.prev`, 'utf8').startsWith('x'));
  check('  … the older `.prev` was replaced, not kept', !fs.readFileSync(`${file}.prev`, 'utf8').includes('older'));
  check('  … and the new file starts empty', (() => {
    try {
      return fs.statSync(file).size === 0;
    } catch {
      return true; // not created yet: the tee creates it on its first append
    }
  })());
  check('a file below the limit is left alone', (() => {
    const small = path.join(SANDBOX, 'small');
    fs.mkdirSync(small, { recursive: true });
    fs.writeFileSync(path.join(small, diagnosticsFileName(333)), 'kept');
    prepareDiagnosticsLog(small, 333);
    return fs.readFileSync(path.join(small, diagnosticsFileName(333)), 'utf8') === 'kept';
  })());

  console.log('\n== only the newest windows survive ==');
  const many = path.join(SANDBOX, 'many');
  fs.mkdirSync(many, { recursive: true });
  for (let i = 0; i < DIAGNOSTICS_KEEP + 3; i++) {
    const p = path.join(many, diagnosticsFileName(900 + i));
    fs.writeFileSync(p, `window ${i}`);
    // Distinct mtimes, oldest first, so "newest N" is unambiguous.
    const when = new Date(Date.now() - (DIAGNOSTICS_KEEP + 3 - i) * 60_000);
    fs.utimesSync(p, when, when);
    if (i === 0) {
      fs.writeFileSync(`${p}.prev`, 'generation');
      fs.utimesSync(`${p}.prev`, when, when);
    }
  }
  prepareDiagnosticsLog(many, 9999);
  const left = logs(many);
  const bases = new Set(left.map((n) => (n.endsWith('.prev') ? n.slice(0, -'.prev'.length) : n)));
  // The number is restated here on purpose: reading it from the module under test would make
  // the check pass whatever the module says (raising the limit to 50 once slipped through).
  const EXPECTED_KEPT = 5;
  check(`exactly ${EXPECTED_KEPT} windows are kept`, bases.size === EXPECTED_KEPT, `${bases.size} base file(s): ${[...bases].join(',')}`);
  // The invariant that must never break: the file this window is about to write to survives.
  check('  … and the window’s own file is among them', bases.has(diagnosticsFileName(9999)));
  check('  … the next newest is kept too', bases.has(diagnosticsFileName(900 + DIAGNOSTICS_KEEP + 2)));
  check('  … the oldest was removed with its generation', !bases.has(diagnosticsFileName(900)) && !left.includes(`${diagnosticsFileName(900)}.prev`));

  console.log('\n== the command finds the newest log ==');
  check('the newest file is reported', path.basename(newestDiagnosticsLog(many) ?? '') === diagnosticsFileName(900 + DIAGNOSTICS_KEEP + 2), path.basename(newestDiagnosticsLog(many) ?? '(none)'));
  check('an empty folder reports nothing', newestDiagnosticsLog(path.join(SANDBOX, 'empty')) === null);
  check('a folder that does not exist reports nothing', newestDiagnosticsLog(path.join(SANDBOX, 'nope')) === null);
  // The rule stated on its own, because it is a usability promise: a fresh window creates an
  // empty file, and a user asking for the log of the session that was slow must get the file
  // with content, not the file of the window they are sitting in.
  const freshDir = path.join(SANDBOX, 'fresh-vs-content');
  fs.mkdirSync(freshDir, { recursive: true });
  const older = path.join(freshDir, diagnosticsFileName(1));
  fs.writeFileSync(older, 'the window that was slow');
  const when = new Date(Date.now() - 60_000);
  fs.utimesSync(older, when, when);
  prepareDiagnosticsLog(freshDir, 2); // this window's own, empty file appears after it
  check(
    'an empty (just-created) file is NOT reported as the newest',
    path.basename(newestDiagnosticsLog(freshDir) ?? '') === diagnosticsFileName(1),
    path.basename(newestDiagnosticsLog(freshDir) ?? '(none)'),
  );

  console.log('\n== what the file may contain ==');
  // The promise is structural: only `perf()`/`harnessLog()` lines reach the sink, and the
  // content-bearing lines of this product (a session title, a prompt reminder) are written to
  // the output channel directly. This check keeps the *rule* visible where someone adding a
  // line to `perf()` will read it.
  const provider = fs.readFileSync(path.join(ROOT, 'src', 'chat', 'ChatViewProvider.ts'), 'utf8');
  check('a session title is NOT sent through the perf sink', !/perf\([\s\S]{0,80}\[title\]/.test(provider));
  check('  … it goes to the output channel instead', /outputLog\(`\[title\]/.test(provider));
  check(
    '  … and the API key line reports a state, not a key',
    // Pinned as the exact expression: the moment someone interpolates the key itself into this
    // line, the file a user is asked to send would carry their credential.
    /parts\.push\(`\$\{provider\.name\}=\$\{key \? 'set' : 'missing'\}`\)/.test(provider),
  );

  fs.rmSync(SANDBOX, { recursive: true, force: true });
  console.log('');
  if (problems.length) {
    console.log(`FAIL diagnostics-log-acceptance: ${problems.length} check(s) failed\n - ${problems.join('\n - ')}`);
    process.exit(1);
  }
  console.log(
    'PASS diagnostics-log-acceptance: one log per window, rotated at the limit with one generation kept, ' +
      'only the newest windows retained (with their generations), the command finds the newest, and the file carries no content',
  );
})();
