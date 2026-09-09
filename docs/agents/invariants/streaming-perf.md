## Streaming / long-session performance
- SSE tokens are **not** forwarded 1:1. `ChatViewProvider` coalesces `streamDelta` /
  `reasoningDelta` / `toolCallDelta` (~50ms) and only then `postMessage`s to the webview.
- The webview paints a streaming answer as a plain `Text` node (`appendData`);
  markdown-it runs **once** when the answer is finalized (`done` / `toolStart` /
  `interrupted` / `error`). Re-parsing the whole reply on every token is what used
  to freeze the sidebar after a long session.
- Tool cards shown in the UI (and persisted `displayItems`) cap args (~8 KiB) and
  result (~32 KiB). Agent `messages` still carry the full tool payload for the model.
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
  flush) go to the **Agent Harness** output channel. Open View → Output → "Agent Harness".

