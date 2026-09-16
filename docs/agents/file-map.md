# File map

- `src/extension.ts` — activation; registers the webview provider + commands.
- `src/chat/ChatViewProvider.ts` — the window coordinator: session/persistence,
  config (including `applyModelCards` / `refreshKeys`),
  image attachment, titles, transcripts, the global hop bookkeeping, the
  control-plane host, the HTML shell, the Model Card Tree page controller, and
  webview message routing. It owns the
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
  `nodeId` on every streaming message, bookkeeps interrupts per node, resolves the
  model / effort per node (`cardForNode` / `effortForNode`, over the session's seed),
  and delivers the completion signals (background terminals /
  async sub-agents) — a `kind:'bg'` card per job (`onBackgroundRegistered`) plus the
  per-node `signals` queue, handed to a running turn at its next tool boundary or
  injected into the idle owning node. Reaches the provider through the narrow `RuntimeHost`.
  A full context window is continued rather than compressed by `rolloverContext()` (the
  union kill + settle + flush + re-dump, `beginTurn({ freshContext })`, the harness resume
  text and the `contextFull` flag it ships) — see `invariants/context-rollover.md`.
- `src/chat/SubAgentPool.ts` — `SubAgentPool`: the per-session concurrency limit for
  level-1 sub-agents (`spinney.maxConcurrentSubagents`), a FIFO queue that runs the
  rest as slots free. `setMaxConcurrent` is the live settings path (raising it wakes
  queued tasks; lowering it never kills a running one) and depth-2 sub-agents are
  **not** pooled (they are capped by the per-parent `maxLevel2Subagents`). Pure
  logic, no `vscode`.
- `src/chat/backgroundHub.ts` — `BackgroundHub` (one per window): background terminals
  keyed by `(session, node)`, session-local task ids, an `id → owner` index, the
  `onRegistered` / `onUpdated` / `onFinish` hooks, and the
  removal lifecycles (`removeNode` / `removeSession` / `killAll`); exposes the
  `BackgroundAccess` the tools register through. Pure module, no `vscode`.
- `src/chat/ModelPanel.ts` — the **Model Card Tree** page's webview wrapper (view
  type `spinney.modelTree`): its HTML shell (the vendored layout engine +
  `media/modeltree.js` + `media/modeltree.css`, all carrying the CSP nonce, the l10n
  catalog injected as `window.__spinneyL10n`) and the `ChatPanel` lifecycle — hold
  messages before the page's first `ready`, drop the superseded `modelTree`
  snapshots on `ready`, and one `ModelPanel` per window. `create` makes a new tab;
  `revive` adopts one VS Code restored from serialization.
- `src/chat/modelTree.ts` — `ModelTreeController`: the page's host half and the only
  place that reads or writes `spinney.providers` / `spinney.modelCards` /
  `spinney.model` from it. `validatePayload` is the host-side authority (a rejected
  save writes nothing), `apiKeySecretName` maps a provider id to its SecretStorage
  entry, and a successful save re-reads, reinstalls the catalog and pushes the change
  to every live session (`onModelCardsSaved`). The protocol is frozen in
  `ModelPanel.ts` and replayed by `tools/check-modeltree.js`.
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
- `src/chat/promptSnippets.ts` — the composer's **prompt snippets**: the two texts
  the extension ships (`SHIPPED_PROMPT_SNIPPETS` — `Plan` / `Implement Parallel`)
  and `resolvePromptSnippets(setting)`, which merges the user's
  `spinney.promptSections` rows over them (same name replaces the shipped text, any
  other name adds a row). A name *is* its menu label and its settings key. The texts
  are user-turn text — the composer inserts one into the input box — so this file
  never touches the system prompt.
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
- `src/manual.ts` — the shipped **user manual**: `manualFileNames()` /
  `canonicalLocale()` (which page a display language picks, through
  `languageTags.ts`) and `showManual()` (`spinney.showManual` reads the page with
  `workspace.fs` and opens it as an untitled markdown tab, absent pages falling back
  to English). Its pages are `manual/**` — shipped, and written in ASD-STE100. See
  `docs/agents/user-manual.md`.
- `manual/manual.md` · `manual/manual.<canonical tag>.md` — the pages themselves: one
  per catalog language, English as the source. They are the one user-facing document
  inside the `.vsix`; `.vscodeignore` does not exclude them, and
  `tools/check-docs.js` fails packaging when a page, a command title, a `spinney.*`
  key or the shared heading structure drifts.
- `docs/agents/multi-session.md` — the frozen multi-session / multi-branch contract
  (P1–P4): view-focus vs turn-basis, the host⇄webview protocol, the tools-side
  `BackgroundHub` API, and the acceptance evidence.
- `tools/hyper-vscode/` — the `hvsc` supervisor (CLI + daemon + `serve.ps1`),
  **not** shipped in the `.vsix`.
- `tools/harness-test.mjs` — the control-plane acceptance harness for P1–P4 (suites
  `health`, `sessions`, `concurrency`, `navigation`, `background`, `signals`,
  `branch`, `selftest`). Dev tooling: `.vscodeignore` excludes `tools/**`, so it is never shipped.
