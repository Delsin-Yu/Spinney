# Plan: find in a conversation, find across conversations

**Status: landed.** This page is the contract the feature was built against; §9 is the
landing record. §1 is why the obvious routes cannot carry this feature, §2 what it is,
§3 the frozen interfaces, §4 who owns which file, §5 the phases, §6 the risks and the one
measurement, §8 the decisions taken while designing it.

Two shortcuts, one corpus:

- **Ctrl+F** searches the conversation of the tab it is pressed in.
- **Ctrl+Shift+F** searches every conversation of the workspace.

What is searched is one card's **question and its final answer** (§2.1), what is shown is a
find bar and a results panel inside the chat tab (§2.4, §2.5), and what a hit does is check
out the card and centre it (§2.6). The Command Palette gets two entries (§2.7).

## 1. Why the obvious routes fail

| Route | Why it cannot carry this feature |
| --- | --- |
| A browser-style find over the rendered document, including VS Code's own `enableFindWidget` | The chat surface is an infinite canvas whose content is deliberately absent from the DOM twice over: a card far off screen is **unloaded** (head and box stay, its ask and log go — `media/main.js`, the `virtMayUnload` block), and a long finished log is **windowed** (only a slice of its rows is rendered, `renderNodeItems` → `paintItemsWindow`). Folded step groups are a third: their rows do not exist until the fold opens. A DOM find also cannot see another conversation at all. |
| `search_transcripts` against the on-disk JSONL dumps (`src/chat/transcript.ts`) | It only sees **finished** turns (the dump is written in `finishTurn`), it sees the rendered/clipped line of a message rather than the message, a hit names a line of a `.jsonl` file rather than a card the user can be taken to, and it is not scoped to this workspace (§1.1). |
| VS Code's Search view | There is no extension API to inject results into it. The 1.85 stable API this repository compiles against has no text-search provider and no `findTextInFiles`; the only way to make the Search view see conversations is to materialise them as temporary files, which makes the hit land in a `.txt` instead of the conversation. |
| A QuickPick as the query box | The picker's own filter cannot be turned off, and the filter is the same widget as the input. Case, whole word and regex would have nowhere to live, so the picker can only **navigate** an already-computed list. It keeps that job (§2.7). |

### 1.1 The isolation boundary

The corpus is `ChatViewProvider.sessions`, which is exactly this window's workspace: the
store keeps one folder per workspace (`sessions/<workspaceKey>/`, with `workspaceKey` a
digest of the workspace folder URI, `no-workspace` when there is none —
`src/chat/sessionStore.ts`, `workspaceKeyFor` / `sessionsDir`). A window on another folder
has another key and never loads those sessions; another profile has another global-storage
root.

The transcript dumps are **not** keyed that way: `transcriptRoot()` is
`<globalStorage>/transcripts`, one folder for every workspace of the profile
(`src/chat/ChatViewProvider.ts`, `transcriptRoot` / `transcriptDir`). That is the one place
where a search in this window can see another VS Code window's conversation, which is why
the user-facing search never reads the disk, and why the agent's `search_transcripts`
tool stays what it is.

The consequence worth stating: "all conversations" means **all conversations of this
workspace**. Searching another folder's conversations is deliberately not built (§2.8).

## 2. The design

### 2.1 The corpus: the question and the final answer

Per card (`TreeNode`), from its own `displayItems`:

- **question** — the first item with `kind: 'user'` (the text the pinned ask shows);
- **answer** — the **last** item with `kind: 'assistant'` and a non-empty `text`.

That is the sentence after a run of steps, which is what the user asked to search. Both
fields are stored without a display clip (only tool `args` / `content` and a long
`thinking` are clipped, `clipDisplayItem` in `src/chat/runtime.ts`), so the whole answer is
searchable.

