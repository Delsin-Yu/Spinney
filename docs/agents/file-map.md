# File map

- `src/extension.ts` — activation; registers the webview provider + commands.
- `src/chat/ChatViewProvider.ts` — the window coordinator: session/persistence,
  config (including `applyModelCards` / `refreshKeys`),
  image attachment, titles, transcripts, the session tools’ cross-session reads,
  the control-plane host, the HTML shell, the Model Card Tree page controller, and
  webview message routing. It owns the
  `runtimes: Map<sessionId, SessionRuntime>` and a `PanelManager` (tabs); the editor
  `WebviewPanel` lifecycle is `restorePanel` (serializer) + `postAllState`.
  It also owns the **window-global terminal dock** (`globalBackgroundJobs` +
  `scheduleBackgroundsGlobal` / `postBackgroundsGlobal`, coalesced ~200 ms, broadcast as
  `backgroundsGlobal` to every open tab), its removal list (`bgDismissed`, a view of
  `TreeNode.bgDockDismissed`), and the three dock actions (`killBackgroundIn` /
  `dismissBackground` / `clearFinishedBackgrounds`) — each one routed through the owning
  session's runtime, created on demand, so a job can be killed from a tab that shows
  another conversation.
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
  `treeMessage()` builds the `tree` message **without** posting it.
  `toolTitleFromArgs()` is the one reader of a tool call's `title` argument
  (`exec_command`'s required title, `TOOL_TITLE_DESCRIPTION` in `agent/types.ts` — the one
  schema that carries it): it collapses the label
  to one line, caps it at 60 characters and stores it on the `DisplayItem` **and** on the
  `toolStart` message, so the card's step row shows the model's label even though the
  display copy of `args` is clipped to 8 KiB — and it survives every repaint.
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
- `src/chat/webviewShell.ts` — the **one** HTML shell of the chat surface
  (`buildChatShell` + `webviewNonce`), used by the local chat tab
  (`ChatViewProvider.getHtml()`): the script set and order (the vendored layout engine,
  markdown-it, `media/tree.js`, `media/main.js`), the CSP nonce, `window.__spinneyL10n`
  and the element ids, per-caller `mediaVersion`. One template, because `media/main.js`
  fetches its whole surface by element id. It carries the chat's fixed frame only —
  including the window-global terminal dock's frame (`#term-dock`, `#term-dock-head`,
  `#term-dock-label`, `#term-dock-list`, `#term-dock-clear`), whose rows are built by
  `media/main.js` from the `backgroundsGlobal` snapshot. Guarded by `npm run check:webview`.
- `src/chat/agentsMd.ts` — the two AGENTS.md instruction files, **read at use**
  (`liveAgentsMdSources`, `globalAgentsMdPath`, `workspaceAgentsMdPath`,
  `resetAgentsMdCache`): an mtime cache (one `statSync` per file per use, a
  `readFileSync` only when the file moved) so an edit made while VS Code was closed —
  or during a session — is what the next `freezeEpoch` renders and what the next
  `setupState` drift check hashes. The window snapshots
  (`Agent.setAgentsMd` / `setGlobalAgentsMd`) are the fallback for a file that cannot be
  read at all. `RuntimeHost.agentsMdSources()` is the seam the runtime uses.
- `src/chat/imagePick.ts` — `pickImageAttachment`: the one image picker, returning
  `{ kind: 'picked', dataUrl, name }` / `cancelled` / `failed`. Used by
  `SessionRuntime.handlePickImage`.
- `src/chat/tree.ts` — the Chat Tree data model: `TreeNode` / `AgentSession`,
  path assembly (`pathIds` / `pathMessages`), the context basis that cuts the API
  prefix (`TreeNode.contextBaseId` / `contextBase()` — see
  `invariants/context-rollover.md`), `attachNode`, `pruneSession`,
  branch removal (`branchIds` / `detachBranch`), the `isSidecar` predicate (a
  sub-agent `kind:'agent'` window vs. a background job `kind:'bg'` card — both
  display-only sidecars) and the v1→v2 state migration. Its `DisplayItem` is the shape
  every rendered row is built from: a `kind:'tool'` item carries the model's own one-line
  label (`title`, read out of the call's arguments by `toolTitleFromArgs` in
  `runtime.ts`), the host clocks (`startedAt` / `ms`) and the clipped `args` / `content`,
  so a repaint can rebuild the row instead of re-deriving it. Pure data layer, no VS Code UI.
  A `kind:'bg'` card also carries the dock's removal (`TreeNode.bgDockDismissed`, see
  `invariants/background-terminals.md`).
