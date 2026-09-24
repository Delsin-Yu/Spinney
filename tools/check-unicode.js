/*
 * check-unicode — clipping, as a build-time guard (the 2026-09-24 HTTP 400).
 *
 * A JS string is UTF-16, so an emoji is a *pair* of code units and `slice(0, n)` cuts at
 * a unit boundary. One unpaired half can survive a clip, `JSON.stringify` writes it as a
 * perfectly legal-looking escape (`"\ud83d"`), and the provider's reader does not accept
 * it: serde_json (validating `String` mode) answers `unexpected end of hex escape` and
 * rejects the **whole** request. One clipped `📎` in a `search_transcripts` hit turned
 * every later request of that turn into an HTTP 400, and nothing local complained.
 *
 * So this guard pins the rules of `src/text.ts` against the compiled `out/text.js`:
 *
 *   1. `clipText` / `sliceText` never split a pair and never hand back an unpaired half,
 *      for a family of emoji / astral-CJK inputs and every n = 1..12 — including both
 *      shapes the incident came from (`'**' + '\uD83D' + '…'`, and a clip whose
 *      truncation point lands on a pair). Where the naive `slice(0, n) + '…'` happens to
 *      be well-formed the fixed call must return *exactly* it: the fix is only allowed to
 *      change the cuts that would have split a pair, so no caller's output shifts.
 *   2. `sliceText`'s cut rules on their own (n <= 0, fits-as-is, a straddled pair dropped
 *      whole) — `clipText` is only as good as the cut underneath it.
 *   3. `tailText`, the mirror cut at the **head** (a background terminal's output tail): the
 *      same family read from the other end, and the one shape only a head cut has — a pair
 *      straddling that cut is dropped whole, so the kept text loses one unit *and* never
 *      begins on a low half.
 *   4. `wellFormed`: a valid pair is one character and survives byte-for-byte; each
 *      unpaired half — leading, trailing, or a reversed pair — becomes U+FFFD.
 *   5. `wellFormedDeep` over a message-shaped object: every string fixed, the **input not
 *      mutated**, non-string leaves untouched, containers copied — and, end to end, the
 *      serialised bytes carry no `\uXXXX` escape whose surrogate partner is missing. That
 *      last one is the provider's own rule written out here, because it is the thing that
 *      returns the 400.
 *   6. A source scan: a *new* hand-written clip anywhere under `src/` fails the build with
 *      `file:line`, so the fix cannot be quietly undone. Three shapes are read — the head
 *      clip (`.slice(…) + '…'` and `${…slice(…)}…`) and the **tail** clip (`'…' + v.slice(-n)`,
 *      `` `…${v.slice(-n)}` ``), which is the same failure with the halves swapped (a lone
 *      *low* surrogate) — and the ellipsis counts whether it is written `…` or `\u2026`:
 *      both spellings are in this tree and the escaped one splits a pair just as well. The
 *      helper itself (`src/text.ts`) is skipped — it is the fix.
 *
 * Needs `out/` (run `npm run compile` first: it requires the compiled text module).
 *
 * Run: npm run check:unicode   /   node tools/check-unicode.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const textPath = path.join(root, 'out', 'text.js');
if (!fs.existsSync(textPath)) {
  console.error('check-unicode: out/text.js is missing — run `npm run compile` first.');
  process.exit(1);
}
const T = require(path.join(__dirname, '..', 'out', 'text.js'));

const problems = [];
const ok = (label, cond, detail) => {
  if (cond) console.log(`  [ok  ] ${label}${detail ? '  (' + detail + ')' : ''}`);
  else {
    console.log(`  [FAIL] ${label}${detail ? '  (' + detail + ')' : ''}`);
    problems.push(label);
  }
};

/** 📎 U+1F4CE — the emoji whose leading half `\uD83D` survived the incident clip. */
const CLIP = '\u{1F4CE}';
/** 𠀋 U+2000B — an astral CJK glyph: two units, like every other non-BMP character. */
const ASTRAL = '\u{2000B}';
/** The tail `clipText` appends by default. */
const TAIL = '…';
/** The string the incident left behind: the clipped text, then the lone half, then the tail. */
const INCIDENT = '**' + '\uD83D' + '…';

