# File map

- `src/extension.ts` — activation; registers the webview provider + commands.
- `src/chat/ChatViewProvider.ts` — the window coordinator: session/persistence,
  config (including `applyModelCards` / `refreshKeys`),
  image attachment, titles, transcripts, the global hop bookkeeping, the
  control-plane host, the HTML shell, the Model Card Tree page controller, and
  webview message routing. It owns the
  `runtimes: Map<sessionId, SessionRuntime>` and a `PanelManager` (tabs); the editor
  `WebviewPanel` lifecycle is `restorePanel` (serializer) + `postAllState`. It is also the
  remote publisher's host (`src/remote/remoteService.ts`): `postTo` is the single funnel the
  mirror taps, `handleSessionMessage` is the single routing switch a peer's `input` frame
  reaches, `applyRemoteInput` is the refusal gate (read-only window, unknown session), and
  `remoteTreeMessage` answers an `attach` without repainting the local tab.
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
  `treeMessage()` builds the `tree` message **without** posting it, which is what lets a
  remote `attach` be answered with the very message a local tab receives; a turn a peer
  started carries the `RemoteOrigin` mark on its node (`onUserMessage`'s third argument),
  which never touches the messages sent to the provider.
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
  (`buildChatShell` + `webviewNonce`), shared by the local chat tab
  (`ChatViewProvider.getHtml()`) and the replicated session panel
  (`src/remote/remoteSessionPanel.ts`): same script set and order (the vendored layout
  engine, markdown-it, `media/tree.js`, `media/main.js`), same CSP nonce, same
  `window.__spinneyL10n`, same element ids, per-caller `mediaVersion`. Two callers, one
  template, because `media/main.js` fetches its whole surface by element id and a drifted
  second shell would freeze the replica with nothing able to say why. Guarded by
  `npm run check:webview` and `node tools/check-remote-assets.js` (the shell block, which
  reads this file).
- `src/chat/imagePick.ts` — `pickImageAttachment`: the one image picker, returning
  `{ kind: 'picked', dataUrl, name }` / `cancelled` / `failed`. Used by
  `SessionRuntime.handlePickImage` and by the replicated session panel, where the picker
  opens on the surface you are operating and the bytes then travel inside `userMessage`
  (`docs/agents/plans/remote-control.md` §4).
- `src/chat/tree.ts` — the Chat Tree data model: `TreeNode` / `AgentSession`,
  path assembly (`pathIds` / `pathMessages`), the context basis that cuts the API
  prefix (`TreeNode.contextBaseId` / `contextBase()` — see
  `invariants/context-rollover.md`), `attachNode`, `pruneSession`,
  branch removal (`branchIds` / `detachBranch`), the `isSidecar` predicate (a
  sub-agent `kind:'agent'` window vs. a background job `kind:'bg'` card — both
  display-only sidecars) and the v1→v2 state migration. Pure data layer, no VS Code UI.
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
- `src/remote/rooms.ts` — the remote-control **derivation**: token → `master`
  (PBKDF2-HMAC-SHA256, 600000 iterations) → the room id, the AEAD key and the MAC
  key (HKDF-SHA256), plus the room-id validator and the token-strength check the
  connect dialog maps to one localized sentence. It is synchronous on purpose — the
  600000 iterations are paid once per room per connection, never on a hot path.
- `src/remote/frames.ts` — the sealed frame: the logical-frame envelope
  (`{v,type,id,from,to,body}`), the `v|seq|fid` AAD a receiver can build **before**
  it decrypts, `sealFrame`/`openFrame` (AES-256-GCM, tag appended), the
  slice/reassemble pair (one seal per logical frame, then slices of at most 48000
  base64 characters, hard-capped at 16 MiB reassembled), the 64-wide replay window,
  and the three-way error taxonomy (too large / tampered / replayed) that keeps a
  broken peer distinguishable from a hostile one. Pure `node:crypto`, no `vscode`.
- `src/remote/allowlist.ts` — the mirror's two **deny-by-default** tables
  (`MIRROR_TO_PEER`, `ACCEPT_FROM_PEER`) and the refused types with their reasons.
  Deny-by-default is what makes a new host or webview message type fail a guard
  instead of silently crossing the wire: `perfDiag` / `layoutDiagnostic` reaching the
  publisher would trip its own painting-recovery ladder, `openExternal` / `pickImage`
  / `copyNodeId` belong to the surface you are operating, and `setNodeSize` / `panTo`
  to the surface you are looking at. See `remote/PROTOCOL.md` §6.
- `src/remote/relayClient.ts` — `RelayTransport`: the one outbound room connection per
  (window, room). It owns the relay conversation (`join`, the SSE `down` stream, `up` for
  every frame), sealing/slicing and reassembly, the replay window, the 20 s app-level ping
  that keeps the stream non-idle, POST pacing, reconnect with backoff, and a **bounded**
  outbound queue that drops instead of growing — so a peer that cannot keep up can never
  delay the owner's window. It knows nothing about sessions or webviews; it reports phase
  and drop counts through `onStatus` and hands decoded frames to `onFrame`.
- `src/remote/remoteService.ts` — the **publisher**, one per window: one `RelayTransport`
  per room that says `autoConnect` (and only while `spinney.remote.enabled` is on), the
  peer registry keyed by `deviceId`+`instanceId` (never by the transient peer id), the
  `hello`/`instances` presence it announces, the `attach`/`detach` answers, and the two
  halves of the mirror. `mirrorLocal` is called from the one funnel every host→webview
  message passes through (`ChatViewProvider.postTo`), filters by `mayMirrorToPeer`, drops
  the perf `traceId` and forwards **only** for sessions some peer attached to — with no
  `await` anywhere on that path; `applyRemoteInput` drives the *same* local message path
  and answers `error{code}` for every refusal, with a short-lived frame-id de-dupe cache so
  a replayed `input` after a reconnect is not a second submit. It also defines the node's
  `RemoteOrigin` (`{ peerId, deviceName, at }`) mark, its transcript-meta half
  (`writeOriginIntoTranscript`) and the window's status-bar item (whose click now reveals
  the room tree, `spinney.remoteFocus`). `snapshot()` is the read-only
  rooms→peers→instances→sessions view the room tree draws, and `onDidChange` is what it
  repaints from (no polling).
  M2 added the third and fourth things it owns: the **`cmd`/`result` pair** (a control-plane
  route run by the publisher — `session/start`, `navigate`, `continue`, `stop` — correlated
  by the frame `id`, refused `error{code}`, and covered by the *same* de-dupe cache `input`
  uses, so a repeated id after a reconnect cannot create a second session), the **replica
  side** (`openReplica` / `RemoteReplicaHandle`: `attach` on open, `input`/`cmd` addressed to
  that peer, `detach` on close, `mirror` frames routed to the surface that asked, and a
  re-`attach` after a reconnect), and **`kick`/`unblock`** — a *local blocklist* keyed by
  `deviceId`+`instanceId`, which stops mirroring to that peer, drops its `input`/`cmd` frames
  unanswered-but-logged and says `bye`, and cannot revoke anything (the peer still holds the
  token and can reach every other window).
