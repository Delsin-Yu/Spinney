// check-mention.js — fails the build when the `@` file picker stops matching the frozen plan.
//
// WHY THIS GUARD EXISTS
// The picker (`docs/agents/plans/mention-syntax.md` §3–§6) is one feature whose whole value is
// an *ordering*: which row a keystroke puts first. Nothing in `tsc` checks an order, and nothing
// in the webview can see one — a ranking regression looks like "the file I wanted was second",
// which nobody reports and no other suite would catch. Two of the rules are also old bug
// reports: the tier 4 tightening (§6.4, `cd` used to match `SelectWorld`) and the coverage-first
// regression (§6.6, `sl` put a tier 4 `TestLog` above a tier 3 `SelectLayer`). Both are
// re-asserted here by name, so neither can come back quietly.
//
// The `@` token boundary is the other half of the risk: the webview and the host must agree on
// where a token starts, where it ends and what replacing it does to the buffer, or a pick
// leaves a half-eaten path in the composer. That rule lives in `media/mention.js`, a script of
// its own precisely so this guard can drive the **shipped bytes** (§11).
//
// WHAT IT ASSERTS (the numbered sections below)
//   1. §3 — the trigger and the wash, on `media/mention.js`: `@` at index 0, after whitespace
//      and after `([{"'` opens a token; `foo@bar.com` does not; a caret in the middle of a
//      token yields the query up to the caret and `end` at the token's own end; `wash` removes
//      the `@` entirely, adds exactly one trailing space only when the next character demands
//      it, and leaves the caret after the inserted text; `quotePath` quotes a path that needs
//      it and leaves a plain one alone.
//   2. §4 — the scope classifier: `/x`, `~`, `\\srv`, `C:`, `./a`, `../a` are `absolute`;
//      `src/a` and a `:` that is not a drive root are `workspace`.
//   3. §6.2 — pattern mode: the pattern is tested against the file NAME (`*.ts` finds a file at
//      any depth), a query that is a path is read as the name at its end, `!` excludes, `{a,b}`
//      and `?` work, and a half-typed `src/[` falls back to the literal engine instead of
//      emptying the menu. `.` is deliberately not a metacharacter (§6.1).
//   4. §6.4 — the acceptance pair, on names: `cd` matches `code.ts` and `candidate.ts` and NOT
//      `SelectWorld.ts` or `LoadPickedSave.ts`, while `elect` and `world` still match
//      `SelectWorld.ts`.
//   5. §6.6 — the `sl` regression: `Map/SelectLayer.ts` (tier 3, from the name's humps) stays
//      above `Core/TestLog.ts` (tier 4) even though the latter covers more of its name. A
//      dotted fixture (`Map.SelectLayer`) would hump to `MSL` and land in tier 4, i.e. test
//      nothing, which is why the fixture is spelled the way a path is.
//   6. §6.6 — the comparator's five keys, each isolated: tier, coverage, score, path length,
//      ordinal.
//   7. §6.5 — pinyin against the real provider: `zhujiemian` finds `存档系统/读取面板/主界面.cs`
//      at tier 5 for the FILE NAME it lands on, a directory name (`cundang` over `存档系统/`)
//      matches nothing, an interior run is tier 6, `matches` are whole Chinese characters (never
//      a letter inside a syllable), a literal hit outranks a tier 5 pinyin one, and `ü` / `u:`
//      normalise to `v` (`nv` matches 女).
//   8. the caps: `limit` bounds the answer and `max` bounds the scan, so a 50 000-path index is
//      never walked a second time to trim a list of 50 (§6.6, §7).
//   9. the webview wiring, textually: `media/main.js` posts `mentionQuery` and `mentionBrowse`,
//      handles `mentionResult` and `mentionPicked`, and reads no `#mention-*` element out of
//      the shell — the menu is built on demand (§5, §11).
//
// HOW: `out/chat/mentions.js` and `out/chat/pinyin.js` are `require`d straight out of the
// compiled tree — the matcher is pure logic, and `mentions.ts` imports only a pinyin *type*, so
// its compiled JS has no runtime dependency on the vendored table (`pinyin.ts` resolves
// `media/vendor/pinyin/pinyin.json` from its own `__dirname`, which works from `out/chat/`).
// `media/mention.js` is loaded into a `vm` context with `ctx.window = ctx`, the same way
// `tools/check-tree-grid.js` loads a `media/*.js` file with no browser. No framework, no
// dependency, no Extension Host.
//
// Run: npm run check:mention   (`vscode:prepublish` runs it right after `npm run check:webview`)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const MENTIONS_OUT = path.join(root, 'out', 'chat', 'mentions.js');
const PINYIN_OUT = path.join(root, 'out', 'chat', 'pinyin.js');
const SYNTAX_MEDIA = path.join(root, 'media', 'mention.js');
const MAIN_MEDIA = path.join(root, 'media', 'main.js');
// The host half of path mode imports `vscode`, so it cannot be required here; the two text
// checks at the end of the run pin the part of its behaviour a reader could silently lose.
const MENTION_INDEX_TS = path.join(root, 'src', 'chat', 'mentionIndex.ts');