- `src/chat/fileWriteQueue.ts` — the coalescing, off-the-host-thread file writer shared by
  the transcript dumps and the session store: a synchronous answer with an async write,
  a later body for one path replacing the pending one, an optional `atomic` swap
  (`.tmp` → `.bak` → rename), a deletion cancelling what is still queued and tombstoning
  what is in flight, and `flush()` for the hand-off points.
- `src/chat/sessionStore.ts` — the **file-backed session store** (Phase 3 of the
  persistence work; the provider now writes through it and falls back to the Memento when
  no root is writable): a fixed root under global storage (or `spinney.dataDir`), one
  subfolder per workspace, a rebuildable `index.json`, atomic per-session files with one
  `.bak` generation, deletions that move to `.trash`, a per-workspace lock with a heartbeat
  and stale takeover, and `discover` / `adoptFrom` — the pair that actually survives a
  rename, since `globalStorage` itself is named after the extension id. Deliberately
  **vscode-free** — the caller passes the paths — which is what makes
  `tools/session-store-acceptance.js` possible. See
  `invariants/session-persistence.md`.
- `src/chat/sessionTitles.ts` — automatic session titles: the once-only gate
  (`shouldAutoTitle`: never twice, never for a locked title; `noteAutoTitle` is the
  write that closes it, and a heuristic fallback leaves it open), the conversation
  digest, the naming prompts (single + batched), `sanitizeTitle` /
  `parseBatchTitles`, and the zero-cost `heuristicTitle` fallback. Pure prompt/data
  helpers — no VS Code APIs, so it is smoke-testable outside the Extension Host
  (`tools/check-titles.js`).
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
  `/session/start`, `/reload-window` — immediate, or deferred to the window's own
  idle moment with `{idle:true}`); token + discovery file, loopback only.
  `controlEnv()` is what a command receives (instance id + discovery path, never the
  token). See "External control plane & the deferred reload".
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
- `tools/reload-window.mjs` — the one-shot **deferred reload** script an agent runs
  as an ordinary `exec_command` (`node tools/reload-window.mjs --message "…"`): it
  posts `POST /reload-window {idle:true, continue}` with the node id and session id
  it read from its own environment and exits; the window reloads itself when idle.
  No dependencies, no daemon, no state — and no fallback when the environment does
  not name a window. Dev-only, **not** shipped in the `.vsix`.
- `tools/harness-test.mjs` — the control-plane acceptance harness for P1–P4 (suites
  `health`, `sessions`, `concurrency`, `navigation`, `background`, `signals`,
  `branch`, `selftest`). Dev tooling: `.vscodeignore` excludes `tools/**`, so it is never shipped.
- `tools/rollover-acceptance.js` · `tools/modeltree-acceptance.js` ·
  `tools/model-switch-acceptance.js` · `tools/gate-acceptance.js` — four of the
  **windowless acceptance drivers** (dev-only, not build guards, not shipped): the
  context rollover's runtime half, the Model Card Tree page's host half, the
  per-node model selection, and the request gate through `ClientRegistry`. Each
  stubs the `vscode` module and needs `out/` (`npm run compile` first); no window,
  no network. See `testing.md`.
- `tools/exec-cwd-acceptance.js` — a windowless driver that *is* a build guard
  (`npm run check:cwd`): the working directory and path base, driven through the
  compiled tools with a `vscode` stub and a real shell. See `testing.md`.
- `tools/shell-argv-acceptance.js` · `tools/exec-kill-acceptance.js` ·
  `tools/exec-runtime-acceptance.js` — the three
  guards next to it
  (`npm run check:shell` / `check:kill` / `check:exec`, all part of
  `vscode:prepublish`, all needing `out/`): the argv a **native** child really
  receives under Git Bash (the `MSYS_NO_PATHCONV` fix — `/PID` must arrive verbatim,
  and what `//F` / `//IM` become is printed), the kill contract
  (`'exited' | 'no-exit' | 'no-pid'`, a real exit confirmed before the deadline,
  `BackgroundRegistry.kill` staying synchronous, an unconfirmed kill flagged *and*
  logged), and the **exec runtime** (`run_type` is `foreground` / `background` /
  `global`; a foreground command past `spinney.execForegroundSeconds` is **moved to
  the background** with its id, never killed; a call that still sends `timeout` /
  `timeout_behavior` answers one frozen sentence before anything is spawned; **no job
  has a deadline** — the task carries no `timeoutMs` / `deadlineAt`, the module exports
  no `remainingBudgetMs`, no `bg expire` line exists and a job survives well past the
  slice; `wait_for_command` finishes early with the notice suppressed and times out as a
  normal result with the notice restored; the Stop abort path; `check_command` is a
  status read and `kill_command` ends the tree; the sub-agent tool set and the prompt).
  See `testing.md`.
