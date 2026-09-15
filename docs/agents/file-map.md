# File map

- `src/extension.ts` — activation; registers the webview provider + commands.
- `src/chat/ChatViewProvider.ts` — the window coordinator: session/persistence,
  config, image attachment, titles, transcripts, the global hop bookkeeping, the
  control-plane host, the HTML shell, and webview message routing. It owns the
  `runtimes: Map<sessionId, SessionRuntime>` and a `PanelManager` (tabs); the editor
  `WebviewPanel` lifecycle is `restorePanel` (serializer) + `postAllState`.
- `src/chat/ChatPanel.ts` — a thin wrapper around a `WebviewPanel` (one chat tab).
  It carries its `sessionId`; `PanelManager` keeps one per session. `ChatPanel.create`
  makes a new panel, `ChatPanel.revive` adopts one VS Code restored from serialization
  (window reload) — both share the same HTML/event wiring. It also gates on the
  webview's first `ready`: messages posted before it are held, and `markReady()` →
  one `postAllState` → `flushHeld()` (which drops the repaint messages the hold
  accumulated) is what keeps a cold tab from rendering a stale tree and tearing it
  down again — see `invariants/streaming-perf.md`.
- `src/chat/panels.ts` — `PanelManager`: the `sessionId → ChatPanel` map. `ensure`
  returns/focuses a session's tab (creating it on first open), `adopt` takes over a
  serializer-restored panel (disposing a duplicate — a session has exactly one tab),
  `close` unmaps one without deleting the session. `activeSessionId` is just "the last
  focused tab".
- `src/chat/runtime.ts` — `SessionRuntime`: all per-session state and the in-flight
  turns. Splits the view focus (`session.activeNodeId`) from a turn's basis
  (`run.nodeId`), keys runs by node (`runs: Map<nodeId, TurnRun>`), keeps one node
  worker (its own `Agent` + `ToolRegistry`) per node (`workerFor`), puts an explicit
  `nodeId` on every streaming message, bookkeeps interrupts per node, holds the
  per-session model/effort, and delivers the completion signals (background terminals /
  async sub-agents) — a `kind:'bg'` card per job (`onBackgroundRegistered`) plus the
  per-node `signals` queue, handed to a running turn at its next tool boundary or
  injected into the idle owning node. Reaches the provider through the narrow `RuntimeHost`.
  A full context window is continued rather than compressed by `rolloverContext()` (the
  union kill + settle + flush + re-dump, `beginTurn({ freshContext })`, the harness resume
  text and the `contextFull` flag it ships) — see `invariants/context-rollover.md`.
- `src/chat/backgroundHub.ts` — `BackgroundHub` (one per window): background terminals
  keyed by `(session, node)`, session-local task ids, an `id → owner` index, the
  `onRegistered` / `onUpdated` / `onFinish` hooks, and the
  removal lifecycles (`removeNode` / `removeSession` / `killAll`); exposes the
  `BackgroundAccess` the tools register through. Pure module, no `vscode`.
- `src/chat/SessionsProvider.ts` — the native sidebar `TreeDataProvider` listing
  session titles; it re-reads items from `ChatViewProvider` on every refresh.
- `src/chat/tree.ts` — the Chat Tree data model: `TreeNode` / `AgentSession`,
  path assembly (`pathIds` / `pathMessages`), the context basis that cuts the API
  prefix (`TreeNode.contextBaseId` / `contextBase()` — see
  `invariants/context-rollover.md`), `attachNode`, `pruneSession`,
  branch removal (`branchIds` / `detachBranch`), the `isSidecar` predicate (a
  sub-agent `kind:'agent'` window vs. a background job `kind:'bg'` card — both
  display-only sidecars) and the v1→v2 state migration. Pure data layer, no VS Code UI.
- `src/chat/sessionTitles.ts` — automatic session titles: the gates
  (`shouldAutoTitle`: locked / cooldown / growth), the conversation digest, the
  naming prompts (single + batched), `sanitizeTitle` / `parseBatchTitles`, and the
  zero-cost `heuristicTitle` fallback. Pure prompt/data helpers — no VS Code APIs,
  so it is smoke-testable outside the Extension Host.