/**
 * An unpaired half, as the helpers must see it: a leading surrogate with no trailing half
 * after it, or a trailing one with no leading half before it. A pair is *one character*,
 * so a valid `\uD83D\uDCCE` must not match — which is why the leading alternative is not
 * `\uD800[\uDC00-\uDFFF]` (that would flag a valid pair as broken).
 */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;
/** Both witnesses of "nothing was left behind": the regexp, and the helper's own repair. */
const clean = (s) => !LONE.test(s) && T.wellFormed(s) === s;

console.log('-- 1. clipText: no lone surrogate leaves, for n = 1..12 --');

/** The inputs the rule has to hold for: every emoji shape, plus the two from the report. */
const FAMILY = [
  { why: 'text around an emoji', s: '…' + CLIP + '…' },
  { why: 'a string that is only the emoji', s: CLIP },
  { why: 'an astral CJK glyph in context', s: 'x' + ASTRAL + 'y' },
  { why: 'a valid pair right at the n=3 boundary', s: 'ab' + CLIP + 'c' },
  { why: 'the incident string', s: INCIDENT },
  { why: 'the 200-unit clip', s: 'a'.repeat(198) + CLIP + 'b' },
];

// Counted so a loop that stops matching anything is visible as a zero in the detail
// instead of reading as a pass.
let naiveCuts = 0;
let wellFormedCuts = 0;
let splitCuts = 0;

for (const c of FAMILY) {
  const lone = [];
  const same = [];
  for (let n = 1; n <= 12; n++) {
    const cut = T.clipText(c.s, n);
    if (!clean(cut)) lone.push(`n=${n}: ${JSON.stringify(cut)}`);
    if (cut.length > n + TAIL.length) lone.push(`n=${n}: ${cut.length} units, over n + tail`);
    if (c.s.length <= n) continue; // nothing was cut, so there is no naive cut to equal
    naiveCuts++;
    const naive = c.s.slice(0, n) + TAIL;
    if (clean(naive)) {
      wellFormedCuts++;
      if (cut !== naive) same.push(`n=${n}: ${JSON.stringify(cut)} ≠ ${JSON.stringify(naive)}`);
    } else {
      splitCuts++;
      if (cut === naive) same.push(`n=${n}: kept the split pair of ${JSON.stringify(naive)}`);
    }
  }
  ok(
    `clipText(${c.why}) is lone-free and at most n + the tail`,
    lone.length === 0,
    lone.length ? lone.slice(0, 3).join(' | ') : 'n = 1..12',
  );
  ok(
    '  … and equals the naive cut exactly when that cut is well-formed',
    same.length === 0,
    same.length ? same.slice(0, 3).join(' | ') : 'the fix touches split cuts only',
  );
}
ok(
  'the family exercised both halves of the rule',
  naiveCuts > 0 && wellFormedCuts > 0 && splitCuts > 0,
  `${naiveCuts} naive comparison(s): ${wellFormedCuts} well-formed, ${splitCuts} with a split pair`,
);