- `src/remote/replicaRouting.ts` — the **frozen 1:1 table** a replicated session routes by:
  `REPLICA_LOCAL_MESSAGES` (the types the replica answers itself — the clipboard, the file
  picker, an external link, the local Model Cards page, the webview's own diagnostics and
  card geometry, `ready`) and `replicaRoute()`, which reads it and falls through to
  `mayAcceptFromPeer` (`allowlist.ts`), refusing everything else. Data, not a switch, because
  a new webview message must be *decided* rather than forwarded by accident;
  `tools/remote-surfaces-acceptance.js` pins it (and that the two sets never overlap).
- `src/remote/remoteTreeView.ts` — the **room tree**: `RemoteTreeProvider`, one
  `TreeDataProvider` over `RemoteService.snapshot()`, drawing `room → device → instance →
  session` (a room's phase and peer count; a device's name, blocked/live state and version; an
  instance's workspace folder, model and busy state; a session's title and
  running/locked/background state). It re-reads on `RemoteService.onDidChange`, never polls,
  and publishes `spinney.remote.hasRooms` for the two welcome views. The actions beside it are
  the split made visible: `openRemoteSession` (the replica panel), `sendRemoteMessage` /
  `stopRemoteSession` / `newRemoteSession` (a `cmd` frame the publisher runs), `kickRemoteDevice`
  / `unblockRemoteDevice` / `copyRemoteDeviceName` / `setRemoteRoomConnected` (local), and
  `manageRemoteRoomsFromTree` (M1's editor).
- `src/remote/remoteSessionPanel.ts` — the **replicated session panel** (view type
  `spinney.remoteSession`, one tab per `room+deviceId+instanceId+sessionId`, re-opened by
  focusing the existing tab and recovered through a `WebviewPanelSerializer`): it renders
  **only** `mirror` frames, with the shared shell (`src/chat/webviewShell.ts`) and therefore
  the shipped `media/main.js`. It answers the local affordances itself (`pickImage` → this
  machine's dialog → `imagePicked`; `copyNodeId`; `openExternal`; the local Model Cards page;
  the diagnostics and card geometry are dropped), forces `readOnly: false` on the `state` it
  hands its webview (this window's workspace lock is not the publisher's), shows a publisher
  refusal (`error{code:'readonly'}` included) as a notice, and asks the **`deleteBranch`**
  confirmation here before submitting the one input marked `confirmed: true` — the one remote
  input that deliberately bypasses the owner's dialog.
- `src/remote/origin.ts` — the `RemoteOrigin` type alone (`{ peerId, deviceName, at }`): the
  mark a remote-originated turn carries on its node (`TreeNode.origin`) and in its transcript
  dump's line-1 meta. It lives in its own import-free module because `src/chat/tree.ts` needs
  the type and is loaded by plain node (guards, acceptance runs), while
  `src/remote/remoteService.ts` is a `vscode`/`node:crypto` module that re-exports it.
- `src/remote/roomsStore.ts` — the persisted half: `spinney.remote.rooms` (an object keyed
  by the **local room name**, each row `{ relayUrl, autoConnect }`), the parser with its
  skip-and-report policy, and the tokens in SecretStorage
  (`spinney.remote.password.<roomName>`, moved on a rename, never written to a setting).
  Every write goes through `configuration.update` at the scope the window reads from.
- `src/remote/roomsCommand.ts` — `Spinney: Manage Remote Rooms` (`spinney.remoteRooms`):
  the QuickPick over the rooms (each with its live phase and peer count plus Connect /
  Disconnect / Rename / Set token / Clear token / Remove / Copy room name), the chained
  input boxes of `Add room…`, and the `tokenIssue`→sentence mapping the pure `rooms.ts`
  cannot localize itself.
- `remote/PROTOCOL.md` — the wire contract for remote control: roles, identity, the
  crypto, the frame types, the two allow-lists, the SSE-down/POST-up transport, the
  slicing and backpressure rules, the sizing table and the threat model. Three
  implementations read it (this host, the C# relay, the Android app) and it is the
  authority when one of them disagrees.
- `remote/vectors/vectors.json` · `remote/vectors/README.md` —
  `tools/gen-remote-vectors.mjs` is the generator; the committed vectors are the
  proof that the TypeScript and Kotlin derivations and seals agree **byte for byte**
  (the relay holds no key, so it has nothing to agree about). Regenerate with
  `node tools/gen-remote-vectors.mjs`; a mismatch means one implementation drifted,
  and `npm run check:remote` is what says so.
- `remote/server/` — the relay: a C# ASP.NET Core Minimal API, Native AOT, cross
  compiled to `linux-x64` from any host with the `StuDev.AotAnywhere` MSBuild SDK. A
  dumb byte pipe (it routes by room id and never parses, decrypts, logs or stores a
  frame body), with `--selftest` running its whole contract in process and
  `remote/server/README.md` carrying the flag table and a VPS run-book. Self-hosted
  only; **not** shipped in the `.vsix` (`.vscodeignore` excludes `remote/**`).
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
- `tools/remote-interop.mjs` (`npm run check:interop`) — the **cross-implementation
  acceptance** for remote control: the real relay, the real Kotlin peer (a jar built by
  `:core:interopJar`) and the real compiled TypeScript transport in one room, proving
  sealed frames cross byte for byte and that each side opens the other's frame with the
  salt it read from the envelope, while the `fid`-derived salt provably cannot open it.
  Dev-only and **not** in the gate: it needs `dotnet` and a JVM. See `testing.md`.
- `tools/remote-acceptance.mjs` (`npm run check:remote-e2e`) — the **windowed**
  acceptance for remote control: one throwaway VS Code window (the `tools/sim/run.mjs`
  recipe) joins a real relay and is driven by a second member. Dev-only and **not** in the
  gate: it needs a window.
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
  `tools/exec-timeout-acceptance.js` · `tools/bg-budget-acceptance.js` — the four
  guards next to it
  (`npm run check:shell` / `check:kill` / `check:timeout` / `check:budget`, all part of
  `vscode:prepublish`, all needing `out/`): the argv a **native** child really
  receives under Git Bash (the `MSYS_NO_PATHCONV` fix — `/PID` must arrive verbatim,
  and what `//F` / `//IM` become is printed), the kill contract
  (`'exited' | 'no-exit' | 'no-pid'`, a real exit confirmed before the deadline,
  `BackgroundRegistry.kill` staying synchronous, an unconfirmed kill flagged *and*
  logged), the **foreground limit** `spinney.commandMaxForegroundDuration` (a `timeout`
  above it refused *before the spawn* unless a background `timeout_behavior` asked for
  one — `background_when_timeout` / `start_in_background` / `start_detached`, the
  default `stop_when_timeout` being the value that is refused — the promotion at the
  limit carrying only the `timeout − limit` that is left and
  one `hub.register` under the owner of the turn, a node-scoped value
  (`background_when_timeout` / `start_in_background`) with no `timeout` refused before the
  spawn, and no ceiling on `timeout`), and the
  **background budget** (a job killed at its deadline with `killReason:'timeout'`, an
  unbudgeted job left alone, a `remainingBudgetMs` that counts down, and
  `join_background`'s two refusals — more budget left than the limit, or no deadline at
  all (which the guard registers directly; the only value that can produce such a job
  now is `start_detached`) — plus the allowed case). See `testing.md`.
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
  `normalizeEffort`, `visionCardsLabel`), `parseContextLengthError()` — the
  reader of the provider's context-length 400 — and `windowFullReason()` — the
  classifier of a refusal's **kind** (`'tokens'` / `'images'` / `undefined`), which is
  what triggers a context rollover for either budget (`invariants/context-rollover.md`).
  See `invariants/model-cards.md`. It is the **only** place a model id may
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
  `tools/check-modeltree.js` · `tools/check-tree-grid.js` · `tools/check-docs.js` ·
  `tools/exec-cwd-acceptance.js` · `tools/shell-argv-acceptance.js` ·
  `tools/exec-kill-acceptance.js` · `tools/exec-timeout-acceptance.js` ·
  `tools/bg-budget-acceptance.js` · `tools/check-remote.js` ·
  `tools/relay-acceptance.js` · `tools/remote-surfaces-acceptance.js` ·
  `tools/check-remote-assets.js` · `tools/websearch-acceptance.js` ·
  `tools/check-png.js` · `tools/check-resample.js` · `tools/check-image.js` ·
  `tools/check-jpeg.js` · `tools/check-unicode.js` —
  the packaging guards
  (`npm run check:models` / `check:webview` / `check:signals` / `check:l10n` /
  `check:rollover` / `check:modeltree` / `check:grid` / `check:docs` / `check:cwd` /
  `check:shell` / `check:kill` / `check:timeout` / `check:budget` / `check:remote` /
  `check:relay` / `check:remote-surfaces` / `check:remote-assets` /
  `check:websearch` / `check:png` / `check:resample` / `check:image` /
  `check:jpeg` / `check:unicode`, run
  by `vscode:prepublish`):
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
  pattern that would keep a page out of the `.vsix`), and the working directory and path
  base (`resolvePath`'s `/d/x` → `D:\x` on Windows only, a command's first line naming
  the directory it ran in, a broken `cwd` naming the path instead of the shell, and the
  `/d/...` form reaching the file it means), and the command's other four contracts —
  the argv a native child receives under Git Bash (the `MSYS_NO_PATHCONV` fix), the
  kill-confirmation rules (`'exited'` / `'no-exit'` / `'no-pid'`, a confirmed exit before
  the deadline, a synchronous `BackgroundRegistry.kill`, an unconfirmed kill flagged and
  logged), the foreground limit (`spinney.commandMaxForegroundDuration`: the refusal of a
  `timeout` above it before the spawn without a background `timeout_behavior`, the
  promotion at the limit with only the remaining budget, a node-scoped value
  (`background_when_timeout` / `start_in_background`) with no `timeout` refused before the spawn,
  no ceiling on `timeout`), and the background budget (a job killed at its own
  deadline with `killReason:'timeout'`, an unbudgeted job left alone,
  `remainingBudgetMs`, `join_background`'s refusals). See `testing.md`.

  `tools/remote-surfaces-acceptance.js` is the M2 half of that list (and the reason it is a
  guard rather than scratch): it stubs `vscode` and replaces `RelayTransport.prototype` with
  a recorder, so the **real** `RemoteService` runs its own reconciliation, key derivation,
  frame routing, de-dupe cache and blocklist with no window and no socket. It pins the room
  tree's snapshot, the `cmd`/`result` pair (including that a repeated frame id answers from
  the cache and creates no second session), the four refusals, `kick` as a local blocklist
  with `unblock`, the replica surface's `attach`/`mirror`/`input`/`cmd`/`detach` across a
  reconnect, and the frozen 1:1 routing table of `src/remote/replicaRouting.ts`.
  `tools/relay-acceptance.js` is its sibling for the transport: a real relay on an ephemeral
  loopback port driving the compiled `RelayTransport` through join, slicing, replay/tamper
  refusals, pacing, backpressure and a reconnect with fresh key material.
  The four image guards in that list (`check:png` / `check:resample` / `check:image` /
  `check:jpeg`) pin the pre-upload transform's bytes in and bytes out, the PNG codec, the
  resampler and the JPEG decoder — see `testing.md`.