- `tools/dock-acceptance.js` — a windowless driver that *is* a build guard
  (`npm run check:dock`, part of `vscode:prepublish`): the **window-global dock's
  membership** (`globalBackgroundJobs`, driven on a fake `this` with a `vscode` stub) and
  the **`read_image` answer** (`answerImageUrl`), plus the kill path through a real
  `SessionRuntime` and `BackgroundHub`. See `testing.md` and
  `invariants/background-terminals.md`.
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
  (`spawn_*` / `send_*` / `create_session` / `send_session_prompt` /
  `wait_for_session_idle` / `interrupt_session` / `list_sessions` /
  `list_nodes` / `rename_session` / `read_image`). The prompt text is **not** here — see `prompt.ts`.
- `src/agent/prompt.ts` — **the system prompt**: both templates, the
  `{{placeholder}}` renderer (plus the unresolved-placeholder guard) and the two
  `AGENTS.md` snapshots (systemwide + workspace, rendered by `agentsMdSection`). One
  file to read top-to-bottom to see what the model gets.
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
  in the setting's `enum`; `replyLanguageTag` beside it resolves the same setting to
  its BCP-47 tag (`''` for a free-form name), which only the `exec_command` title
  description carries. That `enum` is ordered by use (`auto`, `en`, `zh-Hans`,
  `zh-Hant`, then the rest) and its `enumDescriptions` are these same names, so the
  dropdown reads like the prompt does; `zh-cn`/`zh-tw` stay aliased because
  `vscode.env.language` reports the region tags.