- `src/chat/transcript.ts` — transcript dumps (JSONL, one API message per line,
  meta + tool stats on line 1), one file per main-agent turn (`writeSessionTranscript`)
  and per sub-agent run (`writeSubAgentTranscript`); plus the read side —
  `renderTranscriptLine` (one line → searchable `[role] text → tool(args)`),
  `searchTranscripts`, `listTranscriptSessions`. Also `summarizeTranscript`
  (tool-call / denied-call stats), `sumUsage`, and the removal helpers
  (`removeTranscriptDir` for a session, `removeTranscripts` / `removeTranscriptFile`
  for the dumps of deleted nodes). Pure fs, no VS Code UI (so it is smoke-testable
  outside the Extension Host).
- `src/http/controlServer.ts` — the opt-in local HTTP control plane
  (`/health`, `/state`, `/wait-for-finish`, `/navigate`, `/continue`, `/stop`,
  `/session/start`, `/reload-window`); token + discovery file, loopback only. See
  "External control plane & the `hvsc` supervisor".
- `docs/agents/multi-session.md` — the frozen multi-session / multi-branch contract
  (P1–P4): view-focus vs turn-basis, the host⇄webview protocol, the tools-side
  `BackgroundHub` API, and the acceptance evidence.
- `tools/hyper-vscode/` — the `hvsc` supervisor (CLI + daemon + `serve.ps1`),
  **not** shipped in the `.vsix`.
- `tools/harness-test.mjs` — the control-plane acceptance harness for P1–P4 (suites
  `health`, `sessions`, `concurrency`, `navigation`, `background`, `branch`,
  `selftest`). Dev tooling: `.vscodeignore` excludes `tools/**`, so it is never shipped.
- `src/agent/agent.ts` — the agent loop: message sanitizing, interrupt/rollback,
  model/effort switching, the completion-signal injection hook
  (`setSignalHandler`; consulted after each whole tool batch, like the `read_image`
  image block) and the interception of the provider-orchestrated tools
  (`spawn_*` / `send_*` / `hop_session` / `list_nodes` / `rename_session` /
  `read_image`). The prompt text is **not** here — see `prompt.ts`.
- `src/agent/prompt.ts` — **the system prompt**: both templates, the
  `{{placeholder}}` renderer (plus the unresolved-placeholder guard) and the
  `AGENTS.md` snapshot. One file to read top-to-bottom to see what the model gets.
- `src/agent/profile.ts` — `describeAgent(profile, registryTools, facts?)`: the
  prompt **and** the tools array for one (role, model, effort, capabilities)
  profile — the public entry point for "what does the model actually receive".
- `src/languageTags.ts` — the canonical ↔ reported tag pair for the two Chinese
  scripts (`zh-Hans` ↔ `zh-cn`), and nothing else. Deliberately import-free: an
  extension host module, a pure agent module and the `tools/` dev scripts all read
  it, and the scripts `require('../out/languageTags.js')` outside the host.
- `src/agent/languages.ts` — `replyLanguageName(value, vscodeLocale)`: the
  reply-language setting (`auto` or a VS Code language tag) → the language **name**
  the prompt carries, named through `Intl.DisplayNames` so the tag list lives only
  in the setting's `enum`. That `enum` is ordered by use (`auto`, `en`, `zh-Hans`,
  `zh-Hant`, then the rest) and its `enumDescriptions` are these same names, so the
  dropdown reads like the prompt does; `zh-cn`/`zh-tw` stay aliased because
  `vscode.env.language` reports the region tags.
- `src/agent/models.ts` — the model catalog (id / context window / accepts images)
  and its accessors (`DEFAULT_MODEL`, `isVisionModel`, `contextWindowFor`,
  `visionModelsLabel`), plus `parseContextLengthError()` — the reader of the
  provider's context-length 400, which is what triggers a context rollover. The
  **only** place a model id may appear;
  `tools/check-models.js` enforces that on every package.
- `src/i18n.ts` — the UI localisation entry point: which display language
  (`vscode.env.language`, normalized) the host is in, the `l10n/bundle.l10n.<locale>.json`
  reader behind the webview's injected dictionary (`webviewL10n`,
  `ChatViewProvider.getHtml`), the `[i18n]` diagnostic line, and the
  `defaultSessionTitle()` / `isDefaultSessionTitle()` pair that keeps the stored
  "nobody named this session yet" sentinel working across languages. See
  `invariants/i18n.md`.
