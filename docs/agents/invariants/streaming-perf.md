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
- Transcript scrolling is **per-card and event-driven**: each node's
  `.node-items` (and each thinking body) has a `createScrollController` with a
  green lock dot (`attachLock(container, host, locked)`). It starts locked only
  for a **live** turn (`status === 'running'`); a finished node starts unlocked
  and is positioned at its newest content once on first render, so history is
  scrollable immediately. Both item-render paths (`expandedCard` and
  `renderPath`) apply that default right after `renderNodeItems`, because the
  thinking blocks — which keep their own dot — only exist at that point.
  Locked = pinned to bottom with `scroll-locked` hiding and disabling the
  scrollbar; clicking the dot toggles it and hands scrolling back to the user. It is never re-engaged from scroll position (that heuristic
  was unreliable). Instead it follows the turn lifecycle: `setBusy(true)`
  re-locks the active card, `done` / `interrupted` / `error` release it, and
  sub-agent cards lock on `agentStart` / release on `agentDone`
  (`setCardScrollLock`). `scrollToBottom()` is a no-op while the light is off.
  The dot sits in the strip the container reserves below its scrollbar
  (`margin-bottom: 20px`), inside the card/block. The tree viewport itself is a
  pannable canvas (pan/zoom/fit), not a scroll container.
- `[perf]` lines (request JSON size, assistant-round, tool timings, persist, stream
  flush) go to the **Spinney** output channel. Open View → Output → "Spinney".

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

The lines that make such a report diagnosable, in the order they appear:

- `[env version=… diag=… vscode=… node=… <platform>-<arch> cpus=… mem=…GB appRoot=… folders=… root=… store=… key=… language=…]`
  — which build, on which VS Code (that decides whether the bundled ripgrep is findable at
  all), on what machine, for which workspace and store root.
- `[config effective maxSubagents=… maxLevel2=… maxInlineToolOutput=… commandTimeout=… saveSessionTranscripts=… transcriptDir=… dataDir=… autoSessionTitles=… replyLanguage=… defaultCard=… providers=… cards=…]`
  — the settings in force, in one line.
- `[search rg=<path>]` (or `rg=missing (… the fix is NOT in play)`, or a spawn-failure line)
  — **the first thing to check**: whether the child-process search path is actually the one
  running. `via=walk` on the per-call line and `rg=missing` here mean the fix is not in play.
- `[perf] search-files ms=… files=… matches=… capped=… via=rg|walk scope=… wait=…ms` — per
  call; `wait=` is the time the call spent queued behind the work budget.
- `[perf] spawn-request count=N mode=… depth=1 node=…` — the shape of the fan-out.
- `[perf] work-done peak rg:N peak req:M …` — one line per storm, on the falling edge of the
  work counters. **A clean run produces this and no `lag blocked` line at all**, which is
  exactly why it exists: without it a good log would contain no evidence that the storm ran.
- `[perf] lag blocked <ms> | ctx: … | heap=…` — the stall, when there is one, with what was
  in flight and the heap.
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

