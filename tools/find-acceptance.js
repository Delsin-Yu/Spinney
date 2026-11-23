/*
 * check-find — the corpus, the matcher, the order and the three bounds, as a build-time
 * guard (`docs/agents/plans/conversation-search.md`, §2.1–§2.3 and §7).
 *
 * What is pinned, against the compiled `out/chat/find.js`:
 *
 *   1. The corpus is the **question and the final answer** of a card: the last non-empty
 *      `assistant` text leads (the prose block after the run of steps), the first `user`
 *      item follows, and tool rows, tool output, thinking, notices, harness notes and
 *      background output are never searchable at all. A `bg` card — a command, not a turn
 *      — offers nothing.
 *   2. Reading order is `orderedNodeIds`: every root in `rootIds` order, children in order,
 *      depth first; a node no root reaches is still walked (after the roots), and a cycle
 *      in `parentId`/`children` cannot hang the scan.
 *   3. The matcher is the VS Code search box: literal by default (so `search_files(` finds
 *      itself instead of failing as a pattern), `\b` for whole word, `i` unless case
 *      sensitive, the query as a regex when the toggle is on — and `invalid` with the
 *      engine's own message, never a throw, when it does not parse.
 *   4. One hit per card, and it is the answer when both halves of a card match.
 *   5. The three bounds: `limit` (with `capped`), `deadlineAt` (with `timedOut`, and a
 *      spent deadline never starts the scan) and `yieldTo` (a 40-card scan really yields).
 *   6. The snippet: `snippet.slice(matchStart, matchEnd)` is the query, a long answer
 *      still yields one line of at most 200, and no clip hands back half a surrogate pair
 *      — including the cut that lands exactly on one, which is the case the emoji at the
 *      boundary is built for.
 *
 * Needs `out/` (run `npm run compile` first: it requires the compiled find module).
 *
 * Run: npm run check:find   /   node tools/find-acceptance.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const findPath = path.join(root, 'out', 'chat', 'find.js');
if (!fs.existsSync(findPath)) {
  console.error('check-find: out/chat/find.js is missing — run `npm run compile` first.');
  process.exit(1);
}
const F = require(findPath);

/** Every assertion bumps this, so the final line says how much the guard really checked. */
let assertions = 0;
/** Labels of the assertions that failed; empty means the guard passed. */
const problems = [];

/**
 * One assertion. Deliberately silent when it passes — the detail is carried for the
 * failure report only, so a green run is exactly one line.
 */
const ok = (label, cond, detail) => {
  assertions++;
  if (!cond) {
    problems.push(detail ? `${label}  (${detail})` : label);
  }
};

/** A `DisplayItem`-shaped row; `extra` carries whatever the item kind additionally has. */
const item = (kind, text, extra) => Object.assign({ kind, text }, extra || {});

/**
 * A `TreeNode` with only the fields the module reads (id, parentId, children,
 * displayItems, title, status, kind, role, messages).
 */
const card = (id, spec) => {
  const s = spec || {};
  return {
    id,
    parentId: s.parentId === undefined ? null : s.parentId,
    children: s.children || [],
    displayItems: s.items || [],
    title: s.title || '',
    status: 'done',
    kind: s.kind || 'turn',
    role: s.role,
    messages: [],
  };
};

/** An `AgentSession` over the cards given, `rootIds` defaulting to insertion order. */
const sessionOf = (id, spec) => {
  const s = spec || {};
  const cards = s.cards || [];
  const nodes = {};
  for (const c of cards) {
    nodes[c.id] = c;
  }
  return {
    id,
    title: s.title || id,
    createdAt: 1,
    updatedAt: s.updatedAt === undefined ? 1000 : s.updatedAt,
    nodes,
    rootIds: s.rootIds || cards.map((c) => c.id),
    activeNodeId: s.activeNodeId === undefined ? null : s.activeNodeId,
    orphanItems: [],
  };
};

/** One card of one session whose answer is `answer` and whose ask is `question`. */
const cardSession = (id, answer, question) =>
  sessionOf(id, {
    cards: [card('n1', { items: [item('user', question || 'what does it do?'), item('assistant', answer)] })],
  });

/** One query, spelled the way the caller will spell it. */
const run = (sessions, opts, yieldTo) => F.findInSessions(sessions, opts, yieldTo);