- `tools/rollover-acceptance.js` · `tools/modeltree-acceptance.js` ·
  `tools/model-switch-acceptance.js` · `tools/gate-acceptance.js` — the four
  **windowless acceptance drivers** (dev-only, not build guards, not shipped): the
  context rollover's runtime half, the Model Card Tree page's host half, the
  per-node model selection, and the request gate through `ClientRegistry`. Each
  stubs the `vscode` module and needs `out/` (`npm run compile` first); no window,
  no network. See `testing.md`.
- `tools/migrate-state.mjs` — the one migration this repo carries: an install that
  only ever ran Minimal Agent Harness (`minimal-host.minimal-agent-harness`) moves
  to Spinney (`DE-YU.spinney`) — the memento row key keeps the case the manifest
  declared, the `globalStorage` folder is that id lowercased. Dev-only; run it with
  VS Code closed. See `invariants/session-persistence.md`.
- `src/agent/agent.ts` — the agent loop: message sanitizing, interrupt/rollback,
  card/effort switching (`setCard(card)` / `setThinkingEffort(level)`, which rewrite
  the identity line in place), the completion-signal injection hook
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
- `src/agent/models.ts` — the model configuration module: the `ProviderSpec` /
  `ModelCard` shapes (a provider's `balance` dialect among the fields), the built-in
  fallback provider and card (`deepseek-flash`),
  `parseCatalog()` (the object-shape parser with per-field defaults and error rows),
  the accessors everything derives from (`cards`, `cardById`, `resolveCard`,
  `contextWindowFor`, `isVisionCard`, `cardDisplayName`, `effortsFor`,
  `normalizeEffort`, `visionCardsLabel`), and `parseContextLengthError()` — the
  reader of the provider's context-length 400, which is what triggers a context
  rollover. See `invariants/model-cards.md`. It is the **only** place a model id may
  appear; `tools/check-models.js` enforces that on every package.
- `src/agent/clients.ts` — `ClientRegistry`, the one place that turns a card into a
  request: one `ApiClient` per provider (created lazily, re-pointed when the
  provider's `baseUrl` is edited), the per-provider API key (cached until
  `ChatViewProvider.refreshKeys` invalidates it), the two `RequestGate`s, and the
  routing (`stream(card, request)` fills in `body.model` from the card's `oaiModel`,
  so no caller can name a model the card did not declare). The wallet is
  `balance(spec)` — the dialect and the display name come off the `ProviderSpec`, and
  the request itself is `fetchBalance` in `src/agent/balance.ts`. Chat completions
  and file uploads take a slot; session-title requests and the wallet readout
  deliberately do not. See `invariants/model-cards.md`.
- `src/agent/requestGate.ts` — `RequestGate`: the FIFO, abort-aware slot gate used
  per provider and per card (`0` = unlimited; a limit that drops below the running
  count never kills a request in flight; `acquire(signal)` rejects while queued, so
  Stop works on a request that is only waiting for a slot).
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
  · `tools/check-l10n.js` · `tools/check-context-rollover.js` ·
  `tools/check-modeltree.js` · `tools/check-tree-grid.js` · `tools/check-docs.js` —
  the packaging guards
  (`npm run check:models` / `check:webview` / `check:signals` / `check:l10n` /
  `check:rollover` / `check:modeltree` / `check:grid` / `check:docs`, run by
  `vscode:prepublish`):
  model-config drift (the default is the fallback card, `providers` / `modelCards`
  exist as object schemas, no `enum` on `model`, no model id in the code or the
  webviews), "does the chat webview still survive every message the provider
  posts" (including the rollover button's label and click), the completion-signal
  persistence contract, the UI catalogs drifting from the code, the
  context-rollover contract (`contextBaseId` / the prefix cut / the error-text
  parse — pure functions, no DOM), and "does the Model Card Tree page still
  understand the host" (`media/modeltree.js` into a stub DOM: the `ready` handshake,
  a snapshot drawn as a tree, a failed save that keeps the draft, an add-card → save
  round trip), and the Chat Tree's sidecar lattice (`media/tree.js` into node: each
  column its own stack ending flush and evenly filled, a `stretch` map covering every
  sidecar card, card-free corridors, over ~18 topologies plus the real session
  `mu2zn79jlv7b23`; and `relayout()` in `media/main.js` clearing the stretch before
  measuring and applying the new one after), and the shipped user manual against the
  manifest (`manual/**`: a page per catalog language, one shared heading structure, a
  spot for every command title and every `spinney.*` key, and no `.vscodeignore`
  pattern that would keep a page out of the `.vsix`). See `testing.md`.
- `src/agent/tools/` — one file per intercepted tool (`readImage`, `spawnAgents`,
  `spawnReadonlyAgents`, `sendAgentMessage`, `sendReadonlyAgentMessage`,
  `hopSession`, `listNodes`, `renameSession`) plus `index.ts`, the barrel that
  filters them.
  Each declares its `requires` capability tag, so the advertised tools and the
  prompt's capability wording cannot drift apart.
