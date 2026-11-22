# Plan: the `@` file picker (composer references)

**Status: planned, not implemented.** Every decision below was settled in a planning
conversation; §3–§10 are frozen for implementation, and §12 lists what is deliberately still
open. Nothing in `src/` or `media/` has been touched.

## 1. What this is

Typing `@` at the start of a token in the composer opens a **caret-anchored** list of files.
There are two sources: the workspace (a ripgrep index, so it inherits `.gitignore` and
`search.exclude`) and any absolute path on the machine.

**`@` is a trigger and nothing else.** Accepting a row replaces the whole `@query` token with
the path, so the `@` is washed out of the input buffer immediately and **no `@` ever reaches the
model**. The message the model receives is the message the user would have typed by hand.

A reference is **plain text and only plain text**: no request-byte injection, no inlined file
content, no attachment, no token cost of its own. The agent reads the file with `read_file`
(which already accepts absolute paths and line ranges), because reading a file is the agent's
own job and it can read a range instead of a whole file.

## 2. Decisions, and the two that were refused

| # | Question | Decision |
| --- | --- | --- |
| D1 | What does a reference *mean* at send time | **Reference only.** The text goes up verbatim and the agent reads the file itself. |
| D2 | Where the workspace file list comes from | **The vendored ripgrep** (`rg --files`), so the picker and `search_files` see the same files. |
| D3 | Where the popup sits | **At the caret**, JetBrains style (§5), not docked above the composer. |
| D4 | Workspace vs absolute paths | Workspace picks insert a **workspace-relative** path; absolute mode is entered by typing `/`, `~`, `\\`, or `X:`; `./` and `../` also enter absolute mode. The `Attach image` button becomes one **Attach** button (§9). |
| D5 | What an empty query lists | The up-to-20 files referenced in this session first, then the index in path order. |

**Refused 1: inlining file content at send time.** That was the alternative design (read the
file in the host and append it to the request bytes, hidden from the card, the way
`promptOrigin` hides the inter-session line). It is deterministic but every later request in the
window re-sends the content until a compression, and it makes the harness the one deciding how
much of a file the model sees. Not a setting either: one behaviour, no `spinney.mentionDelivery`.

**Refused 2: a system prompt section describing the syntax.** The system prompt is not touched by
this feature. After the wash there is no syntax to explain (the model just sees a path), so a
prompt line would be a line about nothing, and it would only reach windows opened after the
change anyway.

**Corollary, also refused: making `read_file` tolerate a leading `@`.** With the wash our own
insertion can never produce one, and the one remaining source (a user who pressed `Esc` on the
menu, leaving `@src/a.ts` in the box) is rare enough that a tolerant path resolver is not worth
the ambiguity of a file that is really named `@foo`. It stays a plain failure.

**Rejected outright: fabricating a `read_file` tool call/result into the history** so the content
arrives "for free". It violates the harness invariant that an assistant message carrying
`tool_calls` must be followed by the matching `tool` response, and a user-initiated tool result
is not a shape the API accepts.

## 3. The trigger, and the wash

**Trigger.** Walk backwards from the caret to the nearest `@` that is at index 0 or preceded by
whitespace or one of `([{"'`. No whitespace may appear between that `@` and the caret. The text
between the `@` and the caret is the query. Consequences that fall out of the rule:

- `foo@bar.com` never triggers (the `@` is preceded by a word character).
- `@Component(` in pasted code does trigger; the menu is non-modal, the user keeps typing, and a
  query with no matches closes it (§5), so the cost is one painted frame.
- A composing IME (`event.isComposing`, or a `compositionstart` seen and no `compositionend` yet)
  suppresses the menu entirely. This is not optional: the users of this feature type Chinese.

**The wash (accept).** With `atIndex` and the token end `tokenEnd` (the first whitespace at or
after the caret, or the end of the buffer):

1. `value = value.slice(0, atIndex) + insert + value.slice(tokenEnd)`
2. `insert` is the path, wrapped in `"` when it contains whitespace or `"`.
3. A space is added on either seam that needs one: when the character after the caret would glue
   itself to the path, and when the character **before** it would (§3.1).
4. The caret lands after everything just inserted.
5. `afterComposerWrite()` runs (a programmatic write fires no `input` event) and the typed query is
   gone for good. **The menu stays open** (§3.1).

`Enter`, `Tab` and a mouse click take a row: a directory walks into itself (§3.1), a file finishes
the reference. `Esc` closes the menu and **keeps** the typed text (JetBrains behaviour). A query
with zero matches closes the menu and leaves the buffer alone; deleting a character reopens it.

### 3.1 A directory row is a step, a file row is the answer

One `@` is meant to build a **long path**: `@src` then `Tab` on `chat/` gives `@src/chat/`, then
`Tab` on `runtime.ts` finishes it. That is path completion, and it needs the token to survive every
step but the last.

- **`Tab` walks into a `dir` row.** The `@` and everything before it are untouched; the text
  between the `@` and the token end becomes that directory plus its separator (`@src/` becomes
  `@src/chat/`), the caret lands at the end, and a fresh `mentionQuery` goes out for the new text
  (the write is programmatic, so no `input` event asks for it). The old rows stay on screen until
  that answer lands, so a step never flashes an empty list.
- **`Enter` takes the row as it stands.** On a directory that is how a whole folder is referenced
  (`Enter` on `chat/` washes the token into `src/chat`); on a file it finishes the reference the
  same way. A click takes the row too, exactly like `Enter`.
- The arrow keys move the highlight; `Esc` closes and leaves whatever was typed (`@src/chat/`)
  alone.