- `src/agent/models.ts` — the model configuration module: the `ProviderSpec` /
  `ModelCard` shapes (a provider's `balance` dialect among the fields), the built-in
  fallback provider and card (`deepseek-flash`),
  `parseCatalog()` (the object-shape parser with per-field defaults and error rows),
  the accessors everything derives from (`cards`, `cardById`, `resolveCard`,
  `contextWindowFor`, `isVisionCard`, `cardDisplayName`, `effortsFor`,
  `normalizeEffort`, `visionCardsLabel`), `parseContextLengthError()` — the
  reader of the provider's context-length 400 — and `windowFullReason()` — the
  classifier of a refusal's **kind** (`'tokens'` / `'images'` / `undefined`), which is
  what triggers a context rollover for either budget (`invariants/context-rollover.md`).
  See `invariants/model-cards.md`. It is the **only** place a model id may
  appear; `tools/check-models.js` enforces that on every package.
- `src/agent/compaction.ts` — the **handoff summary** of a context rollover, the pure half
  (`docs/agents/invariants/context-rollover.md` §6a): `extractCompactionSource` (one
  window, the first user message verbatim, every user message clipped to 500 chars with
  the count, the last 8 assistant texts, each tool call as `name -> brief -> first line of
  the result`, the whole source capped at 60,000 chars by a head+tail selection),
  `detectPriorHandoffSummary`, `buildCompactionPrompt` / `buildCompactionRequest` (one
  user message, the fixed eleven-section schema, no tools, `max_tokens` 1500, temperature
  0.2), `COMPACTION_TIMEOUT_MS` (30 s), `missingCompactionSections` (the nine required
  headings), `classifyCompactionAnswer` (the whole fallback decision) and
  `compactionDiagLine` (the `[perf] compaction …` line). Deliberately `vscode`-free and
  dependent on nothing but `../text`, which is what lets `tools/check-compaction.js` drive
  it from plain node.
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
  `tools/check-modeltree.js` · `tools/check-tree-grid.js` · `tools/check-docs.js` ·
  `tools/exec-cwd-acceptance.js` · `tools/shell-argv-acceptance.js` ·
  `tools/exec-kill-acceptance.js` · `tools/exec-runtime-acceptance.js` ·
  `tools/dock-acceptance.js` ·
  `tools/search-files-acceptance.js` ·
  `tools/websearch-acceptance.js` ·
  `tools/check-png.js` · `tools/check-resample.js` · `tools/check-image.js` ·
  `tools/check-jpeg.js` · `tools/check-neterror.js` · `tools/check-unicode.js` ·
  `tools/check-continue.js` · `tools/check-compaction.js` —
  the packaging guards
  (`npm run check:models` / `check:webview` / `check:signals` / `check:l10n` /
  `check:rollover` / `check:modeltree` / `check:grid` / `check:docs` / `check:cwd` /
  `check:shell` / `check:kill` / `check:exec` / `check:dock` /
  `check:search` / `check:websearch` / `check:png` / `check:resample` / `check:image` /
  `check:jpeg` / `check:neterror` / `check:unicode` / `check:continue` /
  `check:compaction`, run
  by `vscode:prepublish`):
  model-config drift (the default is the fallback card, `providers` / `modelCards`
  exist as object schemas, no `enum` on `model`, no model id in the code or the
  webviews), "does the chat webview still survive every message the provider
  posts" (including the rollover button's label and click), the completion-signal
  persistence contract, the UI catalogs drifting from the code, the
  context-rollover contract (`contextBaseId` / the prefix cut / the error-text
  parse — pure functions, no DOM) and its **handoff summary** (`check:compaction`: the
  bounded window source, the previous-summary marking, the nine required headings, the
  fallback decision and the capped summary request), and "does the Model Card Tree page still
  understand the host" (`media/modeltree.js` into a stub DOM: the `ready` handshake,
  a snapshot drawn as a tree, a failed save that keeps the draft, an add-card → save
  round trip), and the Chat Tree's sidecar lattice (`media/tree.js` into node: the depth
  bands of `agentMaxRows` = 3-card columns, each column its own stack, a deeper band
  starting to the right so the block stays bounded, the monitor cards and the one focused
  full card, no height valve and no
  `stretch` map, card-free corridors, over 19 topologies plus the real session
  `mu2zn79jlv7b23`; and `relayout()` in `media/main.js` measuring `offsetHeight`, passing
  the knobs and writing no inline height or max-height for layout), and the shipped user
  manual against the
  manifest (`manual/**`: a page per catalog language, one shared heading structure, a
  spot for every command title and every `spinney.*` key, and no `.vscodeignore`
  pattern that would keep a page out of the `.vsix`), and the working directory and path
  base (`resolvePath`'s `/d/x` → `D:\x` on Windows only, a command's first line naming
  the directory it ran in, a broken `cwd` naming the path instead of the shell, and the
  `/d/...` form reaching the file it means), and the command's other three contracts —
  the argv a native child receives under Git Bash (the `MSYS_NO_PATHCONV` fix), the
  kill-confirmation rules (`'exited'` / `'no-exit'` / `'no-pid'`, a confirmed exit before
  the deadline, a synchronous `BackgroundRegistry.kill`, an unconfirmed kill flagged and
  logged), and the **exec runtime** (`run_type` = `foreground` / `background` /
  `detached`, the promotion at `spinney.execForegroundSeconds` with its handle, the
  removed-argument sentence, no deadline on any job — no `timeoutMs` / `deadlineAt` /
  `remainingBudgetMs` / `bg expire` — `wait_for_command` finishing early and timing out,
  the Stop abort path, `check_command` / `kill_command`, the sub-agent tool set). See
  `testing.md`.
  The four image guards in that list (`check:png` / `check:resample` / `check:image` /
  `check:jpeg`) pin the pre-upload transform's bytes in and bytes out, the PNG codec, the
  resampler and the JPEG decoder — see `testing.md`.
- `src/agent/tools/` — one file per intercepted tool (`readImage`, `spawnAgents`,
  `spawnReadonlyAgents`, `sendAgentMessage`, `sendReadonlyAgentMessage`,
  `createSession`, `sendSessionMessage`, `listSessions`, `listNodes`, `renameSession`) plus
  `index.ts`, the barrel that
  filters them.
  Each declares its `requires` capability tag, so the advertised tools and the
  prompt's capability wording cannot drift apart.
- `src/agent/imageTransform.ts` — the **pre-upload transform**: `Rect`,
  `ImageTransformRecord`, `TransformOutcome`, `IMAGE_TARGET_MAX_SIDE` (1024),
  `readImageSize` (a synchronous header read: PNG `IHDR`, JPEG `SOFn`), `normalizeRect`
  and `transformImage`. It exists because the endpoint resizes every image to ~800×800
  and charges a flat ~384 tokens for it, so the pixels above that are discarded
  server-side — which makes a client-side downscale a *fix* rather than an
  optimisation — while the **uploaded** bytes are the request's own, separate budget
  (`MAX_REQUEST_IMAGE_BYTES` / `INLINE_REQUEST_BODY_BYTES`, tracked by the brake in
  `read_image`). Pure and `vscode`-free (`node:zlib` only, inside the codecs), and it
  **never throws for a bad image**: an unreadable or unsupported input comes back as
  `changed: false` with the input bytes, which keeps the caller's "attach what we have"
  behaviour and leaves the budget as the backstop.
