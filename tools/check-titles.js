/*
 * check-titles — the automatic session namer's **once-only** gate, as a build-time
 * guard (`docs/agents/invariants/session-persistence.md`, the `rename_session` /
 * auto-naming section).
 *
 * A session is named by the model once and keeps that name: the conversation may
 * grow for hours afterwards, and nothing re-titles it. The two ways that can go
 * wrong are silent — a namer that runs on every turn quietly overwrites a name the
 * user has been reading, and a gate that a *failed* model call closes leaves a
 * conversation stuck with its first prompt as a title with no way back. Neither
 * shows up in a compile, so both are pinned here.
 *
 * The rule is driven through the shipped helpers (`shouldAutoTitle` /
 * `noteAutoTitle`, both exported from `src/chat/sessionTitles.ts`) rather than
 * through the provider, because the provider needs the Extension Host, a client
 * registry and a settings store to reach the same three lines. Nothing is copied:
 * `noteAutoTitle` IS the write the provider does, so a change to the rule fails
 * this guard instead of drifting away from it.
 *
 * Needs `out/` (run `npm run compile` first: it requires the compiled module).
 *
 * Run: npm run check:titles   /   node tools/check-titles.js
 */
const path = require('path');
const T = require(path.join(__dirname, '..', 'out', 'chat', 'sessionTitles.js'));

const problems = [];
const ok = (label, cond, detail) => {
  if (cond) console.log(`  [ok  ] ${label}${detail ? '  (' + detail + ')' : ''}`);
  else {
    console.log(`  [FAIL] ${label}${detail ? '  (' + detail + ')' : ''}`);
    problems.push(label);
  }
};

/** A session with `turns` named turns, each one user message (`hasNameableContent`). */
const session = (turns = 1, extra = {}) => {
  const nodes = {};
  for (let i = 0; i < turns; i++) {
    nodes['n' + i] = {
      id: 'n' + i,
      parentId: i === 0 ? null : 'n' + (i - 1),
      children: i + 1 < turns ? ['n' + (i + 1)] : [],
      title: 'n' + i,
      status: 'done',
      createdAt: i + 1,
      messages: [{ role: 'user', content: 'A prompt that can be named, turn ' + i }],
      displayItems: [],
    };
  }
  return {
    id: 'session-' + turns,
    title: 'New session',
    titleSource: 'provisional',
    createdAt: 1,
    updatedAt: 1,
    nodes,
    rootIds: turns > 0 ? ['n0'] : [],
    activeNodeId: turns > 0 ? 'n' + (turns - 1) : null,
    orphanItems: [],
    ...extra,
  };
};

console.log('check-titles: the automatic namer names a session once');

// 1. A fresh session titles once — and only while there is something to name.
{
  const empty = session(0);
  ok(
    'a session with no conversation is never titled',
    T.shouldAutoTitle(empty) === false,
    'an empty session has nothing to name',
  );
  const fresh = session(1);
  ok('a fresh session with a prompt is eligible', T.shouldAutoTitle(fresh) === true, 'never named yet');
}

// 2. After the model names it, no later turn may name it again — however much the
//    conversation grew in between. Two shapes: the gate alone, and the real state a
//    long session reaches (more turns arrived *after* the name was written).
{
  const growing = session(1);
  const at = 1_700_000_000_000;
  T.noteAutoTitle(growing, true, at);
  ok(
    'a model-written title stamps `titleAutoAt`',
    growing.titleAutoAt === at,
    'at=' + at,
  );
  ok('a session the model named never titles again', T.shouldAutoTitle(growing) === false, 'immediately after');
  for (let i = 1; i < 6; i++) {
    growing.nodes['later' + i] = {
      id: 'later' + i,
      parentId: 'n0',
      children: [],
      title: 'later' + i,
      status: 'done',
      createdAt: 100 + i,
      messages: [{ role: 'user', content: 'Another prompt ' + i }],
      displayItems: [],
    };
  }
  ok(
    'a session the model named stays named as the conversation grows',
    T.shouldAutoTitle(growing) === false,
    T.turnCount(growing) + ' nameable turns',
  );
}

// 3. A locked title is never touched, not even a session that was never auto-named.
{
  const locked = session(3, { titleLocked: true });
  ok('a locked title never titles', T.shouldAutoTitle(locked) === false, 'titleLocked');
  const lockedAfterHeuristic = session(2, { titleLocked: true });
  T.noteAutoTitle(lockedAfterHeuristic, true);
  ok(
    'a locked title stays locked once the gate is closed too',
    T.shouldAutoTitle(lockedAfterHeuristic) === false,
    'both reasons',
  );
}

// 4. The heuristic fallback leaves the gate OPEN: a name that only repeated the first
//    prompt is not a name, so the next turn retries — and its model-written title is
//    what finally closes the gate. This is the shape a missing API key makes on every
//    first turn, which is why it must not be terminal.
{
  const fallback = session(1);
  T.noteAutoTitle(fallback, false);
  ok('a heuristic fallback does not stamp `titleAutoAt`', fallback.titleAutoAt === undefined, 'gate open');
  ok('a heuristic fallback leaves the session eligible', T.shouldAutoTitle(fallback) === true, 'a later turn retries');
  fallback.nodes['retry'] = {
    id: 'retry',
    parentId: 'n0',
    children: [],
    title: 'retry',
    status: 'done',
    createdAt: 9,
    messages: [{ role: 'user', content: 'A second prompt' }],
    displayItems: [],
  };
  ok('the retry turn still sees an open gate', T.shouldAutoTitle(fallback) === true, '2 nameable turns');
  T.noteAutoTitle(fallback, true);
  ok('the retry closes it when the model answers', T.shouldAutoTitle(fallback) === false, 'named for good');
}

// The exports the provider's paths depend on. A rename would otherwise be a compile
// error only in `src/chat/ChatViewProvider.ts`, and this guard is what a reviewer runs
// to see the rule itself still exists.
ok('the growth/cooldown gates are gone', T.AUTO_TITLE_GROWTH_NODES === undefined && T.AUTO_TITLE_COOLDOWN_MS === undefined);

if (problems.length > 0) {
  console.error(`\ncheck-titles: ${problems.length} problem(s) — the automatic session title must be written once:`);
  for (const problem of problems) {
    console.error('  ' + problem);
  }
  process.exit(1);
}
console.log('check-titles: OK — a fresh session titles once, a named/locked one never again, and a heuristic fallback leaves the gate open.');