The host side of the same rule is the routing in §4: a query containing a **separator** is a place
to look, and it is answered by listing that directory (directories first), in the workspace scope as
much as in the absolute one, so a repo path is walked exactly like a machine path.

Known limit: a directory whose name contains a space cannot be walked, because the space ends the
token (§3). `Browse…` and the index still reach a file inside one.

## 4. The three scopes

**One classifier, in the host.** The webview posts the raw query and the host decides, so `~`
expansion and the Git-Bash mapping have exactly one implementation.

| Query starts with | Scope | Listed |
| --- | --- | --- |
| `/`, `~`, `\\`, or `^[A-Za-z]:` | absolute | the entries of that directory whose **name matches the trailing fragment** (§4.1) |
| `.` or `..` | absolute | the same, resolved against the agent root exactly like `resolvePath` does |
| anything, with a `/` or `\` in it | workspace | the entries of **that directory**, matched against the fragment after the last separator |
| anything else | workspace | the whole index, matched against file names (§6) |

`~` expands to the OS home. `/d/repos/x` goes through the same Git-Bash to drive-path mapping as
`resolvePath`, so the path the menu shows is the path the agent would read. UNC is recognised only
as a **leading `\\`**, per decision: a `\\` anywhere else is just a character.

**Insert shape.** A workspace pick inserts the workspace-relative path (`src/chat/runtime.ts`,
forward slashes). An absolute pick inserts the native absolute path (`C:\repos\x\a.ts` on Windows,
`/home/u/a.ts` elsewhere). A path chosen through the file dialog (§9) that lies **inside** the
agent root is normalised back to a relative path first, so both entry points produce the same
string for the same file. One normalisation function, used by both.

#### 4.1 A separator makes a query a place, in both scopes

A query is split at its **last separator** into a directory and a fragment. The directory part is
read (`readdir`, one syscall) and never interpreted; the fragment is matched against that
directory's entry **names**, by the same engine §6 describes, so `rt`, `*.cs`, `src/[` and
`cundang` mean here what they mean over the workspace. A trailing separator means there is no
fragment, and the menu is the plain listing: directories first, then files, in name order — which is
exactly the state a `Tab` on a directory leaves behind (§3.1).

The same rule serves both scopes, and the scope decides only how a row is **named**: an absolute
query inserts the machine path, a workspace query the path relative to the agent root. A workspace
query with no separator never reaches this code at all; it is a file-name search over the index
(§6).

**Nothing outside the typing path is ever offered.** A fragment with no match answers with no rows
at all, and the webview closes the menu on it (§3). There is no fallback to the workspace index
and no fallback to any other directory: a candidate the user did not point at is a candidate they
then have to disbelieve.

While a segment is still being typed, the directory part may not exist yet. The host walks up to
the **longest existing ancestor** and matches on the first segment of what is left, so
`~/proj/sub/di` with `sub` missing answers `/Users/u/proj`'s entries matching `sub` instead of
`ENOENT`. The directory the rows come from is always an ancestor of the typed path.

## 5. The menu

A `<textarea>` gives no caret coordinates, so the position is measured with a **mirror div**: one
reusable hidden element (`position: fixed; visibility: hidden; pointer-events: none;
white-space: pre-wrap; word-wrap: break-word; overflow: hidden`) whose width is
`inputEl.clientWidth` (so line breaking matches) and whose `font-family`, `font-size`,
`font-weight`, `font-style`, `letter-spacing`, `line-height`, `padding`, `border-width` and
`box-sizing` are copied from the textarea. The text up to the caret goes in, an empty `<span>`
is appended as a marker, and the caret position is the marker's `offsetLeft`/`offsetTop` plus the
textarea's `getBoundingClientRect()` and padding, minus `inputEl.scrollTop`.

**Re-measure on every one of these**, or the popup drifts: the query changing, the textarea's own
`scroll` event (past `INPUT_MAX_H` the box scrolls internally and the caret moves with no `input`
event), a window `resize`, `mountComposer` (switching cards moves the composer in the DOM), and
font loading.

**Placement.** `x` aligned to the caret, clamped to `[8, innerWidth - width - 8]`; `y` at the
caret line's bottom plus 4, flipped above the caret line when the viewport below is tighter than
the viewport above. Width `min(560, max(280, widest row))`; height at most 240 px with its own
scroll, and the highlighted row kept visible with `scrollIntoView({ block: 'nearest' })`.

**Rows.** The label is the **file name**, painted whole as the row's first column; the dimmed second
column is the containing directory, shortened from its own left (`…/Services/ItemSpreaderService`) by
the same path fitter the file tool cards use, so a narrow menu keeps the segments nearest the file.
The matched characters are wrapped in `<b class="mention-hit">` (for a pinyin hit those are the
Chinese characters, §6.5). Directories end in `/` in path mode.

**Keyboard.** While the menu is open it owns `↑`, `↓`, `PageUp`, `PageDown`, `Enter`, `Tab` and
`Esc`; the existing `Enter` to send is untouched while it is closed. Mouse rows accept on
`mousedown` with `preventDefault`, so the textarea never loses focus and the composer's focus
restore ladder is never involved.

**Reuse, not a new surface.** `.mention-menu` extends the existing floating-surface rules
(`position: fixed`, `z-index: 2000`) that `.node-menu` and `.snippet-menu` already use, because
the composer lives inside a zoomed/panned canvas.

## 6. Matching: three engines, one order

### 6.1 Mode selection, by metacharacter

The host picks the engine from the query text, once per query:

| The query contains | Engine |
| --- | --- |
| any of `* ? [ ] { } ( ) \| ^ $ + \` | **pattern** (§6.2) |
| nothing of the above | **literal/fuzzy** (§6.3–§6.4), then pinyin (§6.5) as a fallback band |
| nothing at all | the recent list, then the index in path order |

`.` is deliberately **not** a metacharacter: `runtime.ts` typed as a query must stay a plain
string, not become a regex whose dot matches anything.

### 6.2 Pattern mode

`rg --files` lists files; ripgrep has no "match file *names* with a regex" mode (`-g` takes globs,
and its regex engine matches file *content*). So the file set comes from ripgrep and the pattern
engine is ours, over that set:

1. Try `new RegExp(query, 'i')` and test it (unanchored) against the **file name**.
2. If that throws (a half-typed `src/[`), translate the query as a glob.
3. If neither compiles, fall back to the literal engine.

The glob is anchored over the **file name** too: `*.ts` matches `src/chat/runtime.ts`, and `?`,
`[...]`, `{a,b}` and a leading `!` (negation) work. A query with a separator never reaches this
engine: the part before the last one is a directory and the routing answers it by listing (§4.1),
so what pattern mode ever sees is a fragment a directory's entries are matched against.

This is deliberately **not** a second `globToRegex`. `src/tools/index.ts`'s `globToRegex` is
`search_files`' semantics (only `*` and `**`) and is left untouched: widening it would silently
change what the `search_files` `glob` argument means, which is a different feature.

Ordering inside pattern mode is deterministic and not scored: earliest match position in the name,
then path length, then ordinal.

### 6.3 The literal engine: tiers 0 to 4

**The candidate is the file name, and only the file name.** Directories never take part in a match:
`chat` is not a reason to offer every file under `src/chat/`. A query that carries one never reaches
this engine at all — it is a **place**, and §4.1 answers it by listing that directory — so the string
matched here never contains a separator, and `src/chat/runtime.ts` is not a query this engine is
asked about.

A "hump" is a boundary inside a name: the start of the string, a character after `_ - . space`,
and an uppercase letter that starts a camelCase word (or an abbreviation run, so `IHMP` is the
humps string of `IHudModuleProvider`).

| Tier | Match | Score |
| --- | --- | --- |
| 0 | the query equals the file name (case-insensitive) | `1000 − len` |
| 1 | the file name starts with the query | `900 − len` |
| 2 | the query equals the name's humps string | `800 − len` |
| 3 | the query is a prefix of the name's humps string | `700 − len` |
| 4 | a general subsequence of the file name | `10·hitScore − 3·holes − len` |

Tier 4's per-character points: `+6` at a hump start, `+4` contiguous with the previous hit, `+1`
otherwise, `+2` more when the case matches exactly. `holes = (last − first + 1) − queryLength`.

**Case is a preference with teeth.** An **uppercase** character in the query may only land on an
uppercase character of the name; a lowercase one is free to land anywhere, in every tier and in
tier 4's landing spots. Typing `Iss` is therefore a claim about `ItemSpreaderService.cs` (whose
humps are `I S S`) and not about `itemspreaderservice.cs`, while typing `iss` stays free to find
either. The rule only ever narrows what a user who typed capitals asked for, so it can never hide a
file from a lowercase query. Pattern mode says the same thing to the regex engine: a query with a
capital in it is compiled without the `i` flag. Pinyin folds the query first — a Chinese character
has no case, so a capital there is not a claim about the name.

The scores of different tiers are **never compared**: tier is the comparator's first key (§6.6),
so a score can never lift a tier 4 row above a tier 2 row.

### 6.4 The tier 4 tightening

Taken directly from the C# project (§6.7), which shipped without it, got a bug report, and fixed
it: **the first query character may land anywhere, but every later character may only land at**

1. a hump start,
2. a position contiguous with the previous hit, or
3. any position inside the same word, when the previous hit was itself that word's start.

Without the rule a two-letter query is noise: `cd` matched `SelectWorld` (Sele**c**t + Worl**d**)
and `LoadPickedSave` (Pi**c**ke**d**), and because the highlight then landed on the *key* while
the Chinese name stayed dark, users reported it as a highlighting bug. The rule keeps
`elect` → `SelectWorld` and `world` → `SelectWorld` while killing the scatter.

For names the same rule applies with `_`, `-`, `.` and camelCase as word starts, so `cd` will not
match `SelectWorld.ts` and will match `candidate.ts` and `code.ts`.

### 6.5 Pinyin: tiers 5 and 6

**Both spellings, from each Chinese character, tones dropped**: the full pinyin of a file name and
its initials. A pinyin hit is a **contiguous run of syllables** that either starts at the name's
first character (tier 5) or anywhere inside it (tier 6), and an initials query must cover the name
it matches.

| Tier | Match | Score |
| --- | --- | --- |
| 5 | a pinyin run starting at the name's first character | `100 − start − nameLen` |
| 6 | a pinyin run inside the name | `60 − start − nameLen` |

Pinyin is tried **only when the literal engine found nothing for that row**, and tiers 5 and 6 sit
above 4 numerically, so "literal first, pinyin second" is a hard band that falls out of the tier
order rather than a weight in the comparator. This is exactly how the C# project implemented
English-first, and it was the one decision it explicitly refused to unify.

**The file name is the whole candidate, and pinyin is not an exception to §6.3.** A directory name
never pinyin-matches: in `存档系统/读取面板/主界面.cs` the name is `主界面.cs`, so `zhujiemian`
finds the file and `cundang`, which names a directory, finds nothing.

**The shadow is built at index time, not at query time.** The index walk tests each name once
against `/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/`; a name with no CJK character is skipped for
good, and a name with one gets a shadow:

```
{ full: 'cundang', initials: 'cd', sylStart: [0,4], charOf: [0,1] }
```

`full` is the concatenation of the CJK characters' readings, `initials` their first letters,
`sylStart[k]` is syllable `k`'s offset in `full`, and `charOf[k]` is the character index in the
name. A query is then one `startsWith` / `indexOf` per shadow.

**Only the CJK characters contribute to the shadow.** ASCII inside a mixed name (`UI缩放`) is
the literal engine's business (`ui` matches it at some literal tier), so the shadow never needs to
spell the ASCII out. This is a simplification of the C# behaviour, chosen because our literal
engine already runs on every row.

**Highlight indices stay in the coordinate space of whatever matched.** A literal hit marks
characters of the name; a pinyin hit maps back through `charOf` and marks **whole Chinese
characters**, not letters within a syllable. Both are then shifted to the row's label, which is the
relative path. This is what the C# build does, and it is why `cd` paints `存档` in `读取存档`
rather than painting nothing.

### 6.6 One comparator

Exactly five keys, in this order, and this order is not negotiable:

**tier asc → coverage desc → score desc → path length asc → path ordinal asc**

`coverage = Σ weight(matched chars) / Σ weight(name chars)`, clamped to 1, with **CJK weight 3
and everything else weight 1**.

Two deliberate divergences from the C# source:

1. **Coverage is measured over the file name, not the whole candidate.** Their candidate was
   a command name; ours is a path, and pushing a name hit in a deep path through a
   whole-path denominator would punish it twice (path length is already key 4).
2. **Coverage is a within-tier key.** The C# project tried coverage first, measured the result, and
   reverted it in the same turn: with `sl`, `Core.TestLog` (coverage 0.29, tier 4) jumped above
   `Map.SelectLayer` (tier 2, humps `SL` exactly) and pushed it to sixth place. The reason is
   recorded in their source as a comment, and it is the reason it is a comment here too: someone
   typing initials wants that one command, not the densest match.

Rows whose only match is pinyin tie with each other on tier and are separated by their own
coverage and score, which is what makes `cundang` put `存档系统.ts` first and `存档备份.ts` second.

The list is capped at **50 rows** after sorting, and the footer says so when more matched.

### 6.7 Where the rules came from

The rules above are not invented. They are the final state of a C# implementation in another
project, reconstructed from its transcripts in session `mwkgxt29fjq4su`, in the nodes after
`mwkmaqfk0yqq48`: tiers and scores (`mwkmixkokgfn29`, `mwlr7n1qnqu7qg`), the coverage-first
regression and its revert (`mwlr7n1qnqu7qg`), the `cd` noise report and the three-landing-spot fix
(`mwlreydscgwiqv`), the English-first band (`mwkmguospt47v5`, `mwlreydscgwiqv`), and the pinyin
index mapping and highlight (`mwluqx7bbygxzj`, `mwm1vdtn1k9s20`).

**Not carried over**, each for a recorded reason:

- **Fuzzy sounds** (`zh`↔`z`, `ch`↔`c`, `sh`↔`s`, `n`↔`l`, …) and **polyphone readings**. Phase 2,
  one switch each. A command name is short and familiar; a file path is long, and every extra
  reading is a new way for an unrelated file to match.
- **A per-row full-pinyin display line.** They shipped it and deleted it: picking the first
  reading gives `草稿地图 → cao gao di tu`, which is a claim about the name that is simply wrong.
- **Non-standard IME aliases** (`yv` for `yu`, `qv` for `qu`). `v` means ü and nothing else, so
  `yvmi` failing to match 玉米 is correct behaviour, not a gap.
- **Coverage-first ordering** (§6.6) and **a unified literal+pinyin ranking** (a precise pinyin hit
  never outranks a literal one).

### 6.8 The vendored pinyin table

`media/vendor/pinyin/`, hash-pinned like every other vendored dependency, with a `PROVENANCE.md`,
an entry in `THIRD_PARTY_NOTICES.md`, and a line in `docs/agents/invariants/vendored-deps.md`. It
is a Unicode to tone-less pinyin map over the common CJK range, stored as one packed string and
read by the host (matching runs in the host, §8).

**It stores the IME spelling**: `xue`, `jue`, `que`, `nv`, `lv`, `lve`. The C# project lost every
`üe` reading (学/雪/月/决/确/约, 732 readings) because its library dropped them and had to be
patched in two places (the data, and a query-side `ue`→`ve` rewrite). Storing the form a Chinese
user actually types removes the whole problem: the only query-side normalisation is `ü` and `u:`
→ `v`.

A character missing from the table simply never pinyin-matches; it still matches literally. A
polyphone gets its first reading, and a query written with the other one misses (recorded as an
accepted cost of phase 1).

## 7. The index

Built once, in the host, per workspace:

```
rg --files --null --hidden --no-config  +  --glob=!**/<dir>/**  for SKIP_DIRS  +  --glob=!<pattern> for searchExcludeGlobs()
```

The same flags and the same two exclusion sources as `search_files`, so "what the agent can find"
and "what the user can point at" are the same set. `--null` because a path may contain a newline;
`--hidden` and the explicit `SKIP_DIRS` globs because that is what `search_files` does.

- **Cache**: kept for the session, capped at **50,000 paths**; past that the footer says the index
  is truncated.
- **Invalidation**: `vscode.workspace.onDidCreateFiles` / `onDidDeleteFiles` / `onDidRenameFiles` /
  `onDidChangeWorkspaceFolders` mark it dirty; the next query rebuilds. No polling, no watcher of
  our own.
- **Fallback**: when the ripgrep binary cannot be spawned, `vscode.workspace.findFiles('**/*')`
  (the same degraded path `search_files` takes). It honours `files.exclude` and `search.exclude`
  but not `.gitignore`, and the footer says which source is live.
- **No folder open**: there is no index. The menu opens directly in absolute mode, over the
  scratch root, with one line saying so.
- **Path mode** does not use the index at all: one `fs.promises.readdir` of the directory the typed
  path names, its entries matched by name against the trailing fragment (§4.1), capped at 200 rows
  for a plain listing and a 5,000-entry ranking scan, plus a `…` row when either is hit.

## 8. The protocol

| Direction | Message | Meaning |
| --- | --- | --- |
| webview → host | `{ type:'mentionQuery', requestId, query, recent }` | one query; `recent` is this session's pick history, used only for the empty query |
| host → webview | `{ type:'mentionResult', requestId, items, note?, truncated? }` | `items` are `{ kind:'file'\|'dir'\|'note', label, detail, insert, matches }` |
| webview → host | `{ type:'mentionBrowse' }` | the `Browse…` row |
| host → webview | `{ type:'mentionPicked', path }` | the dialog's answer, normalised (§4) |

- `requestId` is monotonic and the webview drops any answer that is not the newest one.
- The webview debounces at about 100 ms (trailing) and never sends a query for a closed menu.
- The host answers synchronously from the cache where it can; a stale index is rebuilt first, and
  the answer that arrives late is still matched to its own `requestId`.
- `matches` carries the indices to highlight, in whatever string `kind` implies (§6.5).
- "This session's recent picks" lives in the webview's memory only (at most 20 entries). It is not
  persisted: a reload starts empty, which is cheap and honest for a list that is a convenience.

## 9. The attach button

`#attach-btn` becomes **one button, one dialog, routed by extension**:

- Title and aria-label become `Attach or reference a file`; the click posts
  `{ type:'pickAttachment' }` (the `pickImage` message and `handlePickImage` are renamed with it).
- The host opens `showOpenDialog({ canSelectMany: false, openLabel: t('Attach') })` **with no
  filters**, so any file is selectable.
- A basename whose lowercased extension is in `IMAGE_EXTENSIONS` (`png jpg jpeg gif webp`, exported
  from `src/chat/imagePick.ts` and shared with the existing image path so the two cannot drift)
  takes the old route: read, `data:` URL, `{ type:'imagePicked' }`. Anything else answers
  `{ type:'mentionPicked', path }` and is inserted by the same function the menu uses, so quoting,
  the trailing space, the caret and `afterComposerWrite` have one implementation.
- The vision gate is unchanged: an image chosen while the current card has no vision support still
  produces the existing hint and attaches nothing.

Accepted cost, stated plainly: an image file can no longer be *referenced as a path* through this
button, because it is always taken as an attachment. The `@` menu can still point at one.

Single selection in phase 1. Multi-select would be `canSelectMany: true` plus a per-file routing
loop, whenever it is wanted.

## 10. Boundaries

| Situation | Behaviour |
| --- | --- |
| Read-only window, sub-agent branch | the textarea is already `disabled`, so no `@` can be typed; nothing to add |
| No folder open | absolute mode from the start, over the scratch root (§7) |
| A directory with hundreds of entries | 200 entries plus a `…` row, directories first |
| `readdir` fails (`ENOENT`, `EACCES`, a network drive timing out) | one dim row with the reason; never a VS Code notice, never an exception |
| Path with whitespace or quotes | inserted quoted (§4) |
| The composer scrolls internally | the popup re-measures on the textarea's `scroll` (§5) |
| IME composing | no menu (§3) |
| A query with no matches | the menu closes, the text stays (§3) |
| A workspace with 50k+ files | index truncated at 50k, footer says so |
| A path with no CJK characters | no pinyin shadow is ever built for it (§6.5) |

## 11. Landing checklist

**New files**

- `src/chat/mentions.ts`: pure logic, no `vscode` import. Trigger detection, the scope classifier,
  the pattern compiler (regex, glob, fallback), the literal tiers with the tightening, the pinyin
  shadow builder and matcher, the comparator, and the insert-shape/quoting rule. Pure so the guard
  can drive it directly.
- `src/chat/mentionIndex.ts`: the ripgrep index, its cache and invalidation, the `readdir` path, and
  the dialog. The only file that touches `vscode`, `fs` and `child_process`.
- `media/vendor/pinyin/` with `PROVENANCE.md` (§6.8).
- `tools/check-mention.js` plus `npm run check:mention`, registered in `vscode:prepublish`.

**Changed files**

- `src/chat/ChatViewProvider.ts`: the four message cases (§8).
- `src/chat/runtime.ts`: `postConfig` gains a `mention` field (at minimum `{ hasFolder }`, plus the
  live index source so the footer can say which one answered); `handlePickImage` becomes
  `handlePickAttachment`.
- `src/chat/imagePick.ts`: export `IMAGE_EXTENSIONS`, route by extension, return either an image
  attachment or a path.
- `src/chat/webviewShell.ts`: the attach button's title/aria-label. The menu needs no shell markup:
  it is created on demand, like the snippet menu.
- `media/main.js`: the mirror div, the menu, the keyboard handling, the attach click, the recent
  list.
- `media/style.css`: `.mention-menu`, `.mention-row`, `.mention-hit`, `.mention-mirror`, sharing the
  floating-surface rules of `.node-menu` / `.snippet-menu`.

**Guards**

- `tools/check-mention.js` must cover: the trigger rule (email, mid-word, caret mid-token, IME),
  the scope classifier, pattern compilation including a half-typed `[` and `!` negation, the
  basename-vs-path glob rule, the tier 4 tightening (the `cd` / `elect` pair), the comparator
  against a built `sl` regression fixture (a tier 2 `SelectLayer`-like row must beat a tier 4
  `TestLog`-like row even at lower coverage), the pinyin shadow (`ü`, `üe`, a polyphone, the
  syllable to character map) and the wash (no `@` survives, quoting, no doubled space).
- `tools/check-webview.js`: the new provider messages join `TURN_MESSAGES`.
- `npm run check:l10n` and `npm run check:docs` gate the new strings and the manual pages.

**i18n and manual**

- Every new user-visible string through `tr()` (webview) or `vscode.l10n.t()` (host) as a single
  literal, then `npm run sync:l10n` and both `l10n/bundle.l10n.*.json` catalogs.
- `manual/manual.md` and both translations: one row in the §3.1 composer table for the `@` picker
  and one for the renamed **Attach** button, in the manual's own ASD-STE100 style.

**Docs**

- `THIRD_PARTY_NOTICES.md` and `docs/agents/invariants/vendored-deps.md` for the pinyin table.
- This page is the design record; add it to `AGENTS.md`'s plan index (see §12).

**Closing procedure**, per the workspace rules: `npm run compile`, then `powershell -File
build-deploy.ps1`, then the window reload. A docs-only change (this page) needs none of that, but
the slice that lands the feature does.

## 12. Open items

1. **Fuzzy sounds and polyphone readings** (§6.7): phase 2, one switch each.
2. **Segment weighting** — closed by §13.6: with the file name as the only candidate there is no
   second segment left to weight, so the bonus and its constant are gone rather than tuned.
3. **Multi-select in the attach dialog** (§9).
4. **`AGENTS.md`'s plan index** should gain a line for this page. That file is injected into every
   session's prompt, so the line is left for the developer to approve rather than written with this
   page.
5. **`AGENTS.md` says "compile plus the twenty-one guards"** while `vscode:prepublish` runs 24
   `check:` scripts today. Adding `check:mention` makes it 25. The sentence is stale either way and
   belongs in the same small docs fix.
6. **The pinyin table's provenance and licence** must be settled before vendoring (§6.8): the
   licence has to be compatible and permissive, and the hash pin has to come from an untouched
   upstream copy.

## 13. Landing record

**Status: implemented.** This section is what the slices actually built, where they departed from
§3–§10, and what the guards now pin. It was written after the code compiled and the guard suite ran
clean; nothing here is a plan for later.

### 13.1 What landed, by file

| File | State | What it is |
| --- | --- | --- |
| `src/chat/mentions.ts` | new | The host-side matcher: scope classifier, pattern engine (regex → glob → literal fallback), tiers 0-4 with the tightening, tiers 5-6 via the pinyin provider, the five-key comparator, `recentMentions`. Pure: no `vscode`, no `fs`, one type-only import. |
| `src/chat/pinyin.ts` | new | The provider: table load, per-segment shadow (`full`, `initials`, `sylStart`, `charOf`), the contiguous-run matcher, `normalizeQuery`. |
| `media/vendor/pinyin/pinyin.json` | new | 26,713 characters, tone-less, IME spelling. Derived from `mozillazg/pinyin-data` `pinyin.txt` 0.16.0 (MIT); hashes and the reproducible converter are in that directory's `PROVENANCE.md`. |
| `src/chat/mentionIndex.ts` | new | The ripgrep index (same argv and exclusion sources as `search_files`), its cache and invalidation, absolute-mode `readdir`, the unfiltered dialog, and `workspaceRelativePath`. |
| `src/chat/imagePick.ts` | rewritten | Was dead code whose comment claimed a caller it did not have; it is now the one attach dialog, with `IMAGE_EXTENSIONS` and extension routing. `runtime.ts` calls it (the duplicated inline dialog is gone). |
| `media/mention.js` | new | The webview-side syntax module: `token`, `wash`, `quotePath`, loaded as its own `<script>` like `media/tree.js`. |
| `media/main.js` | extended | The caret mirror, the popup, the keyboard, the accept, `mentionResult` / `mentionPicked` / `pickAttachment`. One contiguous block; the snippet menu, the image path, the focus ladder and the typing probe are untouched. |
| `media/style.css` | extended | `.mention-menu` joined the existing floating-surface selector list rather than duplicating it. |
| `src/chat/webviewShell.ts` | extended | The `mention.js` script tag, and the attach button's new strings. |
| `src/chat/ChatViewProvider.ts` | extended | `mentionQuery`, `mentionBrowse`, `pickAttachment`, the index's lifetime, two helpers. |
| `src/chat/runtime.ts` | extended | `handlePickAttachment` replaced `handlePickImage`. |
| `tools/check-mention.js` | new | 120 assertions over the wash, the typing-path split, the scopes, the patterns, the tightening, the comparator and the `sl` regression, the pinyin tiers, the caps, and the webview wiring. |
| `tools/check-webview.js` | extended | Loads `media/mention.js`; replays a `mentionQuery` → `mentionResult` round trip, the accept, `mentionPicked`, and the Attach click. |
| `package.json` | extended | `check:mention`, inside `vscode:prepublish`. |
| `THIRD_PARTY_NOTICES.md`, `docs/agents/invariants/vendored-deps.md` | extended | The seventh vendored asset. |
| `l10n/bundle.l10n.zh-Hans.json`, `zh-Hant.json` | extended | The 11 new sources, the 3 stale ones removed. |
| `manual/manual.md` + both translations | extended | §3.1's Attach row, and a new §3.6. |

### 13.2 Where the build departs from this page, and why

1. **The trigger and the wash are in `media/mention.js`, not in `mentions.ts`.** §11 assumed one
   module. The webview cannot import TypeScript, and the alternative (the webview asking the host
   to classify a token on every keystroke) would have added a round trip to the one path that must
   feel instant. So the webview owns the syntax and the host owns the matching, and
   `tools/check-mention.js` drives both: `require` for the host module, the `vm` + `window = ctx`
   pattern for the webview one.
2. **`!` skips the regex attempt.** §6.2 says "try a RegExp, then a glob". `!*.ts` is a *valid*
   regex (`!` then any character then `ts`), so the literal order would silently swallow negation.
   A leading `!` therefore goes to the glob engine first.
3. **A pinyin hit's tier reads a character offset, not a syllable index.** §6.5's tier rule is
   "the run starts at the segment's first character", and the C# original measured that offset in
   the Chinese text. The provider reports syllable bookkeeping, `mentions.ts` therefore derives the
   tier and the score from `hit.matches[0]`, and an ASCII prefix (`UI缩放`) puts a hit in tier 6.
4. **No `mention` field in `HarnessConfig`.** §11 anticipated one for the no-folder hint. The hint
   travels in `mentionResult.note` instead, so the config shape, `getConfig` and `postConfig` are
   untouched and there is no field that can go stale.
5. **`imagePick.ts` stopped being dead code.** §9 said to share the image extension list with "the
   existing image path"; the existing path was a second inline copy in `runtime.ts`, and the module
   it was supposed to live in had no caller at all. The slice deleted the duplicate.
6. **The pinyin table is larger than the plan guessed.** §6.8 expected "about 6,500 characters";
   the source covers 26,713 across the three CJK ranges at 189 KB. Trimming it would have meant
   choosing which characters a user's file names may contain.

### 13.3 Verification

`npm run compile` is clean. Every guard in `vscode:prepublish` passes, including the new
`check:mention` (120 assertions) and the extended `check:webview` (46 messages, with the picker block
that fails if `media/mention.js` is dropped from the guard's script list). `check:l10n` is clean
after the catalogs gained the 11 new sources and lost the 3 stale ones, and `check:docs` passes with
the three manual pages structurally identical.

### 13.4 Still open

- §12's items 1, 2, 3 and 6 are untouched: fuzzy sounds and polyphone readings, the segment
  weighting constant, multi-select in the dialog, and nothing depends on them.
- §12 item 4: `AGENTS.md`'s plan index still does not list this page. That file is injected into
  every session's prompt, so the line stays the developer's to add.
- §12 item 5: `AGENTS.md` still says "the twenty-one guards". `vscode:prepublish` now runs 25
  `check:` scripts.
- The popup's caret measurement is verified by the guard only structurally: the `check-webview` DOM
  stub has no layout, so the mirror div's arithmetic (and the zoom mapping from the tree canvas to
  the fixed popup) is exercised in the real webview, not in the build.

### 13.5 A later change: path mode became a search inside the directory being typed

The first implementation listed a typed directory wholesale and answered `Cannot open …` for a
half-typed one. The developer replaced that rule with three: the workspace scope matches the whole
index (unchanged), the absolute scope matches **only the entries of the directory the typing path
names**, and a miss answers with **no rows at all** rather than falling back to the workspace or to
any other directory. §4.1 is the rule; §4's table and §7's path-mode bullet were corrected with it.

What that changed in the tree:

- `answerAbsolute` splits the typed text with `splitTypedPath`, walks up to the longest existing
  ancestor, ranks that directory's entry **names** through `rankMentions` (so globs, regexes and
  pinyin work there too), and returns an empty list on a miss. The per-entry row shaping moved into
  `entryRow`, so the listing and the ranked answer build rows the same way.
- `splitTypedPath` and `firstSegment` live in `src/chat/mentions.ts`, not in the index: they are
  syntax, they are pure, and the guard drives them. That is 11 new assertions, which is why the
  count above is 120 and not 93.
- `RANK_SCAN_CAP` (5,000 entries) bounds the ranking scan, so one `readdir` of a huge directory
  cannot turn a keystroke into a 60k-row scan; `DIR_CAP` (200) still bounds the plain listing.
- The `Cannot open {0}: {1}` string is gone from both catalogs: with the ancestor walk a
  half-typed path is no longer an error, so nothing asks for that sentence.
- Two textual checks at the end of `check-mention` pin what a guard cannot `require` (the index
  imports `vscode`): the absolute answer must rank the directory entries, and a miss must be an
  empty list.

### 13.6 A later change: the match surface is the file name, and nothing else

The first implementation matched the **relative path**: tier 0 could equal the whole path, tier 4
walked the path as a subsequence, pinyin ran per segment, and a glob containing `/` matched the
path. The developer cut all of that: *"stop matching path in workspace and only focus on file
names."* §6.2, §6.3, §6.4, §6.5 and §6.6 now say so, and this is what it took.

- **One candidate.** `literalMatch`, the pattern matchers and `pinyinCandidate` all measure the
  **file name**; `coverage` is measured over it; the label is still the relative path and every
  match index is shifted onto it, so a `runtime.ts` hit highlights the name inside `src/…/runtime.ts`
  and nothing else.
- **A query that is a path is read as the name at its end.** `fileNameQuery` strips everything up
  to the last separator (`src/chat/runtime.ts` is looked up as `runtime.ts`), keeping a leading `!`
  in place for glob negation. A query that is *only* a directory (`src/chat/`) is left alone, which
  means it matches no file name and the popup closes on it — the honest answer once directories are
  out of scope.
- **Pinyin lost its segments.** The per-segment loop, the best-segment selection and
  `PINYIN_BASENAME_BONUS` are gone: the name is one shadow. `cundang` over
  `存档系统/读取面板/主界面.cs` now matches nothing, because 存档系统 is a directory; `zhujiemian`
  finds the file.
- **`spanCoverage` is deleted.** It existed to measure a tier 4 run that crossed `/`, which can no
  longer happen.
- **The guard was re-fixtured, not relaxed.** The `cd` acceptance pair moved from `code/daemon/` to
  `candidate.ts` / `code.ts` and still refuses `SelectWorld.ts` and `LoadPickedSave.ts`; the pinyin
  block asserts the directory-name miss as a positive case; the glob-on-path fixture became the
  path-is-a-name fixture. 106 assertions.

### 13.7 A later change: the row's two columns, and case that means something

Two requests, one round. **The display** first: the first implementation put the relative path in the
label and the directory in the detail, so the left column spent its width on directories and the
file name — the only part that differs between rows — was what the ellipsis ate. Both columns are now
what image 2 of the report showed: the **file name whole** as the label, the **directory** dimmed on
the right, shortened from its own left by the fitter the file tool cards already use
(`fitPathText` / `registerPathFit` in `media/main.js`), so a narrow menu keeps
`…/Services/ItemSpreaderService` instead of the head of the path.

That made the row's label the matcher's own candidate, so the whole index-shifting dance went away:
`literalMatch`, the pattern matchers and `pinyinCandidate` all return indices in the name's
coordinates, and `mentionItem` is the only place that turns a path into `{ label, detail, insert }`.

**Case** second: matching now cares about capitals, as a constraint rather than a tie-break. An
uppercase query character may only land on an uppercase name character, in tiers 0–4 and in tier 4's
landing spots; a lowercase one is unconstrained. Pattern mode compiles case-sensitively when the query
holds a capital, and pinyin folds the query because a Chinese character has no case. The rule can only
narrow what a user who typed capitals asked for, so a lowercase query still finds everything it did
before.

The guard grew to 119 assertions: the row shape (`label` / `detail` / `insert`, and a root-level file
with no detail), the case rule at prefix, humps and tier 4, the all-caps form (`ISS`), and the
glob-with-a-capital pair. The `check-webview` fixture now replays the real row shape, so the two
columns are asserted as two elements rather than through the row's concatenated text.

### 13.8 A later change: one `@`, a long path, and the run that was not it

The wash made one reference cost one `@`, and after it the menu was gone. The first answer to that
was a **run**: taking a row kept the menu up and spent the token, so `Enter Enter Enter` collected
three files out of one list. It shipped, and the developer said what they actually wanted: not
several rows out of one list, but **one long path built a segment at a time** with the arrows and
`Tab` (§3.1). The run was removed the same day.

What that reframing changed:

- **A `dir` row is a step.** `mentionDrill` rewrites only the text between the token's `@` and the
  token end (the `@` itself survives, so the menu keeps its anchor), then calls `mentionSync()` to ask
  for the new directory, because a programmatic write fires no `input` event. A `file` row still
  washes the whole token and closes.
- **The menu is opened by the token again**, and nothing survives the pick: `mentionSticky`,
  `mentionOwnWrite`, the `accepted` mark and `.mention-row.accepted` are all gone.
- **`fileNameQuery` is gone with them.** The previous round had stripped everything before the last
  separator so that `src/chat/rt` meant `rt`; a prefix is now the exact thing being walked, so
  stripping it would have deleted the user's step.
- **The workspace scope gained the path branch.** `mentionIndex.query` routes any query with a
  separator to `answerPath`, which reads the directory and names its rows relative to the agent root.
  The old `answerAbsolute` became `answerPath(typed, scope)`, and `scope` now decides only the
  naming: `insertFor` and `base` produce a machine path or a workspace path from the same listing.
- **Two seam bugs surfaced while building the first version** and are now the guard's own
  assertions: the missing separator on the trailing seam (`a.tslib/b.ts`, so the rule became "a space
  on any side that is not already whitespace"), and a `select` event dispatched by
  `setSelectionRange` closing the menu the pick had just reorganised.

`check-webview` now walks the whole path in its fixture: a `dir` row is taken, the buffer becomes
`@src/chat/`, the posted query is `src/chat/`, the answer for that directory is taken as a file, and
the buffer ends as the path alone with no `@` and the menu closed.

### 13.9 A later change: `Tab` and `Enter` stopped being the same key

The drill made a directory row a step and only a step, so there was no way to reference a folder
itself: `Enter` on `chat/` walked in, and the only way to stop was `Esc`, which left `@src/chat/` in
the box and therefore a `@` in the model's input. The developer's question was whether the `@` should
simply stop being cared about.

It did not have to be: the wash is kept, and the two keys were split instead.

- `Tab` walks into a directory (§3.1). It is the only key that grows the path, so a long path is
  still built by holding one gesture.
- `Enter`, and a click, take the row as it stands: on a directory that is a reference to the folder
  (`src/chat`), on a file it is the finished reference. Both wash the token out, so no `@` reaches
  the model in either case.

`mentionAccept(entry, drill)` carries the flag, `mentionHandleKey` passes `key === 'Tab'`, the row's
`mousedown` passes nothing, and the manual says the pair in one line. `check-webview` now runs both
halves: `Enter` on a directory row yields `src/chat` with no `@` and a closed menu, then a fresh `@`
walks with `Tab` into `@src/chat/`, posts the directory query, and finishes on the file inside it.