- `src/agent/pngCodec.ts` — the PNG half, on `node:zlib` alone: `decodePng` / `encodePng`,
  8-bit non-interlaced, colour types 0 / 2 / 3 / 4 / 6 and filters 0–4, with adaptive
  per-row re-filtering on encode (RGBA in, RGBA out). A variant outside that scope is
  refused with a reason rather than guessed at, and the transform then passes the original
  bytes through unchanged.
- `src/agent/imageResample.ts` — `cropResample(src, rect, targetMaxSide)`: the crop and the
  downscale in one pass, **area-average** on downscale (never nearest — thinning invents
  aliasing the model then reports as image content), **no** upscale (a crop already inside
  the target is returned as it is), and the `scale` it applied (1 = crop only), which the
  record and the result text report.
- `src/agent/jpegDecode.ts` — `decodeJpeg` (baseline sequential only, RGBA out), split as
  `src/agent/jpegEntropy.ts` (markers, huffman, coefficients) and
  `src/agent/jpegReconstruct.ts` (dequant, IDCT, chroma upsampling, colour) behind a frozen
  seam, so the scope rules live in exactly one place and each half can be read on its own.
- `src/agent/apiClient.ts` — `ApiClient` (stream SSE over `fetch`,
  `ApiError`), builds `stream: true`, `stream_options.include_usage`,
  `reasoning_effort`. The read loop flushes the `TextDecoder` and parses a final
  `data:` line that arrived without a trailing newline. It is transport and retries
  only: it no longer reads a wallet (that moved to `balance.ts` below), so nothing
  in it names a vendor — the error strings are the client's own (`API error 400: …`,
  `Stream stalled: …`, `Network error calling the API: …`).
- `src/agent/netError.ts` — `describeFetchError(error)`, the one place a failed `fetch` is
  turned into a line a human can act on: the message, plus the cause — the code, its own
  message, and the host it was talking to — walked out of the cause tree (an undici failure
  nests an `AggregateError` whose `errors` array holds one entry per address tried) and
  clipped through `clipText`. Node reports every network failure as `TypeError: fetch failed`
  and keeps the real reason in `error.cause`, so this is what turns a bare `fetch failed`
  into `fetch failed (ENOTFOUND · getaddrinfo ENOTFOUND <host>)`. Imported by `apiClient.ts`,
  `balance.ts`, `tools/webFetch.ts` and `tools/webBackends.ts`; it depends on nothing but
  `../text`, which is what keeps those four from having to import each other.
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
  argument parsing that is **strict JSON only**, plus the one non-parsing
  sentinel that answers a value still wrapped in the removed verbatim frame,
  `verbatimFrameError`). The tools
  themselves live one per file next to it; they import those helpers back from
  this module (safe: every use is inside `execute()`, i.e. call time).
- `src/tools/readFile.ts` · `writeFile.ts` · `appendFile.ts` · `replaceInFile.ts` ·
  `listDir.ts` · `searchFiles.ts` · `searchTranscripts.ts` · `execCommand.ts` — the
  registry tools, each with its schema and its implementation in the same file. Exactly
  one schema declares a `title` argument — `exec_command`'s required one,
  `TOOL_TITLE_DESCRIPTION` in `src/agent/types.ts`, the model's sentence for the step,
  which the card's tool row shows instead of a derived one. A tool body ignores it; the
  host reads it (`toolTitleFromArgs`) and stores it on the `DisplayItem`. Every other
  tool (these, the three background tools and every intercepted tool) derives its row
  from the arguments and declares no `title`.
- `src/tools/backgroundTools.ts` — `check_command` /
  `wait_for_command` / `kill_command`, grouped because they all read the same
  `BackgroundRegistry`.
- `src/tools/background.ts` — `BackgroundRegistry` + `BackgroundTask`,
  `CommandHandle`/`spawnShellCommand` (live output capture, process-tree kill),
  per-session lifecycle.
- `src/tools/shell.ts` — cross-platform shell detection for `exec_command`
  (Git Bash > pwsh > Windows PowerShell 5.1 > cmd.exe) with UTF-8 safeguards — and
  the environment those shells run with: `MSYS_NO_PATHCONV: '1'` on Windows, so MSYS
  does not rewrite an argument that looks like a Unix path before a **native** child
  sees it (`taskkill /PID … /T /F` used to reach taskkill as `invalid argument/option`
  on `C:/Program Files/Git/PID`, and three stuck processes were never killed; the
  `//F` double-slash spelling is obsolete). Pinned by `tools/shell-argv-acceptance.js`.
  The WSL launcher (`System32\bash.exe` / `WindowsApps`) is **not** accepted as
  Git Bash (different filesystem, no `zh_CN.UTF-8`, Windows cwd).