console.log('-- the incident itself, pinned --');
ok(
  'the incident string is the one that serialised as \\ud83d',
  JSON.stringify(INCIDENT) === '"**\\ud83d…"' && LONE.test('\uD83D'),
  JSON.stringify(INCIDENT),
);
ok(
  '  … clipText never passes that half on, for any n',
  [1, 2, 3, 4, 12].every((n) => clean(T.clipText(INCIDENT, n))),
  [1, 3, 12].map((n) => JSON.stringify(T.clipText(INCIDENT, n))).join(' | '),
);
ok(
  '  … it comes back uncut (n ≥ its length) with only the lone half repaired',
  T.clipText(INCIDENT, INCIDENT.length) === '**\uFFFD…' && T.clipText(INCIDENT, 12) === '**\uFFFD…',
  JSON.stringify(T.clipText(INCIDENT, 12)),
);
const wide = T.clipText('a'.repeat(198) + CLIP + 'b', 200);
ok(
  'the 200-unit clip ends with the emoji whole, never half of it',
  wide === 'a'.repeat(198) + CLIP + TAIL && clean(wide),
  JSON.stringify(wide.slice(196)),
);
ok(
  '  … and the cut that would have split it drops the pair instead',
  T.clipText('a'.repeat(198) + CLIP + 'b', 199) === 'a'.repeat(198) + TAIL,
  JSON.stringify(T.clipText('a'.repeat(198) + CLIP + 'b', 199).slice(194)),
);
ok(
  '  … where the naive cut at 199 really does end in a lone \\ud83d',
  LONE.test(('a'.repeat(198) + CLIP + 'b').slice(0, 199) + TAIL),
  JSON.stringify(('a'.repeat(198) + CLIP + 'b').slice(0, 199) + TAIL),
);
ok('the tail is appended verbatim, and is never itself clipped', T.clipText('a' + CLIP + 'b', 1, ' [more]') === 'a [more]');

console.log('-- 2. sliceText: the cut underneath clipText --');
const WORD = 'a' + CLIP + 'b'; // four units: a, a pair, b
ok('n <= 0 is the empty string', T.sliceText(WORD, 0) === '' && T.sliceText(WORD, -1) === '');
ok('a string that fits comes back as-is', T.sliceText(WORD, WORD.length) === WORD && T.sliceText(WORD, 99) === WORD);
ok(
  'a cut exactly on a pair boundary is not a cut in the middle',
  T.sliceText(CLIP, 2) === CLIP && T.sliceText('ab' + CLIP, 4) === 'ab' + CLIP,
);
const straddle = T.sliceText('a' + CLIP + 'b', 2);
ok('a pair straddling the cut is dropped whole', straddle === 'a', JSON.stringify(straddle));
ok('  … the kept text is one unit short, never half a pair', straddle.length === 1 && !LONE.test(straddle), `${straddle.length} unit(s)`);
ok('a pair at the head of the string is dropped entirely', T.sliceText(CLIP, 1) === '' && T.sliceText(CLIP + 'x', 1) === '');

/** `sliceText(s, n)` as the rule reads it: `slice(0, n)`, or one unit less at a split. */
function sliceIsSound(s, n) {
  const res = T.sliceText(s, n);
  if (n <= 0) return res === '';
  if (s.length <= n) return res === s;
  const splits = isHigh(s.charCodeAt(n - 1)) && isLow(s.charCodeAt(n));
  return res === (splits ? s.slice(0, n - 1) : s.slice(0, n));
}
const unsound = [];
for (const c of FAMILY) {
  for (let n = 0; n <= 12; n++) {
    if (!sliceIsSound(c.s, n)) unsound.push(`${c.why} n=${n}: ${JSON.stringify(T.sliceText(c.s, n))}`);
  }
}
ok(
  'for the whole family, the cut is slice(0, n) — or slice(0, n - 1) at a pair',
  unsound.length === 0,
  unsound.slice(0, 3).join(' | ') || `${FAMILY.length * 13} cut(s) checked`,
);

