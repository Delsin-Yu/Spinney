/**
 * pinyin.ts — the pinyin engine behind the `@` picker: the last matching band, and the only
 * one that can find a Chinese file name typed on a Latin keyboard.
 *
 * The rules are `docs/agents/plans/mention-syntax.md` §6.5 and §6.8, and the shape of what
 * this module returns is fixed by that contract:
 *
 *   - a **shadow** is built once per path segment and covers that segment's CJK characters
 *     **only**. ASCII is the literal engine's business (`ui` already finds `UI缩放` at a
 *     literal tier), so it never enters the shadow — which is why `charOf` indexes the
 *     *original* segment and skips whatever it does not cover;
 *   - a **query** is matched as a contiguous run of whole syllables, in both spellings:
 *     `initials` (one character per syllable) and `full` (the readings run together). No
 *     letter inside a syllable matches on its own, and no run may begin or end in the
 *     middle of one;
 *   - a hit is **tier 5** when the run starts at the segment's first CJK character and
 *     **tier 6** when it starts anywhere inside. Two tiers, not a weight, because "literal
 *     first, pinyin second" has to be a hard band: a precise pinyin hit never outranks a
 *     literal one, and the picker's comparator reads the tier before it reads the score.
 *
 * Two readings are deliberately absent. The table holds **one canonical reading per
 * character** — the first one upstream writes — with tones dropped and ü written as `v`,
 * which is the spelling a Chinese IME produces. Fuzzy sounds (`zh`↔`z`, `n`↔`l`) and the
 * alternatives of a polyphone are phase 2 (§6.7): a command name is short and familiar,
 * while a file path is long, and every extra reading is one more way for an unrelated file
 * to match. A character missing from the table simply never pinyin-matches; it still
 * matches literally.
 *
 * The table is host-side data under `media/vendor/pinyin/` (with `PROVENANCE.md` beside
 * it), read with `fs` on the first `shadow()` call and kept for the life of the extension
 * host — off the activation path, and off every query but the first. Nothing here is
 * user-visible, so this file carries no localized string: it is host logic, not UI.
 */
import * as fs from 'fs';
import * as path from 'path';

/**
 * What a segment's CJK characters look like from the pinyin side. Built once per segment by
 * {@link PinyinProvider.shadow} and then matched against many queries.
 */
export interface PinyinShadow {
  /** Concatenated tone-less readings of the CJK characters, no separators, lowercase. */
  full: string;
  /** First letter of each reading, one character per CJK character. */
  initials: string;
  /** `sylStart[k]` = offset of syllable `k` inside `full`. */
  sylStart: number[];
  /** `charOf[k]` = character index of syllable `k` inside the ORIGINAL segment. */
  charOf: number[];
}

/** One pinyin match inside a segment, in the coordinates the caller paints in. */
export interface PinyinHit {
  /** 5 = the run starts at the segment's first CJK char, 6 = anywhere inside. */
  tier: 5 | 6;
  /** `(tier === 5 ? 100 : 60) - syllableIndex - segment.length`. */
  score: number;
  /** The syllable index the run starts at. */
  start: number;
  /** Whole-character indices in the ORIGINAL segment, ascending. */
  matches: number[];
}

/** The two calls the picker uses; see the module comment for the rules behind them. */
export interface PinyinProvider {
  /** `null` when the segment has no CJK at all — nothing pinyin could ever match. */
  shadow(segment: string): PinyinShadow | null;
  /** `null` when the query does not spell the start of a run of whole syllables. */
  match(shadow: PinyinShadow, query: string): PinyinHit | null;
}

/**
 * The vendored table. This file compiles to `out/chat/`, so two levels up is the folder
 * `package.json` sits in — and `media/vendor/pinyin/` is inside it, in the `.vsix` as much
 * as in a checkout. The resolution is `EXTENSION_ROOT`'s in `src/tools/searchFiles.ts`,
 * deliberately: one rule for "where does a vendored file live".
 */
const TABLE_PATH = path.resolve(__dirname, '..', '..', 'media', 'vendor', 'pinyin', 'pinyin.json');

/**
 * What counts as CJK, and therefore what may contribute a syllable. The Unicode property is
 * the definition of "this segment has Chinese in it"; the *table* is the narrower three-range
 * set (Extension A, the Unified Ideographs, the Compatibility Ideographs). A Han character
 * outside the table contributes no reading and then behaves exactly like the ASCII of
 * `UI缩放`: not part of the shadow, so it neither breaks a run nor joins one.
 */