// The guard drives the COMPILED matcher, so it needs a compiled tree. When there is none, it
// says so once and passes: `vscode:prepublish` runs `npm run compile` first, so a packaged
// build always has one, and a checkout that has not been compiled yet must not turn a guard
// into a build failure (nor compile the tree itself, which would fight a concurrent compile).
if (!fs.existsSync(MENTIONS_OUT)) {
  console.log(
    'check-mention: skipped — this guard needs a compiled tree and out/chat/mentions.js is not ' +
      'there yet; run `npm run compile`, then `npm run check:mention`.',
  );
  process.exit(0);
}

// ---------------------------------------------------------------- report stream
const problems = [];
const notes = [];
let checks = 0;

/** Record one assertion: `problems` gets one line per failure, `notes` one per pass. */
function check(label, ok, detail) {
  checks += 1;
  if (ok) {
    notes.push(label);
    return true;
  }
  problems.push(label + (detail ? ' — ' + detail : ''));
  return false;
}

/** `check` with a deep comparison, so a failure prints both sides. */
function eq(label, actual, expected) {
  const got = JSON.stringify(actual);
  const want = JSON.stringify(expected);
  return check(label, got === want, got === want ? undefined : 'got ' + got + ', expected ' + want);
}

/**
 * The identity of a ranked answer, in order — what every ordering assertion reads.
 *
 * The row's `insert` is the path, and its `label` is the file name (§7); an ordering fixture has to
 * tell two same-named files apart, so it reads the path. A `note` row inserts nothing, so its label
 * is the identity there.
 */
const labels = (items) => items.map((item) => item.insert || item.label);

// ---------------------------------------------------------------- loaders
/**
 * `media/mention.js` in a bare `vm` context, the `tools/check-tree-grid.js` way: the file
 * touches nothing but `window`, so `ctx.window = ctx` is the whole platform it needs.
 */
function loadMentionSyntax(file) {
  const ctx = { console };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  const api = ctx.window.mentionSyntax;
  if (!api || typeof api.token !== 'function' || typeof api.wash !== 'function' || typeof api.quotePath !== 'function') {
    throw new Error('media/mention.js did not define window.mentionSyntax.{token,wash,quotePath}');
  }
  return api;
}

let mentions;
let pinyinModule;
let syntax;
try {
  mentions = require(MENTIONS_OUT);
  pinyinModule = require(PINYIN_OUT);
  syntax = loadMentionSyntax(SYNTAX_MEDIA);
  for (const name of ['classifyMentionQuery', 'splitTypedPath', 'firstSegment', 'rankMentions']) {
    if (typeof mentions[name] !== 'function') {
      throw new Error('out/chat/mentions.js does not export ' + name + '()');
    }
  }
  for (const name of ['pinyin', 'normalizeQuery']) {
    if (!pinyinModule[name]) {
      throw new Error('out/chat/pinyin.js does not export ' + name);
    }
  }
} catch (err) {
  // Collapsed to one line: Node's MODULE_NOT_FOUND message carries a "Require stack" block,
  // and every problem this guard reports has to be one readable line.
  problems.push('the guard could not load what it guards — ' + String((err && err.message) || err).replace(/\s+/g, ' '));
}

const { classifyMentionQuery, firstSegment, rankMentions, splitTypedPath } = mentions || {};
const pinyin = pinyinModule && pinyinModule.pinyin;
const normalizeQuery = pinyinModule && pinyinModule.normalizeQuery;

/** `rankMentions` with the plan's own default cap, so every fixture states only its own query. */
const rank = (query, paths, opts) => rankMentions(query, paths, Object.assign({ limit: 50 }, opts || {}));