console.log('-- 3. tailText: the cut underneath a tail clip (a background output tail) --');
const WORD_TAIL = 'ab' + CLIP + 'cd'; // six units: a, b, a pair, then c and d
ok('n <= 0 is the empty string', T.tailText(WORD_TAIL, 0) === '' && T.tailText(WORD_TAIL, -1) === '');
ok(
  'a string that fits comes back as-is',
  T.tailText(WORD_TAIL, WORD_TAIL.length) === WORD_TAIL && T.tailText(WORD_TAIL, 99) === WORD_TAIL,
);
ok(
  'n = 0, 1, 2 spelled out: empty, the last unit, the last two — no low half among them',
  T.tailText(WORD_TAIL, 0) === '' && T.tailText(WORD_TAIL, 1) === 'd' && T.tailText(WORD_TAIL, 2) === 'cd',
  [0, 1, 2].map((n) => JSON.stringify(T.tailText(WORD_TAIL, n))).join(' | '),
);
const headStraddle = T.tailText(WORD_TAIL, 3);
ok(
  'a pair straddling the head cut is dropped whole, one unit short of n',
  headStraddle === 'cd' && headStraddle.length === 2 && !isLow(headStraddle.charCodeAt(0)) && !LONE.test(headStraddle),
  JSON.stringify(headStraddle),
);
ok(
  '  … where the naive tail at n = 3 really does begin with a lone \\udcce',
  LONE.test(WORD_TAIL.slice(-3)),
  JSON.stringify(WORD_TAIL.slice(-3)),
);
ok(
  'a cut exactly on a pair boundary keeps the pair whole',
  T.tailText(WORD_TAIL, 4) === CLIP + 'cd' && T.tailText(WORD_TAIL, 6) === WORD_TAIL,
  JSON.stringify(T.tailText(WORD_TAIL, 4)),
);

/** The family the tail rule has to hold for: the pair anywhere relative to a cut at the head. */
const TAILED = [
  { why: 'a pair that straddles the head cut', s: 'ab' + CLIP + 'cd' },
  { why: 'a pair kept whole inside the tail', s: 'log ' + CLIP + ' end' },
  { why: 'a pair the cut drops entirely', s: 'x' + CLIP },
  { why: 'an astral CJK glyph in context', s: 'x' + ASTRAL + 'y' },
  { why: 'the incident string, its lone half inside the tail', s: INCIDENT },
  { why: 'a pair at the very head of a 200-unit string', s: CLIP + 'b'.repeat(198) },
];

// Counted the way the clipText group counts: a family that stops straddling anything
// shows up as a zero in the detail instead of reading as a pass.
let tailCuts = 0;
let tailStraddles = 0;
const tailWrong = [];
for (const c of TAILED) {
  const inputIsClean = !LONE.test(c.s);
  for (let n = 0; n <= c.s.length; n++) {
    const out = T.tailText(c.s, n);
    if (!clean(out)) tailWrong.push(`${c.why} n=${n}: ${JSON.stringify(out)} carries a lone half`);
    if (out.length > Math.max(0, n)) tailWrong.push(`${c.why} n=${n}: ${out.length} unit(s), over n`);
    if (n <= 0 || c.s.length <= n) continue; // nothing was cut, so there is no suffix to check
    tailCuts++;
    const start = c.s.length - n;
    const splits = isHigh(c.s.charCodeAt(start - 1)) && isLow(c.s.charCodeAt(start));
    if (splits) {
      tailStraddles++;
      if (out.length !== n - 1) tailWrong.push(`${c.why} n=${n}: ${out.length} unit(s), not one short of ${n}`);
      if (isLow(out.charCodeAt(0))) tailWrong.push(`${c.why} n=${n}: starts on a low half`);
    }
    // The rule: the plain suffix `s.slice(s.length - n)` when no pair was split (or that
    // suffix one unit longer — the low half left behind — when one was), and only a *lone
    // half already in the input* (the incident string) comes back repaired instead.
    const want = c.s.slice(splits ? start + 1 : start);
    const got = inputIsClean ? want : T.wellFormed(want);
    if (out !== got) tailWrong.push(`${c.why} n=${n}: ${JSON.stringify(out)} ≠ ${JSON.stringify(got)}`);
  }
}
ok(
  'for the whole family, the tail is the suffix named — lone-free, at most n, one short at a pair',
  tailWrong.length === 0,
  tailWrong.slice(0, 3).join(' | ') || `${tailCuts} cut(s) checked`,
);
ok(
  'the family exercised both halves of the rule',
  tailCuts > 0 && tailStraddles > 0,
  `${tailCuts} cut(s): ${tailStraddles} with a straddled pair`,
);
ok(
  'the incident string: the lone half inside the tail is repaired, never passed on',
  [1, 2, 3, 4].every((n) => clean(T.tailText(INCIDENT, n))) &&
    T.tailText(INCIDENT, 2) === '\uFFFD…' &&
    T.tailText(INCIDENT, 12) === '**\uFFFD…',
  [1, 3, 4].map((n) => JSON.stringify(T.tailText(INCIDENT, n))).join(' | '),
);