Skipped: `kind: 'bg'` cards (a command is not a conversation turn), and a node with
neither field (an interrupted turn that never answered). A compression card competes with
its answer like any other card: its answer is the handoff it wrote, and searching it is
correct. A sub-agent card's answer is its final answer, and it is included.

Deliberately excluded: tool arguments, tool output, thinking, notices and harness notes.
"Which run printed this" is a question for `search_transcripts`, not for Ctrl+F.

### 2.2 Scopes and order

- `session` (Ctrl+F): every card of the current conversation, **all branches**, including
  the ones hanging off a fork and the sub-agent sidecars. Searching only the checked-out
  path would hide a sibling branch the user made on purpose; a hit carries its branch so the
  result panel can say which one it is.
- `all` (Ctrl+Shift+F): every session the window has loaded, newest session first
  (`updatedAt` descending), then the same reading order inside each.

Reading order is `orderedNodeIds`: every root in `rootIds`, then each node's `children` in
order, depth first. It is the order the tree toolbars and the layout already use, so
Enter/Next walks the results the way the eye does.

### 2.3 Matching, identical to the VS Code search box

| Toggle | Default | Meaning | Shortcut |
| --- | --- | --- | --- |
| case sensitive | off | a plain substring otherwise | `Alt+C` |
| whole word | off | `\b` around the query | `Alt+W` |
| regular expression | off | the query is a JS regex | `Alt+R` |

Whole word is ignored while the regex toggle is on, which is VS Code's own rule. An
unparsable regex is reported as `invalid` with the engine's message, the input is drawn in
the error colour, and the previous list stays as it was; nothing throws.

Two properties the implementation owes the user:

- a **literal** query is matched as text, never as a pattern, so `search_files(` finds
  itself instead of failing as a regex;
- a snippet is cut through `clipText` (never `slice`), so an emoji's surrogate pair is never
  split in the middle of a message.

### 2.4 The find bar

One row, fixed at the top right of the tab (outside `#tree-wrap`, so the canvas transform
cannot move or scale it), rendered by the shell (`webviewShell.ts`) and driven by
`media/main.js`:

```
[ input ] [Aa] [ab|] [.*]   3/47   [↑] [↓] [×]
```

- `Ctrl+F` / `Ctrl+Shift+F` open it in the `session` / `all` scope. Both are caught on the
  document with `preventDefault` (a key pressed inside the webview never reaches the
  workbench, which is also why the shadowing is possible at all); `e.isComposing` and an IME
  composition are never intercepted.
- Typing re-queries after a 120 ms debounce. Every request carries a `requestId`; the
  webview drops an answer that is not the newest one it asked for, and the host stops a scan
  when a newer request for that session has arrived.
- `Enter` / `↓` next, `Shift+Enter` / `↑` previous, `F3` / `Shift+F3` the same, wrapping at
  both ends; `Esc` closes and returns the focus to the composer.
- The counter reads `{current}/{total}`, and `{cap}+` when the list was cut by the limit.
- The bar says "no matches in N cards" rather than showing an empty counter.

### 2.5 The results panel

`Ctrl+Shift+F` opens the bar **and** a docked list on the left of the tab (collapsible, the
`#term-dock` precedent for a floating panel with its own header):

```
Conversations · 12 hits
▾ Session "Fix the parser"        3
    The ask: … parser drops the last token …
    Card "Rewrite the tokenizer"   Answer
      …the tokenizer now keeps the trailing token, and the parser sees it…
```

Each row is one hit: the session (in the `all` scope), the card title, a `Question` /
`Answer` chip, and the snippet with every match marked. A click is the same jump as
`Enter` on the current hit (§2.6). The list is capped at 200 rows per query (hard cap 500);
past that the header says the list was cut and the query needs narrowing.

Both scopes use the same panel and the same rows; the `session` scope groups only by card.

### 2.6 The jump

A hit is a card, so the jump is the checkout the tree already has:

1. the host sets the view focus to the hit's node (`SessionRuntime.handleCheckout` when the
   session has a runtime, otherwise `session.activeNodeId` plus `noteFocus`), and
