/*
 * search-files-acceptance — drives the COMPILED `search_files` tool with a stubbed
 * `vscode`, to prove the tool's contract without a window. It is wired into
 * `vscode:prepublish` as `npm run check:search`, so it fails packaging (never the
 * user's window), and it is never shipped in the `.vsix`.
 *
 * Why it exists: the tool used to walk the whole tree in-process on the extension
 * host's only JS thread — 397 calls / 782.7 s in one customer log, a hitless search
 * costing as much as a hit-heavy one, and the host blocked for up to 10.3 s. It now
 * runs in a ripgrep child process (the VENDORED binary first, then VS Code's bundled
 * one, then `PATH`), honors `search.exclude` / `files.exclude` / `.gitignore` only
 * inside the workspace, always prunes `.git` and the build directories, skips
 * binaries, kills the child at the match cap, and gives the WHOLE call one hard time
 * budget (`spinney.searchTimeoutSeconds`) that the fallback walk shares. The original
 * walk survives as the fallback for a machine where no `rg` can run. Both paths must
 * keep one contract, which is what this asserts.
 *
 * It needs a compiled tree and falls back to `./out`:
 *   npx tsc -p ./ && node tools/search-files-acceptance.js [<outDir>]
 * The fixture is built under `.spinney/` (gitignored) and removed again; a second one
 * is built under `os.tmpdir()` because it must be OUTSIDE the workspace folder.
 *
 * Four modes, all of them exercised by the default run:
 *   (none)             ripgrep (the vendored binary, since it ships with the repo)
 *   --no-app-root      no `vscode.env.appRoot` and no `rg` on PATH: the VENDORED
 *                      binary alone must carry the search
 *   --no-vendor        runs from a COPY of `out/` (so no `media/vendor/` sits above
 *                      it), no appRoot, no PATH rg: the in-process walk
 *   --timeout-probe    --no-vendor plus a 1-second budget: the timeout contract
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
/** The copy of `out/` that has no `media/vendor/` above it (see `--no-vendor`). */
const COPIED_OUT = path.join(ROOT, '.spinney', 'search-files-acceptance-out');
const TIMEOUT_ONLY = argv.includes('--timeout-probe');
const NO_VENDOR = argv.includes('--no-vendor') || TIMEOUT_ONLY;
/** Only the run of the script itself spawns the child modes — a child never recurses. */
const TOP_LEVEL = !argv.some((flag) => flag.startsWith('--'));
const OUT_DIR = path.resolve(
  argv[0] && !argv[0].startsWith('--') ? argv[0] : NO_VENDOR ? COPIED_OUT : path.join(ROOT, 'out'),
);
if (TIMEOUT_ONLY) {
  // The timeout probe needs the in-process WALK: ripgrep scans linearly, so the
  // pathological pattern below would be answered in milliseconds and never reach the
  // budget. The vendored binary and appRoot are already off in this mode (a copy of
  // `out/` with no `media/vendor/` above it); a PATH with no `rg` finishes the job, so
  // the mode behaves the same however it is invoked.
  process.env.PATH = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/nonexistent';
  process.env.Path = process.env.PATH;
}

/** The VS Code install to take `appRoot` from (and therefore ripgrep). */
function findAppRoot() {
  const bases = [
    'D:\\Program Files\\Microsoft VS Code',
    'C:\\Program Files\\Microsoft VS Code',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code'),
  ];
  for (const base of bases) {
    try {
      const commit = fs.readdirSync(base).find((n) => /^[0-9a-f]{10}$/.test(n));
      if (commit) {
        return path.join(base, commit, 'resources', 'app');
      }
    } catch {
      /* not installed here */
    }
  }
  return null;
}

const APP_ROOT = argv.includes('--no-app-root') || NO_VENDOR ? null : findAppRoot();
const VENDOR_RG = path.join(
  ROOT,
  'media',
  'vendor',
  'ripgrep',
  `${process.platform}-${process.arch}`,
  process.platform === 'win32' ? 'rg.exe' : 'rg',
);
const HAS_VENDOR = fs.existsSync(VENDOR_RG);
/** 14.1.1 publishes no Windows-on-ARM build, so that one platform has no directory. */
const VENDOR_EXPECTED = !(process.platform === 'win32' && process.arch === 'arm64');
/** A 1-second budget for the timeout probe; unset (so the default 10 s) otherwise. */
const TIMEOUT_SEC = TIMEOUT_ONLY ? 1 : undefined;

