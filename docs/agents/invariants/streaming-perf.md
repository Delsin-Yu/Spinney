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
- **The live block is the only expanded one.** `foldThinking` / `foldToolCalls` are
  the *at rest* default: the thinking block receiving deltas, and a tool call between
  its first delta and its end, are expanded whatever the default says, and fold back
  the moment the answer's text takes over, the call reports its result, or the turn
  ends (`done` / `interrupted` / `error` → `endRun`). Without it a long turn either
  reasoned behind a closed header or grew one never-collapsing tool card per call.
  A click on a block's header hands *that* block to the user for good
  (`_userTouched`), and `applyFoldDefault` skips the live body so a settings change
  cannot fold it. `setActive` / `clearActive` / `closeActive` in `media/main.js`;
  `tools/check-webview.js` asserts it ("the live block is always expanded").
- Transcript scrolling is **per-card and event-driven**, and a card has exactly
  one scroller: the **work zone** `.node-work`, the middle of the card's three
  zones (see §"The three zones of a card"). It has a `createScrollController`
  with a green lock dot (`attachLock(container, host, locked, card)`) and is also the
  only zone that windows a long transcript; the answer zone has no controller of
  its own — it opens at its top **once per card** (`_answerOpened`) — so the two zone wrappers
  and the card classes `has-answer` / `work-folded` are what decide the heights. The controller starts locked only
  for a **live** turn (`status === 'running'`); a finished node starts unlocked
  and is positioned at its newest content once on first render, so history is
  scrollable immediately — and that one move survives as a pending
  `_needsBottomScroll` when the same pass folded the log, because a `scrollTop`
  written into a `display: none` scroller is thrown away (§"A repaint never moves a
  scroller", below). Both item-render paths (`expandedCard` and
  `renderPath`) apply that default right after `renderNodeItems`, which also ends
  in `syncAnswerZone(card)`. **A repaint never moves a scroller**: only the follow
  light (locked → pinned to the bottom) and the once-per-card "opens at its newest
  content" may move one, and where a fold or unfold is involved the zone is put
  back where the reader left it.
  Locked = pinned to bottom with `scroll-locked` hiding and disabling the
  scrollbar; clicking the dot toggles it and hands scrolling back to the user. It is never re-engaged from scroll position (that heuristic
  was unreliable). Instead it follows the turn lifecycle: `setBusy(true)`
  re-locks the active card, `done` / `interrupted` / `error` release it, and
  sub-agent cards lock on `agentStart` / release on `agentDone`
  (`setCardScrollLock`). `scrollToBottom()` is a no-op while the light is off.
  The dot sits in the strip the container reserves below its scrollbar
  (`margin-bottom: 20px`), inside the card. The tree viewport itself is a
  pannable canvas (pan/zoom/fit), not a scroll container. The **live-block
  folding rule above is unchanged** by the split: the block taking deltas is
  still expanded in place, it simply sits in zone 2 with the rest of the log.
- `[perf]` lines (request JSON size, assistant-round, tool timings, persist, stream
  flush) go to the **Spinney** output channel. Open View → Output → "Spinney". Every
  one that reaches the diagnostics file also ends with a ` | at=<ISO8601>` stamp, and
  each tool call now writes a `tool-start` line before it runs — see the log section
  below.

### The three zones of a card: `ask` / `work` / `answer`

A turn card — and a sub-agent sidecar card — is split into three zones, and the two
rules above (one scroller, one expanded block) are really properties of that split:

- **zone 1, `.node-ask`** — the pinned user prompt, Markdown-rendered; it does not
  change once the card exists.
- **zone 2, `.node-work`** — the work log: reasoning blocks, tool cards, notices,
  background and sub-agent notices, `HARNESS` blocks, intermediate assistant text and
  usage lines. It is the scroller with the green lock dot, and the only zone that
  windows a long transcript. Its top carries the work log's own fold header
  (`.node-work-head`, below), and a **folded** log hides the dot with itself: nothing
  scrolls, so there is nothing to lock.
- **zone 3, `.node-answer`** — a **conditional** pretty-print of the *tail* of zone 2.
  It has no lock dot and opens at its top **once per card** (`_answerOpened`); after
  that a repaint leaves it where the reader left it. It is a surface of its own *around* the
  answer (below), and the heights of the two zones are a ratio of the card, not a cap
  on either one.

