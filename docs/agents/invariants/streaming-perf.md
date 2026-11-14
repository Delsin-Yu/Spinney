## Streaming / long-session performance
- SSE tokens are **not** forwarded 1:1. `SessionRuntime.scheduleStreamFlush` coalesces a
  run's `streamDelta` / `reasoningDelta` / `toolCallDelta` (~50ms) and only then
  `postMessage`s to the webview; every such message carries the run's explicit `nodeId`.
- The webview paints a streaming answer as a plain `Text` node (`appendData`);
  markdown-it runs **once** when the answer is finalized (`done` / `toolStart` /
  `interrupted` / `error`). Re-parsing the whole reply on every token is what used
  to freeze the sidebar after a long session.
- Tool cards shown in the UI (and persisted `displayItems`) cap args (~8 KiB) and
  result (~32 KiB). Agent `messages` still carry the full tool payload for the model.
- **The window-global terminal dock repaints one row, never the tree.** `backgroundsGlobal` is
  coalesced ~200 ms in the host (`ChatViewProvider.scheduleBackgroundsGlobal`), exactly like the
  per-session `backgrounds`, and the webview diffs it row by row (`renderTerminalDock` in
  `media/main.js`): a row whose own signature (command, status, both clocks, output tail, badges,
  session title) did not move is left completely alone, a changed row is rebuilt in place, and a
  row that left the list is removed. The dock is a `fixed` element **outside `#tree-canvas`**, so
  nothing on that path re-lays out the tree — a job that prints a line a second cannot make a
  40-card session lay out again, which is what a dock inside the canvas would cost. Its elapsed
  chips go through the same 250 ms local ticker the cards use (the host ships clocks, never a
  counter), and `tools/check-webview.js` pins that the dock's section contains no layout call and
  that an unchanged snapshot rebuilds no row.
- **A turn is one essay, and its rows follow the turn.** The log is a linear flow, so
  the only row with a *live* state is the thinking row: it is open while its turn runs
  (the upright 13 px paragraph) and collapses to one ellipsised line the moment the
  answer's text takes over or the turn ends (`done` / `interrupted` / `error` →
  `endRun` → `settleRowsFinished`). A click hands *that* row to the user for good
  (`_userTouched`), and so does the row's own follow light being released — a reader
  who scrolled the reasoning box up is reading it, so a row the reader released stays
  open when the turn ends — and the rule then leaves it exactly where they put it. A tool row
  is folded at rest whatever it is doing — its one line already says what the step was —
  and a click opens its detail. The **steps groups** follow the same hand-over rule per
  group: each is open while its run is live, folded when the turn ends, and a click on its
  own header always wins for that one group — and a group holding a row the reader released
  stays open, or its fold would hide that row. `setThinkingOpen` / `setToolOpen` /
  `setActiveRow` / `clearActiveRow` / `closeActiveRows` / `setStepsFold` in `media/main.js`;
  `tools/check-webview.js` asserts both halves ("the two rows of a turn") and the per-run
  groups ("steps groups: one per run").
- Transcript scrolling is **per-card and event-driven**, and a card has exactly one
  scroller: `.node-work`, which holds the whole turn (see §"One card, one flow"). It has
  a `createScrollController` with a green follow dot
  (`attachLock(container, host, locked)`) and it is also the only container that
  windows a long transcript. The controller starts following only for a **live** turn
  (`status === 'running'`); a finished node starts released and is positioned at its
  newest content once on first render, so history is scrollable immediately — that one
  move is carried by `_needsBottomScroll`, which the item-render paths
  (`expandedCard` / `renderPath` / `applyFetchedItems`) consume through
  `pinToBottom()`. **A repaint never moves a scroller**: only the follow light
  (following → pinned to the bottom) and the once-per-card "opens at its newest content"
  may move it (§"A repaint never moves a scroller", below).
  **The green light means follow, not a lock on the scrollbar.** The reader may scroll
  while it is on, and the rule is the *direction* of their move: a `scroll` that lands at
  the bottom (`top + clientHeight >= scrollHeight - 2`) engages follow, and a `scroll`
  above the bottom whose offset moved **up** since the last one releases it — the dot
  dims and the log keeps the reader's offset. Nothing else may release it: a
  `scrollToBottom` / `pinToBottom` pin and plain content growth only move the offset
  *towards* the bottom, which is exactly the bug the direction rule fixes. The old
  heuristic asked "is it still at the bottom?" on every pass, and a heavy stream answered
  "no" — so a card unlocked itself under its own output. The pin also **stands down** while
  the box sits above the offset the controller last wrote: that is the reader's move whose
  `scroll` has not been dispatched yet, so the one ordering that could fight a drag (a
  delta first, its event second) still leaves the light out and the offset where the reader
  put it. Clicking the dot toggles it, and
  engaging follow scrolls to the newest content immediately. The light also follows the
  turn lifecycle: `setBusy(true)` engages the active card, `done` / `interrupted` /
  `error` release it, and sub-agent cards engage on `agentStart` / release on `agentDone`
  (`setCardScrollLock`). `scrollToBottom()` is a no-op while the light is off. The class
  `scroll-locked` is the light's state and nothing more — it must never hide the bar or
  block manual scrolling (no `overflow` rule).
  The dot sits in the strip the container reserves below its scrollbar
  (`margin-bottom: 20px`), on `.node-work-wrap` — the log's box, which is not itself a
  scroller. **Its horizontal offset is measured, not fixed** (`lockDotRight` /
  `syncLockDot`): the log keeps a `scrollbar-gutter: stable` strip, so the light is
  centred on that gutter — `(gutter - dotWidth) / 2` plus the host's own right padding,
  because `right` is measured against the host's padding box — instead of sitting half a
  gutter to the left of the bar it belongs to. The card's layout pass (`relayout`) is
  what measures it (a card is appended a few lines after its dot is built, so the
  attach-time attempt sees no box), and the stylesheet's `right` is the fallback for a
  box with no layout at all — the case `tools/check-webview.js` pins, because a guard's
  DOM reports 0 for every box. **The reasoning box has its own light**: the open thinking
  row is a 240 px
  scroller of its own, so it carries a small dot in its bottom-right corner
  (`attachRowLock`, `.thinking-row > .scroll-lock-dot`), in the row only while the row is
  open, under the same direction rule; its click releases or re-engages that box and
  `stopPropagation`s, because the row's own click opens and closes the row. The tree
  viewport itself is a pannable canvas (pan/zoom/fit), not a scroll container.
- `[perf]` lines (request JSON size, assistant-round, tool timings, persist, stream
  flush) go to the **Spinney** output channel. Open View → Output → "Spinney". Every
  one that reaches the diagnostics file also ends with a ` | at=<ISO8601>` stamp, and
  each tool call now writes a `tool-start` line before it runs — see the log section
  below.