const excludes = { '**/node_modules': true, '**/skipme/**': true, '**/*.min.js': true };
const vscodeStub = {
  env: { appRoot: APP_ROOT },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: ROOT, toString: () => 'file:///' + ROOT.split(path.sep).join('/') } }],
    getConfiguration: () => ({
      get: (key) => {
        if (key === 'search.exclude') {
          return excludes;
        }
        if (key === 'searchTimeoutSeconds') {
          return TIMEOUT_SEC;
        }
        return undefined;
      },
    }),
  },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.call(this, request, parent, isMain);
};

const { searchFilesTool } = require(path.join(OUT_DIR, 'tools', 'searchFiles.js'));
const perfLines = [];
require(path.join(OUT_DIR, 'perf.js')).setPerfSink((line) => perfLines.push(line));

const TREE = path.join(ROOT, '.spinney', 'search-files-acceptance-tree');
const OUTSIDE = path.join(os.tmpdir(), `spinney-search-acceptance-outside-${process.pid}`);
fs.rmSync(TREE, { recursive: true, force: true });
const put = (rel, body) => {
  const file = path.join(TREE, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};
put('src/a.ts', 'line one\nNEEDLE alpha\nline three\nNEEDLE beta\n');
put('src/b.ts', 'nothing here\nNEEDLE gamma\n');
put('src/deep/c.ts', 'NEEDLE delta\n');
put('node_modules/pkg/index.js', 'NEEDLE excluded-by-node_modules\n');
put('skipme/x.ts', 'NEEDLE excluded-by-search-exclude\n');
put('assets/bundle.min.js', 'NEEDLE excluded-by-glob-setting\n');
put('assets/font.woff2', Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(4096, 7), Buffer.from('NEEDLE in binary')]));
for (let i = 0; i < 40; i++) put(`many/f${String(i).padStart(2, '0')}.txt`, 'NEEDLE many\n'.repeat(20));
// Always pruned, whatever the settings say: the tool's own SKIP_DIRS. Searched on its
// own, so the match cap cannot hide an answer this section needs.
put('prune/keep.ts', 'NEEDLE kept\n');
put('prune/.git/HEAD', 'NEEDLE inside-a-git-directory\n');
put('prune/.spinney/scratch.ts', 'NEEDLE inside-the-agent-scratch\n');
put('prune/out/bundle.ts', 'NEEDLE inside-build-output\n');
put('prune/dist/bundle.ts', 'NEEDLE inside-dist\n');
put('prune/node_modules/pkg/i.js', 'NEEDLE inside-node-modules\n');
if (!TIMEOUT_ONLY) {
  // The per-file cap is 8 MB: just under it is searched, just over it is skipped.
  put('big/under.ts', 'NEEDLE under-eight-megabytes\n' + 'x'.repeat(2 * 1024 * 1024));
  put('big/over.ts', 'NEEDLE over-eight-megabytes\n' + 'x'.repeat(8 * 1024 * 1024 + 1));
}
// The timeout probe's tree: a hit that must be DROPPED when the budget runs out, then
// a line whose regex evaluation cannot finish inside a second — V8 backtracks
// exponentially on `(a+)+b`, and `NEEDLE|(a+)+b` against 30 "a"s takes seconds.
put('slow/a1.txt', 'NEEDLE collected-before-the-timeout\n');
put('slow/b2.txt', 'a'.repeat(30) + '\n');

