/**
 * The matching core of the `@` file picker (docs/agents/plans/mention-syntax.md §6).
 *
 * This module is the half of the feature that can be proved by a Node guard (§11): it touches no
 * `vscode`, no `fs` and no clock, so the host owns the index and the pinyin table, the webview
 * owns the menu, and every ranking decision below is a pure function of the query and the path
 * list. The same keystroke therefore always paints the same rows, in the same order, whatever
 * else is happening in the window.
 *
 * Three engines, one order (§6.1). A metacharacter makes the query a **pattern** and the answer is
 * regex-then-glob (§6.2); anything else runs the **literal** tiers 0-4 (§6.3, with the tier 4
 * tightening of §6.4), and only where those found nothing for a row, the **pinyin** tiers 5-6
 * (§6.5). The tier is the comparator's first key (§6.6), so a lossy engine can never lift a row
 * above a precise one — that "literal first, pinyin second" band is the one thing the C# original
 * explicitly refused to unify, and it is repeated here rather than weighted.
 */

// The pinyin table and its shadow are the provider's business (§6.5, §6.8); only the types cross
// this boundary, because a value import would drag the vendored table into every consumer of the
// matcher — including the guard, which runs with no extension host at all.
import type { PinyinProvider } from './pinyin';

/** The two scopes of §4. `absolute` means "the caller resolves this against the machine". */
export type MentionScope = 'workspace' | 'absolute';

/**
 * One row of the menu. `label` is what is painted and is also the coordinate space of `matches`;
 * `detail` is the dimmed suffix; `insert` is the unquoted path text a pick writes into the
 * composer (the webview owns quoting and the trailing space, §3, §4).
 */
export interface MentionItem {
  kind: 'file' | 'dir' | 'note';
  label: string;
  detail?: string;
  insert: string;
  matches?: number[];
}

/**
 * Every character that switches the query to the pattern engine (§6.1). `.` is deliberately
 * absent: `runtime.ts` typed as a query has to stay a literal string rather than become a regex
 * whose dot matches anything.
 */
const META_CHAR = /[?*[\]{}()|^$+\\]/;

/**
 * The CJK ranges a pinyin shadow can exist for (§6.5). The same test decides a character's
 * coverage weight (§6.6: CJK weighs 3, everything else 1), because a Chinese character carries a
 * whole syllable of information and a Latin one carries a letter.
 */
const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** The characters a new word starts after (§6.3: `_`, `-`, `.`, space), plus `/` for a path. */
const WORD_SEPARATOR = /[\s_\-./]/;

/* ------------------------------------------------------------------------------------------- *
 * §4 — one classifier, in the host
 * ------------------------------------------------------------------------------------------- */

/**
 * Classify a raw composer query into a scope plus the path text the caller resolves (§4).
 *
 * The query is returned **exactly as typed**: `~` expansion and the Git-Bash `\/d\/repos\/x` to
 * `D:\repos\x` mapping live in the host, so there is one implementation of each and it is the same
 * one `resolvePath` uses. Nothing here interprets a metacharacter — path mode is a directory
 * listing, always (§4, last line), so `src/[` in absolute mode is a directory name and not a
 * half-typed character class.
 *
 * `.` is matched as a *prefix*, which is what §4's table row "`.` or `..`" has to mean: D4 states
 * that `./` and `../` enter absolute mode, and a rule that accepted only the literal `.` and `..`
 * would leave both in workspace mode. The consequence is accepted: `.gitignore` is a path query
 * too, and it resolves against the root, where the listing still finds it.
 */
export function classifyMentionQuery(query: string): { scope: MentionScope; path: string } {
  if (/^[/~\\]/.test(query) || /^[A-Za-z]:/.test(query) || query.startsWith('.')) {
    return { scope: 'absolute', path: query };
  }
  return { scope: 'workspace', path: query };
}

/**
 * Split a typed absolute path into the **directory to read** and the **fragment still being
 * typed** (§4). Everything up to the last separator is a directory the user has already
 * committed to; only the fragment is matched, and only against that directory's entries.
 *
 * `~`, a bare `C:` and the empty no-folder query name a directory and have no fragment. The
 * separator appended to a bare drive letter is `\` and not the host's: a drive letter is a
 * Windows concept, and on any other platform the string is a file name and `resolvePath` is
 * free to treat it as one.
 */