// ---------------------------------------------------------------- the checks
function runChecks() {
  // ---- 1. §3 — the trigger, the wash and the quoting (media/mention.js) ----------
  {
    const { token, wash, quotePath } = syntax;

    // The trigger. `@` at index 0 opens a token when the caret sits after it.
    eq('§3 an `@` at index 0 opens a token', token('@', 1), { at: 0, query: '', end: 1 });
    eq('§3 an `@` after whitespace opens a token', token(' @', 2), { at: 1, query: '', end: 2 });
    eq('§3 an `@` after a tab opens a token', token('\t@a', 3), { at: 1, query: 'a', end: 3 });
    eq('§3 an `@` after `(` opens a token', token('(@a', 3), { at: 1, query: 'a', end: 3 });
    eq('§3 an `@` after `"` opens a token', token('"@a', 3), { at: 1, query: 'a', end: 3 });
    eq(
      '§3 the query is the text between the `@` and the caret',
      token('please @src/a', 13),
      { at: 7, query: 'src/a', end: 13 },
    );
    eq('§3 `foo@bar.com` never opens a token', token('foo@bar.com', 11), null);
    eq('§3 a mid-word `@` never opens a token', token('x@a', 2), null);
    eq('§3 whitespace between the `@` and the caret means no token', token('@a b', 4), null);
    eq(
      '§3 a caret in the middle of a token yields the query up to the caret, and `end` at the token\'s end',
      token('@src/a.ts', 5),
      { at: 0, query: 'src/', end: 9 },
    );
    // The accepted cost of §3: pasted code is a trigger, and the menu is non-modal.
    eq('§3 `@Component(` does open a token', token('@Component(', 11), { at: 0, query: 'Component(', end: 11 });

    // The wash.
    const tail = wash('@a.ts', token('@a.ts', 5), 'a.ts');
    eq('§3 the wash removes the `@` entirely', tail.value, 'a.ts');
    eq('§3 … and leaves the caret after the inserted text', tail.caret, 4);
    check('§3 no `@` survives the wash', tail.value.indexOf('@') < 0, JSON.stringify(tail.value));

    const surrounded = wash('see @x.ts, thanks', token('see @x.ts, thanks', 9), 'x.ts');
    eq('§3 the wash keeps the text on both sides', surrounded.value, 'see x.ts thanks');
    eq('§3 … and the caret sits after the path, mid-buffer', surrounded.caret, 8);
    check(
      '§3 the wash never doubles the space it keeps',
      surrounded.value.indexOf('  ') < 0,
      JSON.stringify(surrounded.value),
    );

    // `end` is the whole token, not the query: a caret parked mid-token still washes the lot.
    eq('§3 the wash replaces the WHOLE token, not just the typed query', wash('@src/a.ts', token('@src/a.ts', 5), 'x.ts'), {
      value: 'x.ts',
      caret: 4,
    });

    // The one way the extra space appears: the token was read before the word grew, so the
    // character now at the caret is not whitespace. Exactly one space, and the caret after it.
    const stale = token('@a.ts', 5);
    const glued = wash('@a.tsplease', stale, 'a.ts');
    eq('§3 one trailing space is added when the next character demands it', glued.value, 'a.ts please');
    eq('§3 … and the caret lands after the inserted text and that space', glued.caret, 5);
    check('§3 … and only ONE space is added', glued.value.indexOf('  ') < 0, JSON.stringify(glued.value));

    // A quoted insert is the same write (§4: a path with a space is inserted quoted).
    eq('§3 a quoted path is washed in as one insert', wash('@a.ts', token('@a.ts', 5), quotePath('src/a b.ts')), {
      value: '"src/a b.ts"',
      caret: 12,
    });

    eq('§3 `quotePath` leaves a plain path alone', quotePath('a.ts'), 'a.ts');
    eq('§3 `quotePath` quotes a path with a space', quotePath('src/a b.ts'), '"src/a b.ts"');
    eq('§3 `quotePath` quotes a path with a quote in it', quotePath('a"b.ts'), '"a"b.ts"');
    eq('§3 `quotePath` never doubles up on an already quoted path', quotePath('"a b.ts"'), '"a b.ts"');
  }

  // ---- 2. §4 — the scope classifier ------------------------------------------------
  {
    // The plan's table, row by row. `:` is absolute only as a DRIVE ROOT (`^[A-Za-z]:`), which
    // is why `a:b` is absolute and `src/a:b` is not — one rule, no guessing.
    const SCOPES = [
      ['/x', 'absolute'],
      ['~', 'absolute'],
      ['~/.config', 'absolute'],
      ['\\\\srv\\share', 'absolute'],
      ['C:', 'absolute'],
      ['C:\\repos\\x', 'absolute'],
      ['./a', 'absolute'],
      ['../a', 'absolute'],
      ['..', 'absolute'],
      ['.gitignore', 'absolute'],
      ['src/a', 'workspace'],
      ['src/a:b', 'workspace'],
      ['foo:bar', 'workspace'],
      ['a:b', 'absolute'],
      ['@x', 'workspace'],
      ['', 'workspace'],
    ];
    for (const [query, scope] of SCOPES) {
      eq('§4 ' + JSON.stringify(query) + ' is ' + scope + ' scope', classifyMentionQuery(query).scope, scope);
    }
    // The query travels untouched: `~` expansion and the drive mapping have exactly one
    // implementation, in the host (§4).
    eq('§4 the classifier hands the query back exactly as typed', classifyMentionQuery('/d/repos/x'), {
      scope: 'absolute',
      path: '/d/repos/x',
    });
  }

  // ---- 2b. §4 — the typing path, split into a directory and a fragment ------------
  {
    // This is the rule that makes path mode a search *inside the directory being typed* and
    // nothing else: everything up to the last separator is a directory the user already
    // committed to, the rest is what the engine matches, and a trailing separator means
    // "list this directory". There is no fallback to the workspace index on a miss.
    eq('§4 `~/proj/rt` reads `~/proj/` + `rt`', splitTypedPath('~/proj/rt'), { dir: '~/proj/', fragment: 'rt' });
    eq('§4 a trailing separator means the whole directory', splitTypedPath('~/proj/'), {
      dir: '~/proj/',
      fragment: '',
    });
    eq('§4 a bare `~` names a directory', splitTypedPath('~'), { dir: '~', fragment: '' });
    eq('§4 a bare drive letter is a directory root, not a drive-relative path', splitTypedPath('C:'), {
      dir: 'C:\\',
      fragment: '',
    });
    eq('§4 the last separator wins on a windows path', splitTypedPath('C:\\repos\\x\\rt'), {
      dir: 'C:\\repos\\x\\',
      fragment: 'rt',
    });
    eq('§4 a relative climb stays in the directory part', splitTypedPath('../a'), { dir: '../', fragment: 'a' });
    eq('§4 the empty no-folder query has no fragment', splitTypedPath(''), { dir: '', fragment: '' });

    // A fragment carries a separator only after the ancestor walk climbed past a directory
    // that does not exist yet, and then only its first segment can name a sibling of the
    // listed directory.
    eq('§4 a one-segment fragment is itself', firstSegment('rt'), 'rt');
    eq('§4 a climbed fragment is matched on its first segment', firstSegment('sub/di'), 'sub');
    eq('§4 … with either separator', firstSegment('sub\\di'), 'sub');
  }

  // ---- 2c. §7 — the row's two columns, and §6.3's case rule -------------------------
  {
    // The menu paints the file name whole on the left and the directory dimmed on the right, so the
    // label is the name and the detail is the directory; `insert` stays the whole path.
    const row = rank('runtime', ['src/chat/runtime.ts'])[0];
    eq('§7 the label is the file name', row && row.label, 'runtime.ts');
    eq('§7 … the detail is the directory', row && row.detail, 'src/chat');
    eq('§7 … and the insert is the whole path', row && row.insert, 'src/chat/runtime.ts');
    eq('§7 a root-level file has no detail to show', rank('a', ['a.ts'])[0].detail, undefined);
    eq('§7 … and its label is still just the name', rank('a', ['a.ts'])[0].label, 'a.ts');

    // Case is a preference with teeth: an UPPERCASE query character may only sit on an uppercase
    // name character, so a capitalised query is a claim about a camel-cased name, while a
    // lowercase query stays free.
    const CAMEL = 'ItemSpreaderService.cs'; // humps I S S
    const FLAT = 'itemspreaderservice.cs'; // one lowercase word, no capital to sit on
    eq('§6.3 `Iss` reads the humps of a camel-cased name', labels(rank('Iss', [CAMEL])), [CAMEL]);
    eq('§6.3 … and finds nothing where no capital can take the `I`', labels(rank('Iss', [FLAT])), []);
    eq('§6.3 `ISS` all-caps still reads the humps', labels(rank('ISS', [CAMEL])), [CAMEL]);
    eq('§6.3 a capitalised prefix refuses the all-lowercase name', labels(rank('Item', [FLAT, CAMEL])), [CAMEL]);
    eq('§6.3 the lowercase query is free to match both', labels(rank('item', [FLAT, CAMEL])), [FLAT, CAMEL]);
    eq('§6.3 the rule binds tiers 2 and 4 as well', labels(rank('PS', ['player-service.ts', 'Player-Service.ts'])), [
      'Player-Service.ts',
    ]);

    // A pattern says the same thing to the regex engine: capitals make it case-sensitive.
    eq('§6.3 a glob with a capital is case-sensitive', labels(rank('*.CS', ['a.cs', 'a.CS'])), ['a.CS']);
    eq('§6.3 … and one without is case-insensitive', labels(rank('*.cs', ['a.cs', 'a.CS'])), ['a.cs', 'a.CS']);
  }

  // ---- 3. §6.2 — pattern mode ------------------------------------------------------
  {
    const paths = ['src/chat/runtime.ts', 'src/runtime.ts', 'other/src/x/runtime.ts', 'README.md', 'a.ts'];
    // A glob with no `/` matches the basename only, so `*.ts` finds a file at any depth.
    // Order inside pattern mode is deterministic and unscored: earliest match position, then
    // path length, then ordinal.
    eq('§6.2 `*.ts` matches a basename at any depth', labels(rank('*.ts', paths)), [
      'a.ts',
      'src/runtime.ts',
      'src/chat/runtime.ts',
      'other/src/x/runtime.ts',
    ]);

    // §6.3: directories never take part in a match, so a query that carries one is not a name at
    // all — it is a PLACE, and the index answers it by listing that directory (§3.2). The name
    // engine therefore never strips a prefix and never matches one: a path query belongs to the
    // routing, not to `rankMentions`.
    eq(
      '§6.2 a query that is a path matches no NAME',
      labels(rank('src/chat/runtime.ts', ['src/chat/runtime.ts', 'src/chat/other.ts'])),
      [],
    );
    const indexSource = fs.readFileSync(MENTION_INDEX_TS, 'utf8');
    check(
      '§6.2 … because a prefix is routed to the directory listing instead',
      /SEPARATOR\.test\(query\)/.test(indexSource) && /answerPath\(query, 'workspace'\)/.test(indexSource),
      'src/chat/mentionIndex.ts no longer routes a separator-bearing query to the path answer',
    );
    eq(
      '§6.2 … and a directory on its own matches no name either',
      labels(rank('src/chat/', ['src/chat/runtime.ts', 'src/a.ts'])),
      [],
    );

    const negated = labels(rank('!*.ts', ['README.md', 'src/a.ts', 'x.md']));
    eq('§6.2 `!` negation excludes what it names', negated.includes('src/a.ts'), false);
    eq('§6.2 … and keeps everything else', negated.includes('README.md'), true);

    // A half-typed character class: not a regex, not a glob either, so the query falls back to
    // the literal engine — it must not throw and it must not empty the menu (§6.2 step 3). The
    // fragment has no separator, because that is the only shape the name engine ever sees (§3.2).
    let threw = null;
    let halfTyped = [];
    try {
      halfTyped = rank('[', ['[id].ts', 'a.ts']);
    } catch (err) {
      threw = err;
    }
    eq('§6.2 a half-typed `[` does not throw', threw && threw.message, null);
    eq('§6.2 … and falls back to the literal engine', labels(halfTyped), ['[id].ts']);

    eq('§6.2 `?` is one character', labels(rank('?.ts', ['a.ts', 'ab.ts', 'c.md'])), ['a.ts']);

    // `{a,b}` needs a query the REGEX branch rejects, because JS reads a bare `{a,b}` as a
    // literal brace (Annex B) and §6.2 tries the regex first: the leading `*` is what makes
    // this query a glob.
    const braces = labels(rank('*{a,b}.ts', ['a.ts', 'b.ts', 'c.ts', 'x/a.ts']));
    eq('§6.2 `{a,b}` is an alternation', braces, ['a.ts', 'b.ts', 'x/a.ts']);

    // §6.1: `.` is not a metacharacter, so `runtime.ts` stays a string and never becomes a
    // regex whose dot matches anything — here `a.b` must not find `axb.ts`.
    eq('§6.1 `.` is not a metacharacter', labels(rank('a.b', ['axb.ts', 'a.b.ts'])), ['a.b.ts']);
  }

  // ---- 4. §6.4 — the tier 4 tightening (the acceptance pair) -----------------------
  {
    // The match surface is the file NAME (§6.3), so the pair is built from names: `code.ts` is
    // the real hit (`c` starts a word and `d` sits inside that same word), and the two names the
    // rule exists to kill are the scatter of the bug report — SelectWorld (Sele-c-t + Worl-d)
    // and LoadPickedSave (Pi-c-ke-d).
    const TIGHT = ['code.ts', 'SelectWorld.ts', 'LoadPickedSave.ts'];
    eq('§6.4 `cd` matches the name where the run starts a word', labels(rank('cd', TIGHT)), ['code.ts']);
    eq('§6.4 `cd` does not match `SelectWorld.ts`', labels(rank('cd', ['SelectWorld.ts'])), []);
    eq('§6.4 `cd` does not match `LoadPickedSave.ts`', labels(rank('cd', ['LoadPickedSave.ts'])), []);
    // The third landing spot of the rule: once the run started a word, the rest of that word is
    // legal — which is what lets `cd` reach `candidate` and not only `code`.
    eq('§6.4 the rest of a word the run started is a legal landing', labels(rank('cd', ['candidate.ts'])), [
      'candidate.ts',
    ]);
    eq('§6.4 `elect` still matches `SelectWorld`', labels(rank('elect', ['SelectWorld.ts', 'ChatViewProvider.ts'])), [
      'SelectWorld.ts',
    ]);
    eq('§6.4 `world` still matches `SelectWorld`', labels(rank('world', ['SelectWorld.ts'])), ['SelectWorld.ts']);
  }

  // ---- 5. §6.6 — the `sl` regression, on real PATHS ---------------------------------
  {
    // `.` is a word separator in this matcher, so `Map.SelectLayer` would hump to `MSL` and
    // land in tier 4 — the fixture would then compare two tier 4 rows and prove nothing. The
    // fixture is therefore the paths a filesystem really shows.
    const SL = ['Map/SelectLayer.ts', 'Core/TestLog.ts'];
    eq('§6.6 `sl` keeps the tier 3 hit above the tier 4 one', labels(rank('sl', SL)), [
      'Map/SelectLayer.ts',
      'Core/TestLog.ts',
    ]);
    // …and it is the tier that decides, not the array's own order (the comparator's last key).
    eq('§6.6 the `sl` order does not depend on the input order', labels(rank('sl', [SL[1], SL[0]])), [
      'Map/SelectLayer.ts',
      'Core/TestLog.ts',
    ]);
  }

  // ---- 6. §6.6 — the comparator's five keys, one isolated fixture each --------------
  {
    // Key 1, tier: the `sl` fixture of §5 is exactly this key (tier 3 beats tier 4 even
    // though the tier 4 row covers more of its path), so it is not repeated here.

    // Key 2, coverage desc. Both rows are tier 4 with the same score (the same local run, and
    // a tier 4 score does not read the length of the path); the longer path has the HIGHER
    // coverage and the longer length, so only the coverage key can order them this way.
    const COVERAGE = ['qwertyuiop/xabq.ts', 'xabqzzzzzzzz.ts'];
    eq('§6.6 coverage: the better-covered row wins', labels(rank('ab', COVERAGE)), [
      'qwertyuiop/xabq.ts',
      'xabqzzzzzzzz.ts',
    ]);
    eq('§6.6 … in either input order', labels(rank('ab', [COVERAGE[1], COVERAGE[0]])), [
      'qwertyuiop/xabq.ts',
      'xabqzzzzzzzz.ts',
    ]);

    // Key 3, score desc. Same tier, same coverage (both matches span 2 of 6 characters) and
    // the same path length: the only difference is the score, because the capital in `zAb.ts`
    // is a word start (+6) where `zab.ts` scores a loose character (+1).
    const SCORE = ['zab.ts', 'zAb.ts'];
    eq('§6.6 score: the higher-scoring row wins a tie', labels(rank('ab', SCORE)), ['zAb.ts', 'zab.ts']);
    eq('§6.6 … in either input order', labels(rank('ab', [SCORE[1], SCORE[0]])), ['zAb.ts', 'zab.ts']);

    // Key 4, path length asc. Same tier, same score, same coverage — the extra directory is
    // outside the matched segment, so it changes nothing but the length.
    const LENGTH = ['dir/xabq.ts', 'xabq.ts'];
    eq('§6.6 path length: the shorter path wins a tie', labels(rank('ab', LENGTH)), ['xabq.ts', 'dir/xabq.ts']);
    eq('§6.6 … in either input order', labels(rank('ab', [LENGTH[1], LENGTH[0]])), ['xabq.ts', 'dir/xabq.ts']);

    // Key 5, path ordinal asc: a genuine tie keeps the caller's order, which is the only
    // stable answer left (two files that differ only in their directory names).
    const ORDINAL = ['dirA/xabq.ts', 'dirB/xabq.ts'];
    eq('§6.6 ordinal: a perfect tie keeps the caller\'s order', labels(rank('ab', ORDINAL)), ORDINAL);
    eq('§6.6 … whichever way round the caller passes them', labels(rank('ab', [ORDINAL[1], ORDINAL[0]])), [
      ORDINAL[1],
      ORDINAL[0],
    ]);
  }

  // ---- 7. §6.5 — pinyin, against the real provider ---------------------------------
  {
    const ZH_PATH = '存档系统/读取面板/主界面.cs';
    const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

    // §6.3: the FILE NAME is the whole candidate, so a pinyin query has to be spelled from the
    // name. `zhujiemian` is 主界面; the label is the relative path, so its indices are that far in.
    const found = rank('zhujiemian', [ZH_PATH], { pinyin });
    eq('§6.5 `zhujiemian` finds 存档系统/读取面板/主界面.cs', labels(found), [ZH_PATH]);
    eq('§6.5 … highlighting the three characters of 主界面', found[0] && found[0].matches, [0, 1, 2]);

    // A directory name is not a match surface, so the spelling of 存档系统 reaches only a FILE
    // that carries it — the half of the old behaviour the file-name rule removes.
    eq('§6.5 a directory name does not pinyin-match', labels(rank('cundang', [ZH_PATH], { pinyin })), []);
    eq(
      '§6.5 … while a file named 存档系统 does',
      labels(rank('cundang', ['x/存档系统.ts'], { pinyin })),
      ['x/存档系统.ts'],
    );

    // Tier 5 is the provider's own answer for the name the query lands on; the guard reads it
    // directly because the tier is not part of a row (the comparator already consumed it).
    const cundang = pinyin.match(pinyin.shadow('存档系统'), 'cundang');
    eq('§6.5 a run at the name\'s first character is tier 5', cundang && [cundang.tier, cundang.start], [5, 0]);

    const interior = pinyin.match(pinyin.shadow('读取面板'), 'qu');
    eq('§6.5 an interior run is tier 6', interior && [interior.tier, interior.start], [6, 1]);
    // Never inside a syllable: `qu` is two letters and one whole character (取), and the run
    // paints characters, not letters.
    eq('§6.5 `matches` are whole-character indices, never inside a syllable', interior && interior.matches, [1]);
    const interiorName = '读取面板.cs';
    const interiorRow = rank('qu', [interiorName], { pinyin })[0];
    eq('§6.5 … mapped back to the label\'s own coordinates', interiorRow && interiorRow.matches, [1]);
    check(
      '§6.5 … and every highlighted character really is Chinese',
      !!interiorRow && interiorRow.matches.every((index) => CJK.test(interiorName.charAt(index))),
      JSON.stringify(interiorRow && interiorRow.matches),
    );
    check(
      '§6.5 … for the 主界面 row too',
      !!found[0] && found[0].matches.every((index) => CJK.test(found[0].label.charAt(index))),
      JSON.stringify(found[0] && found[0].matches),
    );

    // "Literal first, pinyin second" is a hard band, not a weight: the literal engine runs on
    // every row and a row it found is never asked about again, so a literal hit stays above a
    // tier 5 pinyin one even though 5 is the bigger number.
    eq(
      '§6.5 a literal hit still outranks a pinyin tier 5 hit',
      labels(rank('cundang', ['x/存档系统.ts', 'cundang.ts'], { pinyin })),
      ['cundang.ts', 'x/存档系统.ts'],
    );

    // `ü` / `u:` → `v`, which is the spelling the table stores (§6.8).
    eq('§6.5 `nv` matches 女', !!(pinyin.match(pinyin.shadow('女'), 'nv')), true);
    eq('§6.5 `nü` normalises to `nv`', normalizeQuery('nü'), 'nv');
    eq('§6.5 `nu:` normalises to `nv`', normalizeQuery('nu:'), 'nv');
    const nv = pinyin.match(pinyin.shadow('女'), normalizeQuery('nü'));
    eq('§6.5 … and the normalised query finds the character', nv && [nv.tier, nv.matches], [5, [0]]);

    // A path with no CJK never gets a shadow: it is skipped at index time, not at query time.
    eq('§6.5 a segment with no CJK has no shadow', pinyin.shadow('src/a.ts'), null);
  }

  // ---- 8. the caps -----------------------------------------------------------------
  {
    const many = [];
    for (let i = 0; i < 400; i += 1) {
      many.push('p' + i + '/a.ts');
    }
    eq('§6.6 `limit` bounds the answer', rank('a', many, { limit: 3 }).length, 3);
    eq('§7 `max` bounds the scan', rank('a', many, { limit: 50, max: 7 }).length, 7);
    const capped = rank('a', many, { limit: 50, max: 7 });
    check(
      '§7 … and the rows considered come only from the first `max` paths',
      capped.every((item) => /^p[0-6]\//.test(item.insert)),
      JSON.stringify(labels(capped)),
    );
    eq('§6.6 `limit: 0` answers with nothing', rank('a', many, { limit: 0 }).length, 0);
  }

  // ---- 9. the webview wiring, textually --------------------------------------------
  {
    const main = fs.readFileSync(MAIN_MEDIA, 'utf8');
    const has = (pattern, label) => check(label, pattern.test(main), 'media/main.js has no match for ' + pattern);
    // The two messages the webview sends (§8).
    has(/type:\s*'mentionQuery'/, '§8 media/main.js posts `mentionQuery`');
    has(/type:\s*'mentionBrowse'/, '§8 media/main.js posts `mentionBrowse`');
    // The two answers it must understand (§8, §9).
    has(/case\s+'mentionResult'/, '§8 media/main.js handles `mentionResult`');
    has(/case\s+'mentionPicked'/, '§9 media/main.js handles `mentionPicked`');
    // The menu is built on demand (§5, §11): nothing may be looked up in the shell for it, or
    // a picker that forgot one shell element would fail only in the real window.
    check(
      '§11 media/main.js reads no `#mention-*` element out of the shell',
      !/getElementById\(\s*['"]mention-/.test(main) &&
        !/querySelector(?:All)?\(\s*['"]#mention-/.test(main) &&
        !/['"]#mention-/.test(main),
      'a `#mention-…` lookup found; the menu must be built on demand',
    );

    // Path mode's one rule (§4): the fragment is matched against the entries of the directory
    // the typing path names, through the same engine, and a miss answers with no rows. The
    // host half cannot be required here (it imports `vscode`), so it is pinned as text: the
    // absolute answer must rank, and must not offer anything it was not pointed at.
    const index = fs.readFileSync(MENTION_INDEX_TS, 'utf8');
    check(
      '§4 the absolute answer ranks the directory entries, it does not just list them',
      /rankMentions\(/.test(index) && /firstSegment\(/.test(index) && /splitTypedPath\(/.test(index),
      'src/chat/mentionIndex.ts no longer splits the typing path and ranks its directory',
    );
    check(
      '§4 the path answer has no fallback: a miss is an empty list',
      /return \{ scope, items: \[\] \};/.test(index),
      'src/chat/mentionIndex.ts no longer answers an empty list when nothing matched',
    );
  }
}

// ---------------------------------------------------------------- report
if (!problems.length) {
  try {
    runChecks();
  } catch (err) {
    // A crash is a problem like any other: the guard drives real code, and a fixture that
    // throws says more as one line than as a stack trace.
    const detail = String((err && err.stack) || err).split('\n').slice(0, 2).join(' | ');
    problems.push('the guard itself crashed while driving the matcher — ' + detail);
  }
}

if (process.argv.includes('--verbose')) {
  for (const note of notes) {
    console.log('  [ok  ] ' + note);
  }
}

if (problems.length) {
  console.error(`check-mention: ${problems.length} problem(s)`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

console.log(
  `check-mention: ok (${checks} checks — §3 wash, §4 scopes, §6.2 patterns, §6.4 tightening, ` +
    '§6.6 comparator and the `sl` regression, §6.5 pinyin, the caps, the webview wiring)',
);
process.exit(problems.length ? 1 : 0);