console.log('-- 4. wellFormed: a pair is one character, a half is a lie --');
ok('a valid pair survives byte-for-byte', T.wellFormed('a' + CLIP + 'b') === 'a' + CLIP + 'b', JSON.stringify(T.wellFormed('a' + CLIP + 'b')));
ok(
  '  … against the code units, not just by =',
  T.wellFormed('a' + CLIP + 'b').charCodeAt(1) === 0xd83d && T.wellFormed('a' + CLIP + 'b').charCodeAt(2) === 0xdcce,
);
ok(
  '  … a leading pair included',
  T.wellFormed(CLIP + 'x') === CLIP + 'x' && T.wellFormed(ASTRAL) === ASTRAL,
  JSON.stringify(T.wellFormed(ASTRAL)),
);
ok('a lone high surrogate becomes U+FFFD', T.wellFormed('x\uD83Dy') === 'x\uFFFDy', JSON.stringify(T.wellFormed('x\uD83Dy')));
ok('a lone low surrogate becomes U+FFFD', T.wellFormed('x\uDCCEy') === 'x\uFFFDy', JSON.stringify(T.wellFormed('x\uDCCEy')));
ok('a reversed pair becomes two U+FFFD', T.wellFormed('\uDCCE\uD83D') === '\uFFFD\uFFFD', JSON.stringify(T.wellFormed('\uDCCE\uD83D')));
ok(
  'well-formed text is returned as an equal string',
  T.wellFormed('plain ascii, é, 中文, ' + CLIP) === 'plain ascii, é, 中文, ' + CLIP && T.wellFormed('') === '',
);
const repaired = T.wellFormed('x\uD83Dy');
ok('  … and repairing is idempotent', T.wellFormed(repaired) === repaired);

console.log('-- 5. wellFormedDeep: the whole request body, copied and fixed --');

/**
 * The escapes serde_json's validating reader rejects: a `\uD800`–`\uDBFF` escape that is
 * not immediately followed by a `\uDC00`–`\uDFFF` one, or a trailing escape with no
 * leading half in front of it. `JSON.stringify` writes a lone surrogate exactly this way,
 * so the serialised bytes are the only place the bug is visible.
 */
function loneEscapes(json) {
  const bad = [];
  const re = /\\(u[0-9a-fA-F]{4}|[\s\S])/g;
  const isEsc = (esc) => esc.length === 5 && esc[0] === 'u';
  const codeOf = (esc) => parseInt(esc.slice(1), 16);
  let pending = null; // a leading half still waiting for its partner: { text, end }
  let m;
  while ((m = re.exec(json)) !== null) {
    const esc = m[1];
    if (pending) {
      const paired = isEsc(esc) && m.index === pending.end && isLow(codeOf(esc));
      if (!paired) bad.push(pending.text);
      pending = null;
      if (paired) continue; // the trailing half is consumed by its leading one
      // Otherwise the escape that broke the pairing is judged on its own account.
    }
    if (isEsc(esc)) {
      const code = codeOf(esc);
      if (isHigh(code)) pending = { text: m[0], end: re.lastIndex };
      else if (isLow(code)) bad.push(m[0]);
    }
  }
  if (pending) bad.push(pending.text);
  return bad;
}