- `l10n/bundle.l10n.<locale>.json` · `package.nls.<locale>.json` — the shipped
  catalogs, keyed by the **English source string**, named by the language's
  **canonical** tag (`zh-Hans`, never `zh-cn`); `package.nls.json` holds the
  English manifest values. One catalog serves the host (`vscode.l10n.t`, resolved
  by VS Code) and the webview (`tr()` in `media/main.js`, fed by the injected
  dictionary). English needs no runtime file. Adding a string means adding it here
  too — `check:l10n` fails packaging otherwise.
- `tools/sync-l10n-aliases.js` — writes (and, with `--clean`, removes) the
  reported-tag copies of those catalogs, because VS Code only ever looks a catalog
  up by the tag *it* reports. Run by `vscode:prepublish` before `vsce` reads the
  tree, cleaned up by `build-deploy.ps1`'s `finally` and `npm run clean:l10n`; the
  four names are gitignored. See `docs/agents/invariants/i18n.md`.
- `tools/check-models.js` · `tools/check-webview.js` · `tools/check-signal-persist.js`
  · `tools/check-l10n.js` · `tools/check-context-rollover.js` — the packaging guards
  (`npm run check:models` / `check:webview` / `check:signals` / `check:l10n` /
  `check:rollover`, run by `vscode:prepublish`):
  model-id drift, "does the chat webview still survive every message the provider
  posts" (including the rollover button's label and click), the completion-signal
  persistence contract, the UI catalogs drifting from the code, and the
  context-rollover contract (`contextBaseId` / the prefix cut / the error-text
  parse — pure functions, no DOM). See `testing.md`.
- `src/agent/tools/` — one file per intercepted tool (`readImage`, `spawnAgents`,
  `spawnReadonlyAgents`, `sendAgentMessage`, `sendReadonlyAgentMessage`,
  `hopSession`, `listNodes`, `renameSession`) plus the barrel that filters them.
  Each declares its `requires` capability tag, so the advertised tools and the
  prompt's capability wording cannot drift apart.
- `src/agent/deepseek.ts` — `DeepSeekClient` (stream SSE over `fetch`,
  `DeepSeekError`), builds `stream: true`, `stream_options.include_usage`,
  `reasoning_effort`. The read loop flushes the `TextDecoder` and parses a final
  `data:` line that arrived without a trailing newline.
- `src/agent/types.ts` — shared types (`Role`, `ThinkingEffort`, `ContentPart`,
  `ChatMessage`, `ToolCall`, `ToolDefinition`, `Usage`, `StreamChunk`,
  `AgentEvent`, `AgentTool`).
- `src/tools/index.ts` — `ToolRegistry` + the helpers every tool shares (path
  resolution, line-ending helpers, `globToRegex`, `SKIP_DIRS`, `limitInline`,
  argument parsing for strict JSON **or** the verbatim frame). The tools
  themselves live one per file next to it; they import those helpers back from
  this module (safe: every use is inside `execute()`, i.e. call time).
- `src/tools/readFile.ts` · `writeFile.ts` · `replaceInFile.ts` · `listDir.ts` ·
  `searchFiles.ts` · `searchTranscripts.ts` · `execCommand.ts` — the registry
  tools, each with its schema and its implementation in the same file.
- `src/tools/backgroundTools.ts` — `check_background_terminal` /
  `kill_background` / `join_background`, grouped because they all read the same
  `BackgroundRegistry`.
- `src/tools/background.ts` — `BackgroundRegistry` + `BackgroundTask`,
  `CommandHandle`/`spawnShellCommand` (live output capture, process-tree kill),
  per-session lifecycle.
- `src/tools/shell.ts` — cross-platform shell detection for `exec_command`
  (Git Bash > pwsh > Windows PowerShell 5.1 > cmd.exe) with UTF-8 safeguards.
  The WSL launcher (`System32\bash.exe` / `WindowsApps`) is **not** accepted as
  Git Bash (different filesystem, no `zh_CN.UTF-8`, Windows cwd).
- `src/perf.ts` — the `[perf]` diagnostics: `perf()` (sink = the Spinney
  output channel; takes a string **or a thunk**, a thunk is only evaluated when a
  sink is installed), `harnessLog()` (same channel without the prefix, used by the
  prompt-template guard), `timedSync()`, the **correlated op traces**
  (`beginOp`/`opMark`/`opTag`/`opPayload`, whose id travels to the webview and back
  — see `invariants/streaming-perf.md`), `logWebviewReport` (the webview's
  `perfDiag` half) and `startLagWatch()` (a late timer = a blocked extension host).
