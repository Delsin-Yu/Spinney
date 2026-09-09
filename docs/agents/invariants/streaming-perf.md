## Streaming / long-session performance
- SSE tokens are **not** forwarded 1:1. `ChatViewProvider` coalesces `streamDelta` /
  `reasoningDelta` / `toolCallDelta` (~50ms) and only then `postMessage`s to the webview.
- The webview paints a streaming answer as a plain `Text` node (`appendData`);
  markdown-it runs **once** when the answer is finalized (`done` / `toolStart` /
  `interrupted` / `error`). Re-parsing the whole reply on every token is what used
  to freeze the sidebar after a long session.
- Tool cards shown in the UI (and persisted `displayItems`) cap args (~8 KiB) and
  result (~32 KiB). Agent `messages` still carry the full tool payload for the model.
- Transcript scrolling is **per-card**: each node's `.node-items` (and each
  thinking body) has a `createScrollController` with a green lock dot
  (`attachLock`). It defaults to locked (pinned to bottom), starts green, and
  dims when the user scrolls up. During streaming `followActive` calls
  `scrollToBottom()` which respects the lock (manual scrolling wins); expanding a
  card calls `lock()` which re-engages it. The tree viewport itself is a pannable
  canvas (pan/zoom/fit), not a scroll container.
- `[perf]` lines (request JSON size, assistant-round, tool timings, persist, stream
  flush) go to the **Agent Harness** output channel. Open View → Output → "Agent Harness".

