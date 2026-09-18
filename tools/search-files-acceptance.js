/*
 * search-files-acceptance — drives the COMPILED `search_files` tool with a stubbed
 * `vscode`, to prove the tool's contract without a window (dev-only; not a build
 * guard, and never shipped in the `.vsix`).
 *
 * Why it exists: the tool used to walk the whole tree in-process on the extension
 * host's only JS thread — 397 calls / 782.7 s in one customer log, a hitless search
 * costing as much as a hit-heavy one, and the host blocked for up to 10.3 s. It now
 * runs in a ripgrep child process, honors `search.exclude` / `files.exclude` /
 * `.gitignore`, skips binaries, and kills the child at the match cap; the original
 * walk survives as the fallback for a machine where no `rg` can be found. Both paths
 * must keep one contract, which is what this asserts.
 *
 * It needs a compiled tree and falls back to `./out`:
 *   npx tsc -p ./ && node tools/search-files-acceptance.js [<outDir>]
 * Run it with an explicit path to check the checker itself. No window, no provider,
 * no tokens; the fixture is built under `.spinney/` (gitignored) and removed again.
 * The last section re-runs the whole script in a child process with no appRoot and a
 * stripped PATH, which is exactly the "no ripgrep on this machine" case.
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(ROOT, 'out'));

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

const APP_ROOT = process.argv.includes('--no-app-root') ? null : findAppRoot();
const excludes = { '**/node_modules': true, '**/skipme/**': true, '**/*.min.js': true };
const vscodeStub = {
  env: { appRoot: APP_ROOT },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: ROOT, toString: () => 'file:///' + ROOT.split(path.sep).join('/') } }],
    getConfiguration: () => ({ get: (key) => (key === 'search.exclude' ? excludes : undefined) }),
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

const problems = [];
const check = (label, cond, detail) => {
  console.log(`  [${cond ? 'ok  ' : 'FAIL'}] ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) problems.push(label);
};

(async () => {
  console.log('== ripgrep discovery ==');
  if (APP_ROOT) {
    check('an appRoot was found', true, APP_ROOT);
    const universal = path.join(
      APP_ROOT,
      'node_modules.asar.unpacked',
      '@vscode',
      'ripgrep-universal',
      'bin',
      'win32-x64',
      'rg.exe',
    );
    check('the universal package ships a real rg.exe', fs.existsSync(universal), universal);
    const legacyDir = path.join(APP_ROOT, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin');
    check(
      'the legacy @vscode/ripgrep folder is empty (the trap the candidate list must skip)',
      !fs.existsSync(path.join(legacyDir, 'rg.exe')),
      legacyDir,
    );
  }

  const rel = path.relative(ROOT, TREE).split(path.sep).join('/');
  const run = (args) => searchFilesTool.execute(args, undefined);

  console.log('\n== a normal search (workspace-relative paths, file:line: text) ==');
  const basic = await run({ pattern: 'NEEDLE', path: rel + '/src', maxResults: 50 });
  console.log(basic.split('\n').slice(0, 5).join('\n'));
  check('hits are shaped file:line: text', /search-files-acceptance-tree\/src\/a\.ts:2: NEEDLE alpha/.test(basic), JSON.stringify(basic.slice(0, 120)));
  check('a second file is reported too', /search-files-acceptance-tree\/src\/b\.ts:2: NEEDLE gamma/.test(basic));
  check('a deep file is reported with its relative path', /src\/deep\/c\.ts:1:/.test(basic));
  check('paths use forward slashes', !basic.includes('\\'), basic.split('\n')[0]);
  const via = perfLines.filter((l) => l.includes('search-files')).pop();
  const expectedVia = APP_ROOT ? 'rg' : 'walk';
  check(
    `the search ran in the expected execution path (via=${expectedVia})`,
    Boolean(via) && via.includes(`via=${expectedVia}`),
    via || '(no perf line)',
  );
  check('the perf line reports the scope it applied', Boolean(via) && /scope=[1-9]/.test(via), via || '');

  console.log('\n== exclusions ==');
  check('search.exclude prunes node_modules', !basic.includes('node_modules'));
  check('search.exclude prunes a custom pattern (skipme)', !basic.includes('skipme'));
  check('search.exclude prunes a file glob (*.min.js)', !basic.includes('bundle.min.js'));
  check('the scope echo says the search was narrowed', /\[scope: search\.exclude\/files\.exclude\/\.gitignore honored\]/.test(basic));

  console.log('\n== binary files are skipped (no mojibake hits) ==');
  check('no hit inside the .woff2 "font"', !/font\.woff2/.test(basic), basic.match(/font\.woff2[^\n]*/) || '');
  check('no base64 blob leaks into the result', !/wOF2[\s\S]{0,80}/.test(basic.replace(/^.*font\.woff2.*$/gm, '')));

  console.log('\n== no-match is explicit ==');
  const t0 = Date.now();
  const none = await run({ pattern: 'zzz-no-such-symbol-zzz', path: rel });
  console.log(`  (${Date.now() - t0}ms) ${JSON.stringify(none)}`);
  check('a hitless search answers "(no matches)"', none.startsWith('(no matches)'));

  console.log('\n== caps ==');
  const capped = await run({ pattern: 'NEEDLE', path: rel, maxResults: 3 });
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
  const big = await run({ pattern: 'NEEDLE', path: rel, maxResults: 300 });
  const took = Date.now() - t1;
  check('a 300-hit search over the tree completes', big.includes('NEEDLE'), `${took}ms`);
  check('  … inside a sane budget', took < 5000, `${took}ms`);

  console.log('\n== error strings keep their shape ==');
  check('a missing pattern is refused', (await run({})).startsWith('Error: search_files requires a "pattern"'));
  check('an invalid regex is refused', (await run({ pattern: '([' })).startsWith('Error: invalid regex:'));
  check('a missing path is refused', (await run({ pattern: 'x', path: rel + '/nope' })).startsWith('Error: no such file or directory:'));

  console.log('\n== the ripgrep probe must be skippable (the walk fallback) ==');
  if (APP_ROOT) {
    const probe = __filename;
    const child = require('child_process').spawnSync(process.execPath, [probe, '--no-app-root'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: 'C:\\Windows\\System32', Path: 'C:\\Windows\\System32' },
      cwd: ROOT,
    });
    const childOut = `${child.stdout || ''}${child.stderr || ''}`;
    const viaLine = /\[perf\] search-files[^\n]*/.exec(childOut);
    check('with no rg discoverable the search still works', childOut.includes('PASS search-files-acceptance'), `exit ${child.status}`);
    check('  … and it says it used the in-process walk', Boolean(viaLine) && viaLine[0].includes('via=walk'), viaLine ? viaLine[0] : '(none)');
    check('  … with the same exclude + binary behaviour as rg', childOut.includes('[ok  ] search.exclude prunes node_modules') && childOut.includes('[ok  ] no hit inside the .woff2'));
    if (child.status !== 0) {
      console.log(childOut.split('\n').filter((l) => l.includes('FAIL')).join('\n'));
    }
  }

  fs.rmSync(TREE, { recursive: true, force: true });
  console.log('');
  if (problems.length) {
    console.log(`FAIL search-files-acceptance: ${problems.length} check(s) failed\n - ${problems.join('\n - ')}`);
    process.exit(1);
  }
  console.log('PASS search-files-acceptance: search_files runs in a ripgrep child process, honors search.exclude/files.exclude, skips binaries, keeps the file:line: text contract, the cap note and the error strings');
})();