- `media/main.js` — webview client (tree rendering, pan/zoom, streaming into the
  active node, composer, streaming meter, live tool drafts, drag-to-resize cards,
  background job cards + `.bgnotify` notification blocks).
  Every string it displays goes through its own `tr(message, ...args)` (defined at
  the top of the file): the host has no `vscode.l10n` inside a webview, so it
  injects the catalog as `window.__spinneyL10n` and `tr()` looks the English source
  string up in it — see `invariants/i18n.md`.
  It also carries the webview half of the `[perf]` traces (its perf block, near the
  top): it measures the repaint burst the host tagged with a `traceId`, the markdown
  and layout inside it, its own frame gaps and any slow message handler, and posts
  them back as `perfDiag` — see `invariants/streaming-perf.md`.
  Canvas gestures live in one block near the end: LMB/MMB drag pans by offset,
  RMB-hold autoscroll-pans towards the cursor (browser middle-click semantics,
  with an origin marker and the `all-scroll` cursor), ctrl+wheel zooms.
  RMB on a **card header** is the exception to that block: a `.node-head` opens the
  webview's own **node menu** (`openNodeMenu` → the host's `copyNodeId` case in
  `ChatViewProvider.handlePanelMessage`), because the header is `user-select: none`
  and webview content cannot add entries to VS Code's own menu; the capture-phase
  `contextmenu` listener is where the host menu is suppressed for it.
  The composer is the
  active node's input dock: `setActiveLeaf` moves `#composer` into the
  checked-out card's bottom. It has no other home — with an empty session the
  placeholder card hosts it, and with a focused sidecar card (a sub-agent window or
  a background job card — `isSidecarKind`, `main.js:111`) or no active
  node the pane is **hidden entirely** (`setComposerVisible(false)`); there is
  no floating/docked fallback. The pane keeps one fixed size: nothing about the
  host card's width (or its resize handle) scales it.
- `media/tree.js` — the Chat Tree layout algorithm (`window.treeLayout`), a pure
  function with no DOM; `main.js` positions cards with it. The tidy-tree geometry
  is delegated to the vendored, pinned engine (below); this file only maps our two
  child kinds onto it (turn = below, sidecar = right, where a sidecar is a
  `kind:'agent'` sub-agent window or a `kind:'bg'` job card) and reserves each node's
  sidecar **grid** inside the node's engine box. A node's sidecar children are packed
  **column-major** into an aligned lattice — at most `agentMaxRows` (4) rows per
  column, a new column to the right for every further window — with the lattice
  lines anchored on the window *cards* (not on their subtree boxes, which the engine
  centres its card over) and each column/row reserving the largest card overhang, so
  every card in a column shares an x and every card in a row shares a y. Returns, in
  addition to `pos`/`width`/`height`, a `cells` **routing table** (per agent child:
  `busX` / `chanX` / `corrY`, the card-free corridors `main.js` draws the connectors
  through). `agentMaxRows: 1` reproduces the old single-column ribbon.
- `media/vendor/non-layered-tidy-tree-layout/` — **vendored, pinned** tree layout
  engine (`@2.0.2`, MIT): `dist/` (the file the webview loads), `src/` (readable
  source for offline re-audit), `LICENSE`, `PROVENANCE.md` (hashes + audit record).
  Not an npm dependency; never update it in place — see
  `docs/agents/invariants/vendored-deps.md`.
- `media/style.css` — chat UI styling (incl. tree node cards / toolbar, the
  `kind:'bg'` job card and the `.bgnotify` / `Delivered` badges). Every
  size inside `#composer` is a fixed px value: the input dock's controls and
  fonts never scale with its host card.
- `media/vendor/markdown-it/` — **vendored, pinned** Markdown renderer
  (`@14.3.1`, MIT): `markdown-it.min.js` (the file the webview loads), `LICENSE`,
  `PROVENANCE.md` (hashes + the third-party code inlined in the bundle). Not an npm
  dependency; never update it in place — see
  `docs/agents/invariants/vendored-deps.md`. It replaced the old
  `media/markdown-it.min.js`, which sat outside the `media/vendor/** -text` rule and
  had drifted to CRLF.
- `build-deploy.ps1` — compile + package + install helper.