const CJK = /\p{Script=Han}/u;

/**
 * The only queries matched: non-empty, lowercase, `[a-z]`. Callers normalise first with
 * {@link normalizeQuery}; anything else here is a caller bug, and guessing at it (a stray
 * space, an uppercase letter, a `ü` that was never mapped) would silently produce a match
 * the picker's highlight could not explain.
 */
const QUERY = /^[a-z]+$/;

/**
 * The vendored file's shape. Two **parallel strings** rather than one JSON object per
 * character: 26 713 entries cost roughly ten bytes each as `"档":"dang"`, and about seven as
 * `档` plus `dang,` here — which is the difference between "hundreds of kilobytes for
 * nothing" in every `.vsix` and a table that is smaller than one of the grammar files.
 * `chars` is code-point ordered, so the file is deterministic and reviews as a diff.
 */
interface PinyinTableFile {
  format: string;
  source: string;
  /** What separates the readings in `readings`; only `readings` uses it. */
  separator: string;
  count: number;
  chars: string;
  readings: string;
}

/**
 * The segment length each shadow was built from. The score needs `segment.length`, and the
 * contracted shape carries no field for it — so the value rides **beside** the object
 * instead of on it. That keeps a shadow literal written by hand (`{ full, initials,
 * sylStart, charOf }`, the shape §6.5 prints) valid, while a shadow that this module built
 * scores against the segment it really saw.
 */
const shadowSegmentLength = new WeakMap<PinyinShadow, number>();

/**
 * The parsed table, loaded on the first `shadow()` call and kept forever: the host's own
 * copy of a file that cannot change until the host restarts, so there is nothing to
 * invalidate and no mtime to stat.
 */
let table: Map<string, string> | null = null;

/**
 * Read `media/vendor/pinyin/pinyin.json` into a character → reading map.
 *
 * A missing, truncated or unparsable table leaves the map **empty** rather than throwing:
 * pinyin is the picker's last band, and a picker that cannot spell pinyin — because the
 * `.vsix` was unpacked without the data, say — must still list and match files by path.
 * The empty map is cached too, so the failure is paid once, not once per segment.
 */
function readingTable(): Map<string, string> {
  if (table) return table;
  const map = new Map<string, string>();
  table = map;
  try {
    const file = JSON.parse(fs.readFileSync(TABLE_PATH, 'utf8')) as PinyinTableFile;
    const readings = file.readings.split(file.separator);
    let i = 0;
    // Code points, not `chars[i]`: the table is BMP-only today and this loop must not start
    // reading half a surrogate pair on the day it is not.
    for (const char of file.chars) map.set(char, readings[i++]);
  } catch {
    // Deliberately silent — see the doc comment. A log line here would fire from inside a
    // keystroke handler for every user whose install lost the data file.
  }
  return map;
}

/**
 * Build one segment's shadow: walk its code points, take the reading of each character the
 * table knows, and record both spellings plus where each syllable sits.
 *
 * `charOf` holds **UTF-16** offsets, not code-point positions: a `matches` index travels to
 * the webview as a substring index over the label, and an astral character ahead of a Han one
 * (an emoji in a file name) would shift every later index if the walk counted code points.
 */
function buildShadow(segment: string): PinyinShadow | null {
  if (!CJK.test(segment)) return null;
  const readings = readingTable();
  const syllables: string[] = [];
  const charOf: number[] = [];
  for (let i = 0; i < segment.length; ) {
    const char = String.fromCodePoint(segment.codePointAt(i)!);
    const reading = readings.get(char);
    if (reading !== undefined) {
      syllables.push(reading);
      charOf.push(i);
    }
    i += char.length;
  }
  let full = '';
  let initials = '';
  const sylStart: number[] = [];
  for (const reading of syllables) {
    sylStart.push(full.length);
    full += reading;
    initials += reading.charAt(0);
  }
  const shadow: PinyinShadow = { full, initials, sylStart, charOf };
  shadowSegmentLength.set(shadow, segment.length);
  return shadow;
}