/** A `yieldTo` that counts its calls, so "the scan yields" is observable. */
const countingYield = () => {
  const box = { calls: 0 };
  box.fn = async () => {
    box.calls++;
  };
  return box;
};

/** 📎 U+1F4CE — two UTF-16 units, the pair a naive clip splits. */
const EMOJI = '\u{1F4CE}';
/**
 * An unpaired half: a leading surrogate with no trailing half after it, or a trailing one
 * with no leading half before it. **Unanchored** on purpose — the failure this guard is
 * about (a cut in the middle of a pair) leaves the half in the *middle* of a snippet, so a
 * `^`-anchored pattern would report "clean" for exactly the case that matters.
 */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const hasLone = (s) => typeof s === 'string' && LONE.test(s);

/** The window `makeSnippet` reads: ±60 units around the match (src/chat/find.ts). */
const SNIPPET_RADIUS = 60;
const windowOf = (text, matchStart, matchLength) =>
  text.slice(
    Math.max(0, matchStart - SNIPPET_RADIUS),
    Math.min(text.length, matchStart + matchLength + SNIPPET_RADIUS),
  );

async function main() {
  // ---- 1. the corpus: the answer leads, the question follows -------------------------
  const basic = card('c1', {
    items: [item('user', 'the question'), item('assistant', 'the answer')],
  });
  const basicText = F.searchableText(basic);
  ok(
    'searchableText returns the answer first and the question second',
    basicText.length === 2 &&
      basicText[0].field === 'answer' &&
      basicText[0].text === 'the answer' &&
      basicText[1].field === 'question' &&
      basicText[1].text === 'the question',
    JSON.stringify(basicText),
  );

  // Three assistant blocks: the answer is the LAST one — the prose after the last step.
  const three = card('c2', {
    items: [
      item('user', 'ask'),
      item('assistant', 'first'),
      item('tool', 'read_file', { name: 'read_file' }),
      item('assistant', 'second'),
      item('assistant', 'third'),
    ],
  });
  const threeText = F.searchableText(three);
  ok(
    'the answer is the LAST non-empty assistant text',
    threeText[0] &&
      threeText[0].field === 'answer' &&
      threeText[0].text === 'third' &&
      threeText.filter((f) => f.field === 'answer').length === 1,
    JSON.stringify(threeText),
  );

  // An empty (or whitespace-only) assistant block is not an answer at all.
  const blank = card('c3', {
    items: [
      item('user', 'ask'),
      item('assistant', ''),
      item('assistant', '   '),
      item('assistant', 'the real answer'),
    ],
  });
  const blankText = F.searchableText(blank);
  ok(
    'an empty assistant block is skipped, never the answer',
    blankText.length === 2 && blankText[0].text === 'the real answer',
    JSON.stringify(blankText),
  );

  // Everything outside the corpus: tool args, tool output, thinking, notices, harness,
  // background output. A card made only of those has nothing to search.
  const offCorpus = card('c4', {
    items: [
      item('tool', '{"path":"needle-in-tool-args.ts"}', { name: 'read_file' }),
      item('tool', 'needle in tool output', { name: 'run_command' }),
      item('notice', 'needle in a notice'),
      item('harness', 'needle in a harness note'),
      item('background', 'needle in background output'),
      { kind: 'assistant', thinking: 'needle in thinking', text: '   ' },
    ],
  });
  ok(
    'a card of tool rows, thinking, notices and harness notes returns []',
    F.searchableText(offCorpus).length === 0,
    JSON.stringify(F.searchableText(offCorpus)),
  );

  // Two asks: the question is the FIRST user item (the pinned ask).
  const twoAsks = card('c5', {
    items: [item('user', 'first ask'), item('user', 'second ask'), item('assistant', 'done')],
  });
  const twoAsksText = F.searchableText(twoAsks);
  ok(
    'the question is the FIRST user item',
    twoAsksText.length === 2 && twoAsksText[1].field === 'question' && twoAsksText[1].text === 'first ask',
    JSON.stringify(twoAsksText),
  );

  // End to end: text that lives only in a tool row is not searchable.
  const toolOnly = sessionOf('s-tool', {
    cards: [
      card('t1', {
        items: [item('tool', 'needle in tool output', { name: 'run_command' }), item('assistant', 'no match here')],
      }),
    ],
  });
  const toolOnlyRes = await run([toolOnly], { scope: 'session', sessionId: 's-tool', query: 'needle' });
  ok(
    'a query found only in a tool row is not a hit',
    toolOnlyRes.hits.length === 0,
    `${toolOnlyRes.hits.length} hit(s)`,
  );

  // ---- 2. a bg card is a command, not a turn ----------------------------------------
  const bg = card('b1', {
    kind: 'bg',
    items: [item('user', 'run the tests'), item('assistant', 'all green')],
  });
  ok("a kind:'bg' card returns []", F.searchableText(bg).length === 0, JSON.stringify(F.searchableText(bg)));

  // ---- 3. reading order ------------------------------------------------------------
  const nodeA = card('A', { children: ['B', 'D'] });
  const nodeB = card('B', { parentId: 'A', children: ['C'] });
  const nodeC = card('C', { parentId: 'B' });
  const nodeD = card('D', { parentId: 'A' });
  const nodeE = card('E');
  const ordered = sessionOf('s-order', {
    cards: [nodeD, nodeE, nodeC, nodeA, nodeB], // insertion order is NOT reading order
    rootIds: ['A', 'E'],
  });
  ok(
    'roots in rootIds order, then children in order, depth first',
    JSON.stringify(F.orderedNodeIds(ordered)) === JSON.stringify(['A', 'B', 'C', 'D', 'E']),
    JSON.stringify(F.orderedNodeIds(ordered)),
  );

  // A node no root reaches (a corrupt tree) is still searchable, after the roots.
  const stray = card('Z', { parentId: 'A' }); // parentId says A, but A.children never lists it
  const withStray = sessionOf('s-stray', {
    cards: [nodeA, nodeB, nodeC, nodeD, nodeE, stray],
    rootIds: ['A', 'E'],
  });
  const strayOrder = F.orderedNodeIds(withStray);
  ok(
    'a node no root reaches is walked too, after the roots',
    JSON.stringify(strayOrder) === JSON.stringify(['A', 'B', 'C', 'D', 'E', 'Z']),
    JSON.stringify(strayOrder),
  );

  // A cycle in parentId/children must not hang (nor duplicate an id).
  const cycX = card('X', { parentId: 'Y', children: ['Y'] });
  const cycY = card('Y', { parentId: 'X', children: ['X'] });
  const cyclic = sessionOf('s-cycle', { cards: [cycX, cycY], rootIds: ['X'] });
  const cycleOrder = F.orderedNodeIds(cyclic);
  ok(
    'a parent/child cycle does not hang, and each id appears once',
    JSON.stringify(cycleOrder) === JSON.stringify(['X', 'Y']) && new Set(cycleOrder).size === cycleOrder.length,
    JSON.stringify(cycleOrder),
  );
  const selfCyc = card('S', { parentId: 'S', children: ['S'] });
  const selfSession = sessionOf('s-selfcycle', { cards: [selfCyc], rootIds: ['S'] });
  ok(
    'a self-parented node is walked once and returns',
    JSON.stringify(F.orderedNodeIds(selfSession)) === JSON.stringify(['S']),
    JSON.stringify(F.orderedNodeIds(selfSession)),
  );

  // ---- 4. the matcher --------------------------------------------------------------
  // A literal query is text, never a pattern: `(` cannot throw and must find itself.
  const literal = await run(
    [cardSession('s-lit', 'then it calls search_files( on the path')],
    { scope: 'session', sessionId: 's-lit', query: 'search_files(' },
  );
  ok(
    'a literal query containing regex metacharacters matches itself (no throw)',
    literal.hits.length === 1 && literal.hits[0].field === 'answer' && !literal.invalid,
    `${literal.hits.length} hit(s)${literal.invalid ? ', invalid: ' + literal.invalid : ''}`,
  );
  const literalCompiled = F.compileQuery('search_files(', {});
  ok(
    '  … because compileQuery escapes it instead of passing it through',
    literalCompiled.source === 'search_files\\(' &&
      literalCompiled.flags === 'i' &&
      !literalCompiled.error &&
      new RegExp(literalCompiled.source, literalCompiled.flags).test('calls search_files('),
    JSON.stringify(literalCompiled),
  );

  // An unparsable regex is a result, not an exception.
  const invalid = await run([cardSession('s-inv', 'anything at all')], {
    scope: 'session',
    sessionId: 's-inv',
    query: '(',
    regex: true,
  });
  ok(
    'an invalid regex is `invalid` and no hits (never a throw)',
    typeof invalid.invalid === 'string' && invalid.invalid.length > 0 && invalid.hits.length === 0,
    `${invalid.hits.length} hit(s), invalid: ${JSON.stringify(invalid.invalid)}`,
  );
  ok(
    '  … with the engine message, and total/scanned left at zero',
    typeof invalid.invalid === 'string' && /group|parenthes|unterminated|Invalid|regular expression/i.test(invalid.invalid) &&
      invalid.total === 0 &&
      invalid.scannedNodes === 0,
    JSON.stringify(invalid.invalid),
  );

  // Whole word: `\b` on both ends.
  const concat = await run([cardSession('s-concat', 'the concat helper joins them')], {
    scope: 'session',
    sessionId: 's-concat',
    query: 'cat',
    wholeWord: true,
  });
  ok("whole word: 'cat' does not match 'concat'", concat.hits.length === 0, `${concat.hits.length} hit(s)`);
  const catSat = await run([cardSession('s-catsat', 'a cat sat down')], {
    scope: 'session',
    sessionId: 's-catsat',
    query: 'cat',
    wholeWord: true,
  });
  ok("whole word: 'cat' does match 'a cat sat'", catSat.hits.length === 1, `${catSat.hits.length} hit(s)`);

  // Case: insensitive by default, exact when asked.
  const insensitive = await run([cardSession('s-case', 'Cat')], {
    scope: 'session',
    sessionId: 's-case',
    query: 'cat',
  });
  ok(
    'case-insensitive by default: `cat` matches `Cat`',
    insensitive.hits.length === 1 && insensitive.hits[0].snippet === 'Cat',
    JSON.stringify(insensitive.hits[0] && insensitive.hits[0].snippet),
  );
  const caseSensitive = await run([cardSession('s-case', 'Cat')], {
    scope: 'session',
    sessionId: 's-case',
    query: 'cat',
    caseSensitive: true,
  });
  ok('caseSensitive: true does not match `Cat`', caseSensitive.hits.length === 0, `${caseSensitive.hits.length} hit(s)`);

  // Regex mode really is a pattern, and whole word yields to it (VS Code's own rule).
  const asRegex = await run([cardSession('s-regex', 'a cat sat down')], {
    scope: 'session',
    sessionId: 's-regex',
    query: 'c.t',
    regex: true,
  });
  ok(
    'regex mode matches as a pattern',
    asRegex.hits.length === 1 && asRegex.hits[0].matchEnd - asRegex.hits[0].matchStart === 3,
    JSON.stringify(asRegex.hits[0] && [asRegex.hits[0].matchStart, asRegex.hits[0].matchEnd]),
  );
  const bothToggles = await run([cardSession('s-bothflags', 'the concat helper')], {
    scope: 'session',
    sessionId: 's-bothflags',
    query: 'cat',
    regex: true,
    wholeWord: true,
  });
  ok(
    'whole word yields to regex (compileQuery keeps the source as written)',
    F.compileQuery('cat', { regex: true, wholeWord: true }).source === 'cat' && bothToggles.hits.length === 1,
    `source=${JSON.stringify(F.compileQuery('cat', { regex: true, wholeWord: true }).source)}, ${bothToggles.hits.length} hit(s)`,
  );

  // ---- 5. one hit per card, and it is the answer ------------------------------------
  const bothFields = sessionOf('s-both', {
    cards: [
      card('n1', {
        items: [
          item('user', 'where is the needle?'),
          item('tool', 'grep needle', { name: 'search_transcripts' }),
          item('assistant', 'the needle is in the haystack'),
        ],
      }),
    ],
  });
  const bothRes = await run([bothFields], { scope: 'session', sessionId: 's-both', query: 'needle' });
  ok(
    'a card whose answer AND question both match is exactly one hit',
    bothRes.hits.length === 1 && bothRes.total === 1,
    `${bothRes.hits.length} hit(s)`,
  );
  ok(
    "  … and its field is 'answer'",
    bothRes.hits.length === 1 && bothRes.hits[0].field === 'answer',
    bothRes.hits.length === 1 ? bothRes.hits[0].field : 'no hit',
  );

  // ---- 6. the cap ------------------------------------------------------------------
  const sixCards = [0, 1, 2, 3, 4, 5].map((i) =>
    card('k' + i, { items: [item('user', 'ask ' + i), item('assistant', 'needle ' + i)] }),
  );
  const six = sessionOf('s-six', { cards: sixCards });
  const capped = await run([six], { scope: 'session', sessionId: 's-six', query: 'needle', limit: 2 });
  ok(
    'six matching cards with limit 2 → 2 hits and capped',
    capped.hits.length === 2 && capped.capped === true && capped.total === 2,
    `${capped.hits.length} hit(s), capped=${capped.capped}, total=${capped.total}`,
  );
  const roomy = await run([six], { scope: 'session', sessionId: 's-six', query: 'needle', limit: 50 });
  ok(
    'a limit above the number of cards → every hit and capped false',
    roomy.hits.length === 6 && roomy.capped === false,
    `${roomy.hits.length} hit(s), capped=${roomy.capped}`,
  );

  // ---- 7. the deadline -------------------------------------------------------------
  const spent = await run([six], {
    scope: 'session',
    sessionId: 's-six',
    query: 'needle',
    deadlineAt: Date.now() - 1,
  });
  ok(
    'a spent deadline reports timedOut and no hits (the scan never starts)',
    spent.timedOut === true && spent.hits.length === 0 && spent.scannedNodes === 0,
    `timedOut=${spent.timedOut}, ${spent.hits.length} hit(s), ${spent.scannedNodes} card(s) scanned`,
  );
  ok(
    '  … and it is not reported as an invalid query or a cap',
    spent.invalid === undefined && spent.capped === false,
    `invalid=${JSON.stringify(spent.invalid)}, capped=${spent.capped}`,
  );
  const normal = await run([six], { scope: 'session', sessionId: 's-six', query: 'needle' });
  ok(
    'a normal run reports timedOut false',
    normal.timedOut === false && normal.hits.length === 6 && normal.scannedNodes === 6,
    `timedOut=${normal.timedOut}, ${normal.hits.length} hit(s), ${normal.scannedNodes} card(s) scanned`,
  );

  // ---- 8. the snippet and its offsets ---------------------------------------------
  const short = await run([cardSession('s-snip', 'the needle is here somewhere')], {
    scope: 'session',
    sessionId: 's-snip',
    query: 'needle',
  });
  const shortHit = short.hits[0];
  ok(
    'snippet.slice(matchStart, matchEnd) is the query',
    !!shortHit && shortHit.snippet.slice(shortHit.matchStart, shortHit.matchEnd) === 'needle',
    shortHit ? JSON.stringify(shortHit.snippet.slice(shortHit.matchStart, shortHit.matchEnd)) : 'no hit',
  );
  const upper = await run([cardSession('s-snip2', 'the NEEDLE is here')], {
    scope: 'session',
    sessionId: 's-snip2',
    query: 'needle',
  });
  const upperHit = upper.hits[0];
  ok(
    '  … case-insensitively (the snippet keeps the card\'s own casing)',
    !!upperHit &&
      upperHit.snippet.slice(upperHit.matchStart, upperHit.matchEnd).toLowerCase() === 'needle' &&
      upperHit.snippet.slice(upperHit.matchStart, upperHit.matchEnd) === 'NEEDLE',
    upperHit ? JSON.stringify(upperHit.snippet) : 'no hit',
  );

  // A very long answer: over 400 units with the match in the middle, still one short line.
  const longAnswer = 'a'.repeat(250) + 'needle' + 'b'.repeat(250);
  const longRes = await run([cardSession('s-long', longAnswer)], {
    scope: 'session',
    sessionId: 's-long',
    query: 'needle',
  });
  const longHit = longRes.hits[0];
  ok(
    'a 506-unit answer with the match in the middle yields a snippet of at most 200',
    !!longHit && longHit.snippet.length <= 200,
    longHit ? `${longHit.snippet.length} unit(s)` : 'no hit',
  );
  ok(
    '  … with the offsets inside it and naming the query',
    !!longHit &&
      longHit.matchStart >= 0 &&
      longHit.matchEnd <= longHit.snippet.length &&
      longHit.snippet.slice(longHit.matchStart, longHit.matchEnd) === 'needle',
    longHit ? JSON.stringify([longHit.matchStart, longHit.matchEnd, longHit.snippet.length]) : 'no hit',
  );

  // ---- 9. an emoji never leaves a lone surrogate in a snippet ----------------------
  const emojiNear = await run([cardSession('s-emoji', 'the ' + EMOJI + ' file has a needle inside it')], {
    scope: 'session',
    sessionId: 's-emoji',
    query: 'needle',
  });
  const emojiHit = emojiNear.hits[0];
  ok(
    'an emoji near the match comes through whole, with no lone surrogate',
    !!emojiHit && !hasLone(emojiHit.snippet) && emojiHit.snippet.includes(EMOJI),
    emojiHit ? JSON.stringify(emojiHit.snippet) : 'no hit',
  );

  // The stipulated shape: a 300-unit answer whose character at index 190 is an emoji,
  // with the match in the middle so the emoji falls inside the snippet window.
  const answer300 =
    'a'.repeat(150) + 'needle' + 'a'.repeat(34) + EMOJI + 'a'.repeat(300 - 190 - 2);
  ok(
    'the 300-unit fixture really has the emoji starting at index 190',
    answer300.length === 300 &&
      answer300.charCodeAt(190) >= 0xd800 &&
      answer300.charCodeAt(190) <= 0xdbff &&
      answer300.charCodeAt(191) >= 0xdc00 &&
      answer300.charCodeAt(191) <= 0xdfff,
    `length=${answer300.length}, codes=${answer300.charCodeAt(190).toString(16)}/${answer300.charCodeAt(191).toString(16)}`,
  );
  const boundaryA = await run([cardSession('s-emoji300', answer300)], {
    scope: 'session',
    sessionId: 's-emoji300',
    query: 'needle',
  });
  const boundaryAHit = boundaryA.hits[0];
  ok(
    'a 300-unit answer with an emoji at index 190 yields a snippet with no lone surrogate',
    !!boundaryAHit && !hasLone(boundaryAHit.snippet) && boundaryAHit.snippet.includes(EMOJI),
    boundaryAHit ? JSON.stringify(boundaryAHit.snippet) : 'no hit',
  );

  // The cut that lands exactly ON the pair: a long query makes the ±60 window 220 units,
  // so `clipText(…, 200)` truncates — and the emoji is placed on that 199/200 seam.
  const wideQuery = 'q'.repeat(100);
  const answerSeam = 'a'.repeat(200) + wideQuery + 'a'.repeat(39) + EMOJI + 'a'.repeat(60);
  const seamWindow = windowOf(answerSeam, 200, wideQuery.length);
  ok(
    'the seam fixture really puts the pair on the clip boundary',
    seamWindow.length > 200 &&
      seamWindow.charCodeAt(199) >= 0xd800 &&
      seamWindow.charCodeAt(199) <= 0xdbff &&
      seamWindow.charCodeAt(200) >= 0xdc00 &&
      seamWindow.charCodeAt(200) <= 0xdfff,
    `window=${seamWindow.length}, codes=${seamWindow.charCodeAt(199).toString(16)}/${seamWindow.charCodeAt(200).toString(16)}`,
  );
  ok(
    '  … and a naive slice(0, 200) there really does leave a lone surrogate',
    hasLone(seamWindow.slice(0, 200) + '…'),
    JSON.stringify((seamWindow.slice(0, 200) + '…').slice(196)),
  );
  const seamRes = await run([cardSession('s-seam', answerSeam)], {
    scope: 'session',
    sessionId: 's-seam',
    query: wideQuery,
  });
  const seamHit = seamRes.hits[0];
  ok(
    'a clip landing on the pair drops it whole: no lone surrogate in the snippet',
    !!seamHit && !hasLone(seamHit.snippet),
    seamHit ? JSON.stringify(seamHit.snippet.slice(194)) : 'no hit',
  );
  ok(
    '  … and the snippet is still at most 200 units, with the match inside it',
    !!seamHit &&
      seamHit.snippet.length <= 200 &&
      seamHit.snippet.slice(seamHit.matchStart, seamHit.matchEnd) === wideQuery,
    seamHit ? `${seamHit.snippet.length} unit(s), match ${seamHit.matchStart}..${seamHit.matchEnd}` : 'no hit',
  );

  // ---- 10. the two scopes ----------------------------------------------------------
  const older = sessionOf('s-old', {
    title: 'Older conversation',
    updatedAt: 1000,
    cards: [card('o1', { items: [item('user', 'q'), item('assistant', 'alpha one')] })],
  });
  const newer = sessionOf('s-new', {
    title: 'Newer conversation',
    updatedAt: 2000,
    cards: [card('n2', { items: [item('user', 'q'), item('assistant', 'alpha two')] })],
  });
  const scoped = await run([older, newer], { scope: 'session', sessionId: 's-old', query: 'alpha' });
  ok(
    "scope 'session' finds only that session's cards",
    scoped.hits.length === 1 &&
      scoped.hits.every((h) => h.sessionId === 's-old') &&
      scoped.scannedSessions === 1,
    `${scoped.hits.length} hit(s), ${scoped.scannedSessions} session(s) scanned`,
  );
  const across = await run([older, newer], { scope: 'all', query: 'alpha' });
  ok(
    "scope 'all' finds both sessions",
    across.hits.length === 2 && across.scannedSessions === 2,
    `${across.hits.length} hit(s), ${across.scannedSessions} session(s) scanned`,
  );
  ok(
    '  … newest session first (updatedAt descending)',
    across.hits.length === 2 && across.hits[0].sessionId === 's-new' && across.hits[1].sessionId === 's-old',
    across.hits.map((h) => h.sessionId).join(' → '),
  );
  ok(
    'a hit carries its session title, node id and branch',
    across.hits.length === 2 &&
      across.hits[0].sessionTitle === 'Newer conversation' &&
      across.hits[0].nodeId === 'n2' &&
      JSON.stringify(across.hits[0].branch) === JSON.stringify(['n2']),
    across.hits[0] ? `${across.hits[0].sessionTitle} / ${JSON.stringify(across.hits[0].branch)}` : 'no hit',
  );

  // ---- 11. an empty query does not scan --------------------------------------------
  const quiet = countingYield();
  const emptyQuery = await run([older, newer], { scope: 'all', query: '   ' }, quiet.fn);
  ok(
    'a whitespace-only query returns zero hits and scans nothing',
    emptyQuery.hits.length === 0 &&
      emptyQuery.total === 0 &&
      emptyQuery.scannedNodes === 0 &&
      emptyQuery.scannedSessions === 0 &&
      emptyQuery.timedOut === false &&
      quiet.calls === 0,
    `${emptyQuery.scannedNodes} card(s), ${quiet.calls} yield(s)`,
  );
  const emptyString = await run([older, newer], { scope: 'all', query: '' });
  ok(
    'a completely empty query does the same',
    emptyString.hits.length === 0 && emptyString.scannedNodes === 0 && emptyString.scannedSessions === 0,
    `${emptyString.scannedNodes} card(s)`,
  );

  // ---- 12. the scan really yields ---------------------------------------------------
  const manyCards = [];
  for (let i = 0; i < 40; i++) {
    manyCards.push(card('y' + i, { items: [item('user', 'ask ' + i), item('assistant', 'needle ' + i)] }));
  }
  const many = sessionOf('s-yield', { cards: manyCards });
  const yielding = countingYield();
  const manyRes = await run([many], { scope: 'session', sessionId: 's-yield', query: 'needle' }, yielding.fn);
  ok(
    'yieldTo is used: a 40-card scan yields at least once',
    yielding.calls > 0 && manyRes.hits.length === 40,
    `${yielding.calls} yield(s), ${manyRes.hits.length} hit(s)`,
  );

  // ---- report ----------------------------------------------------------------------
  if (problems.length) {
    for (const p of problems) {
      console.log(`  [FAIL] ${p}`);
    }
    console.log(`FAIL check-find: ${problems.length} of ${assertions} assertion(s) failed`);
    process.exit(1);
  }
  console.log(
    `check-find: ${assertions} assertions, corpus/matcher/order/cap/deadline/snippet ok.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.log(`FAIL check-find: the guard itself threw — ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