export function splitTypedPath(typed: string): { dir: string; fragment: string } {
  const at = Math.max(typed.lastIndexOf('/'), typed.lastIndexOf('\\'));
  if (at < 0) {
    return { dir: /^[A-Za-z]:$/.test(typed) ? typed + '\\' : typed, fragment: '' };
  }
  return { dir: typed.slice(0, at + 1), fragment: typed.slice(at + 1) };
}

/**
 * The first segment of a fragment. A fragment only carries more than one segment when the
 * ancestor walk climbed past a directory that does not exist yet (`~/proj/sub/di` while
 * `sub` is still being typed), and then the only part that can name a sibling of the listed
 * directory is its first segment.
 */
export function firstSegment(fragment: string): string {
  const cut = fragment.search(/[\\/]/);
  return cut < 0 ? fragment : fragment.slice(0, cut);
}

/* ------------------------------------------------------------------------------------------- *
 * §6 — ranking
 * ------------------------------------------------------------------------------------------- */

/** One scored candidate. `hits` are indices into `path`, which is also the row's `label`. */
interface Candidate {
  path: string;
  /** Position in the caller's array, the comparator's last key (§6.6). */
  ordinal: number;
  tier: number;
  coverage: number;
  score: number;
  hits?: number[];
}

/** The result of one literal tier: where it landed, how much it covered and what it scored. */
interface LiteralHit {
  tier: number;
  coverage: number;
  score: number;
  hits: number[];
}

/** Where a pattern landed: `pos` orders the rows, `start`/`length` are label coordinates. */
interface PatternHit {
  pos: number;
  start: number;
  length: number;
}

/**
 * Rank workspace paths against a query (§6).
 *
 * `paths` are workspace-relative with forward slashes, which is what `rg --files` prints (§7), so
 * a candidate's path *is* the row's label and every match index is already in the right
 * coordinate space.
 *
 * `max` bounds the scan rather than the answer: the caller passes the index size, and a 50,000
 * path index must not be walked a second time to trim a list of 50. The answer is capped at
 * `limit` after sorting — the cap is never allowed to decide *which* rows are considered, only
 * how many are shown.
 *
 * An empty query is not ranked here at all: §6.1 gives it to the recent list (`recentMentions`),
 * and a matcher that invented an interpretation for `''` would only disagree with that list.
 */
export function rankMentions(
  query: string,
  paths: string[],
  opts: { limit: number; pinyin?: PinyinProvider; max?: number },
): MentionItem[] {
  const limit = Math.max(0, Math.floor(opts.limit));
  if (!query || limit === 0) {
    return [];
  }
  const wanted = opts.max === undefined ? paths.length : Math.max(0, Math.floor(opts.max));
  const scanned = Math.min(paths.length, wanted);

  // §6.3: the match surface is the FILE NAME, never the directory it sits in. A query that carries
  // a directory is routed to the path answer instead of here (`mentionIndex.query`), because a
  // prefix is a place to look, not a name to match.
  const needle = query;

  // §6.1: one engine choice per query, made from the query text alone.
  if (META_CHAR.test(needle)) {
    const matcher = compilePattern(needle);
    // Only when neither a regex nor a glob can be compiled does the query fall back to the
    // literal engine (§6.2 step 3) — a half-typed `[` must not empty the menu.
    if (matcher) {
      return patternRows(matcher, paths, scanned, limit);
    }
  }
  return literalRows(needle, paths, scanned, limit, opts.pinyin);
}


/**
 * The rows shown for an EMPTY query (§6.1, §8): this session's recent picks that still exist,
 * in the order they were picked, then the index in its own order.
 *
 * "Path order" is taken to be the index's order rather than a fresh `sort()`. The index is
 * `rg --files` output, which is already path order, and sorting it again here would be a second
 * notion of order that can disagree with the walk (and cost a 50,000 element sort per keystroke).
 */