- `src/perf.ts` — the `[perf]` diagnostics: `perf()` (sink = the Spinney
  output channel; takes a string **or a thunk**, a thunk is only evaluated when a
  sink is installed), `harnessLog()` (same channel without the prefix, used by the
  prompt-template guard), `timedSync()`, the **correlated op traces**
  (`beginOp`/`opMark`/`opTag`/`opPayload`, whose id travels to the webview and back
  — see `invariants/streaming-perf.md`), `logWebviewReport` (the webview's
  `perfDiag` half) and `startLagWatch()` (a late timer = a blocked extension host).
- `src/redact.ts` — command-line redaction for the diagnostics log:
  `redactCommand(text, max = REDACT_MAX)` collapses whitespace, masks the value after a
  secret-looking name (`token`, `api-key`, `authorization`, …) and a bare
  `Bearer <token>`, then clips to 120 chars with a `…(+N chars)` tail — the evidence a
  report needs to attribute a slow `exec_command` (which command caused it), without the
  credential that command may have carried. Deliberately dependency-free and
  vscode-free, which is what lets `tools/diagnostics-log-acceptance.js` drive the rules
  from plain node.
- `src/text.ts` — the shared well-formed-text helpers: the cuts that never
  split a surrogate pair (`sliceText()` / `clipText()` / `tailText()`) and the
  repair that replaces an unpaired half with U+FFFD (`wellFormed()` /
  `wellFormedDeep()`) — used by every clip and at the request boundary.
  Deliberately dependency-free and vscode-free, which is what lets
  `tools/check-unicode.js` drive the rules from plain node.