**The log folds itself as soon as the answer shows.** A header — chevron + label —
sits at the top of `.node-work-wrap`, above the log, as `.node-work-head`; the card
class `work-folded` marks the folded state. The rule is a function of zone 3, exactly
like the promotion itself: the log folds **exactly while zone 3 is showing**, and
unfolds while a turn runs or when there is no answer (the two conditions below fail)
— a card with no answer is a card whose content is *only* the log, so folding it
would leave a header in place of the card. **Two gestures hand that card to the
user forever** (`card._workTouched`, the same semantics as a block's `_userTouched`): a
click on the header, and **releasing the follow light** — the click that says "I am
reading this card", which may not have the log it is looking at folded away. From then
on the automatic rule may only refresh the label, never the state. Re-engaging follow
is a scrolling gesture, not a claim on the fold, and neither sets the mark nor clears
it; a card with the mark keeps its fold until the user changes it, and the offsets the
zones remember are what put a reader back where they were (§"A repaint never moves a
scroller"). The label is `Work log · {0} steps` from the card's tool-card count, or plain
`Work log` when it holds no tool card. `spinney.foldWork` (default `true`, window
scope) disables the automatic fold; it rides the existing `config` message
(`postConfig()` reads `cfg.foldWork`) and therefore applies to cards already on
screen, like `foldThinking` / `foldToolCalls`.

The helpers are `setWorkFold` (the one toggler), `autoWorkFold` (the rule above) and
`updateWorkHead` (the label), and the hooks are the **end** of `demoteAnswer` and
`promoteAnswer` (where the class flips), the end of `renderNodeItems` (a repaint
re-derives the fold from the items, exactly like the zones), `routeTo` (label refresh
only, after the append) and the `config` handler (a changed default re-applies to the
cards on screen).

**The answer's own height grows the card; the log is a strip that scrolls.** Both wrappers
are flex children of `.node-body`, and the split is settled in JS (`settleAnswerSplit`)
rather than in CSS, because "the height this answer needs" is not something a stylesheet
can read. The card class `answer-split` marks a settled card, and the measurement that
decides it suspends the split (the card class `split-measure`, whose CSS content-sizes the
**answer** zone only — the log's natural height comes from its own `scrollHeight` plus the
wrapper's chrome, or off the wrapper itself in the one case where the log has nothing to
scroll over, §"A repaint never moves a scroller") and then writes:

- the answer is pinned to the share it can use — `min(answer, room − floor)` as an inline
  height on `.node-answer-wrap` — and **the answer is what makes the card taller**;
- the log takes the rest of the body (`flex: 1 1 0`), but **its own growth never grows the
  card**: its share is `LOG_FLOOR_PX` (360px, and never more than half the room) or its
  whole content when that is shorter, so a conversation that grows in zone 2 scrolls inside
  the strip. A height the user dragged is an explicit budget: the answer takes only what it
  needs and the leftover of that height goes to the log (`max(strip, room − answer)`), which
  is how more of the work log is asked for — never by the log growing on its own;
- nothing has to be showing for this: while a turn runs there is no zone 3 yet, and the same
  strip is what keeps the card from stretching with every tool call.

Two rules came first and were wrong, so they are not tried again. A hard 1:2 lock divided
the card even when neither zone wanted its half — a short answer sat above blank space while
the log scrolled inside a third of the card. A "hug whichever content is longer" rule then
let a long log stretch the card to its cap: a thirteen-tool turn pinned every card at 1200px
whatever its answer said.

The card's cap is **1200px** (`media/style.css`, `.node`), doubled from 600 when the body
stopped being one scroller, and a card may not be shrunk below
`header + prompt + composer + SPLIT_FLOOR_PX` (220px): the drag's own floor is a flat
`MIN_H` (260px), which a multi-line prompt and the input pane already fill, and a card
squeezed past that point had a log with no height left — one that could not be unfolded
again. `onResizeMove` clamps to the card's own floor, and `settleAnswerSplit` lifts a
smaller cap (a size stored before this rule) back up, writing it both into the card's
style and into the layout's copy of the size so a relayout restores the lift.
`cardHeightCap` reads the user's drag size, else `--node-max-h` from the stylesheet, and
**never `card.style.maxHeight`**: the tree layout writes its stretch target there, so
reading it back treated the *folded* card's height as a hard cap and unfolding the log
divided those few pixels — while the max-height, being a real cap, pinned the card so it
could not grow out of them. The mirror of that rule is that the card must actually *be
able* to reach the cap: an inline `max-height` smaller than it (stale, from a stretch
measured while the card was small) is lifted to the cap by the same pass, in the card's
style and in the layout's copy of the size, and an inline `height` smaller than it is
dropped outright — the stretch writes *both*, and an inline `height` is not a cap, so a
stale one pins the card at the old height and the body is squeezed instead (measured in a
Chromium fixture: a card pinned at 470px left the log 20px while the pinned answer kept
its 321px). Without the lift the split is computed for room the card does not have, flex
squeezes the body, and the log — the only zone without a pinned height — takes the whole
loss. Settling
runs from the fold helpers (`setWorkFold` /
`autoWorkFold`), from `expandedCard`, from the end of a drag-resize and from
`setBlockOpen` — a block folding inside the log changes the log's content height and the box
is *measured*, so without that trigger a short log kept the height it had while the block
was still open (a band of blank space under it) until the next settle happened along. It
hands the
tree a debounced `scheduleLayout()` because the card's size just changed. The read clears
the answer's inline height first: `flex-basis: auto` takes a *set* height as the basis, so
measuring a zone the previous pass pinned would read the old share instead of the content
— a squeezed answer then measured small and was given small again, and could never grow
back however far the card was scaled up. A host with no
layout at all (the offline webview checker) measures 0, and then no height is written —
a wrong definite height would be worse than none.

**Zone 3 is a surface, not a bubble.** `.node-answer-wrap` carries a hairline top
border and its own background (`var(--bg2)`, the same surface as zone 1), and the
answer bubble inside it is flattened — no background, no border — so the zone itself
is the block the user reads; the answer has to keep its "stretch to the card width"
rules through that, or a flattened bubble would shrink to its text.

Zone 3 shows that tail only when **both** hold:

- **P1** the card has no live stream, and
- **P2** the tail is a **model message** — a contiguous run of assistant-text items
  that are neither errors nor empty.

Everything else is a *chronological breaker*: a tool call, a `HARNESS` block, a
notice, a background notice, a new user turn or an error item is newer than the
promoted message, so it pushes that message back into zone 2 and zone 3 hides. There
is deliberately no "the answer is finished" flag: the zone is a function of the items
that are actually there, so the same card gains zone 3 when the tail becomes a model
message and loses it again the moment a breaker is appended — with no flag to keep in
sync.

`syncAnswerZone(card)` is that promote-or-hide decision, and it is idempotent through
`card._answerAnchor` — the element that was zone 2's last child when the promotion
happened, i.e. the item the promoted run starts after. A second call that finds the
same tail already promoted moves nothing. `promoteAnswer` puts the run into zone 3
and adds `has-answer`; `demoteAnswer` returns it to zone 2 and drops the class.

**Demotion runs before any append into zone 2, never after it.** The append is
exactly what can falsify P2 — the new item is chronologically newer, so the message
is no longer the tail — and it has to land in a zone 2 that is again showing the
whole log, not beside a tail still parked in zone 3. The choke point is
`routeTo(nodeId, fn)`: every routed message is appended through it, so a new message
kind cannot append first and demote second. One path is deliberately outside that
routing: a `notice` message carries **no** `nodeId` and lands on the view-focus card,
so it runs the same pre-append demote for that card.

The call sites are therefore: `endRun`, **after** `runningNodes.delete` (the run is no
longer live, so P1 can hold now); `onAgentDone` / `onAgentStart` (a sidecar's
lifecycle is a card's lifecycle: finishing can promote, and starting hides the
promotion again because P1 fails); `renderNodeItems` (a repaint re-derives the zones
from the items it was handed); and `routeTo` / `notice`, the pre-append demote above.

That derivation is also why the live DOM and a repaint cannot disagree:
`syncAnswerZone` is a **pure function of `(items, card state)`**, so a repaint that
replays the same items reaches the same verdict and builds the same card — there is no
second copy of "the answer" to keep in sync, and no flag to migrate. The only per-card
memory behind that verdict is `_answerAnchor`, rebuilt with the card, and "it is already
promoted" is an early return rather than stored state.

### A repaint never moves a scroller

`settleAnswerSplit` measures the two zones with the split suspended, and the card class
`split-measure` used to put **both** wrappers on a content basis. Content-sizing the log's
wrapper stretched `.node-work` — the card's one scroller — to the height of its own
content, which leaves the container with no scrollable overflow at all: the engine then
clamps its `scrollTop` to 0 and nothing put it back. That ran on every routed append
(`routeTo` → `demoteAnswer` → `autoWorkFold` → `settleAnswerSplit`) and on every `tree` /
`path` repaint (`expandedCard` → `settleAnswerSplit`). A locked card hid it, because it
pins itself to the bottom right afterwards (`scrollToBottom`); an unlocked card did not, so
a reader who released the follow light to inspect an older tool call was thrown back to the
top of the log on every token the agent emitted.

`.split-measure` therefore content-sizes the **answer** zone only. The log's natural height
is read two ways, and which one applies is the point: a log that is **already showing
everything it holds** has no offset a reader could lose (`0` is the only representable one),
so it is let onto a content basis for that single read (the card class `split-measure-log`)
and measured off the wrapper exactly as every card was measured before; a log that
**overflows** is read off its own `scrollHeight` — the number the stretched wrapper stood in
for — plus the wrapper's chrome: its 10px inset, the fold head above the scroller with its
own bottom margin, and the log's own 20px dot strip. The strip is still added a second time,
exactly as the old stretched-wrapper read counted it, because the number is a floor
comparison and no card's share may move with this change. `scrollHeight` is floored at the
box height, which is exactly why the no-overflow case cannot use it and hugs instead — and
that case can never be the one where a reader is thrown to the top, because there is nothing
there to scroll.

**The guard is that a repaint never moves a scroller.** Each zone (`.node-work`,
`.node-answer`) remembers the last offset it was scrolled to — `rememberScroll` /
`scrollMemory` / `restoreScroll` on the element, fed by a `scroll` listener attached when
`createNodeCard` builds the card — and it is put back at that offset after every step that
can destroy it: `settleAnswerSplit`'s measurement, `renderNodeItems`' full re-render,
unfolding the log in `setWorkFold` and the window repaint (`paintItemsWindow`). It is never
restored while the card is locked (the follow light owns the bottom) nor while
`_needsBottomScroll` is still pending, so only two things may move a scroller at all: the
follow light while it is on, and the once-per-card "opens at its newest content".

**Zone 3 opens at its top once per card, not once per repaint** (the card flag
`_answerOpened`): the old unconditional `answerEl.scrollTop = 0` in `expandedCard` is what
undid a reader's position inside a long answer. `_needsBottomScroll` — the once-only "a
finished card opens at its newest content" — is consumed where the log actually becomes
visible: the promotion that lifts the answer into zone 3 folds the log in the same pass, and
a `scrollTop` written into a `display: none` scroller is thrown away, so the flag stays
pending and `setWorkFold` consumes it on the unfold.

**The window repaint corrects in both directions.** `extendItemsWindow` adjusts the scroll
position by the height difference whichever way the window grew; it used to correct the
upward direction only. `tools/check-webview.js` pins the whole thing: an unlocked card's log
and answer keep their offsets across a routed append and a `tree` / `path` repaint, and a
locked card still pins its log to the bottom.

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
  execution path ran and `scope` how many exclusions were in effect, which is how a
  stall gets attributed to a specific search shape. A search is **allowed to be slow
  and still be healthy**: with `rg` the work is in a child process, so the number to
  watch is `lag blocked`, not this one. See `docs/agents/tools.md` for the tool's
  contract.
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

- `webview-stall state=stale ms=… frames=… hiddenMs=… tab=… tabHiddenMs=… canvas=… dom=…`
  — the renderer stopped producing frames for at least 3 s **in a tab that is on screen**.
  `frames=` is the sampler's running total (it stops growing), `hiddenMs=` how much of the gap
  the window spent hidden, `canvas=` / `dom=` the size of what was being drawn (see the layer
  note below), and `tab=` / `tabHiddenMs=` the same question for the **editor tab**.
- `webview-stall state=recovered ms=… via=self|nudge|probe` — the frames came back, and
  **what brought them back**: `self` (nothing was done, the renderer resumed on its own —
  the suspend case), `nudge` (the ladder's one nudge) or `probe` (the host asked).
- `webview-visibility state=hidden|visible ms=…` — the page's own visibility changes, so a
  gap can be attributed to a hidden window without having to read the host's side for it.
- `webview-resize w=… h=… dpr=… canvas=…` — a resize is where a canvas-backed view can
  lose its drawing surface, and `canvas=` is the size the surface actually has as the
  webview reads it: a resize that leaves it without a size is a document that can no
  longer paint whatever its cards say. Like the sampler, it is the webview describing its
  own surface instead of its work.

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
  canvas=… wrap=… inner=… dpr=… hiddenMs=… readyState=…` — the webview's own state,
  posted back in answer to that request: how many host messages it has handled
  (`msgs`) and how many it dropped (`drops`, the counter below), what the sampler saw
  (`frames`, and `lastFrame=` ms since the last frame it produced), the DOM and card
  counts it holds, the canvas's size against the wrapper's and the window's (`canvas=` /
  `wrap=` / `inner=`) at this `dpr=`, how long it has been hidden, and its `readyState`.
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
surface: `hiddenMs` (nothing to paint), `canvas=` / `wrap=` (a surface with no size),
`lastFrame` / `frames` (the loop running without frames, `frames` being the running total
that stops growing), `drops` (messages that found no card). That discrimination is exactly what the old reading of the customer log could not
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
stall will say.

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
and `[perf] window active=…` follows the window's own focus. A hidden tab in a background
window is allowed to be stale; a tab that is `visible` and `active` is not, and that is the
condition the automatic probe tests.

**What it costs:** a healthy tab writes *nothing* — the sampler reports only a gap of 3 s
or more, the visibility and resize lines are written on change, and a probe only exists
because the tab is already stale. The sampler runs at one frame per second and stops while
hidden, and a stall that is still in flight repeats at most once every 10 s, so even a tab
that froze for an hour adds a bounded handful of lines. The per-session volume stays in the
low hundreds of lines a day, the same order as the op trace it can be read next to.

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
- `[config effective maxSubagents=… maxLevel2=… maxInlineToolOutput=… commandMaxForegroundDuration=…s saveSessionTranscripts=… transcriptDir=… dataDir=… autoSessionTitles=… replyLanguage=… defaultCard=… providers=… cards=…]`
  — the settings in force, in one line.
- `[search rg=<path>]` (or `rg=missing (… the fix is NOT in play)`, or a spawn-failure line)
  — **the first thing to check**: whether the child-process search path is actually the one
  running. `via=walk` on the per-call line and `rg=missing` here mean the fix is not in play.
- `[perf] tool-start <name> args=<len>` — every tool call, written **before** the body runs; the
  line that matches it is the runtime's `tool <name> <ms>ms args=… result=…`, so a start without an
  end is a hang rather than a hole (`exec_command` adds its own `exec end …`).
- `[perf] exec start …` / `still-running …` / `end …` / `kill …` — the `exec_command` lifecycle in
  one grammar: the call as executed (with the redacted command line — `redactCommand` in
  `src/redact.ts`, whitespace collapsed, secrets masked, clipped to 120 chars), a 30 s heartbeat
  while a foreground command holds the turn, what ended the call, and what a kill actually
  achieved. See `docs/agents/tools.md`.
- `[perf] bg register id=… pid=… budget=<n>s|none` · `bg expire id=… pid=… budget=<n>s|none ms=…` ·
  `bg kill id=… pid=… reason=<user|stop|timeout|rollover|none> outcome=… ms=…` — the background
  job's own life, written by `BackgroundRegistry` (`src/tools/background.ts`) rather than by the
  tool: the **registration** and what the job was handed there, the **expiry** — the registry's own
  event, written when the job's budget timer fires, i.e. the registry killing the job at its own
  deadline, so `ms=` is how long it really ran — and the **kill whose confirmation failed**
  (`outcome` is the non-`'exited'` answer; a confirmed kill is not news and stays quiet).
  `register` / `expire` answer "which background job ate the time" (what it was, and the deadline
  that ended it); `kill` answers "and why did it end" — a `reason=timeout` expiry, `stop` from Stop
  or `kill_background`, `rollover` for the window break, `none` when the kill was never attributed.
  The job's origin is `exec_command`'s own `exec start … budget=… behavior=…` line above.
- `[perf] search-files ms=… files=… matches=… capped=… via=rg|walk scope=… wait=…ms` — per
  call; `wait=` is the time the call spent queued behind the work budget.
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

