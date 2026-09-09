# File map

- `src/extension.ts` — activation; registers the webview provider + commands.
- `src/chat/ChatViewProvider.ts` — session/persistence, config, image attachment,
  message routing, event→UI mapping, HTML shell, and the editor `WebviewPanel`
  lifecycle (`ensurePanel` / `createPanel` / `restorePanel` / `postAllState`).
- `src/chat/ChatPanel.ts` — a thin wrapper around a `WebviewPanel` (the chat
  surface in the editor area). Single panel in v1; holds a `sessionId` so several
  panels can live side by side later. `ChatPanel.create` makes a new panel,
  `ChatPanel.revive` adopts one VS Code restored from serialization (window
  reload) — both share the same HTML/event wiring.
- `src/chat/SessionsProvider.ts` — the native sidebar `TreeDataProvider` listing
  session titles; it re-reads items from `ChatViewProvider` on every refresh.
- `src/chat/tree.ts` — the Chat Tree data model: `TreeNode` / `AgentSession`,
  path assembly (`pathIds` / `pathMessages`), `attachNode`, `pruneSession`,
  and the v1→v2 state migration. Pure data layer, no VS Code UI.
- `src/chat/transcript.ts` — transcript dumps (JSONL, one API message per line,
  meta + tool stats on line 1), one file per main-agent turn (`writeSessionTranscript`)
  and per sub-agent run (`writeSubAgentTranscript`); plus the read side —
  `renderTranscriptLine` (one line → searchable `[role] text → tool(args)`),
  `searchTranscripts`, `listTranscriptSessions`. Also `summarizeTranscript`
  (tool-call / denied-call stats), `sumUsage`, `removeTranscriptDir`. Pure fs, no
  VS Code UI (so it is smoke-testable outside the Extension Host).
- `src/http/controlServer.ts` — the opt-in local HTTP control plane
  (`/health`, `/state`, `/wait-for-finish`, `/navigate`, `/continue`,
  `/reload-window`); token + discovery file, loopback only. See "External control
  plane & the `hvsc` supervisor".
- `tools/hyper-vscode/` — the `hvsc` supervisor (CLI + daemon + `serve.ps1`),
  **not** shipped in the `.vsix`.
- `src/agent/agent.ts` — the agent loop, the **system prompt** (`CORE_PROMPT`,
  `identityLines`, `buildSystemPrompt`), message sanitizing, interrupt/rollback,
  `AGENTS.md` snapshot (static `agentsMdSnapshot`), model/effort switching.
- `src/agent/deepseek.ts` — `DeepSeekClient` (stream SSE over `fetch`,
  `DeepSeekError`), builds `stream: true`, `stream_options.include_usage`,
  `reasoning_effort`. The read loop flushes the `TextDecoder` and parses a final
  `data:` line that arrived without a trailing newline.
- `src/agent/types.ts` — shared types (`Role`, `ThinkingEffort`, `ContentPart`,
  `ChatMessage`, `ToolCall`, `ToolDefinition`, `Usage`, `StreamChunk`,
  `AgentEvent`, `AgentTool`).
- `src/tools/index.ts` — `ToolRegistry` + the tools; path resolution, line-ending
  helpers, argument parsing (strict JSON **or** verbatim frame), `exec_command`
  runner (foreground + background behaviors), and the three background tools.
- `src/tools/advancedDocs.ts` — the folded ("advanced") tool docs: `ADVANCED_TOPIC_DOCS`
  (6 topics), `ADVANCED_TOOL_NAMES` (the registry tools kept registered but hidden from
  the tool list) and the `list_advanced_tool` definition + executor the model uses to pull
  an interface on demand.
- `src/tools/background.ts` — `BackgroundRegistry` + `BackgroundTask`,
  `CommandHandle`/`spawnShellCommand` (live output capture, process-tree kill),
  per-session lifecycle.
- `src/tools/shell.ts` — cross-platform shell detection for `exec_command`
  (Git Bash > pwsh > Windows PowerShell 5.1 > cmd.exe) with UTF-8 safeguards.
  The WSL launcher (`System32\bash.exe` / `WindowsApps`) is **not** accepted as
  Git Bash (different filesystem, no `zh_CN.UTF-8`, Windows cwd).
- `src/perf.ts` — tiny `[perf]` logger (sink = the Agent Harness output channel).
  `perf()` takes a string **or a thunk**; a thunk is only evaluated when a sink is
  installed, so an expensive line (JSON sizes, byte counts) costs nothing when off.
- `media/main.js` — webview client (tree rendering, pan/zoom, streaming into the
  active node, composer, streaming meter, live tool drafts). The composer is the
  active node's input dock: `setActiveLeaf` moves `#composer` into the
  checked-out card's bottom. It has no other home — with an empty session the
  placeholder card hosts it, and with a focused sub-agent branch (or no active
  node) the pane is **hidden entirely** (`setComposerVisible(false)`); there is
  no floating/docked fallback. `--cs` follows the host card's width.
- `media/tree.js` — the Chat Tree layout algorithm (`window.treeLayout`), a pure
  function with no DOM; `main.js` positions cards with it. The tidy-tree geometry
  is delegated to the vendored, pinned engine (below); this file only maps our two
  child kinds onto it (turn = below, agent = right) and reserves each node's
  sidecar block inside the node's engine box.
- `media/vendor/non-layered-tidy-tree-layout/` — **vendored, pinned** tree layout
  engine (`@2.0.2`, MIT): `dist/` (the file the webview loads), `src/` (readable
  source for offline re-audit), `LICENSE`, `PROVENANCE.md` (hashes + audit record).
  Not an npm dependency; never update it in place — see
  `docs/agents/invariants/vendored-deps.md`.
- `media/style.css` — chat UI styling (incl. tree node cards / toolbar). Every
  size inside `#composer` is `calc(<design px> * var(--cs))` so the input dock's
  controls and fonts scale with its host card.
- `media/markdown-it.min.js` — vendored markdown renderer.
- `build-deploy.ps1` — compile + package + install helper.