export function recentMentions(recent: string[], paths: string[], limit: number): MentionItem[] {
  const out: MentionItem[] = [];
  const cap = Math.max(0, Math.floor(limit));
  if (cap === 0) {
    return out;
  }
  const existing = new Set(paths);
  const taken = new Set<string>();
  for (const path of recent) {
    if (out.length >= cap) return out;
    // A recent that the workspace no longer has is dropped, not shown as a stale row.
    if (taken.has(path) || !existing.has(path)) continue;
    taken.add(path);
    out.push(mentionItem(path));
  }
  for (const path of paths) {
    if (out.length >= cap) return out;
    if (taken.has(path)) continue;
    taken.add(path);
    out.push(mentionItem(path));
  }
  return out;
}

/* ------------------------------------------------------------------------------------------- *
 * §6.2 — pattern mode
 * ------------------------------------------------------------------------------------------- */

/** A compiled pattern: the label hit for a path, or `null` when the path is not a match. */
type PatternMatcher = (path: string) => PatternHit | null;

/**
 * Compile a metacharacter query into a matcher over the **file name** (§6.2):
 *
 * 1. the query as a regex, unanchored, against the file name;
 * 2. if that throws (a half-typed `src/[`), the query as a ripgrep `--glob`;
 * 3. if that throws as well, `null` — and the caller falls back to the literal engine.
 *
 * The regex branch comes first by design, not by accident: a user who types `^.*\.ts$` means a
 * regex, and a query that happens to be both a valid regex and a valid glob is read as the
 * regex. Ordering inside this mode is deterministic and unscored (§6.2): earliest match position,
 * then path length, then ordinal.
 *
 * The one query that skips the regex attempt is the one starting with `!`. `!*.ts` is a *valid*
 * regex (`!` repeated zero times, then any character, then `ts`), so the frozen step order would
 * swallow the negation §6.2 promises and quietly match the wrong files; `!` is ripgrep's exclusion
 * sigil, and no file-name query that opens with one means "a literal exclamation mark". A
 * `!` query is therefore read as a glob first, and only falls back to the literal engine if even
 * the glob cannot be compiled.
 */
function compilePattern(query: string): PatternMatcher | null {
  // §6.3's case rule in pattern form: a query with a capital in it is matched case-sensitively,
  // which is the same claim "this capital is in the name" said to the regex engine.
  const flags = hasUpper(query) ? '' : 'i';
  if (!query.startsWith('!')) {
    try {
      const re = new RegExp(query, flags);
      return (path: string): PatternHit | null => {
        const name = basenameOf(path);
        const match = re.exec(name);
        if (!match) return null;
        // The label is the name, so the hit needs no translation (§7).
        return { pos: match.index, start: match.index, length: match[0].length };
      };
    } catch {
      // Not a regex: read it as a glob (§6.2 step 2).
    }
  }
  return compileGlob(query, flags);
}

/**
 * Compile a ripgrep `--glob` query (§6.2 step 2), anchored over the file name.
 *
 * `*` never crosses a separator but a name has none, `?` is one character, `[...]` and `{a,b}`
 * work, and a leading `!` negates. This is deliberately not `globToRegex` from
 * `src/tools/index.ts`: that one is `search_files`' semantics (only `*` and `**`) and widening it
 * would silently widen what the tool's `glob` argument means.
 *
 * A negated glob has nothing to point at, so it accepts the paths whose name does *not* match and
 * highlights none of them; its rows order by path length and ordinal, which is exactly what the
 * comparator's remaining keys do.
 */
function compileGlob(query: string, flags: string): PatternMatcher | null {
  let source = query;
  let negate = false;
  if (source.startsWith('!')) {
    negate = true;
    source = source.slice(1);
  }
  if (!source) return null;
  let body: string;
  try {
    body = translateGlob(source);
  } catch {
    return null; // an unterminated `[` or `{`: no glob either (§6.2 step 3)
  }
  let re: RegExp;
  try {
    re = new RegExp('^' + body + '$', flags);
  } catch {
    return null;
  }
  if (negate) {
    return (path: string): PatternHit | null => (re.test(basenameOf(path)) ? null : { pos: 0, start: 0, length: 0 });
  }
  return (path: string): PatternHit | null => {
    const name = basenameOf(path);
    const match = re.exec(name);
    if (!match) return null;
    // The ordering key stays relative to the name the glob was tested against, so a deep path is
    // not rewarded for its directory prefix; the label is that same name (§7).
    return { pos: match.index, start: match.index, length: match[0].length };
  };
}