const MESSAGE = {
  role: 'tool',
  content: [{ type: 'text', text: 'x\uD83Dy' }, { type: 'file', file_id: 'f1' }],
  tool_calls: [{ type: 'function', function: { name: 'read_file', arguments: '{"path":"a\uD83Db"}' } }],
  reasoning_content: 'z\uD83D',
  index: 3,
  streamed: false,
  error: null,
  usage: { prompt_tokens: 12, cache_hit: true },
};
/** The same message with every unpaired half repaired: what the wire must carry. */
const WANT = {
  role: 'tool',
  content: [{ type: 'text', text: 'x\uFFFDy' }, { type: 'file', file_id: 'f1' }],
  tool_calls: [{ type: 'function', function: { name: 'read_file', arguments: '{"path":"a\uFFFDb"}' } }],
  reasoning_content: 'z\uFFFD',
  index: 3,
  streamed: false,
  error: null,
  usage: { prompt_tokens: 12, cache_hit: true },
};

const before = JSON.stringify(MESSAGE);
const fixed = T.wellFormedDeep(MESSAGE);
ok('every string in the message is fixed', JSON.stringify(fixed) === JSON.stringify(WANT), JSON.stringify(fixed.tool_calls[0].function.arguments));
ok(
  '  … now that serde_json can read the three of them',
  loneEscapes(JSON.stringify(fixed)).length === 0,
  loneEscapes(JSON.stringify(fixed)).join(',') || 'no unpaired escape',
);
ok(
  '  … and it took a copy: the caller\'s own message is untouched',
  JSON.stringify(MESSAGE) === before && fixed !== MESSAGE && MESSAGE.content[0].text === 'x\uD83Dy',
);
ok(
  '  … down to the containers (a shared array would smuggle the old string back)',
  fixed.content !== MESSAGE.content &&
    fixed.content[0] !== MESSAGE.content[0] &&
    fixed.tool_calls[0].function !== MESSAGE.tool_calls[0].function &&
    fixed.usage !== MESSAGE.usage,
);
ok(
  'non-string leaves survive as they are',
  fixed.index === 3 && fixed.streamed === false && fixed.error === null && fixed.usage.prompt_tokens === 12 && fixed.usage.cache_hit === true,
  `${fixed.index}, ${fixed.streamed}, ${fixed.error}, ${fixed.usage.prompt_tokens}`,
);
ok('  … and the array shape is preserved', Array.isArray(fixed.content) && fixed.content.length === 2 && fixed.content[1].file_id === 'f1');
ok('a bare leaf is passed through, not boxed', T.wellFormedDeep(42) === 42 && T.wellFormedDeep(null) === null && T.wellFormedDeep(undefined) === undefined);

console.log('-- the bytes on the wire: no unpaired \\uXXXX escape --');
ok(
  'the incident string serialises to the escape the provider rejected',
  loneEscapes(JSON.stringify(INCIDENT)).join(',') === '\\ud83d',
  loneEscapes(JSON.stringify(INCIDENT)).join(',') || 'none seen — the check would be blind',
);
ok(
  '  … and nothing that goes through wellFormedDeep does',
  loneEscapes(JSON.stringify(T.wellFormedDeep(INCIDENT))).length === 0 && loneEscapes(JSON.stringify(T.wellFormedDeep(MESSAGE))).length === 0,
  JSON.stringify(T.wellFormedDeep(INCIDENT)),
);
// The detector has to be able to say *no* for the right reason: a backslash that is
// itself escaped is not an escape, and a real pair spells out as two escapes. Built
// through `BS` rather than written as literals, so the test cannot be broken by an
// escaping mistake of its own.
const BS = String.fromCharCode(92);
/** `"a\\ud83db"` — an escaped backslash, then the letters `ud83d`: nothing here is an escape. */
const FAKE_ESCAPE = '"a' + BS + BS + 'ud83db"';
/** `"\ud83d…"` — a lone leading half, the incident's shape. */
const LONE_ESCAPE = '"a' + BS + 'ud83db"';
/** `"\ud83d\udcce"` — the pair, written the way `JSON.stringify` writes it. */
const REAL_PAIR = '"' + BS + 'ud83d' + BS + 'udcce"';
ok(
  'the detector reads escapes, not text that looks like one',
  loneEscapes(FAKE_ESCAPE).length === 0 && loneEscapes(REAL_PAIR).length === 0 && loneEscapes(LONE_ESCAPE).join(',') === BS + 'ud83d',
  `${JSON.stringify(FAKE_ESCAPE)} → ${loneEscapes(FAKE_ESCAPE).length}, ${JSON.stringify(REAL_PAIR)} → ${loneEscapes(REAL_PAIR).length}, ${JSON.stringify(LONE_ESCAPE)} → ${loneEscapes(LONE_ESCAPE).join(',') || 'none'}`,
);