2. opens (or focuses) the hit's tab when it belongs to another session (`openSession`).

The webview keeps `pendingReveal = { sessionId, nodeId, query, flags }` and consumes it on
the next `tree` / `path` that carries that node: `panToNode` centres the card, and the
marking pass (§2.6.1) runs on it. Keeping the reveal on the webview side is what makes a
cold tab work — the tab that has just opened has no cards yet, and its first repaint is what
the reveal waits for.

#### 2.6.1 Marking

- the card element gets `.find-hit`, and the current one `.find-current` (an outline in the
  theme's focus colour);
- the query is marked inside the card's rendered text with `<mark class="find-match">`, over
  the text nodes of `.node-ask` and `.node-work` (skipping `textarea`, `input` and an
  existing `mark`), applied at the end of `renderNodeItems` and after a routed append while
  a find session is open, at most once per frame;
- before every re-mark the previous marks are unwrapped, so a query change cannot leave a
  stale highlight behind;
- a card whose content is unloaded or whose log is windowed still counts as a hit, and its
  mark appears when the card is checked out (which is what a jump does).

### 2.7 The Command Palette entries

Two commands, for discoverability and for a keyboard that is not inside the tab:

- `Spinney: Find in Conversation` (`spinney.findInConversation`)
- `Spinney: Find in All Sessions` (`spinney.findInAllSessions`)

Each reveals the active session's tab, posts `{type:'findOpen', scope}`, and the tab opens
the bar with the input focused. On a cold tab the message is held by `ChatPanel.post` until
the document is ready, so the command never needs to wait.

`Find in All Sessions` additionally opens a **QuickPick navigator** once the bar is up
(`window.createQuickPick`): its input re-runs the same search, and each row's `label` is the
snippet, `description` is `session title · card title`, `detail` is the branch. Putting the
snippet in the label is what keeps the picker's own filter from hiding a row whose match is
in the answer rather than in the title. The picker navigates; the panel remains the view.

### 2.8 What it deliberately does not do

- **No other workspace.** "All conversations" is this workspace's. See §1.1.
- **No tool output.** The corpus is the question and the answer (§2.1).
- **No row-level jump.** A hit is a card, so nothing has to open a folded step group or
  force a windowed log to render around an index.
- **No disk.** The transcript dumps stay the agent's memory, not the user's search index.
- **No index, no cache.** A query scans the in-memory strings, bounded by §6.

## 3. Interfaces (frozen)

### 3.1 `src/chat/find.ts` — pure, `vscode`-free

```ts
export type FindScope = 'session' | 'all';
export type FindField = 'answer' | 'question';

export interface FindOptions {
  scope: FindScope;
  /** Required for 'session'; ignored for 'all'. */
  sessionId?: string;
  query: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  /** Default 200, hard cap 500. */
  limit?: number;
  /** `Date.now() + budget`: the scan stops at the next card boundary past it. */
  deadlineAt?: number;
}

export interface FindHit {
  sessionId: string;
  sessionTitle: string;
  nodeId: string;
  nodeTitle: string;
  /** 'turn' | 'compress' | 'resume' | 'agent' — the card's own kind, for the chip. */
  nodeKind: string;
  field: FindField;
  /** Root → node, so the panel can say which branch the card is on. */
  branch: string[];
  /** ±`SNIPPET_RADIUS` chars around the first match, whitespace collapsed. */
  snippet: string;
  matchStart: number;
  matchEnd: number;
}

export interface FindResult {
  hits: FindHit[];
  total: number;
  capped: boolean;
  /** The engine's message when the query is not a valid regex (see §2.3). */
  invalid?: string;
  scannedNodes: number;
  scannedSessions: number;
  timedOut: boolean;
  ms: number;
}

/** The query as a reusable pattern, or the engine's error. `wholeWord` yields to `regex`. */
export function compileQuery(
  query: string,
  opts: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean },
): { source: string; flags: string; error?: string };

/** Every card's searchable text in reading order (question, then answer). */
export function searchableText(node: TreeNode): { field: FindField; text: string }[];

/** Root → node ids, roots in order, children in order, depth first. */
export function orderedNodeIds(session: AgentSession): string[];

/**
 * One query over the sessions it is given. Never throws: an invalid regex, a deadline and
 * the match cap are all results. `yieldTo` (default `setImmediate`) is awaited between
 * cards, so a scan over a big workspace never blocks the host's event loop for long.
 */
export async function findInSessions(
  sessions: AgentSession[],
  opts: FindOptions,
  yieldTo?: () => Promise<void>,
): Promise<FindResult>;
```

### 3.2 Messages

| Direction | Message | Answer |
| --- | --- | --- |
| webview → host | `{type:'find', requestId, scope, sessionId, query, caseSensitive, wholeWord, regex, limit}` | — |
| host → webview | `{type:'findResults', requestId, scope, ...FindResult}` | the scan |
| webview → host | `{type:'findJump', sessionId, nodeId, field}` | — |
| host → webview | `{type:'findOpen', scope}` | — (the two commands) |

- `find` is answered **before** `runtimeFor` in `handleSessionMessage`, like `perfDiag`, so
  a tab that only searches never builds a session runtime. It is a read: no reboot hold, no
  read-only refusal (§ the `mentionQuery` precedent).
- A `find` while an earlier one is still scanning replaces it: the provider keeps
  `currentFindRequest` per session and stops the older scan at its next card boundary.
- The answer goes through `postTo(sessionId, …)`, so it reaches the tab that asked.
- `findJump` needs `runtimeFor` (a checkout); a session with no tab still moves its focus
  pointer, because that is what the tab will open on.
- Both new host→webview types must be added to `TURN_MESSAGES` in
  `tools/check-webview.js` (§7).

### 3.3 Host entry points

```ts
// ChatViewProvider
private handleFind(sessionId: string, message: FindMessage): Promise<void>;
private gotoFindHit(sessionId: string, nodeId: string): void;   // checkout + openSession
private openFindPanel(scope: FindScope): void;                  // the two commands
private showFindQuickPick(): void;                              // Find in All Sessions
```

The commands are registered in `src/extension.ts` beside `spinney.reloadChatWebview`.

### 3.4 Webview state (all in `media/main.js`)

```js
const findState = {
  active: false,
  scope: 'session',        // 'session' | 'all'
  query: '',
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  requestId: 0,            // the newest answer this tab will accept
  hits: [],                // [{ sessionId, nodeId, field, snippet, matchStart, matchEnd, ... }]
  index: -1,               // the current hit, -1 when there are none
  invalid: '',             // the regex error, drawn on the input
};
let pendingReveal = null;  // { sessionId, nodeId, query, flags }
```

The card marks are the two classes above; nothing else of the tree is touched.

## 4. Files and ownership (one writer per file)

| Slice | Owns | Delivers |
| --- | --- | --- |
| **A** corpus | `src/chat/find.ts`, `tools/find-acceptance.js`, `package.json` (`check:find`) | the matcher, the corpus rule, the ordering, the deadline |
| **B** host | `src/chat/ChatViewProvider.ts`, `src/extension.ts`, `package.json` (commands), `package.nls*.json` | `find` / `findJump`, `gotoFindHit`, the two commands, the QuickPick |
| **C** webview | `media/main.js`, `media/style.css`, `src/chat/webviewShell.ts` | the shortcuts, the bar, the panel, the marks, `pendingReveal` |
| **D** docs | `manual/manual.md` + the two translations, `CHANGELOG.md`, `AGENTS.md` (directory line), `l10n/bundle.l10n.*.json` | the user-facing text in three languages |
| **E** integration | `tools/check-webview.js`, the closing procedure | the guard fixtures, compile, package, reload |

New user-visible strings, in one list so the two catalogs cannot drift: `Find in
Conversation`, `Find in All Sessions`, `Find`, `Previous match`, `Next match`, `Close
find`, `Match case`, `Match whole word`, `Use regular expression`, `No matches in {0}
cards`, `Invalid regular expression: {0}`, `Search stopped early at {0} results, narrow the
query`, `Answer`, `Question`, `Conversations · {0} hit(s)`, `Search every conversation of
this workspace`. Each one is a single `vscode.l10n.t('…')` (host) or `tr('…')` (webview)
literal.

## 5. Phases

- **P1 (A)** — `find.ts` plus `check:find`: corpus rule, order, the three toggles, an
  invalid regex, the cap, a deadline. No UI: this is where the semantics are frozen.
- **P2 (B)** — the two message cases, `gotoFindHit`, the two commands, the QuickPick.
  Landing: the palette opens a conversation's find bar and jumps to a hit.
- **P3 (C)** — the shell markup, the bar, the shortcuts, the card marks, `pendingReveal`.
  Landing: Ctrl+F walks the hits of the open conversation.
- **P4 (C)** — the results panel, grouping, the row click.
  Landing: Ctrl+Shift+F lists every conversation's hits and jumps between them.
- **P5 (D+E)** — the three manual pages, the l10n catalogs, the guard fixtures, the
  CHANGELOG entry under `[Unreleased]`, compile, package, reload.

## 6. Risks and the one measurement

- **Host-thread cost.** The scan reads stored strings, so no clipping or joining happens,
  but "all conversations" on a large profile is still the whole workspace's text. It is
  bounded three ways: `yieldTo` between cards, a deadline (500 ms for `session`, 2000 ms for
  `all`) and the match cap. Over the deadline the answer is `timedOut`, and the bar says so
  instead of showing a partial list as complete (the `search_transcripts` rule).
- **The measurement this plan owes:** one real profile, `sessions`, cards, characters,
  and the wall time of one `all` query at 200 results, reported as a `[perf] find` line. If
  it cannot fit the 2000 ms budget, the first move is the deadline and a "search this
  conversation instead" prompt, not an index. **Answered in §9.**
- **A pathological regex** can still spend a long time inside one card's answer, because the
  deadline is read between cards. The query is the user's own typing and the tab stays
  usable; if a measured case says otherwise, add a per-field length guard.
- **Marking cost inside a card.** Only cards with a hit, only while the bar is open, at most
  once per frame, and every pass unwraps first. A windowed or unloaded log is marked when it
  renders (a jump checks the card out, so it renders).
- **Shadowing Ctrl+Shift+F** only works while the webview has focus. Outside it, VS Code's
  file search opens; the two commands are the answer, and the manual says so.
- **A read-only window** (another window owns the workspace) can search; a jump moves a
  pointer, which that window does not persist (`noteFocus` refuses the write there).

## 7. Guards and the manual

- `npm run check:find` (`tools/find-acceptance.js`, plain node over `out/`, the shape every
  other guard uses) asserts: the answer is the last assistant text and not a tool row; the
  question is the first user row; a bg card is skipped; the order is the reading order; the
  three toggles; `search_files(` as a literal; an invalid regex as `invalid` and not a
  throw; the cap; a deadline that reports `timedOut`; a surrogate pair never split.
- `npm run check:webview` gains `findResults` and `findOpen` in `TURN_MESSAGES`, so a
  reference to a dead identifier inside either handler fails the guard instead of freezing
  the tab silently.
- `npm run check:docs` sees the two new command titles, so each of the three manual pages
  must list them in §12; the feature itself gets a short §3.7 ("Search a conversation") in
  each page.
- `npm run check:l10n` sees the new literals, so both zh catalogs must be filled in.
- Closing: `npm run compile` clean, then `powershell -File build-deploy.ps1`, then the
  window reload (`node tools/reload-window.mjs --message …` where the control plane is on).

## 8. Decisions taken

- **Corpus is the question and the final answer**, not the steps and not the raw API
  messages. It is what a card shows, it is not clipped, and it keeps a hit a card.
- **The disk is out, the memory is in.** The isolation argument is §1.1, and it is also why
  no "other workspaces" switch exists: the search must never read another folder's
  conversations.
- **The VS Code Search view is out** because no stable API can be given results; the
  Command Palette entries are the official surface this feature gets.
- **QuickPick navigates, it does not query**, because its filter cannot be disabled.
- **Ctrl+F covers the whole conversation, all branches.** A fork is part of the same
  conversation, and the branch rides on every hit so the panel can say which one.
- **No row-level jump in this plan.** It would need per-row indices, opening folded groups
  and rendering around a windowed log, and the corpus decision makes it unnecessary.

## Related

- `invariants/session-persistence.md` — the store layout and the workspace key this feature
  relies on for isolation.
- `invariants/transcripts.md` — the agent's own search, what it can see, and why the user
  search does not read the same files.
- `invariants/i18n.md` — the two lookup paths and the guard that keeps the catalogs whole.
- `user-manual.md` — the three pages, the command table the new commands must enter.
- `invariants/streaming-perf.md` — why a host-thread scan has a deadline and a yield.

## 9. Landing record

Landed as planned, with four deviations worth reading next to the contract.

- **Measured, and the budget question is closed.** A synthetic workspace shaped like a
  large profile (80 conversations × 60 cards, 8.2 M characters of answers and questions)
  scans in **6–7 ms** for a rare query and for a regex, and **2 ms** for a query that hits
  the 200-row cap; 20 × 40 cards (1.4 M characters) takes 1–2 ms. The 500 ms / 2000 ms
  deadlines are therefore safety nets of roughly 300× the measured need, and no index is
  warranted. The `[perf] find scope=… hits=… nodes=… sessions=… ms=… q="…"` line in
  `handleFind` is the one that will report the real number in a user's window.
- **The jump carries its query (`findJump` seed).** §2.6 described a jump as a checkout plus
  a `panTo`, which is right inside one conversation and wrong across two: clicking a hit in
  another conversation opened that tab and the bar was gone. `findJump` now carries
  `scope`/`query`/the three toggles, `gotoFindHit` forwards them as a `findOpen` seed **only
  when the tab really changes**, and the seeded tab re-runs the search with the clicked card
  as its current hit (`findState.focusNode`). The QuickPick's accepted row seeds the same
  way, with the query typed in the picker.
- **`limit` is not accepted from the webview.** The cap belongs to the corpus module
  (200 default, 500 hard) and a tab cannot raise it; the request still carries `limit: 200`,
  which is the default, so §3.2's message shape is unchanged.
- **Sixteen sentences, not seventeen.** `Find in Conversation` is only a **manifest** title
  (`package.nls*.json`, prefixed `Spinney: ` like every other command); no code asks
  `vscode.l10n.t` for it, so a catalog entry would be reported stale by `check:l10n`. The two
  catalogs carry the other sixteen strings. The manual's §12 closing line ("Spinney adds no
  default keyboard shortcut") was clarified in all three pages, because these two keys are
  shadowed inside the chat tab.

- **The result list keeps its place.** Two things were losing it: `findRenderResults` emptied the
  list on every render (an empty box clamps `scrollTop` to 0), and `findSelect` rebuilt the whole
  list on every Next press, so walking the hits scrolled the reader back to the top. The render now
  reads `scrollTop` first and hands it back, `findSelect` only moves the `current` marker between the
  rows already on screen (`findMarkRows`), and the current row is scrolled into view
  (`findScrollCurrentIntoView`) — which is what makes the seeded jump into another conversation land
  on the clicked row instead of the top of a fresh list.
- **A result row is inline markdown.** The snippet is a ±60-character window of an answer, so
  `renderInline` on a second markdown-it instance (`mdInline`) is the only rendering that
  applies: blocks start outside the window. That instance disables the `link`, `image` and
  `autolink` rules — the row is a `<button>`, so an `<a>` in it is invalid HTML that would also
  take the click from the jump, and an `<img>` would make the webview fetch a URL a conversation
  happens to hold — and `html: false` already escapes raw HTML. Everything the row can now show
  (`<strong>`, `<em>`, `<code>`, `<s>`) is styled at the row’s own dim size in `media/style.css`.
  The mark moved with it: the host’s offsets point into the markdown *source*, and rendering
  removes the markers, so `findMarkZone` locates the query again in the rendered text nodes — the
  same walk a card uses. Two honest consequences: a query that is itself markdown syntax (say
  `**`) no longer appears in the rendered line, so the row shows no mark while the counter still
  counts the hit; and the build-time stub of `check:webview` has no markdown-it, so the guard
  asserts the plain fallback (`findSnippetPlainEl`) instead of the rendered path.
- **A row click selects, a double-click opens.** Opening a card is a checkout: it moves the
  composer and can switch the whole tab, which is too much for a stray click in a list of 200
  rows. The row carries the tooltip (`Double-click to open the card`), and `Enter` / `F3` / the
  arrows still walk and open the current hit. The current row is a background only — the 2 px
  left rule it used to draw is gone.
- **The camera never moves on its own.** Typing only *selects* a hit: the row, the counter and the
  card's outline. Going to a card is an explicit act — a double-click on a row, `Enter` / `F3`, the
  arrows, `Next` / `Previous`, or the host's `panTo` for a seeded jump into another conversation.
  An earlier version re-centred on every answer, which is the "magnet" a drag has to fight: an
  answer arrives asynchronously (a debounce plus a scan), so the camera must not follow it. Two
  smaller sources were removed with it: the current row is scrolled with arithmetic on the list's
  own box instead of `scrollIntoView` (which scrolls **every** scrollable ancestor, the document
  included), and the panel is `min(340px, 45vw)` so it can never swallow a narrow canvas and turn
  its left strip into a dead zone for the pan gesture. `check:webview` pins the camera rule by
  comparing the canvas transform across a `findResults` answer (with a finite card box, so the
  comparison cannot pass for the wrong reason — a mutation that puts the pan back fails it).
- **A fold must invalidate the box the engine remembers.** The bug this fixed is worth naming,
  because it is a rule of the card-skip mechanism rather than of search: a card far off screen is
  skipped with its last measured box in `contain-intrinsic-size`, and `relayout()` reads
  `offsetHeight` — so a card that *collapsed* while it was skipped kept feeding its unfolded
  height into the layout, and every card after it was misplaced (the report: double-clicking an
  earlier card folded the descendants but they kept their unfolded positions). The four places
  where a card's structure or content changes (`collapsedCard`, `expandedCard`, `monitorCard`,
  `renderNodeItems`) now call `cvWakeForMeasure` first, and the `relayout()` that follows writes
  the **new** box back, so the placeholder describes the card that is really there. The build-time
  guard cannot model `content-visibility`, so this one is verified by the real window.
Known edges, deliberately left:

- A query of ~80 characters or more can produce a 201-unit snippet: `clipText` appends its
  `…` after the 200-unit cut. Harmless, and `check:find` pins the 200-unit intent.
- A pathological regex can still spend a long time inside **one** card's answer, because the
  deadline is read between cards (§6). The tab stays usable; a measured case would add a
  per-field guard.
- The stub DOM `check:webview` replays into has no `createTreeWalker`, so the guard asserts
  the wiring (the two card classes, the grouped rows, the counter, the `findJump`, the
  invalid-pattern state) and not the painted `<mark>`. The text marks and the camera are the
  one half of this feature that only a real window shows.