/** Translate a glob into an anchored regex source, or throw when the glob cannot be read. */
function translateGlob(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '*') {
      if (src[i + 1] === '*') {
        // `**/` is zero or more directory segments, so `src/**/x` also matches `src/x`;
        // a bare `**` spans everything, `/` included (§6.2).
        if (src[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 3;
          continue;
        }
        out += '.*';
        i += 2;
        continue;
      }
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if (ch === '[') {
      const close = classEnd(src, i + 1);
      if (close < 0) throw new Error('unterminated character class');
      let body = src.slice(i + 1, close);
      if (body.startsWith('!')) body = '^' + body.slice(1); // glob's in-class negation
      out += '[' + body.replace(/\\/g, '\\\\') + ']';
      i = close + 1;
      continue;
    }
    if (ch === '{') {
      const close = braceEnd(src, i);
      if (close < 0) throw new Error('unterminated alternation');
      const alts = splitTopLevel(src.slice(i + 1, close));
      out += '(?:' + alts.map(translateGlob).join('|') + ')';
      i = close + 1;
      continue;
    }
    out += /[\\^$.|+()[\]{}*?]/.test(ch) ? '\\' + ch : ch;
    i += 1;
  }
  return out;
}

/** The index of the `]` closing the class opened before `from`, or -1. */
function classEnd(src: string, from: number): number {
  let i = from;
  if (src[i] === '!' || src[i] === '^') i += 1;
  // A `]` in the first position is a literal, in globs as in regex.
  if (src[i] === ']') i += 1;
  for (; i < src.length; i += 1) {
    if (src[i] === '\\') {
      i += 1;
      continue;
    }
    if (src[i] === ']') return i;
  }
  return -1;
}