- `src/agent/tools/` — one file per intercepted tool (`readImage`, `spawnAgents`,
  `spawnReadonlyAgents`, `sendAgentMessage`, `sendReadonlyAgentMessage`,
  `hopSession`, `listNodes`, `renameSession`) plus `index.ts`, the barrel that
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
  card's exact height (`height` + `max-height`, since `.node` caps at 1200px), and a
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
- `tools/collect-artifacts.mjs` — the one owner of the `artifacts/` layout: it copies a
  built `.vsix` (`spinney-<version>.vsix`), the cross-compiled relay
  (`spinney-<version>-relay-linux-x64`) together with its **companion**
  `appsettings.json` — collected flat under its canonical name, because ASP.NET loads
  that file by name from the executable's own directory, and reported like a missing
  input when the binary is present without it — and the Android debug APK
  (`spinney-<version>-debug.apk`) into the gitignored top-level `artifacts/`, replacing
  the previous file of a kind instead of letting packages pile up, and prints a name /
  size / sha256 table. The relay's ~55 MiB `.dbg` symbol file is deliberately not
  collected (it stays in the toolchain's publish tree, where anyone symbolizing a crash
  looks). `--vsix` / `--relay` / `--apk` narrow it to one kind (no flag means all three,
  opportunistically); a missing input is a warning unless `--strict` makes it a
  failure. `npm run artifacts` collects whatever exists; `npm run package` and
  `build-deploy.ps1` collect strictly. Dev-only, like the rest of `tools/**`: that
  folder is excluded from the `.vsix`.
- `artifacts/` — the gitignored, top-level publish directory `tools/collect-artifacts.mjs`
  owns (the `.vsix`, the `linux-x64` relay with its `appsettings.json`, and the Android
  debug APK); never hand-edited, and useless to a fresh clone.
- `build-deploy.ps1` — compile + package + install helper.