/** A fixture OUTSIDE the workspace folder: this workspace's settings must not narrow it. */
const OUTSIDE_TREE = path.join(OUTSIDE, 'keep');
const putOutside = (rel, body) => {
  const file = path.join(OUTSIDE_TREE, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};
putOutside('skipme/y.ts', 'NEEDLE outside-skipme\n');
putOutside('assets/bundle.min.js', 'NEEDLE outside-glob-setting\n');
putOutside('node_modules/pkg/i.js', 'NEEDLE outside-node-modules\n');
putOutside('.git/HEAD', 'NEEDLE outside-git\n');

const problems = [];
const check = (label, cond, detail) => {
  console.log(`  [${cond ? 'ok  ' : 'FAIL'}] ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) problems.push(label);
};

const rel = path.relative(ROOT, TREE).split(path.sep).join('/');
const run = (args) => searchFilesTool.execute(args, undefined);
const lastPerf = () => perfLines.filter((l) => l.includes('search-files')).pop() || '(no perf line)';

/** One child process of this script, on a PATH that holds no rg: `{ status, out }`. */
function child(flags) {
  const barePath = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/nonexistent';
  const result = spawnSync(process.execPath, [__filename, ...flags], {
    encoding: 'utf8',
    env: { ...process.env, PATH: barePath, Path: barePath },
    cwd: ROOT,
  });
  return { status: result.status, out: `${result.stdout || ''}${result.stderr || ''}` };
}

(async () => {
  console.log(`== mode: ${TIMEOUT_ONLY ? 'timeout probe (walk)' : NO_VENDOR ? 'walk fallback' : 'ripgrep'} ==`);
  const expectedVia = NO_VENDOR ? 'walk' : 'rg';

  if (NO_VENDOR && !fs.existsSync(path.join(OUT_DIR, 'tools', 'searchFiles.js'))) {
    console.log(`FAIL search-files-acceptance: ${OUT_DIR} holds no compiled tool\n`);
    process.exit(1);
  }

  if (!TIMEOUT_ONLY) {
    console.log('== which ripgrep answers ==');
    check(
      `the vendored ripgrep is ${VENDOR_EXPECTED ? 'present' : 'absent (not published for this platform)'}`,
      HAS_VENDOR === VENDOR_EXPECTED,
      VENDOR_RG,
    );
    if (APP_ROOT) {
      check('an appRoot was found', true, APP_ROOT);
    }

    console.log('\n== a normal search (workspace-relative paths, file:line: text) ==');
    const basic = await run({ pattern: 'NEEDLE', path: rel + '/src', maxResults: 50 });
    console.log(basic.split('\n').slice(0, 5).join('\n'));
    check('hits are shaped file:line: text', /search-files-acceptance-tree\/src\/a\.ts:2: NEEDLE alpha/.test(basic), JSON.stringify(basic.slice(0, 120)));
    check('a second file is reported too', /search-files-acceptance-tree\/src\/b\.ts:2: NEEDLE gamma/.test(basic));
    check('a deep file is reported with its relative path', /src\/deep\/c\.ts:1:/.test(basic));
    check('paths use forward slashes', !basic.includes('\\'), basic.split('\n')[0]);
    check(
      `the search ran in the expected execution path (via=${expectedVia})`,
      lastPerf().includes(`via=${expectedVia}`),
      lastPerf(),
    );
    check('the perf line reports the scope it applied', /scope=[1-9]/.test(lastPerf()), lastPerf());
    if (expectedVia === 'rg' && HAS_VENDOR) {
      check(
        '  … and ripgrep came from the vendored binary',
        /search rg=.*media[\\/]vendor[\\/]ripgrep/.test(perfLines.join('\n')),
        VENDOR_RG,
      );
    }

    console.log('\n== exclusions inside the workspace ==');
    check('search.exclude prunes node_modules', !basic.includes('node_modules'));
    check('search.exclude prunes a custom pattern (skipme)', !basic.includes('skipme'));
    check('search.exclude prunes a file glob (*.min.js)', !basic.includes('bundle.min.js'));
    check(
      'the scope echo says the search was narrowed by the workspace settings',
      /\[scope: search\.exclude\/files\.exclude\/\.gitignore honored\]/.test(basic),
    );

    console.log('\n== always pruned, whatever the settings say (SKIP_DIRS) ==');
    const pruned = await run({ pattern: 'NEEDLE', path: rel + '/prune', maxResults: 50 });
    console.log(pruned.split('\n').slice(0, 4).join('\n'));
    check('the file next to the pruned directories is found', /prune\/keep\.ts:1: NEEDLE kept/.test(pruned));
    check('.git is never searched', !/inside-a-git-directory/.test(pruned));
    check('the agent scratch (.spinney) is never searched', !/inside-the-agent-scratch/.test(pruned));
    check('build output (out) is never searched', !/inside-build-output/.test(pruned));
    check('build output (dist) is never searched', !/inside-dist/.test(pruned));
    check('node_modules is never searched', !/inside-node-modules/.test(pruned));

    console.log('\n== binary files are skipped (no mojibake hits) ==');
    const assets = await run({ pattern: 'NEEDLE', path: rel + '/assets', maxResults: 50 });
    check('no hit inside the .woff2 "font"', !/font\.woff2/.test(assets), (assets.match(/font\.woff2[^\n]*/) || [''])[0]);
    check('no base64 blob leaks into the result', !/wOF2/.test(assets));
    check('the settings glob still prunes *.min.js next to it', !/bundle\.min\.js/.test(assets));

    console.log('\n== the per-file cap is 8 MB ==');
    const big = await run({ pattern: 'NEEDLE', path: rel + '/big', maxResults: 50 });
    check('a 2 MB text file is searched', /big\/under\.ts:1: NEEDLE under-eight-megabytes/.test(big));
    check('a file just over 8 MB is skipped', !big.includes('over-eight-megabytes'));
    if (expectedVia === 'walk') {
      check(
        '  … and the walk note names the skipped file and the cap',
        /skipped 1 file\(s\) larger than 8388608 bytes/.test(big),
        (big.match(/…\[search stopped early:[^\]]*\]/) || ['(no note)'])[0],
      );
    } else {
      check('  … rg drops it silently (no note, no hit)', !/search stopped early/.test(big), big.split('\n').pop());
    }

    console.log('\n== a search OUTSIDE the workspace is workspace-invariant ==');
    const outside = await run({ pattern: 'NEEDLE', path: OUTSIDE_TREE, maxResults: 50 });
    console.log(outside.split('\n').slice(0, 4).join('\n'));
    check('search.exclude is NOT applied (skipme answers)', /outside-skipme/.test(outside));
    check('files.exclude is NOT applied (*.min.js answers)', /outside-glob-setting/.test(outside));
    check('  … node_modules is still pruned', !/outside-node-modules/.test(outside));
    check('  … .git is still pruned', !/outside-git/.test(outside));
    check(
      '  … and the scope echo says the settings did not apply',
      /\[scope: the root is outside the workspace — search\.exclude\/files\.exclude not applied/.test(outside),
    );
    check('  … the perf line reports no settings scope there', /scope=0/.test(lastPerf()), lastPerf());
    check(`  … and it took the same execution path (via=${expectedVia})`, lastPerf().includes(`via=${expectedVia}`));

    console.log('\n== no-match is explicit ==');
    const t0 = Date.now();
    const none = await run({ pattern: 'zzz-no-such-symbol-zzz', path: rel });
    console.log(`  (${Date.now() - t0}ms) ${JSON.stringify(none)}`);
    check('a hitless search answers "(no matches)"', none.startsWith('(no matches)'));

    console.log('\n== caps ==');
    const capped = await run({ pattern: 'NEEDLE', path: rel + '/many', maxResults: 3 });
    const hits = (capped.match(/NEEDLE/g) || []).length;
    check('maxResults is honored exactly', hits === 3, `${hits} hits`);
    check('  … and the result says it stopped early', /search stopped early: reached the 3-match cap/.test(capped));

    console.log('\n== glob + context + single file ==');
    const globbed = await run({ pattern: 'NEEDLE', path: rel, glob: '**/*.ts' });
    check('a glob restricts the files searched', globbed.includes('.ts:') && !globbed.includes('.txt:'));
    const ctx = await run({ pattern: 'NEEDLE alpha', path: rel + '/src/a.ts', context: 1 });
    console.log(ctx.split('\n').slice(0, 4).join('\n'));
    check('context lines use "-" separators', /a\.ts-1- line one/.test(ctx) && /a\.ts-3- line three/.test(ctx));
    check('the matching line keeps ":"', /a\.ts:2: NEEDLE alpha/.test(ctx));
    const single = await run({ pattern: 'NEEDLE', path: rel + '/src/b.ts' });
    check('a single-file path still searches just that file', single.includes('b.ts:2:') && !single.includes('a.ts'));

    console.log('\n== a wide search stays fast (the child is killed at the cap) ==');
    const t1 = Date.now();
    const wide = await run({ pattern: 'NEEDLE', path: rel, maxResults: 300 });
    const took = Date.now() - t1;
    check('a 300-hit search over the tree completes', wide.includes('NEEDLE'), `${took}ms`);
    check('  … inside a sane budget', took < 5000, `${took}ms`);

    console.log('\n== error strings keep their shape ==');
    check('a missing pattern is refused', (await run({})).startsWith('Error: search_files requires a "pattern"'));
    check('an invalid regex is refused', (await run({ pattern: '([' })).startsWith('Error: invalid regex:'));
    check(
      'a missing path is refused',
      (await run({ pattern: 'x', path: rel + '/nope' })).startsWith('Error: no such file or directory:'),
    );
  }

  if (TIMEOUT_ONLY) {
    console.log('\n== the one hard budget: a timeout answers an Error line, not a page ==');
    const slow = await run({ pattern: 'NEEDLE|(a+)+b', path: rel + '/slow' });
    console.log(`  ${JSON.stringify(slow.slice(0, 160))}`);
    check(
      'the result is the timeout line',
      /^Error: search_files timed out after 1 s \(spinney\.searchTimeoutSeconds\) while searching /.test(slow),
      slow.slice(0, 120),
    );
    check('  … it returns NO hits, not the ones collected before the deadline', !slow.includes('collected-before-the-timeout'));
    check('  … and no count at all', !/no matches|files=|matches=/.test(slow));
    check('  … it names the setting the user can raise', /ask the user to raise spinney\.searchTimeoutSeconds/.test(slow));
    check('  … the perf line records the stop reason', /capped=wall/.test(lastPerf()), lastPerf());
    const quick = await run({ pattern: 'NEEDLE alpha', path: rel + '/src/a.ts' });
    check('a fast search under the same 1 s budget still answers', /NEEDLE alpha/.test(quick));
  }

  if (TOP_LEVEL) {
    console.log('\n== the other two execution paths, in child processes ==');
    // A copy of `out/` with no `media/vendor/` above it is the only honest way to prove
    // the walk path works while the vendored binary is checked in.
    fs.rmSync(COPIED_OUT, { recursive: true, force: true });
    fs.cpSync(path.join(ROOT, 'out'), COPIED_OUT, { recursive: true });
    const runs = [];
    if (HAS_VENDOR) {
      // The child asserts `via=rg` and that the vendored path answered; its exit code
      // is that assertion's verdict.
      const vendored = child(['--no-app-root']);
      runs.push(vendored);
      check(
        'with no appRoot and no rg on PATH the vendored binary still answers (via=rg)',
        vendored.status === 0 && vendored.out.includes('== mode: ripgrep =='),
        `exit ${vendored.status}`,
      );
    }
    const walk = child(['--no-vendor']);
    runs.push(walk);
    check(
      'with no rg discoverable at all the in-process walk answers (via=walk)',
      walk.status === 0 && walk.out.includes('== mode: walk fallback =='),
      `exit ${walk.status}`,
    );
    check(
      '  … with the same exclude + binary + scope behavior as rg',
      walk.out.includes('[ok  ] search.exclude prunes node_modules') &&
        walk.out.includes('[ok  ] no hit inside the .woff2') &&
        walk.out.includes('[ok  ] search.exclude is NOT applied (skipme answers)') &&
        walk.out.includes('[ok  ] .git is never searched'),
    );
    const probe = child(['--timeout-probe']);
    runs.push(probe);
    check('the timeout contract holds on the walk too', probe.status === 0, `exit ${probe.status}`);
    for (const failed of runs.filter((c) => c.status !== 0)) {
      console.log(failed.out.split('\n').filter((l) => l.includes('FAIL')).join('\n'));
    }
    fs.rmSync(COPIED_OUT, { recursive: true, force: true });
  }

  fs.rmSync(TREE, { recursive: true, force: true });
  fs.rmSync(OUTSIDE, { recursive: true, force: true });
  console.log('');
  if (problems.length) {
    console.log(`FAIL search-files-acceptance: ${problems.length} check(s) failed\n - ${problems.join('\n - ')}`);
    process.exit(1);
  }
  console.log(
    'PASS search-files-acceptance: search_files runs in a ripgrep child process (the vendored binary first), ' +
      'honors search.exclude/files.exclude only inside the workspace, always prunes .git and the build ' +
      'directories, skips binaries, keeps the file:line: text contract, the 8 MB per-file cap, the cap note, ' +
      'the error strings and the one hard time budget — and the same contract on the in-process walk',
  );
})();