/** The index of the `}` matching the `{` at `open`, or -1. Braces may nest. */
function braceEnd(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '\\') {
      i += 1;
      continue;
    }
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split `a,b` on the commas that are not inside a nested `{}`; a lone `{a}` stays one branch. */
function splitTopLevel(src: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(src.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(src.slice(from));
  return parts;
}

/** Pattern rows: earliest match position, then path length, then ordinal (§6.2). */
function patternRows(
  matcher: PatternMatcher,
  paths: string[],
  scanned: number,
  limit: number,
): MentionItem[] {
  const rows: { path: string; ordinal: number; hit: PatternHit }[] = [];
  for (let i = 0; i < scanned; i += 1) {
    const path = paths[i];
    const hit = matcher(path);
    if (hit) rows.push({ path, ordinal: i, hit });
  }
  rows.sort(
    (a, b) =>
      a.hit.pos - b.hit.pos ||
      a.path.length - b.path.length ||
      a.ordinal - b.ordinal,
  );
  return rows
    .slice(0, limit)
    .map((row) => mentionItem(row.path, indicesIn(row.hit.start, row.hit.length)));
}

/* ------------------------------------------------------------------------------------------- *
 * §6.3, §6.4 — the literal engine
 * ------------------------------------------------------------------------------------------- */

/** Literal rows: tiers 0-4, then pinyin 5-6 only where no literal tier matched (§6.5). */
function literalRows(
  query: string,
  paths: string[],
  scanned: number,
  limit: number,
  pinyin: PinyinProvider | undefined,
): MentionItem[] {
  const needle = query.toLowerCase();
  const rows: Candidate[] = [];
  for (let i = 0; i < scanned; i += 1) {
    const path = paths[i];
    // §6.3: one match surface, the file name, for every engine — and it is also the row's label,
    // so a hit needs no translation on its way to the highlight.
    const name = basenameOf(path);
    const literal = literalMatch(name, query, needle);
    if (literal) {
      rows.push({ path, ordinal: i, ...literal });
      continue;
    }
    // §6.5: pinyin is a fallback band, never a competitor. A path the literal engine already
    // found is not asked about again — "a precise pinyin hit never outranks a literal one".
    // The query is folded here: a Chinese character has no case, so a capital is not a claim
    // about the name the way it is for Latin text (§6.3).
    if (pinyin) {
      const fallback = pinyinCandidate(path, name, i, needle, pinyin);
      if (fallback) rows.push(fallback);
    }
  }
  rows.sort(compareCandidates);
  return rows.slice(0, limit).map((row) => mentionItem(row.path, row.hits));
}

/**
 * The literal tiers of §6.3, most precise first, on one file name.
 *
 * The candidate text is the **base name** and nothing else: the directory never takes part in a
 * match, so `chat` is not a reason to offer every file under `src/chat/`. The indices travel back
 * untranslated because the row's label IS this string (§7).
 *
 * **Case is a preference with teeth** (§6.3): an uppercase query character may only land on an
 * uppercase name character, while a lowercase one is free to land anywhere. Typing `Pcss` is
 * therefore a claim about `PlayerCharacterSpawnerService.cs` (`P`, `C`, `S`, `S` are its humps)
 * and not about `playercharacter-action-service.cs`, and typing `pcss` still finds both. Among the
 * rows that survive, the tier 4 `+2` and the hump tiers keep the case-exact hits ahead.
 *
 * `len` in a score is the length of the name, so the score keeps meaning "how tightly this row
 * matched" instead of restating the comparator's path-length key (§6.6 key 4 already decides
 * between two equally good matches).
 */
function literalMatch(name: string, query: string, needle: string): LiteralHit | null {
  const lower = name.toLowerCase();
  // Tier 0 — the query IS the file name, case rule included.
  if (lower === needle && caseOk(name, 0, query)) {
    const local = indicesIn(0, name.length);
    return { tier: 0, coverage: coverageIn(name, local), score: 1000 - name.length, hits: local };
  }
  // Tier 1 — the file name starts with the query.
  if (lower.startsWith(needle) && caseOk(name, 0, query)) {
    const local = indicesIn(0, needle.length);
    return { tier: 1, coverage: coverageIn(name, local), score: 900 - name.length, hits: local };
  }
  // Tiers 2 and 3 — the name's humps: `IHudModuleProvider` reads `IHMP`, so `ihmp` finds it.
  const humps = humpIndices(name);
  let humpsText = '';
  for (const index of humps) humpsText += name[index];
  const want = query.slice(0, Math.min(query.length, humpsText.length));
  if (humpsText.toLowerCase() === needle && caseOk(humpsText, 0, query)) {
    return { tier: 2, coverage: coverageIn(name, humps), score: 800 - name.length, hits: humps };
  }
  if (humpsText.toLowerCase().startsWith(needle) && caseOk(humpsText, 0, want)) {
    const local = humps.slice(0, needle.length);
    return { tier: 3, coverage: coverageIn(name, local), score: 700 - name.length, hits: local };
  }
  // Tier 4 — a general subsequence of the file name, under the §6.4 tightening and the case rule.
  const run = subsequence(name, query, needle);
  if (!run) return null;
  const first = run.indices[0];
  const last = run.indices[run.indices.length - 1];
  const holes = last - first + 1 - needle.length;
  const spanLength = holes + needle.length;
  return {
    tier: 4,
    coverage: coverageIn(name, run.indices),
    score: 10 * run.points - 3 * holes - spanLength,
    hits: run.indices,
  };
}

/**
 * The case rule (§6.3): every UPPERCASE character of `query` must sit on an uppercase character of
 * `text`, starting at `from`. A lowercase query character is unconstrained, so the rule only ever
 * narrows what a user who typed capitals is asking for, and it can never hide a file from a
 * lowercase query.
 */
function caseOk(text: string, from: number, query: string): boolean {
  for (let i = 0; i < query.length; i += 1) {
    if (!isUpperChar(query[i])) continue;
    const target = text[from + i];
    if (target === undefined || !isUpperChar(target)) return false;
  }
  return true;
}

/** An uppercase letter by Unicode's own answer, so `É` and `Ä` count without a table. */
function isUpperChar(ch: string): boolean {
  return ch.toUpperCase() === ch && ch.toLowerCase() !== ch;
}

/** `true` when any character of `text` is an uppercase letter (§6.3's case rule). */
function hasUpper(text: string): boolean {
  for (const ch of text) {
    if (isUpperChar(ch)) return true;
  }
  return false;
}

/** A lowercase letter, by the same test — a CJK character or a digit is neither. */
function isLowerChar(ch: string): boolean {
  return ch.toLowerCase() === ch && ch.toUpperCase() !== ch;
}

/**
 * Tier 4's solver (§6.3, §6.4), returning the matched indices and their point total.
 *
 * The search is a memoised best-path walk rather than a greedy scan because the tightening makes
 * the greedy answer wrong in both directions: a character that is legal in one landing spot can
 * make the next one illegal, and two legal landings score differently (`+6` at a hump, `+4`
 * contiguous, `+1` loose, `+2` more for an exact-case hit). `f(qi, prev)` is the best remaining
 * value from query character `qi` given the previous hit at `prev`; the key does not need the
 * first index, so every starting position shares one table.
 *
 * The value carried is `10·points − 4·lastIndex`, which folds the plan's
 * `10·hitScore − 3·holes − len` into something a prefix search can maximise: with
 * `len = holes + queryLength`, the expression becomes `10·points − 4·holes − queryLength`, so
 * only `−4·lastIndex` is charged at the end and `+4·firstIndex − 4 + 3·queryLength` is added once
 * the winner is known.
 */
function subsequence(
  path: string,
  query: string,
  needle: string,
): { indices: number[]; points: number } | null {
  const n = path.length;
  const q = needle.length;
  if (q === 0 || q > n) return null;

  const starts = wordStarts(path);
  const nextWord = nextWordAfter(starts);
  // Positions of each lowercased character, ascending: the only places a query character can
  // land, so the walk never visits a position that cannot match.
  const spots = new Map<string, number[]>();
  for (let i = 0; i < n; i += 1) {
    const key = path[i].toLowerCase();
    const list = spots.get(key);
    if (list) list.push(i);
    else spots.set(key, [i]);
  }

  const memo = new Map<number, number>();
  const score = (qi: number, at: number, prev: number): number => {
    // §6.3 tier 4 points: a hump start beats a contiguous hit, which beats a loose one, and an
    // exact-case character adds two more. A hump start that is also contiguous stays a hump.
    const base = starts[at] ? 6 : at === prev + 1 ? 4 : 1;
    return 10 * (base + (path[at] === query[qi] ? 2 : 0));
  };
  /** The landing spots legal for query character `qi`, given the previous hit at `prev`. */
  const landings = (qi: number, prev: number): number[] => {
    const all = spots.get(needle[qi]) ?? [];
    // §6.3's case rule: an uppercase query character may only land on an uppercase name character,
    // so `Pcss` is a claim about a camel-cased name and `pcss` is not. Applied before every other
    // rule, because it constrains the whole landing set.
    const wantUpper = isUpperChar(query[qi]);
    const out: number[] = [];
    for (const at of all) {
      if (at <= prev) continue;
      if (wantUpper && !isUpperChar(path[at])) continue;
      if (qi === 0) {
        out.push(at); // the FIRST query character may land anywhere (§6.4)
        continue;
      }
      if (starts[at]) {
        out.push(at); // (1) a hump start
        continue;
      }
      if (at === prev + 1) {
        out.push(at); // (2) contiguous with the previous hit
        continue;
      }
      // (3) anywhere inside the same word, when the previous hit was itself that word's start.
      // Without this third spot `cd` matched `SelectWorld` (Sele**c**t + Worl**d**) and the
      // highlight landed on the key while the Chinese name stayed dark — the bug §6.4 records.
      if (starts[prev] && at < nextWord[prev]) out.push(at);
    }
    return out;
  };

  const best = (qi: number, prev: number): number => {
    if (qi === q) return -4 * prev; // the run's last index, which `holes` charges for
    const key = qi * (n + 1) + (prev + 1);
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let value = -Infinity;
    for (const at of landings(qi, prev)) {
      const candidate = score(qi, at, prev) + best(qi + 1, at);
      if (candidate > value) value = candidate;
    }
    memo.set(key, value);
    return value;
  };

  let first = -1;
  let top = -Infinity;
  for (const at of landings(0, -1)) {
    const value = score(0, at, -1) + best(1, at) + 4 * at;
    if (value > top) {
      top = value;
      first = at;
    }
  }
  if (first < 0) return null;

  // Rebuild the winning path by re-reading the memo, so `matches` and the score agree.
  const indices = [first];
  let prev = first;
  for (let qi = 1; qi < q; qi += 1) {
    const want = best(qi, prev);
    let chosen = -1;
    for (const at of landings(qi, prev)) {
      if (score(qi, at, prev) + best(qi + 1, at) === want) {
        chosen = at;
        break;
      }
    }
    if (chosen < 0) return null; // unreachable: `want` was produced by one of these landings
    indices.push(chosen);
    prev = chosen;
  }

  let points = 0;
  for (let k = 0; k < indices.length; k += 1) {
    points += score(k, indices[k], k === 0 ? -1 : indices[k - 1]) / 10;
  }
  return { indices, points };
}

/** `true` at every index where a word starts in `s` (§6.3's hump rule). */
function wordStarts(s: string): boolean[] {
  const out = new Array<boolean>(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = isWordStart(s, i);
  return out;
}

/**
 * The start of a word inside a name (§6.3): the string's own start, a character after
 * `_ - . space /`, a capital that opens a camelCase word, and the capital that closes an
 * abbreviation run (`IHud` humps at `I` and `H`, so `IHMP` is `IHudModuleProvider`'s hump string).
 */
function isWordStart(s: string, i: number): boolean {
  if (i === 0) return true;
  const prev = s[i - 1];
  const ch = s[i];
  if (WORD_SEPARATOR.test(prev)) return true;
  if (!isUpper(ch)) return false;
  if (!isUpper(prev)) return true; // lower or digit before a capital: a camelCase word
  const next = i + 1 < s.length ? s[i + 1] : undefined;
  return next !== undefined && !isUpper(next); // last capital of an abbreviation run
}

/** A capital for the hump rule; CJK and digits are not capitals (their case maps to themselves). */
function isUpper(ch: string): boolean {
  return ch !== ch.toLowerCase() && ch === ch.toUpperCase();
}

/** The indices a word starts at, in order — the "hump string" of a name. */
function humpIndices(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 1) {
    if (isWordStart(s, i)) out.push(i);
  }
  return out;
}

/** For each index, the next index where a word starts, or `s.length` (§6.4's third spot). */
function nextWordAfter(starts: boolean[]): Int32Array {
  const n = starts.length;
  const next = new Int32Array(n + 1);
  next[n] = n;
  for (let i = n - 1; i >= 0; i -= 1) {
    next[i] = i + 1 < n && starts[i + 1] ? i + 1 : next[i + 1];
  }
  return next;
}

/* ------------------------------------------------------------------------------------------- *
 * §6.5 — pinyin, tiers 5 and 6
 * ------------------------------------------------------------------------------------------- */

/**
 * The pinyin fallback for one path (§6.5), or `null` when its file name cannot be read as pinyin.
 *
 * **The file name is the whole candidate.** §6.3's rule is that directories never take part in a
 * match, and pinyin is not an exception: `存档系统/读取面板/主界面.cs` is asked about as
 * `主界面.cs`, so `cundang` — which names the directory — matches nothing, and `zhujiemian`
 * matches.
 *
 * `query` arrives already folded (§6.3's case rule is about Latin capitals, and a Chinese character
 * has none), so it is used as-is.
 *
 * Tier 5 means the run starts at the name's first character, tier 6 that it starts inside;
 * `runStart` is a character offset in the name, so the plan's `100 − start − len` and
 * `60 − start − len` keep their meaning.
 */
function pinyinCandidate(
  path: string,
  name: string,
  ordinal: number,
  query: string,
  provider: PinyinProvider,
): Candidate | null {
  const shadow = provider.shadow(name);
  if (!shadow) return null; // no CJK in the name: it can never pinyin-match (§6.5)
  const hit = provider.match(shadow, query);
  if (!hit) return null;
  // The hit travels in the name's own coordinates: `matches` are whole-character indices (§6.5
  // never paints a letter inside a syllable) and the run starts at the first of them.
  const chars = hit.matches
    .filter((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < name.length)
    .filter((n, i, all) => all.indexOf(n) === i)
    .sort((a, b) => a - b);
  if (!chars.length) return null;
  const runStart = chars[0];
  // Tier 5 is a run that starts at the name's first character, not merely at its first CJK one:
  // an ASCII prefix (`UI缩放`) is the literal engine's business (§6.5), so a pinyin hit behind it
  // is an interior hit and ranks as one.
  const tier = runStart === 0 ? 5 : 6;
  return {
    path,
    ordinal,
    tier,
    coverage: coverageIn(name, chars),
    score: (tier === 5 ? 100 : 60) - runStart - name.length,
    // The label is the name, so the whole-character indices are already in its coordinates.
    hits: chars,
  };
}

/* ------------------------------------------------------------------------------------------- *
 * §6.6 — one comparator, and the measurements it reads
 * ------------------------------------------------------------------------------------------- */

/**
 * The comparator of §6.6, all five keys and in this order:
 * `tier asc → coverage desc → score desc → path length asc → path ordinal asc`.
 *
 * Tier first is the whole point: the scores of different tiers are never comparable, and the C#
 * project's coverage-first experiment (which put a tier 4 `Core.TestLog` above a tier 2
 * `Map.SelectLayer` for `sl`) is why coverage is a within-tier key and not the first one.
 */
function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    a.tier - b.tier ||
    b.coverage - a.coverage ||
    b.score - a.score ||
    a.path.length - b.path.length ||
    a.ordinal - b.ordinal
  );
}