console.log('-- 6. the source scan: a new hand-written clip fails the build --');

/**
 * `…` and the escape `\u2026` are the same string at runtime, and both are written in this
 * tree (`src/tools/webBackends.ts` writes the escape), so every shape below reads the two
 * spellings alike: an escaped ellipsis splits a pair exactly as well as a literal one.
 */
/** `.slice(…) + '…'` — the helper's own shape, written out again at a call site. */
const CLIP_PLUS_TAIL = /\.slice\([^()]*\)\s*\+\s*['"`]\s*(?:…|\\u2026)/;
/** `${…slice(…)}…` — the template flavour (`\n` is allowed between the cut and the tail). */
const CLIP_IN_TEMPLATE = /\$\{[^{}]*\.slice\([^()]*\)[^{}]*\}(?:\\n)?\s*(?:…|\\u2026)/;
/** `'…' + value.slice(-n)` — a cut at the **head**: it keeps the *low* half of a split pair. */
const TAIL_PLUS_PREFIX = /['"`]\s*(?:…|\\u2026)\s*['"`]\s*\+.*\.slice\(\s*-/;
/** `` `…${value.slice(-n)}` `` — the same head cut in a template. */
const TAIL_IN_TEMPLATE = /(?:…|\\u2026)\s*\$\{[^{}]*\.slice\(\s*-/;
const SHAPES = [
  [".slice(…) + '…'", CLIP_PLUS_TAIL, 'clipText() / sliceText()'],
  ['${…slice(…)}…', CLIP_IN_TEMPLATE, 'clipText() / sliceText()'],
  ["'…' + value.slice(-n)", TAIL_PLUS_PREFIX, 'tailText()'],
  ['`…${value.slice(-n)}`', TAIL_IN_TEMPLATE, 'tailText()'],
];

const findings = [];
let walked = 0;

function scanDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDir(full);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    walked++;
    const rel = path.relative(root, full).replace(/\\/g, '/');
    if (rel === 'src/text.ts') continue; // the helper itself — it *is* the fix
    fs.readFileSync(full, 'utf8')
      .split(/\r?\n/)
      .forEach((line, i) => {
        for (const [shape, re, remedy] of SHAPES) {
          if (re.test(line)) {
            findings.push(
              `${rel}:${i + 1}: clips with ${shape} — use ${remedy} from src/text.ts (an unpaired half here 400s the next request)`,
            );
          }
        }
      });
  }
}
scanDir(path.join(root, 'src'));

ok(
  'src/**/*.ts has no hand-written slice-then-ellipsis clip left (head or tail)',
  findings.length === 0,
  findings.length ? `${findings.length} site(s)` : `${walked} file(s) walked, src/text.ts skipped`,
);
for (const f of findings) {
  console.log(`         ${f}`);
  problems.push(f);
}
ok('the walk itself is real (an empty tree is visible here)', walked > 1, `${walked} .ts file(s) walked`);

console.log('');
if (problems.length) {
  console.log(`FAIL check-unicode: ${problems.length} check(s) failed`);
  process.exit(1);
}
console.log(
  `PASS check-unicode: clipText/sliceText/tailText never split a pair (head or tail), wellFormed(Deep) leaves no lone surrogate, no hand-written slice-then-ellipsis clip in src/ (${walked} file(s) walked)`,
);
process.exit(0);