**The character / element appear animation never becomes the streaming surface.** The
plain `Text` node is still what a streaming answer (and a thinking row) is painted
into, and a delta's text is **complete in the DOM the moment it arrives**, so nothing
rate-limits the reveal and nothing queues it. What is animated is only its appearance,
**one word at a time**: each token of a delta (a word, or one CJK character, with its
whitespace) sits in a transient `<span class="word-in">` that fades over 200 ms,
staggered 6 ms per token up to 36 ms (`.d1`…`.d6`), and a span is merged back into the
same `Text` node when **its own** `animationend` fires (with a 400 ms timer behind it,
past every delay plus its run, because an engine that never fires the event — the
offline guard's stub does not — must still settle). **The stagger has to stay far
shorter than the fade**: `stagger × words` is how long a burst takes to light up end to
end, and once it reaches the interval between two bursts the bursts overlap and the
stream stops reading as one. That cadence is the one measured frame by frame from
claude.ai (200 ms per word, a few milliseconds apart); it is opacity alone, with no
rise — Claude Code's own CLI does not animate its answer text at all, its
`StreamingMarkdown` only re-lexes the growing block. **The spans hold the unsettled
tail of the host's text, in document order**, and only the oldest settled word may be
merged: the `Text` node holds the settled *prefix*, so an out-of-order merge would put
text in the wrong place. `_settled` counts the characters in that node and `_wordChars`
the ones still in spans, which keeps the delta slice exact mid-fade. The span is an
**inline** one, never `inline-block`, which would change line breaking and trim the
token's trailing space; an opacity-only fade needs no position on it at all. A token's
word is extended in place when the next delta continues a word the stream split (so no
word is typed in fragments), the queue is capped at
`MAX_PENDING_WORDS` (24) by merging the oldest at once, and a merge is idempotent and
safe when a repaint or a finalize already removed the span.
`finalizeStreamingAnswer` settles everything **before** the markdown render, and
`reset` / `tree` settle the words in flight before their cards are replaced. A new
row (assistant text, tool, thinking, notice) arrives on one `.row-in` fade + 2 px rise
that is removed again on `animationend`. **The verb of a step that is still working rides
a wave**: Godot's `[wave]` moves a run of text up and down by giving every glyph a sine
whose phase advances with its place in the run, and this is the same shape. `setVerbText`
puts each character of the verb in its own `<span class="w">` with its index,
`media/style.css` turns that index into a negative `animation-delay` (−90 ms per
character) on one 1.2 s `ease-in-out` keyframe. **The offset is a `transform`, and it only
goes up** (`0 → −2 px → 0`): a relative `top` is repainted per frame and its downward half
grows the work log's scrollable overflow, so a following log re-pins itself every frame and
the scrollbar is pushed over and over, while overflow above the box is not scrollable and
leaves `scrollHeight` unchanged. A transform needs a box, so each character is
`inline-block` (a non-replaced inline box ignores `transform`); the price is this one short
word's kerning pairs. The spans exist whether the setting is on or off: only the animation
is gated, in CSS, by
`.msg.tool.running .tool-verb .w` and by `body.anim`, the class the `config` message
sets. `tools/check-webview.js` pins the span-per-character shape, because a verb written
as plain text reads the same and moves nothing. **A highlight travels along that verb at
the same time**, and along the tag of a live thinking row (`.msg.thinking-row.live`, which
`setActiveRow` marks): a second animation of `color` on the same spans, with its own slower
phase step, so the crest of a brightness wave moves through the word. Nothing fades; a
character at rest is the verb's own `--text-dim`. This is Claude Code's
`useShimmerAnimation` in its own shape — it interpolates the colour of the characters around
a moving index. The first attempt was a clipped gradient on the parent
(`background-clip: text`) and it is deliberately gone: a `transform`ed child is painted in
its own context, so the clip lost the glyphs and the whole word vanished while it ran. A tool
call that is still being written is one fixed line (`Writing tool call...`, see below),
so no label is rewritten per delta and there is no `.label-in` fade: the only text a
composing call changes is its verb, and that changes on a name delta.
`spinney.streamAnimation`
(absent ⇒ on, in the `config` message) is the **only** switch, and it turns all of it off
into exactly the old rendering (the glimmer included, through `body.anim`). The
browser's `prefers-reduced-motion` wish is deliberately
**not** consulted, neither in the script nor in `media/style.css` (there is no
reduced-motion block at its end): the OS toggle behind it also drives every other
animation on the machine, so a reader who keeps the system's animation effects off and
still wants this one would have no way to say so, while the setting is explicit and per
window. `tools/check-webview.js` pins that a delta is readable at once, that the spans
hold the unsettled tail in order, one per token and staggered, that the `config` message
marks and clears `body.anim`, that the setting off creates no span, and that a matching
`prefers-reduced-motion` query still gets the animation.

### One card, one flow: `ask` + one log

A turn card — and a sub-agent sidecar card — reads as **one essay**. There are two
containers and no more:

- **`.node-ask`** — the pinned user prompt, Markdown-rendered; it does not change once the
  card exists, and it stays out of the scroller so scrolling a long turn never hides the
  question.
- **`.node-work`** — the card's **only scroller**, holding every row of the turn in the
  order it happened. There are no zones and no window above a fold: the rows are the flow.
  The process is grouped **per run of tool rows**: a tool row opens a steps group
  (`.steps`, `data-kind="steps"`) when none is open, an assistant **text** row closes it,
  and the next tool row opens another — so a turn can hold several `Ran N steps` groups
  (`Ran 1 step` when it is one), each with its own `.steps-body`, its own count and its
  own fold state (open while its turn runs, folded when the turn ends, and a click on that
  header toggles it and always wins **for that group**). A thinking row, a notice, a
  background/sub-agent notice and a `HARNESS` block join the open group's body when there
  is one and stand in the log itself when there is not. **The text always stays in the
  flow**: an assistant text row is appended to `.node-work` itself, never into a group's
  body, so the model's **final answer is simply the flow's last text block** — there is
  nothing to lift out, and no second place an answer could live (`.msg.assistant` has no
  background or border; the error variant keeps its tint). A turn with no tool calls has
  no group at all: its reasoning line and its answer are the flow.

That is the whole structure. It replaced a three-zone card (`ask` / `work` / `answer`)
whose third zone was a *move* of the log's trailing answer run, and the machinery that
went with it is deliberately **gone**, not disabled: `promoteAnswer` / `demoteAnswer` /
`syncAnswerZone` (the move), `settleAnswerSplit` + `SPLIT_MEASURE` / `SPLIT_MEASURE_LOG`
(the measured share), `autoWorkFold` / `setWorkFold` / `updateWorkHead` and the classes
`has-answer` / `work-folded` / `answer-split`, the containers `.node-answer-wrap` /
`.node-answer` and the log's fold header `.node-work-head`, plus the per-card memories
`_answerAnchor` / `_answerOpened` / `_workTouched`. The single steps group's own
`moveAnswerOut` went the same way with it: a text row is never inside a group, so the
answer needs no move at all. History is why: the split had to be *measured* on every append
(the answer's natural height is not something a stylesheet can read), and every measured
pass was a chance to move a reader. One flow needs no measurement at all — the card's own
cap (`--node-max-h`, 840 px) bounds the log, and a long turn scrolls in it.

**A cold card builds only what it shows, group by group.** A finished card with steps
paints the flow, **each** group's header and the answer; every group's body is empty until
the click that opens *that* group (`paintStepsBody` builds it once, from the group's own
`_lazy` list, and the header's count travels with the group until then). That is also why
the old scroll *window* now applies only to a tool-less long turn: a card with steps is
bounded by the folds instead, and `renderNodeItems` skips `paintItemsWindow` for it.

**The two rows.** A tool call and a piece of reasoning are *lines in the essay*, not boxes
stacked on it, and each has one renderer used by both the live path and the history
repaint. The log carries **three type levels** and nothing louder: the prose and the
reasoning are normal text (13 px `--text`, upright), a tool row's line is one step down
(the bold verb and the label both 12 px `--text-dim` — one grey for the whole title), the
expanded detail is one more (11 px `--text-dim`), and the usage line stays the faintest
footnote (10 px `--text-dim`).

Two things and no more say *this is a step*: the step's own line is **italic** (`.tool-verb`
and a prose `.tool-label`; a `.tool-label.mono`, the `.tool-elapsed` chip and everything in
`.tool-detail` stay upright), and a step is the only thing **inset** — one rule,
`.steps-body > .msg.tool { margin-left: 15px }`, which puts a row's text on its
header's own `Ran N steps` label. The inset traces one step at a time and never a block:
the reasoning row that rides the same body keeps the prose's left edge and is deliberately
not italic either, because what the agent *said* is not a step and the italic marks what it
*did*. `.steps-body` itself carries no padding and no rule down its side.

- **a thinking row** (`.msg.thinking-row`, `data-kind="thinking"`) — no header, no
  chevron, no label: the row *is* the control. Open (while its turn runs) it is the
  paragraph in the same type as the prose (no dim, no italic), capped at **240 px** with
  its own scrollbar so a long reasoning cannot push the turn below the fold, and its tail
  is the turn's usage line
  (`[Prompt: {0} + Completion: {1}, Cache Hit: {2}, Cache Miss: {3}]`). The box follows its
  own stream — it carries its **own green dot** while it is open, and the same direction
  rule as the log (`appendThinking` calls the row's `scrollToBottom()`; a reader who
  scrolled the box up released it, and the next delta does not take it back). Closed it is
  one line of the same text, ellipsised in CSS, with no scroller and no light.
  `setThinkingOpen` owns the two states and puts the dot in the row on open / takes it out
  on close; `_open` mirrors the class. It joins the open steps group's body when there is
  one, and stands in the log itself when there is not. **A message's reasoning and its
  text are one row and one block, whatever order the provider streams them in**: a
  `thinkingDelta` that arrives after that message's text has started joins its own row
  above the answer, in place and without re-opening it.
- **a tool row** (`.msg.tool`) — one line: the bold verb, the label and the elapsed chip.
  There is **no status dot**: the ticking chip is the running cue (the row still wears its
  `running` / `done` class, for anything that reads the state rather than looks at it), and
  the verb and the label are both `--text-dim`, so the whole title reads as one grey. The
  verb is per tool, `tr()`-localized (`TOOL_VERBS`: Read /
  Viewed / Wrote / Edited / Appended / Listed / Searched / Recalled / Ran / Checked /
  Waited / Killed / Fetched / Spawned / Hopped / Finished / Renamed; a name no verb knows
  keeps its own name) and bold. The label is
  **`DisplayItem.title`** — `exec_command`'s required `title` argument, read out of the
  call's arguments on the host (`toolTitleFromArgs`) and stored on the item, so a clipped
  argument string can never lose it — else `toolBrief()`'s path/command/pattern. It is
  12 px `--text-dim` and set in **monospace (11 px) only for a derived command or pattern**:
  `const mono = !title && MONO_LABEL_TOOLS.has(name)` in `addTool` / `finalizeLiveTool`, so
  a `title` always reads as normal text. That
  monospace label is also the one part of the line that stays **upright** — the verb and a
  prose label are italic — because Consolas has no true italic and an 11 px synthesized
  oblique smears a command's glyphs. The
  detail (`.tool-detail`) is folded at rest and a click toggles it: the `> command / args`
  line, a `pre` block with the full result (the existing UI caps still apply: args ~8 KiB,
  result ~32 KiB, enforced host-side by `clipForUi`), the error text when there is one, and
  the usage line. The whole detail is one level down — 11 px `--text-dim` (monospace for
  the command and the output, because it is code) — and the usage line inside it stays the
  faintest footnote of all. A running row's chip ticks (250 ms); a finished row's chip
  freezes at the host's `ms`.

Both are also the reason a card no longer grows a block per call: a step that took ten
tools is ten one-line rows, and the reader who wants the output opens the one they care
about.

**A call that is still being written is one row with one fixed label.** While the model
composes the call's arguments the row says exactly that — `Writing tool call...`
(`LIVE_TOOL_LABEL`, a `tr()` key) — and nothing else: no argument text, no elapsed chip
(nothing has started yet), and a detail that stays empty until the call settles. The verb
is the one thing that follows the stream, because the tool's **name** arrives in pieces
(`appendLiveTool` appends them and re-reads `toolVerb`); the arguments do not, which is
why `toolCallDelta` stopped carrying them at all and no longer grows a string in the
runtime either. `finalizeLiveTool` (on `toolStart`) turns that same element into the real
row in place — verb, label, monospace, chip and the detail painted from the settled
arguments — so a live call and a replayed one are still the same element shape.
`tools/check-webview.js` pins the draft's shape, the verb following two name fragments,
and that `toolStart` upgrades the same row rather than adding a second one.

**`renderItemInto` is the same rendering as the live path, split the same way.** The
history repaint builds a tool row with the one \`addTool\` (which takes the whole row state —
\`{ name, args, id, title, usage, status, start, ms, content }\`), a thinking row with the
one \`makeThinkingRow\`, and an answer with the one \`addAssistant\`; a live call goes through
\`addLiveTool\` → \`finalizeLiveTool\` and mutates the same element shape instead of building a
second one. The **split** is one rule for both: a tool row opens a group when none is open,
a text row closes it (and is appended to the log itself), a thinking row rides the open
group. \`tools/check-webview.js\` pins that equivalence by replaying the same items through
\`path\` and comparing the verb, the label, the classes, the chip and the folded detail
against what the live messages produced **and** the top-level kind sequence, the per-group
headers and each group's own lazy body against the live runs — a repaint that reformatted or
renumbered a turn would be a silent regression nobody could see without a window.

**The previews still work.** \`.node-excerpt\` (a collapsed card, and a monitor's footer) and
\`.node-summary\` (a sub-agent's one-line result) are untouched by all of this: they describe
a card that is not the reading surface, and they never held a row.

### A repaint never moves a scroller

**The guard is that a repaint never moves a scroller.** The log remembers the last offset it
was scrolled to — \`rememberScroll\` / \`scrollMemory\` / \`restoreScroll\` on the element, fed
by a \`scroll\` listener attached when \`createNodeCard\` builds the card — and it is put back
at that offset after every step that can destroy it: \`renderNodeItems\`' full re-render (a
\`tree\` / \`path\` repaint) and the window repaint (\`paintItemsWindow\`). It is never restored
while the card is following (the follow light owns the bottom) nor while
\`_needsBottomScroll\` is still pending, so only two things may move a scroller at all: the
follow light while it is on, and the once-per-card "opens at its newest content". A restore
is the memory's write and not the reader's: it hands the offset back to the controller
(\`syncOffset\`), so a repaint can neither release the light nor re-engage it, not even when
the remembered offset is the bottom.

A routed append is not a rebuild: it appends one row into the log that is already there, so
there is nothing to restore — which is exactly what the measured split could not say. The
history is why the rule is written down rather than assumed: when the log was briefly given
the height of its own content, the engine clamped its \`scrollTop\` to 0 and a reader who had
released the follow light was thrown to the top of their turn by every token. Nothing on the
append path measures the log any more.

**The window repaint corrects in both directions.** \`extendItemsWindow\` adjusts the scroll
position by the height difference whichever way the window grew; it used to correct the
upward direction only. \`tools/check-webview.js\` pins the whole thing: a released card's log
keeps its offset across a routed append and a \`tree\` / \`path\` repaint, a following card
still pins its log to the bottom, scrolling a windowed log does not lose the answer as the
last block, and the direction rule of the light (up releases, the bottom re-engages) is
replayed against the stub's own scroll offsets.

### Diagnosing a stutter (the `[perf] op#` traces)
A stutter — above all when **switching sessions** — is one user-visible operation
that spans two processes: the extension host creates a webview tab, renders the HTML
shell, builds the session runtime, persists the state and posts the session's whole
tree + path; the webview then renders the cards, the markdown and the layout. The
instrumentation therefore traces the *operation*, not each side, and joins the halves
by id (`src/perf.ts`):

- `beginOp(label, detail, {awaitWebview, subject})` opens `op#N begin …` and makes it
  the ambient op; `timedSync` / `opMark` / `opPayload` below it land in the same
  block with the op's own elapsed time (`op#7 +12ms panel-html 3ms bytes=118345`).
- The id rides in the repaint messages whose op is webview-facing **and of the same
  subject** (`opTag(sessionId)` → `reset` / `tree` / `path` carry `traceId`;
  `ChatPanel.post` also times the delivery of those three). The subject is the
  session: a window reload restores *every* chat tab at once, so without it one
  tab's repaint would end another tab's op (each `panel-repaint` /
  `checkout-node` / `switch-session` op is bound to its session through
  `startRepaintOp` / `beginOp(… {subject})`). The webview measures the burst it
  belongs to and posts `{type:'perfDiag', kind:'paint', …}`, which the host writes
  into the same block and uses to **end** the op — so `op#7 end 2210ms painted` is
  "what the user waited for", and the marks say where it went.
- Ops that nothing reports on (a tab that was *already* open only needs `reveal`, a
  lost report) end on their own: `tab already open (no repaint)`, or the 20 s
  deadline (`no webview report`).
- Ops: `switch-session` / `open-chat` / `new-session` (`ChatViewProvider.openTab`,
  `openSession`), `panel-open` (a tab coming up: `PanelManager.ensure`
  creates it, `PanelManager.adopt` revives one restored by a reload), `panel-repaint`
  (a tab repainting itself, `SessionRuntime.postAllState` / the `ready` handler) and
  `checkout-node` (a card click repaints a branch the webview may never have shown).
  The op belongs to whoever needs a webview report for that session **first** and
  every later step joins it, so a click that has to create the tab, build the
  runtime, persist and repaint is *one* block: the label says what started it, and
  the subject keeps two tabs (a window reload restores all of them at once) from
  writing into or ending each other's op.

What the marks are, in the order a cold switch produces them:
`panel-ensure` (existing vs. create) → `panel-create` (the webview window) →
`panel-html` (+ bytes) → `panel-focus` → `runtime-create` → `persist-queued` / `-done`
(+ `sessions=` `nodes=` `items=` `msgs=` and `chars≈` — `chars≈` is the same pass that
builds the payload — plus `coalesced=n` when a burst was folded into one write) →
`post-all-state`, `post-tree` / `post-path` (+ `bytes=`, which only `opPayload` emits,
i.e. only inside an op) → `deliver-*` (the host's `postMessage` resolved — this
is VS Code's ack, which for a webview that is still loading its scripts lags the
webview's own handling by hundreds of ms: that gap *is* the cold-tab cost, so read it
next to `webview-paint since=`) → `webview-paint` (`since=` from the burst's first
tagged message to the frame after it went quiet — the webview coalesces a burst with
a ~50 ms window, `BURST_QUIET_MS` — plus `steps=tree=…,path=…`, `markdown=ms/calls`,
`layout=`, `cards=`, `items=`, `dom=`).

Two probes catch what a single op cannot express:

- **`[perf] webview-handler <type> <ms>`** — one host message took at least
  `SLOW_HANDLER_MS` (40 ms) inside the webview; `webview-frames phase=stream
  worst=<ms> frames=<n>` reports the worst frame gap (`STALL_MS` 80 ms) of a burst,
  either while a switch paints or while a turn streams. Both thresholds live at the
  top of `media/main.js`'s perf block; a hidden window is skipped (throttling is not
  a stutter). The probes are diagnostics only and swallow their own errors — they may
  never affect the UI, and never swallow a handler's own exception.
- **`[perf] lag blocked <ms> (n late ticks)`** — the host's event loop was blocked
  (`startLagWatch`, 250 ms interval, reports a lag over 120 ms). This is the half no
  `perf()` line can write while it happens: a `persist-done` line is *late* exactly
  when the Memento write stalled the host. **It carries a ` | ctx: …` tail**
  (`setLagContextProvider`, registered by `ChatViewProvider.hostContext`) saying *what*
  was most likely occupying the loop — the persist machinery (`persist in-flight
  <ms>` / `persist idle, last done <ms> ago (took <ms>ms)`, the `chars≈` of that
  write, the coalesced `queued=` depth), then the **live host work** (`beginWork` in
  `src/perf.ts`): `work=[rg:6 req:15]` for the units alive at that instant (`rg` per
  ripgrep child, `req` per outbound API request), **`peak <label>:N`** for the highest
  concurrency reached since the previous report — a stall is over by the time the watch
  runs, so only the peak describes it — and the monotonic **totals** (`rg-spawn:32`: a
  burst of short units never shows as a high concurrent count), followed by
  **`heap=used/total MiB rss=…`**, because GC churn and real work look nothing alike.
  `workReadout()` resets the peak/total counters on read, so one burst is one line. The
  provider is asked **once per reported burst**, never per tick, and must stay O(1): it
  runs right after the loop was blocked, so any real work there would extend the stall
  it describes. `[perf] sidebar-refresh <ms>` / `<n>/s` reports the same for VS Code
  re-reading the session list (fired by `notifyStateChanged`).

  This is what attributed the 15-sub-agent storm: three runs reading
  `work=[peak req:15 peak rg:14 rg-spawn:32] | heap=77/109MiB rss=270MiB` showed the
  stall was **aggregate saturation** — not one blocking call, not the persist
  (7 ms queued / 80–100 ms done throughout) and not GC — which led to the ripgrep work
  budget (`RG_CONCURRENCY` = 6, `src/tools/searchFiles.ts`): 32 whole-tree scans fired
  at once cost 482 ms of loop lag offline and were *slower* than 6 at a time (890 ms vs
  741 ms), and with the gate the live storm reports **no lag line at all**.
- **`[perf] search-files ms=… files=… matches=… capped=… via=rg|walk scope=…`** — one
  line per `search_files` call, written by the tool itself (`src/tools/searchFiles.ts`)
  next to the generic `tool search_files <ms>` line the runtime emits. `via` says which
  execution path ran (the vendored ripgrep, the host's, or the in-process walk) and
  `scope` how many `search.exclude`/`files.exclude` patterns were in effect — `scope=0`
  for a root outside the workspace, where those settings deliberately do not apply — which
  is how a stall gets attributed to a specific search shape. `capped=wall` means the call
  spent its **one** hard budget (`spinney.searchTimeoutSeconds`, 10 s by default) and
  answered the timeout `Error:` line instead of a page; `ms=` is that whole call, ripgrep
  and the fallback walk included, so `ms ≳ 10 000` with `capped=wall` is expected, not a
  fault. A search is **allowed to be slow and still be healthy**: with `rg` the work is in
  a child process, so the number to watch is `lag blocked`, not this one. See
  `docs/agents/tools.md` for the tool's contract.
- **`[perf] dev tee dropped <n> line(s)`** — the dev-only `SPINNEY_PERF_LOG` file tee
  could not keep up (`ChatViewProvider.openPerfTee`, off unless the variable names a
  path). The tee exists because the output channel has no read-back API, which is what
  a harness needs to assert on these lines; the output channel stays the primary sink
  and a failing tee never loses a line from it.

### Open: a webview that stops painting

The symptom is real — a customer's screenshot shows a tab whose conversation stopped
changing while its turn was still running — but the reading this section used to carry is
not: that customer log does **not** prove a webview that "painted once and then never
repainted". Three independent reasons, each one a property of our own instrumentation
rather than a guess about that file:

1. **`post-tree` / `post-path` only exist inside a traced op.** Both are written by
   `opPayload`, which returns immediately when no ambient op is open (`src/perf.ts`), and
   an op is only open around a panel open, a repaint or a checkout — never around a
   streaming turn. That log holds 14 `post-tree` lines in 21642, every one of them inside
   an op block, so "zero `post-tree` for that session" after the switch is simply the
   normal shape of a tab that is already up: it proves nothing about whether the host
   posted, because the host posts deltas there, not trees.
2. **A routed message for a node with no card is thrown away silently.** `routeTo` looks
   up the card of the node the message names and returns without a word when there is
   none (`if (!itemsEl) return;`, `media/main.js`). A delta that arrived for a node the
   webview never built a card for is therefore indistinguishable — on *both* sides of the
   wire — from a delta that was never sent, so "the deltas kept arriving while nothing was
   painted" cannot be read out of that file at all.
3. **The big gaps in it are suspend artifacts, not freezes.** `webview-frames
   … worst=30431785` (8.45 h), `worst=466604` and `55554` sit next to `stream-flush …
   window=29951350ms` (11.9 h; 3.2 h and 1.2 h appear the same way), while the host's own
   lag watch around them reported only `lag blocked 342ms`. Two measurements of one pause
   of hours, in two processes, next to a host that was 342 ms late: that is a renderer
   that was **not running** — page hidden, window minimized, display off, machine asleep.
   The frame watch cannot report it as anything else, because it computes the gap when its
   callback finally runs and evaluates the hidden check *at that moment*, i.e. after the
   page is visible again; only the reporting is suppressed while it is hidden. **Read no
   `webview-frames worst=` of minutes or hours, and no `stream-flush window=` of the same
   size, as a stall** — the `suspend=` / `resume gap=` pair in the section below is what
   makes that split explicit from now on.

The open question stands: a tab **can** stop painting, and the customer's screenshot is
what keeps it real. What was missing is evidence only the webview itself can produce,
because the host cannot see inside it: the op trace goes quiet on a repaint that never
happens, and a delta posted to a tab with no card for its node is dropped without a
record. The instrumentation below is that evidence — a frame sampler inside the tab, a
probe the host can send when the tab goes stale, and one non-destructive nudge — and it is
what a re-report of this defect will be read against. The ` | at=` stamp (already shipped,
`ChatViewProvider.stampLine`) still matters for exactly this reason: without it the
header's `started` is the only time in the file, and the last painted op cannot be placed
relative to the deltas that followed it. `tools/check-webview.js` grows the matching
assertion — a repaint must come back as a paint report, and the new probes must **answer**
(the probe reply, its frame, the nudge frame, and a drop for a message routed to a node
that does not exist) — so a silently dead probe fails packaging instead of shipping
silently; that intent, and this issue, are recorded next to each other in `testing.md`.

**The first re-report, read against these lines (2026-10-03, build 0.2.0, 3 h 20 m).**
The same user hit it again on another machine, and the account of it is what the numbers
had to be matched to: *"the entire Spinney page becomes a small rectangle anchored at the
top-left of its webview, and it recovers by itself"*, after *"bringing VS Code to the front
and scaling the section"*. What those lines said:

- **27 `stale` episodes, 459 s in total, worst 84.1 s** — and every one of them closed with
  `recovered … via=self` within **0–202 ms** of the report. That is the signature of a
  renderer that comes back *in a burst*, not of a screen that stuttered.
- **26 of the 27 sat inside an unfocused window** (`[perf] window active=false`, the one
  exception lasting exactly the 3 s threshold). The sampler's "on screen" question had only
  ever asked about the page and the editor tab — so every stretch spent in another
  application read as a frozen screen, and the ladder (probe → nudge) ran for a screen
  nobody could see: 9 probes, 7 of them unanswered inside the deadline, **6 ladders ending
  `stale-unresolved`** — all of it noise.
- **The script was alive and nothing was lost**: all 9 probes were answered (up to 92.6 s
  late, `webview-probe-late`), `drops=0`, no `post-failed`, and the frame after each answer
  arrived in 2–61 ms. So neither "the script is dead" nor "the host stopped posting" — and
  the host was healthy throughout (one `lag blocked` line in the whole file, at startup).
- **The report written for the user's own description never fired once: zero
  `webview-resize` lines.** It was driven by the wrapper's *own box*, and that box is
  exactly the one a stale layout viewport does not move — so the defect it exists for is the
  one case it could never see.
- The load is real and worth naming (it is what made the bursts long): `dom=33432` nodes,
  one `canvas=1865x26602` layer, 40–58 ms per streaming message handler, **410–757 messages
  a second** handed to the tab, and 19–26 parallel tool calls in a single second.

Two changes came out of it, both reports and nothing else — the sampler's question gained
the window's own focus (so an unfocused window is no longer a stall, and the *return* sends
the surface snapshot the diagnosis was missing), and the resize report gained the window's
and the visual viewport's own events plus the whole surface on the line, so a document that
kept laying out at its old size states that instead of staying silent. Both are described
below, in the line list they belong to.

### The tab stopped painting: the frame sampler, the probe, and one nudge

Everything above measures a repaint that **happened**: an op ends on the webview's paint
report, so a tab that stops drawing looks like a session that went idle, and (reason 2
above) a delta dropped for a missing card is silent on both sides. The lines below are the
other half — the webview saying what *it* is doing, on every tab, whether or not anything
was asked of it.

**The sampler is one frame per second, and only while the tab can be seen.** A frame loop
posts a line a second while the document is visible and nothing at all while it is hidden
(a hidden page is throttled to about that rate anyway, and an unwatched tab has no user to
disappoint), so the sampler itself can never be the traffic it reports on: it is one
`requestAnimationFrame` callback per tick, never a continuous loop, so it cannot keep the
window from idling either. Stale is defined as a **3 s** gap in a *visible* tab: three ticks
that did not happen while somebody was looking, which no throttling can explain.

**"On screen" is three facts, not one, and the third was missing until the re-report.**
The page visible (`document.hidden`), the **editor tab** in front (`viewState.visible`), and
the **window** focused (`viewState.focused`) — because a window that is not in front is
painted on a different clock: Windows marks it occluded, the engine stops producing frames
and after minutes it freezes the script outright, and nothing about the page or the tab says
so. Measured on the re-report: 26 of 27 `stale` episodes sat inside an unfocused window and
the 27th lasted exactly the threshold, so every one of them was a screen nobody could have
been looking at. The webview now treats losing the window exactly like going off screen (the
episode in flight ends **without** a `recovered`, the frame clock is reset, the time is
accumulated in `winBlurMs`), and coming back is the moment the diagnostic exists for:

- `webview-focus state=return awayMs=… doc=… vis=… inner=… wrap=… canvas=… canvasDev=…
  canvasRect=… dpr=… zoom=…` — the **snapshot of the surface at the moment the window came
  back**, sent *before* the three frames that prove drawing resumed. This is the line the
  2026-10-03 report was missing: the complaint was "the whole page is a small rectangle in
  the top-left corner" and no line could say it, because at that instant nobody had asked.
  `awayMs=` is the stretch that just ended, so a short alt-tab is recognisable and ignorable.
  One line per return (59 of them in the measured 3 h 20 m), and a healthy one is still
  evidence: it says the surface agreed with its window at the moment the user came back.

- `webview-composer-focus state=blur|restore|restored|skip|lost reason=… hasFocus=… active=…
  relatedTarget=… msSinceBlur=… retries=…` — the **caret** half of the same return, and the
  one place the platform's own focus is visible. A retained webview document keeps its DOM,
  but `WebviewEditor.focus()` (which runs ~50 ms after the window comes back, throttled)
  focuses the webview's **frame**, not the element inside it, so the composer's caret blinks
  for a few milliseconds and is gone; VS Code closed "restore focus inside a retained
  webview" as out of scope for extensions, so the webview re-asserts the caret itself
  (`restoreComposerFocus` in `media/main.js`) and reports every sequence: `blur` is a caret
  lost while the window was away (`hasFocus=false`, `relatedTarget` is where the focus went),
  `restore` is a sequence starting (`reason=window|blur|mount|show`), `restored` / `lost` is
  how it ended after `retries` re-asserts, and `skip` is the policy refusing — the dock hidden
  or read-only, or a `focusout` that says the user clicked somewhere else in this document
  (`reason=window/hidden`, `…/readonly`, `focus-elsewhere`, `pointer-elsewhere`). `active=` is
  the element the document's focus was on (an id, or a tag plus two classes — never its text),
  `msSinceBlur` is `-1` when the caret was never lost in this document, and `retries=0` next to
  a `skip` is the proof that no focus call was even attempted. It is written per **sequence**,
  not per tick: a healthy return with the caret in the dock writes two lines (`restore`,
  `restored`), and one where the user had already clicked elsewhere writes none at all.

- `webview-stall state=stale ms=… frames=… hiddenMs=… tab=… tabHiddenMs=… canvas=… dom=…
  doc=… zoom=…` — the renderer stopped producing frames for at least 3 s **in a tab that is
  on screen**. `frames=` is the sampler's running total (it stops growing), `hiddenMs=` how
  much of the gap the window spent hidden, `canvas=` / `dom=` the size of what was being
  drawn (see the layer note below), and `tab=` / `tabHiddenMs=` the same question for the
  **editor tab**. The last two fields are the cheap half of the *other* shape a frozen
  picture takes: `doc=` is the document's own box, so a layout viewport that went stale shows
  up here as a `doc=` that disagrees with the window's size, and `zoom=` turns `canvas=` into
  the device pixels a layer limit is measured against. The full surface (`vis=`,
  `canvasDev=`, `canvasRect=`) is what the probe reply carries, and the host asks for one
  within the same 3 s.
- `webview-stall state=recovered ms=… via=self|nudge|probe` — the frames came back, and
  **what brought them back**: `self` (nothing was done, the renderer resumed on its own —
  the suspend case), `nudge` (the ladder's one nudge) or `probe` (the host asked).
- `webview-visibility state=hidden|visible ms=…` — the page's own visibility changes, so a
  gap can be attributed to a hidden window without having to read the host's side for it.
- `webview-resize via=observer|window|vv was=… doc=… vis=… inner=… wrap=… canvas=…
  canvasDev=… canvasRect=… dpr=… zoom=…` — the surface changed, reported by whichever of the
  three things noticed: the tree area's `ResizeObserver` (which also drives the re-layout),
  the **window's** own `resize`, or the **visual viewport's**. `was=` is the pair the previous
  report replaced (`<wrap>@<inner>`), and the rest is the surface readout below.
  A resize is where a canvas-backed view can lose its drawing surface, and `canvas=` is the
  size the surface actually has as the webview reads it: a resize that leaves it without a
  size is a document that can no longer paint whatever its cards say. Like the sampler, it is
  the webview describing its own surface instead of its work.

  **Why the observer alone was not enough, and what the fields are for.** The report used to
  fire only when the wrapper's own box changed — and that is precisely the box a *stale layout
  viewport* does not move: when the panel grows but the document keeps laying out at its old
  size, the wrapper measures the same as before and the one report written for this defect can
  never fire. The session that complained about exactly that wrote **zero** `webview-resize`
  lines in 3 h 20 m. So the window's and the visual viewport's events drive it too — they fire
  whether or not the layout followed — and the line carries the whole surface, which is what
  turns the two shapes of a frozen picture into numbers instead of impressions:

  | Field | What it is | What it says when it is wrong |
  |---|---|---|
  | `doc=` | `documentElement.clientWidth×clientHeight` — the document's own box, what layout believes it was given | behind `inner=` / `vis=`: the layout viewport went stale, so the page lays out at the old size and paints into the top-left corner |
  | `vis=` | `window.visualViewport` (`n/a` where the engine has none) | the size the compositor is actually showing; a `doc=` that disagrees with it *is* the defect above |
  | `inner=` | `window.innerWidth×innerHeight` | the window the document was handed |
  | `wrap=` | the tree area's measured box | a wrapper that changed while the canvas did not |
  | `canvas=` | the canvas' style box, in CSS pixels | — |
  | `canvasDev=` | `canvas × zoom × dpr` | the pixels the compositor owes for that one layer, i.e. the number a layer/texture limit is measured against |
  | `canvasRect=` | the canvas' laid-out box, `WxH@x,y` | the canvas kept an old box relative to its wrapper |
  | `zoom=` / `dpr=` | the tree's zoom, the device pixel ratio | the pair that turns `canvas=` into `canvasDev=` |

  A reported surface also **restarts the frame clock** (`if (staleSince == null) lastFrameAt =
  now`): re-laying out — and, on a tree this size, re-rastering one enormous layer — is a
  legitimate reason for frames to stop, and its own line is the evidence. An episode already
  in flight is left alone, because a stall that began before the line is not made untrue by it.

**The tab is not the page, and the first real logs proved it.** `document.hidden` is about the
*window*: a chat tab in the background of a visible VS Code window is not a hidden document —
so the sampler kept counting, the engine stopped drawing it (Chromium throttles, then freezes,
an off-screen `iframe`), and every switch away produced `stale ms=3972 … 48495` with
`hiddenMs=0`, plus one more `stale` in the milliseconds after the tab came back. That is noise
dressed as the very defect the probe exists for, and it buried the real case in five logs of
use. The host therefore pushes the fact the page cannot see, as `{ type:'viewState', visible,
active }` (`ChatPanel.reportViewState`), and the sampler treats "my tab is off screen" exactly
like the page being hidden: it stops, it accumulates `tabHiddenMs`, it ends an episode in flight
**without** a `recovered` (frames did not come back — the tab went away), and **it resets the
frame clock on the way back in**, so the one moment that matters is not reported as a stall of
frames that stopped for a reason nobody should report. A `stall` line afterwards means what it
says: a tab that was on screen did not draw for three seconds.

**The probe is how the host finds out which failure it is looking at.** The host asks on
its own at two moments: after **3 s** of staleness in a tab that is both `visible` and
`active` (there is a user in front of it), and when a traced op reaches its 20 s deadline
(`no webview report` — the existing end of an op nothing reported on, which is the same
defect seen from the host's side). It has to ask at all because nothing on the host's side
can tell a script that is dead from a script that runs and draws nothing — and that
discrimination is the whole purpose of the probe.

- `webview-probe-request session=… probe#N` — the host asked; `N` is the probe's number
  for that tab, and it is what the reply and the two failures below are named by.
- `webview-probe session=… id=N msgs=… drops=… frames=… lastFrame=… dom=… cards=…
  hiddenMs=… tabHiddenMs=… focused=… winBlurMs=… readyState=… doc=… vis=… inner=…
  wrap=… canvas=… canvasDev=… canvasRect=… dpr=… zoom=…` — the webview's own state,
  posted back in answer to that request: how many host messages it has handled
  (`msgs`) and how many it dropped (`drops`, the counter below), what the sampler saw
  (`frames`, and `lastFrame=` ms since the last frame it produced), the DOM and card
  counts it holds, how long it has been hidden (`hiddenMs`) and off screen
  (`tabHiddenMs`) and, because "is anybody looking at this tab" now has three parts,
  whether the **window** is focused (`focused`) and how long it has been away
  (`winBlurMs`), its `readyState`, and finally the whole surface (`doc=` / `vis=` /
  `inner=` / `wrap=` / `canvas=` / `canvasDev=` / `canvasRect=` / `dpr=` / `zoom=`, one
  template shared with the `focus` and `resize` reports — see the table below).
- `webview-probe-frame session=… id=N ms=…` — a frame was produced *after* the reply,
  which is the proof that the tab was drawing and not merely running.
- `webview-probe-dead … (no reply in 3000ms)` — the reply itself never arrived.
- `webview-probe-noframe … (no frame in 1000ms)` — the reply arrived, the frame did not.

**That pair is the whole point of the probe: it separates the script from the
compositor.** `webview-probe-dead` means the webview's script is not running at all — the
document never answered, so nothing inside it can be trusted (a crashed renderer, a
document whose boot threw, a message that never got through) — while
`webview-probe-noframe` means the script *is* running and its own state is readable, but
the compositor produced no frame: the DOM is intact and the surface is not, which is a
paint problem and never a logic one. The reply's numbers then say which part of the
surface: `hiddenMs` (nothing to paint), `tabHiddenMs` / `focused` / `winBlurMs` (nobody was
looking), `doc=` / `vis=` (the document's box against the compositor's — the stale viewport),
`canvas=` / `canvasDev=` / `canvasRect=` / `wrap=` (a surface with no size, or one too large
to repaint), `lastFrame` / `frames` (the loop running without frames, `frames` being the
running total that stops growing), `drops` (messages that found no card). That discrimination is exactly what the old reading of the customer log could not
make.

**`webview-drop node=… n=1`** is written the first time a routed message finds no card
for its node — the silent `return` in `routeTo`, and the one place where "the deltas never
arrived" and "the deltas were thrown away" can be told apart. It is written once per node
(`n=1`; a second drop for the same node does not repeat the line, or a broken route would
flood the log), and the probe reply carries the running total as `drops=`, which is what
turns one drop into a rate.

**`post-failed session=… type=…`** is the host's own half of the same question: a
`postMessage` to that tab was **rejected**, so the document is not there at all and nothing
the host sends can ever be shown. It used to be swallowed (`the webview was torn down
mid-flight; nothing to do`), which left "the host is posting into a document that is gone"
exactly as invisible as the drops it was feeding. It is written once per session, per
message type and minute, because a turn streaming into a dead document fails hundreds of
messages in a row and the first one carries all of the news.

**The ladder stops where it stops on purpose:** stale → probe → **one** nudge:

- `nudge session=… probe#N reason=stale` — the host re-applies the existing transform and
  re-runs the layout for that tab.
- `webview-nudge-frame …` — a frame followed it, i.e. the nudge was enough.
- `nudge-still-stale session=… probe#N` — it was not.
- `webview-stale-unresolved session=… ms=… ladder=r0,r1` — the end of the ladder: rung 0
  is the probe, rung 1 the nudge, and `ladder=` names the rungs that were climbed, so
  "nothing further was tried" is in the line itself.

**A `recovered` no longer cancels a probe already in flight, and a late answer is a finding.**
The first five logs of real use contained exactly **zero** completed ladders: a stall
self-reported `recovered` in the same millisecond the probe went out (the measured freeze read
`stale ms=174746` followed by `recovered` **12 ms** later), `endStallEpisode` cleared the wait,
and the probe's own answer — the one piece of evidence about that tab — arrived to nobody. Now
only the episode ends there; a deadline that passes keeps its wait and writes
`webview-probe-dead` as before, and the answer that arrives afterwards writes
`webview-probe-late session=… probe#N ms=…` and **continues the ladder**. That `ms=` is the
sharpest number this diagnostic has produced so far: a probe answered **257 s** late, next to
`lastFrame=173988` and `frames=388` over seventy minutes, is what identified a background tab
whose script the engine had frozen — not a stutter, and not something a 3 s threshold could
have described on its own. A second, ten-minute deadline forgets a probe that never answers.

**Coming back to a tab is the one nudge the host sends unasked.**
`nudge session=… probe#N reason=visible hidden=<ms>ms` follows every return to the front after
at least 3 s off screen, and it carries `force`: it drops the canvas' own layer and takes it
again (`perfOnNudge`), which is the invalidation a surface that was never repainted answers to
— a re-applied transform it already had can be a no-op. Nothing moves on screen, so it stays
inside the rule that the agent repairs nothing silently; what it buys is the experiment. If
`webview-nudge-frame` follows it, the stale corner is a repaint away; if `nudge-still-stale`
does, the surface had to be rebuilt, and the next suspect is the layer itself.

**The layer is the next suspect, and the readout for it is now on the stall line.**
`#tree-canvas` is *one* layer sized to the whole tree — measured in a real session at
`canvas=7928x8278` and `5749x11194` at `dpr=1.44`, against a viewport of a few hundred thousand
pixels — and every card in it used to be laid out and rastered whether or not anyone could see
it. A card that is far outside the viewport is now skipped by the engine
(`.node.cv-skip { content-visibility: auto }`), with the box it last measured written into
`contain-intrinsic-size` **first**, because `relayout()` reads `offsetHeight` and a skipped card
would otherwise feed a placeholder height into the tidy-tree layout. A live card, the focused
node, a card being dragged and any card something is written into (`cvWake`) are never skipped,
and the margin is 1000px, so the un-skip happens well before a card becomes visible. Whether
that is enough to stop the stale corner is what the `canvas=` / `dom=` fields on the next real
stall will say — and the 2026-10-03 re-report raised the number rather than settling it: its
worst canvas was `1865x26602` at `dpr=1.5` with `dom=33432`, i.e. ~40 000 device pixels of one
layer, while every stall of that session was inside an unfocused window. `canvasDev=` and
`zoom=` are now on the surface readout so the next one can be judged without arithmetic, and
the load beside it is worth naming too: 40–58 ms per streaming message handler and 410–757
messages a second handed to the tab.

**Nothing above the nudge is automatic**, and that is a rule rather than a missing
feature: a silent repair hides the defect — the tab paints again, the user never learns
why it stopped, and the log they would have sent never gets sent, so the next report is
about a defect we have already damaged the evidence for. The one automatic move is allowed
because it is **non-destructive**: it re-applies the transform that is already in effect
and re-runs the layout, so it never moves the camera and cannot change what the user sees
beyond repainting it, and the `webview-nudge-frame` / `nudge-still-stale` pair is what
tells us whether it was a **cure** (frames returned) or a **cover** (the tab is drawing
again and nothing we did explains why — which is itself the evidence we want).

**The user's escape hatch is a reload of the document, never of the session.** `Spinney:
Reload Chat Webview` rebuilds the webview document from the same HTML renderer the tab was
created with, and the fresh script's `ready` drives the host's usual repaint — the session,
its runtime and a running turn are all untouched, because the view is the only thing that
was broken. That is also its price: the new document starts empty, so the scroll position
and the cards the user had expanded are gone, which is exactly why the nudge is tried
first and why this is the user's move rather than an automatic one. It marks itself in the
log as `[panel] webview reload session=…`, so "I reloaded it and it came back" is a dated
line rather than a memory. A document that says `ready` a **second** time — a renderer
crash VS Code recovered from, or the reload above — writes `webview-reloaded session=…`:
the two lines are deliberately distinct, because `webview-reloaded` alone is the defect (or
a reload) reporting itself, while `[panel] webview reload` is what says a user asked for it.

**A slept machine can never be misread as a freeze again.** Both sides now name a long gap
for what it is: the host's lag watch writes `resume gap=<ms>` when a tick arrives that
late, and the `webview-frames` line carries `suspend=<ms>`, non-zero only for a gap of at
least **30 s** (that threshold is what keeps an ordinary hitch from being renamed a
suspend, so the field sits on every `webview-frames` line and reads `0` for the ordinary
case) — both describing the same event from the two processes. The `resume gap=` line is
deliberately counted nowhere: it does not reach the lag watch's worst value and does not
open a stall report of its own, so a sleep can neither inflate the one number that says how
bad the host's blocking was nor hide a real stall that merely sat next to it — the ticks
around it are still reported normally. A suspend is expected on both sides and produces no
stall reading; a gap in the sampler that is *not* a suspend is what `webview-stall` is for.

**The two sides also agree on the view state**, which is what decides whether a stall
matters at all: `[panel] session=… visible=… active=…` is written once when the tab is
wired and then on **every change** (never per tick — and once at wiring, because a
listener that only fired on change would leave "is this the tab the user is looking at?"
unanswered until the next click, which is exactly the moment a stale tab gets noticed),
and `[perf] window active=…` follows the window's own focus. Those two facts are also
**pushed into the tab** — the window's focus rides in the same `viewState` message the tab's
visibility does (`ChatPanel.viewStateTo`, forwarded by the provider's
`onDidChangeWindowState`), because the sampler has to stop calling an unfocused window a
frozen screen, and only the document can take the snapshot of the return. The same message is
what re-asserts the **composer's caret**: the platform's own focus lands on the webview's
frame rather than the element inside the document, so the return is a caret sequence too
(`webview-composer-focus`, in the line list above). A hidden tab in a
background window is allowed to be stale; so is a tab in an unfocused one; a tab that is
`visible`, `active` **and** in a focused window is not, and that is the condition the
automatic probe tests.

**What it costs:** a healthy tab writes *nothing* — the sampler reports only a gap of 3 s
or more, the visibility and resize lines are written on change, and a probe only exists
because the tab is already stale. The sampler runs at one frame per second and stops while
hidden, and a stall that is still in flight repeats at most once every 10 s, so even a tab
that froze for an hour adds a bounded handful of lines. The lines a *user* causes are
the return snapshot (`webview-focus`, one per return to a focused window — 59 of them in the
measured 3 h 20 m), its caret trace (`webview-composer-focus`, two lines for a return with the
caret in the composer and none when the user had already clicked elsewhere) and
`webview-resize` (one per half second while a panel is being dragged),
and all of them are only written for a change. The per-session volume stays in the low
hundreds of lines a day, the same order as the op trace it can be read next to.

### Sending the log to someone else: the diagnostics log

A report from a user's machine has to be self-describing, because there is no developer
sitting next to it — and the Spinney **output channel cannot be read back** (VS Code has no
API for it), so a file is the only thing a report can contain. **Every build therefore keeps
one**, in the session data folder (`<data folder>/perf-<pid>.log`), and
`src/chat/diagnosticsLog.ts` keeps it bounded: one file per window, rotated at 2 MiB with one
`.prev` generation, and only the newest **5** windows retained (with their generations), so a
machine nobody looks at cannot fill up over months. `spinney.diagnostics.log` (default `true`)
turns it off, `Spinney: Open Diagnostics Log` reveals the newest file (a user should never have
to type a profile path), and `SPINNEY_PERF_LOG` still wins when it is set — that is how the
simulation harness points the log anywhere.

**What it may contain is a promise, not a hope:** only `perf()` / `harnessLog()` lines reach it
— timings, counters and **paths**. A session title is written to the output channel directly
(`outputLog`, not the perf sink) and the API-key line reports `set`/`missing` only, so neither
the conversation nor a credential can appear. `tools/diagnostics-log-acceptance.js` pins the
bounds *and* those two source-level rules, because both failures would be silent.

**Every line of the file ends with ` | at=<ISO8601>`** (`ChatViewProvider.stampLine`), the file's
four `#` header lines being the only exception (they are written straight to the stream, and their
`started` field is already an ISO timestamp). The stamp is a deliberate **suffix**:
`tools/sim/run.mjs`'s `analysePerfLog` keeps the lines that `startsWith('[perf]')`, strips the
marker and then matches several **`^`-anchored** patterns, so a *prefix* would silently drop exactly
the measurements it reads — `lag blocked`, `persist-queued`, `op#… end`. Without it the header's
`started` is the only time in the file: "when did this stall happen?" has no answer, and a call that
never returned leaves a hole nobody can date.

**A tool call is now bracketed.** `Agent.executeToolCall` writes `[perf] tool-start <name> args=<len>`
*before* the body runs — the old log had nothing before the end line, so a call that hung (a shell
waiting for input, an API request with no deadline) or a turn killed while one was running left
**nothing at all** for it, and the file simply had a hole in it. With the start line, the end line
that matches it (`tool <name> <ms>ms args=… result=…`, or the `exec …` family below for
`exec_command`) and the ` | at=` stamp on each, that hole becomes **measurable**: a start without an
end *is* the hung call, and the two timestamps say for how long — which is the difference between
"the session was idle" and "the session was blocked for three hours".

The lines that make such a report diagnosable, in the order they appear:

- `[env version=… diag=… vscode=… node=… <platform>-<arch> cpus=… mem=…GB appRoot=… folders=… root=… store=… key=… language=…]`
  — which build, on which VS Code (that decides whether the bundled ripgrep is findable at
  all), on what machine, for which workspace and store root.
- `[config effective maxSubagents=… maxLevel2=… maxInlineToolOutput=… execForegroundSeconds=…s subAgentSyncSeconds=…s saveSessionTranscripts=… transcriptDir=… dataDir=… autoSessionTitles=… replyLanguage=… defaultCard=… providers=… cards=…]`
  — the settings in force, in one line.
- `[search rg=<path>]` (or `rg=missing (… the fix is NOT in play)`, or a spawn-failure line)
  — **the first thing to check**: whether the child-process search path is actually the one
  running. `via=walk` on the per-call line and `rg=missing` here mean the fix is not in play.
- `[perf] tool-start <name> args=<len>` — every tool call, written **before** the body runs; the
  line that matches it is the runtime's `tool <name> <ms>ms args=… result=…`, so a start without an
  end is a hang rather than a hole (`exec_command` adds its own `exec end …`).
- `[perf] exec start …` / `still-running …` / `end …` / `kill …` — the `exec_command` lifecycle in
  one grammar (`run_type=<foreground|background|detached>`, no timeout, no budget): the call as executed (with the redacted command line — `redactCommand` in
  `src/redact.ts`, whitespace collapsed, secrets masked, clipped to 120 chars), a 30 s heartbeat
  while a foreground command holds the turn, what ended the call, and what a kill actually
  achieved. See `docs/agents/tools.md`.
- `[perf] bg register id=… pid=… detached=<true|false>` ·
  `bg kill id=… pid=… reason=<user|stop|rollover|none> outcome=… ms=…` — the background job's own
  life, written by `BackgroundRegistry` (`src/tools/background.ts`) rather than by the tool: the
  **registration** (and whether that job locks its node and notifies) and the **kill whose
  confirmation failed** (`outcome` is the non-`'exited'` answer; a confirmed kill is not news and
  stays quiet). There is no `bg expire` line and no `budget=` field any more: a job has **no
  deadline**, so nothing ends it but its own exit or a kill. `kill` answers "and why did it end" —
  `stop` from Stop or `kill_command`, `rollover` for the window break, `none` when the kill was
  never attributed. The job's origin is `exec_command`'s own `exec start … run_type=…` line above,
  and its ending as a foreground call is `exec end … outcome=promoted`.
- `[perf] search-files ms=… files=… matches=… capped=… via=rg|walk scope=… wait=…ms` — per
  call; `wait=` is the time the call spent queued behind the work budget, and `capped=wall`
  is the one hard budget (`spinney.searchTimeoutSeconds`) ending the call with the timeout
  `Error:` line instead of a page.
- `[perf] spawn-request count=N mode=… depth=1 node=…` — the shape of the fan-out.
- `[perf] work-done peak rg:N peak req:M …` — one line per storm, on the falling edge of the
  work counters. **A clean run produces this and no `lag blocked` line at all**, which is
  exactly why it exists: without it a good log would contain no evidence that the storm ran.
- `[perf] lag blocked <ms> | ctx: … | heap=…` — the stall, when there is one, with what was
  in flight and the heap. A `resume gap=<ms>` line next to it is the other reading of the
  same gap: the host's own tick arrived that late, i.e. the machine was suspended rather
  than the loop blocked.
- `webview-stall …` / `webview-visibility …` / `webview-resize …` / `webview-probe* …` /
  `webview-drop …` / `webview-frames … suspend=` / `post-failed …` — the **webview's** half
  of a stall (`post-failed` being the host's own line about a webview that is not there),
  posted back to the host and therefore in the same file: the frame sampler, a probe and
  its answer, a routed message that found no card, and the suspend split. They are the only
  lines that can say a tab stopped painting at all (see the section above), and the ` | at=`
  stamp is what places them on the host's clock.
- `[store] …` and `load-sessions … source=store|memento` — where the content lives and
  whether a migration/adoption happened.
- `[perf] persist-queued … via=store` / `persist-done …` — the write path.

Reading a switch, the shape to look for: a large `panel-create`+`panel-html` is
webview startup, a large `runtime-create` is a session with a lot of nodes, a large
`post-tree`/`deliver-tree` is payload size, and `markdown=` dominating
`webview-paint` is rendering cost (the webview re-markdowns every item of a branch it
has never shown; an already-rendered branch keeps its DOM, so a *second* visit should
have no `markdown` at all).

### What a real trace found, and what was changed for it

A measured cold switch (`op#9`, 81 sessions / 751 nodes, ~111 M chars persisted):

```
op#9 +0ms panel-HTML/CREATE/FOCUS          ← the tab comes up instantly
[perf] persist-queued 821ms … chars≈116927140   ← a pointer move re-serialized the world
[perf] lag blocked 751ms (2 late ticks)         ← …and blocked the host doing it
[perf] persist-done 2348ms                      ← VS Code wrote the 131 M-char memento
op#9 +1634ms post-tree bytes=2325344            ← 2.3 MB: every sidecar's transcript
op#9 +2359ms deliver-reset 733ms                ← posted while the webview was loading
op#9 +3407ms webview-paint since=219 cards=8 dom=10035 → end 3407ms painted
```

Five separate costs, fixed one by one (each fix verified against these same lines):
1. **A pointer move wrote the whole state.** `setActiveSession` now writes
   `spinney.activeSession` alone — and that key lives in the **other** Memento
   scope, because VS Code keeps an extension's whole `workspaceState` as one row:
   a "40-byte" update inside it still rewrote all 118.9 M chars (`lag blocked 549ms`
   right after the pointer write). See `invariants/session-persistence.md`.
   A cold switch no longer logs `persist-queued` at all.
2. **The repaint was pushed into a webview that had not loaded its scripts.** A
   `ChatPanel` holds every message until the webview says `ready`, then the provider
   sends **one** `postAllState` and `flushHeld()` drops the repaint messages the hold
   accumulated (a cold tab used to render a stale tree and tear it down again) while
   releasing the rest in order. `deliver-*` on a cold tab is now a few ms, not ~730 ms.
3. **Content writes happened once per event.** A turn with a dozen tool calls
   serialized the whole state a dozen times; writes are coalesced now (800 ms, 3 s
   ceiling) with `persistNow()` at the conversation-critical sites and flushes at
   every hand-off point — a merged write says `coalesced=n`. See
   `invariants/session-persistence.md`.
4. **The `tree` shipped every sidecar's transcript.** A `kind:'agent'` node now
   carries `itemCount` and no `items`; the webview asks once with `loadAgentItems`
   when such a card expands and the host answers `agentItems`. `dom=10035` for 8 cards
   became a few hundred, and `post-tree` dropped from MBs to KBs.
5. **The measurement itself was the slowest part of the measurement.** `persist()`'s
   size is `chars≈` from the same pass that builds the payload (no `JSON.stringify`,
   no second walk over 108 M chars), and the bigger picture is in
   `invariants/session-persistence.md`.

### A second trace: 15 sidecar cards, one cold switch

The lazy-item contract fixed the *payload*, but a cold repaint still re-expanded every
sidecar card of a session at once, and each one asked for its transcript in the same
burst: 15 × `loadAgentItems` in one frame answered with ~5.35 M chars, `dom=2692`, and
`webview-handler … ms=903…999` while they landed. Two changes, both on the client:

- **The requests are queued** (`media/main.js`, `AGENT_ITEMS_CONCURRENCY` = 3 in
  flight; an `agentItems` answer releases the next slot). A repaint that needs exactly
  **one** transcript is not a burst and still posts immediately — which is the contract
  `tools/check-webview.js` pins for the single-sidecar fixture. Where a layout exists
  (`IntersectionObserver`), a card that enters the viewport is promoted ahead of the
  queue and an off-screen card is not asked for at all: panning to it is what makes it
  ask. `reset` drops the queue with the old tree, and a node the tree drops leaves the
  queue with its card, so an answer for it can never be rendered.
- **A finished card with a long transcript renders a window**
  (`VIRTUAL_ITEM_THRESHOLD` 60, `VIRTUAL_WINDOW` 24): the items near the scroll
  position are real DOM, everything above/below them is a spacer whose `data-items`
  count and height stand in for them, so the scrollbar still describes the whole
  transcript; scrolling extends the window one page at a time (rAF-throttled, and the
  scroll position is corrected by what the new page added, so the text under the cursor
  does not jump). The first window is the **tail**, because a finished card opens at its
  newest content. A **running** node is never windowed — its transcript is appended in
  place as deltas arrive and the streaming path reads the container's last child back to
  continue, so re-rendering it from a slice would break the stream. `suppressFollow`
  keeps a history repaint from panning the tree to the active node.

Both halves are pinned by `tools/check-webview.js` (the burst cap, the released slot,
the spacer's above-count of 37 for a 61-item card, and that no spacer stands below the
newest page), and the IntersectionObserver stub there reports "observed = on screen"
because the sandbox has no layout.

**Still on the table (measured, not fixed):** the content write is one
118,860,732-char Memento value, so `persist-done` costs ~1.5 s *inside VS Code*
(plus ~0.5 s building the payload) — coalesced, but once per burst and at every turn
end. No amount of key-splitting fixes that (the row is per extension, not per key);
the way out is to move session content out of the Memento (per-session files + a small
index, sessions loaded on demand), which is a storage-architecture change over all
stored sessions and therefore wants an explicit decision.