/**
 * Fold a typed query into the spelling the table stores: lowercase, `ü` and `u:` written as
 * `v` (`nv`, `lv`, `lve` — the IME's own spelling, and the reason the data keeps the IME
 * form in the first place: §6.8 records that the C# project lost every `üe` reading by
 * storing `lüe` and then having to rewrite queries instead).
 *
 * `ü` is mapped on its **pre-composed** form: `toLowerCase()` first, then the diaeresis
 * vowels — decomposing first would put `u` + U+0308 through the filter and leave a plain
 * `u`, which is the very reading the rule exists to avoid.
 */
export function normalizeQuery(query: string): string {
  return query.toLowerCase().replace(/u:/g, 'v').replace(/[\u00fc\u01d5-\u01dc]/g, 'v');
}

/**
 * Shadows, keyed by the segment string.
 *
 * The caller asks for the same segment once per indexed path that carries it — `存档` is one
 * segment of `存档/存档系统.md` and of `存档备份/` — so the map turns a per-path cost into a
 * per-distinct-segment cost. It is unbounded on purpose: §7 caps the index at 50 000 paths,
 * so the map's own ceiling is the index's, and the entries die with the extension host.
 */
const shadows = new Map<string, PinyinShadow | null>();

export const pinyin: PinyinProvider = {
  shadow(segment: string): PinyinShadow | null {
    const cached = shadows.get(segment);
    // `null` is a cached answer too ("no CJK"), which is exactly why this tests against
    // `undefined` instead of truthiness.
    if (cached !== undefined) return cached;
    const built = buildShadow(segment);
    shadows.set(segment, built);
    return built;
  },

  match(shadow: PinyinShadow, query: string): PinyinHit | null {
    if (!QUERY.test(query)) return null;
    const count = shadow.charOf.length;
    if (count === 0) return null;

    // Initials mode: one query character per syllable, so the run covers `query.length`
    // whole characters. `startsWith` at every offset is the contiguous-run search — a run
    // has to be unbroken, and `indexOf` would not say which syllable it began at.
    let initialsStart = -1;
    if (query.length <= shadow.initials.length) {
      for (let i = 0; i + query.length <= shadow.initials.length; i++) {
        if (shadow.initials.startsWith(query, i)) {
          initialsStart = i;
          break;
        }
      }
    }

    // Full mode: a run of whole syllables whose readings, run together, are the query. The
    // walk hops syllable boundary to syllable boundary and requires the last hop to land
    // exactly on the query's end — that is what forbids both a partial first syllable
    // (`ang` inside `dang`) and a partial last one (`cund`).
    let fullStart = -1;
    let fullUsed = 0;
    for (let k = 0; k < count && fullStart < 0; k++) {
      const at = shadow.sylStart[k];
      const target = at + query.length;
      let end = at;
      let used = 0;
      while (end < target && k + used < count) {
        end = k + used + 1 < count ? shadow.sylStart[k + used + 1] : shadow.full.length;
        used++;
      }
      if (end === target && shadow.full.slice(at, target) === query) {
        fullStart = k;
        fullUsed = used;
      }
    }

    // One hit, not two: prefer the earlier start because the tier and the score both read
    // it, and on an equal start prefer the run of fewer syllables (initials, or the compressed
    // full spelling) because it is the more specific reading of the same characters. Without
    // the tie-break `cd` over syllables `c` `d` would depend on which loop ran first.
    let start = -1;
    let used = 0;
    if (initialsStart >= 0) {
      start = initialsStart;
      used = query.length;
    }
    if (fullStart >= 0 && (start < 0 || fullStart < start || (fullStart === start && fullUsed < used))) {
      start = fullStart;
      used = fullUsed;
    }
    if (start < 0) return null;

    // `- segment.length` is the only use of the segment's own size: a short segment is the
    // more likely intent, so it edges out a longer one that matched equally early.
    const tier: 5 | 6 = start === 0 ? 5 : 6;
    const length = shadowSegmentLength.get(shadow) ?? shadow.charOf[count - 1] + 1;
    // Whole characters, and every character between them: the run is a span of the segment,
    // so a character that sits between two matched syllables is painted too, keeping the
    // highlight contiguous. What is never painted is a letter *inside* a syllable — those
    // have no index in the original segment at all.
    const first = shadow.charOf[start];
    const last = shadow.charOf[start + used - 1];
    const matches: number[] = [];
    for (let i = first; i <= last; i++) matches.push(i);
    return { tier, score: (tier === 5 ? 100 : 60) - start - length, start, matches };
  },
};