- `src/agent/apiClient.ts` — `ApiClient` (stream SSE over `fetch`,
  `ApiError`), builds `stream: true`, `stream_options.include_usage`,
  `reasoning_effort`. The read loop flushes the `TextDecoder` and parses a final
  `data:` line that arrived without a trailing newline. It is transport and retries
  only: it no longer reads a wallet (that moved to `balance.ts` below), so nothing
  in it names a vendor — the error strings are the client's own (`API error 400: …`,
  `Stream stalled: …`, `Network error calling the API: …`).
- `src/agent/balance.ts` — the wallet readout: `BalanceDialect` (`none` /
  `deepseek` / `openrouter` / `moonshot`), `BALANCE_DIALECTS`, `isBalanceDialect()`,
  the normalized `BalanceEntry` / `Balance`, `emptyBalance()`, and
  `fetchBalance({ dialect, baseUrl, apiKey, providerName, signal? })` — the one place
  that reads a wallet. Called once, never retried; `none` answers with the empty
  readout and sends no request at all. Which dialect a provider uses is a field on
  its row (`src/agent/models.ts` — declared by host when the row leaves it out). See
  `invariants/model-cards.md`.
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
  a background job card — `isSidecarKind`, `media/main.js:307-309`) or no active
  node the pane is **hidden entirely** (`setComposerVisible(false)`); there is
  no floating/docked fallback. The pane keeps one fixed size: nothing about the
  host card's width (or its resize handle) scales it.
  It also owns the two **model dropdowns**: the card list comes from the `config`
  message (no catalog copy here), the model `<select>` is grouped per provider with
  an `optgroup` per provider name, and the thinking-level `<select>` is built from
  the **active card's** `efforts` — so switching a card switches its levels with it.
  The gear beside the model dropdown (`#models-btn`) only posts `openModelTree`; the
  page itself is a host-owned tab. No model id is ever hardcoded here.
- `media/modeltree.js` — the **Model Card Tree** page's script: providers as roots
  with their cards branching off them (the same vendored layout engine, drawn the
  chat tree's way — the connector layer is a sized `<svg>`). The gesture set is the
  chat tree's with **one deliberate difference: the wheel scales** — anchored on the
  pointer, with or without ctrl/cmd, because this page is a handful of cards and the
  wheel *is* its zoom (the chat tree pans on a plain wheel); dragging (LMB/MMB) pans,
  RMB-hold autoscroll pans towards the cursor, and fit-to-view is on the toolbar.
  **There is no side panel**: the selected node's card
  expands in place into its own form (that is where every parameter is edited),
  while the other cards stay compact. A two-pass layout measures the rendered node
  before handing its size to the engine, so a card full of effort levels still lays
  out correctly. It also owns a draft/save/revert model that posts the whole desired
  state at once, client-side validation mirroring the host's `validatePayload`,
  per-provider write-only API-key fields, and the read-only request preview. Every
  string goes through its own `tr()` (fed by `window.__spinneyL10n`), and the page
  keeps no model name of its own — the names come from the host's snapshot.
- `media/modeltree.css` — the Model Card Tree page's styling (tree cards, the
  provider/model card kinds, the in-card form fields, the request preview).
- `media/tree.js` — the Chat Tree layout algorithm (`window.treeLayout`), a pure
  function with no DOM; `main.js` positions cards with it. The tidy-tree geometry
  is delegated to the vendored, pinned engine (below); this file only maps our two
  child kinds onto it (turn = below, sidecar = right, where a sidecar is a
  `kind:'agent'` sub-agent window or a `kind:'bg'` job card) and reserves each node's
  sidecar **grid** inside the node's engine box. A node's sidecar children are packed
  **column-major** into a lattice — at most `agentMaxRows` (4) cells per column, with
  the next cell opening a new column to the right. Rows are **not** aligned across
  columns: each column is its own stack of cells, its extent is the sum of its cells'
  own subtree box heights, and the block's height is the maximum over the columns;
  the free space of a shorter column (`blockHeight − that column's stack`) is spread
  **evenly** over that column's cards (the integer remainder to the topmost cards
  first), so every column ends flush at the block's bottom line and no hole is left
  between a parent's cards. Returns, in addition to `pos`/`width`/`height`, a
  `stretch` map (id → pixel height, every sidecar card) that `main.js` applies as the
  card's exact height (`height` + `max-height`, since `.node` caps at 600px), and a
  `cells` **routing table** (per agent child: `busX` / `chanX` / `corrY`, the
  card-free corridors `main.js` draws the connectors through). `agentMaxRows: 1`
  reproduces the old single-column ribbon.
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
- `media/activity.svg` · `media/icon.png` — the Activity Bar entry icon and the
  extension icon (`package.json`: `contributes.viewsContainers.activitybar` / `icon`).
- `build-deploy.ps1` — compile + package + install helper.