/**
 * Coverage of one match (§6.6): weighted matched characters over weighted characters of the
 * **matched segment**, clamped to 1.
 *
 * The C# original divided by its whole candidate, which for a path punishes a filename hit twice
 * (path length is already comparator key 4); the segment is therefore the denominator. CJK weighs
 * 3 and everything else 1, because one Chinese character carries a syllable where a Latin one
 * carries a letter.
 */
function coverageIn(segment: string, hits: number[]): number {
  if (!segment.length) return 0;
  let matched = 0;
  const counted = new Set<number>();
  for (const index of hits) {
    if (index < 0 || index >= segment.length || counted.has(index)) continue;
    counted.add(index);
    matched += charWeight(segment[index]);
  }
  let total = 0;
  for (let i = 0; i < segment.length; i += 1) total += charWeight(segment[i]);
  return total === 0 ? 0 : Math.min(1, matched / total);
}

/* ------------------------------------------------------------------------------------------- *
 * shared helpers
 * ------------------------------------------------------------------------------------------- */

/** The last path segment: `src/chat/runtime.ts` → `runtime.ts`. */
function basenameOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? path : path.slice(cut + 1);
}

/** `[start, start+1, …]` of `length` entries — the highlight indices of a contiguous match. */
function indicesIn(start: number, length: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < length; i += 1) out.push(start + i);
  return out;
}