- `media/main.js` — webview client (tree rendering, pan/zoom, streaming into the
  active node, composer, streaming meter, live tool drafts, drag-to-resize cards,
  background job cards + `.bgnotify` notification blocks, and the window-global
  terminal dock).
  **A turn card is one essay.** `.node-ask` pins the user's prompt and `.node-work` is the
  card's **only scroller**, holding every row of the turn in order. The ask also carries the
  small `.node-ask-edit` pencil of an idle turn card (`syncAskEdit` / `beginAskEdit`): a click
  swaps the rendered ask for a textarea holding the node's **raw** prompt text plus one hint
  line (Enter sends, Shift+Enter adds a newline, Esc cancels), Enter posts
  `editUserMessage` — which the host turns into a branch from the edited node's **parent**,
  never an in-place rewrite — and Esc, or any repaint, puts the rendered ask back.
  The process is grouped
  **per run of tool rows**: a tool row opens a `.steps` group (`data-kind="steps"`) with a
  `Ran N steps` / `Ran 1 step` header over its own `.steps-body`, and the next assistant
  **text** closes it — the prose is appended to `.node-work` itself, never into a group's
  body, and the following tool row opens a second group. So a turn can hold several groups,
  each with its own count, its own body and its own fold state (open while its turn runs,
  folded when it ends, and a click on that header always wins); thinking rows ride the open
  group, or the log when none is open. A group's header stays on the log's left edge, and
  the only rows inset under it are the **step lines** (`.steps-body > .msg.tool`): a
  reasoning row that rides the same body keeps the prose's left edge, so the inset marks one
  step at a time and never a block around the group. A message's reasoning that trails a run joins that
  group's body even when its text arrived first, so the live turn and a repaint put it in
  the same place. **Nothing is moved out of a group**: the turn's final
  answer is simply the flow's last text block, with no frame of its own (`.msg.assistant`
  carries no background or border). A cold card paints the flow and each group's header and
  leaves every body lazy until that group's own header is clicked (`paintStepsBody`, per
  group), which is also why the old scroll window now applies only to a tool-less long turn.
  The two rows are *thinking* (`.msg.thinking-row` — open while its turn runs, one
  ellipsised line after, no label; the open form is normal prose at 13 px `--text`, capped at
  240 px with its own scrollbar, and carries the usage line
  `[Prompt: {0} + Completion: {1}, Cache Hit: {2}, Cache Miss: {3}]`) and *tool*
  (`.msg.tool` — one line: a bold `tr()`-localized verb from `TOOL_VERBS` in `--text-dim`
  and the label from `DisplayItem.title` or `toolBrief()` in 12 px
  `--text-dim` — one grey for the whole title, monospace and 11 px only for a **derived**
  command/pattern, i.e. only when there is no `title` — and the elapsed chip, whose tick is
  the only running cue since the row has no status dot; a click expands `.tool-detail` in
  place — the `> args` line, the result, an error, the usage line, all 11 px `--text-dim`).
  `renderItemInto` (the history repaint) goes through the **same** `addTool` /
  `makeThinkingRow` / `addAssistant` the live path uses and splits the items with the same
  per-run rule, and `tools/check-webview.js` pins both halves. The **appear animation**
  lives here too: a delta's newest characters briefly sit in a transient `.chunk-in` span
  that the script merges back into the answer's (or the thinking row's) own `Text` node on
  `animationend`, a new row arrives on `.row-in`, and a live tool row's label restarts
  `.label-in` in place — all of it off when `spinney.streamAnimation` is false or the OS
  asks for reduced motion (`animationsOn` in the animation block above the message
  rendering; the CSS and its `@media (prefers-reduced-motion: reduce)` block are at the
  end of `media/style.css`). While a thinking row is
  open, its 240 px box carries its own small green **follow** dot (`attachRowLock`), whose
  click `stopPropagation`s the row's click (which opens and closes the row). The log
  carries one green dot (`attachLock`): green means **following** the newest content, an
  upward scroll releases it and the bottom re-engages it — it never hides or blocks the
  scrollbar, and a programmatic pin or a growing turn can never release it.
  Every string it displays goes through its own `tr(message, ...args)` (defined at
  the top of the file): the host has no `vscode.l10n` inside a webview, so it
  injects the catalog as `window.__spinneyL10n` and `tr()` looks the English source
  string up in it — see `invariants/i18n.md`.
  It also carries the webview half of the `[perf]` traces (its perf block, near the
  top): it measures the repaint burst the host tagged with a `traceId`, the markdown
  and layout inside it, its own frame gaps and any slow message handler, and posts
  them back as `perfDiag` — see `invariants/streaming-perf.md`.
  The window-global **terminal dock** is its own block (`renderTerminalDock` /
  `paintTermDockRow`): rows are diffed by a per-row signature, so a job that prints
  repaints its own row only, and the dock is fixed outside `#tree-canvas` so no dock
  repaint ever runs a layout. A row's body is `buildBgBody` — the **same** builder the
  owning node's `kind:'bg'` card uses (`renderBgBody`), so the two views of one job
  cannot disagree.
  Canvas gestures live in one block near the end: LMB/MMB drag pans by offset,
  RMB-hold autoscroll-pans towards the cursor (browser middle-click semantics,
  with an origin marker and the `all-scroll` cursor), ctrl+wheel zooms,
  alt+wheel pans vertically and shift+wheel pans horizontally — both from
  anywhere in the tree, including over a native scroller, so a card, a thinking
  block, a work log, an expanded step and the composer pan instead of scrolling
  themselves.
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
  **The composer keeps its focus across a window reactivation** — the caret contract.
  The webview document is *retained* while its tab is in the background, but VS Code's own
  `WebviewEditor.focus()` runs on reactivation (after a ~50 ms throttle) and focuses the
  webview's **frame**, not the element inside it: the dock keeps `#input` and loses the DOM
  focus, which is the stable repro (caret in the composer → another OS window → click the
  composer again, and the caret shows for a few milliseconds). VS Code closed "restore focus
  inside a retained webview" as out of scope for extensions, so the rule lives here:
  `composerHadFocus` is the user's *intent*, tracked by `focusin` / `focusout` — never
  `document.activeElement` read at mount time, which is already gone (`renderTree` / `reset`
  remove the old card before `mountComposer` runs); `setComposerVisible(false)` only hides and
  never blurs; and `restoreComposerFocus` re-asserts the caret on the next frame and then
  every ~60 ms for up to a second, because the platform's own focus lands *after* ours.
  `shouldRestoreComposerFocus` is the whole policy — restore only when the user had the caret
  there, the dock is visible and the input is not `readOnly` / `disabled` — so a click that
  landed elsewhere, a hidden dock and a read-only composer are never stolen into. Each
  sequence posts `perfDiag kind:'composer-focus'` (`invariants/streaming-perf.md`), and
  `tools/check-webview.js` pins both halves: a window return restores the caret *and* its
  selection, and a hidden / hidden+disabled / visible+disabled dock is refused.
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
  sidecar **grid** inside the node's engine box. A node's sidecar children are grouped into
  **depth bands** — depth 1 is the node's own sub-windows, depth 2 theirs — each band a
  lattice of **column-major** stacks of at most `agentMaxRows` (3) cells (`nodeW` = 320 wide,
  `agentColGap` apart), and the columns are ordered so that a window's own windows stand
  directly right of its own column — a window that spawns
  windows costs a column hop instead of height. Every sidecar card is a **monitor card** —
  `agentMonitorH` (200) tall, head + status + live tail of its work log + one-line preview —
  and only the focused node (`id === treeActiveId`) renders as a full expanded card. There is
  no height valve (`agentMaxBlockH` is deleted): a column ends at the row cap and the cell
  that breaks it opens a new column inside its own band, so the block is bounded — a full band
  is `agentTopPad + 3·agentMonitorH + 2·agentVGap` = 664px — and no longer grows with the
  content a window holds.
  Rows are **not** aligned across columns: each column is its own stack of cells, its extent
  is the sum of its cells' own subtree box heights, and the block's height is the maximum
  over the columns; the columns are **not** flush at the bottom — a shorter one ends earlier
  and leaves blank canvas inside the parent's reserved box. Returns exactly
  `{ pos, cells, width, height }` — no `stretch` map, so `main.js` writes no inline height
  or max-height for layout and every card renders at its measured height — plus a
  `cells` **routing table** (per agent child: `busX` / `chanX` / `corrY`, the
  card-free corridors `main.js` draws the connectors through).
