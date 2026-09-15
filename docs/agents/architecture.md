# Architecture & data flow

```
User (editor WebviewPanel: media/main.js)
   |  postMessage ⇄
   v
ChatPanel (src/chat/ChatPanel.ts, view type 'spinney.chatTree')   one tab per session
   ^
   |  PanelManager (src/chat/panels.ts): sessionId → ChatPanel
   |
ChatViewProvider (src/chat/ChatViewProvider.ts) — the window coordinator: sessions +
   |   persistence, `runtimes`, tabs, titles, transcripts, config (model cards, keys),
   |   the global hop bookkeeping, the control plane, webview message routing
   |
   |  runtimes: Map<sessionId, SessionRuntime>
   v
SessionRuntime (src/chat/runtime.ts) — all per-session state, one instance per session
   |   runs: Map<nodeId, TurnRun>  (P1: one; P3: several branches at once)
   |   view focus (session.activeNodeId) vs. turn basis (run.nodeId)
   |   subAgentPool (src/chat/SubAgentPool.ts), background per (session, node)
   v
Agent (src/agent/agent.ts) — one worker per **node** (`workerFor`), each with its own
   |   ToolRegistry — streaming loop
   v
ClientRegistry (src/agent/clients.ts) → ApiClient (src/agent/apiClient.ts)
   |   one client per provider (baseUrl + its key), the two RequestGates
   |   tools (function calls)
   v
ToolRegistry (src/tools/index.ts)
   |   v
exec_command -> shell detection (src/tools/shell.ts)

Side layers:
+ Sidebar (native TreeView `spinney.sessions`)   SessionsProvider   reads ChatViewProvider
+ BackgroundHub (src/chat/backgroundHub.ts) — one per window; background terminals keyed by
  (session, node) (P2), the `BackgroundAccess` the tools register through; pure module, no `vscode`
+ ModelPanel (src/chat/ModelPanel.ts) + ModelTreeController (src/chat/modelTree.ts) — the Model
  Card Tree page (view type `spinney.modelTree`), the editor of `spinney.providers` /
  `spinney.modelCards` / `spinney.model`
+ SubAgentPool (src/chat/SubAgentPool.ts) — the per-session sub-agent concurrency limit
  (`spinney.maxConcurrentSubagents`, mutable at runtime)
```

1. `extension.ts::activate` creates the `ChatViewProvider` and the sidebar
   `TreeView` (`spinney.sessions`), registers the two webview panel serializers
   (chat + model page), starts the optional control plane, and registers the
   commands: `spinney.openSession`, `spinney.newSession`,
   `spinney.renameSession`, `spinney.autoRenameSession`, `spinney.copySessionId`,
   `spinney.deleteSession`, `spinney.deleteBranch`, `spinney.openModelCards`,
   `spinney.clear`, `spinney.showSystemPrompt`, `spinney.setApiKey`,
   `spinney.clearApiKey`.
2. The webview (`media/main.js`) posts `ready`, `perfDiag`, `userMessage`,
   `checkout`, `setNodeSize`, `setModel`, `setThinkingEffort`, `stop`,
   `continueTurn`, `rolloverTurn`, `killAgent`, `killBackground`,
   `deleteBranch`, `loadAgentItems`, `layoutDiagnostic`, `copyNodeId`,
   `openModelTree`, `openExternal` and `pickImage` — `handlePanelMessage` also
   answers `clear`, which only the `spinney.clear` palette command reaches
   (`media/main.js` never posts it).
   It streams in a sandboxed iframe and loads the vendored
   `media/vendor/markdown-it/markdown-it.min.js` plus
   `media/tree.js` (pure layout), which uses the vendored pinned engine
   `non-layered-tidy-tree-layout@2.0.2` (loaded first, same CSP nonce).
3. All per-session state — the session's tree (`messages` + `displayItems` per
   node), its `TurnRun`s, its sub-agent pool and background registries, and its
   completion-signal queues — lives in `SessionRuntime` (`src/chat/runtime.ts`),
   reached through `ChatViewProvider.runtimes` (`Map<sessionId, SessionRuntime>`).
   The `Agent` is per **node** (`SessionRuntime.workerFor`), not per session.
   Each session persists its own state and is restored from `vscode.Memento`.
4. Window recovery: `extension.ts` registers a `WebviewPanelSerializer` for the
   `spinney.chatTree` viewType. VS Code serializes the chat tab at shutdown
   and hands it back on the next activation → `ChatViewProvider.restorePanel`
   adopts it (`ChatPanel.revive` re-sets the HTML and re-hooks the events), binds
   it to the session the webview remembered via `vscode.setState({ sessionId })`
   and repaints on the webview's `ready`. `ChatViewProvider.dispose()` therefore
   must **not** dispose the panel: closing the editor tab would kill the tab
   itself.
5. `Agent.sendUserMessage` pushes a user message and runs the loop: stream an
   assistant turn → if it emits `tool_calls`, execute each tool (emitting
   `toolStart`/`toolEnd`) and append `tool` results → loop → until a plain-text
   answer.
6. `Agent` emits `AgentEvent`s (`status`, `streamDelta`, `reasoningDelta`,
   `assistantDone`, `usage`, `toolCallDelta`/`toolStart`/`toolEnd`, `done`,
   `interrupted`, `error`); the session's runtime forwards them to the webview
   and mutates the owning node's `displayItems`.