/** Every index moved by `delta`, so a basename hit can be painted on the path's label. */
function shift(indices: number[], delta: number): number[] {
  return delta === 0 ? indices.slice() : indices.map((index) => index + delta);
}

/** The coverage weight of one character (§6.6). */
function charWeight(ch: string): number {
  return CJK_CHAR.test(ch) ? 3 : 1;
}

/**
 * A workspace row (§7): the **file name** is the label, and the containing directory is the dimmed
 * detail on its right (omitted at the root, where there is nothing to add).
 *
 * The name is the label because it is exactly the string the matcher was given, so `matches` needs
 * no translation and the highlight lands on the characters the query actually hit. The directory is
 * the second column, shortened from its own left by the webview (`fitPathText`), so the segments
 * nearest the file survive a narrow menu.
 *
 * `insert` is the relative path, unquoted — the webview wraps it when it needs to (§3, §4).
 */
function mentionItem(path: string, matches?: number[]): MentionItem {
  const isDir = path.endsWith('/');
  const bare = isDir ? path.slice(0, -1) : path;
  const cut = bare.lastIndexOf('/');
  const name = bare.slice(cut + 1);
  const item: MentionItem = {
    kind: isDir ? 'dir' : 'file',
    label: isDir ? `${name}/` : name,
    insert: path,
  };
  if (cut > 0) item.detail = bare.slice(0, cut);
  if (matches && matches.length) item.matches = matches;
  return item;
}