- `media/vendor/non-layered-tidy-tree-layout/` — **vendored, pinned** tree layout
  engine (`@2.0.2`, MIT): `dist/` (the file the webview loads), `src/` (readable
  source for offline re-audit), `LICENSE`, `PROVENANCE.md` (hashes + audit record).
  Not an npm dependency; never update it in place — see
  `docs/agents/invariants/vendored-deps.md`.
- `media/style.css` — chat UI styling (incl. tree node cards / toolbar, the
  `kind:'bg'` job card and the `.bgnotify` / `Delivered` badges, and the fixed
  `#term-dock` at the top-right: above the cards and the autoscroll origin, below the
  floating menus). Every
  size inside `#composer` is a fixed px value: the input dock's controls and
  fonts never scale with its host card.
  The card's reading height is one number in one place — `--node-max-h` (840 px), which a
  drag raises per card through an inline `max-height` and nothing writes an inline height
  — and the log's **three type levels** live here with it: the prose and the reasoning at
  13 px `--text`, a tool row's bold verb and its label both at 12 px `--text-dim`
  (11 px monospace for a *derived* command/pattern only), the expanded `.tool-detail` at
  11 px `--text-dim`, and the usage line as the faintest footnote. The log spends exactly
  one mark on "a step, not a voice": a step's own line is **italic** (`.tool-verb` and a
  prose `.tool-label`; a monospace label, the elapsed chip and the detail stay upright), and
  a step is the only thing **inset** — `.steps-body > .msg.tool`'s 15 px left margin, which
  puts a row's text on its `Ran N steps` label. The inset is per row, never a block: the
  reasoning that can ride the same body keeps the prose's left edge and stays upright.
- `media/vendor/markdown-it/` — **vendored, pinned** Markdown renderer
  (`@14.3.1`, MIT): `markdown-it.min.js` (the file the webview loads), `LICENSE`,
  `PROVENANCE.md` (hashes + the third-party code inlined in the bundle). Not an npm
  dependency; never update it in place — see
  `docs/agents/invariants/vendored-deps.md`. It replaced the old
  `media/markdown-it.min.js`, which sat outside the `media/vendor/** -text` rule and
  had drifted to CRLF.
- `media/activity.svg` · `media/icon.png` — the Activity Bar entry icon and the
  extension icon (`package.json`: `contributes.viewsContainers.activitybar` / `icon`).
- `tools/collect-artifacts.mjs` — the one owner of the `artifacts/` layout: it copies a
  built `.vsix` (`spinney-<version>.vsix`) into the gitignored top-level `artifacts/`,
  replacing the previous file of a kind instead of letting packages pile up, and prints a
  name / size / sha256 table. A missing input is a warning unless `--strict` makes it a
  failure. `npm run artifacts` collects whatever exists; `npm run package` and
  `build-deploy.ps1` collect strictly. Dev-only, like the rest of `tools/**`: that
  folder is excluded from the `.vsix`.
- `artifacts/` — the gitignored, top-level publish directory `tools/collect-artifacts.mjs`
  owns (the `.vsix`); never hand-edited, and useless to a fresh clone.
- `build-deploy.ps1` — compile + package + install helper.

