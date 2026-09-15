# Where to look when changing

- **Add/change a tool** → the tool's own file: `src/tools/<name>.ts` for a
  registry tool (schema + implementation together; register it in
  `buildTools()` in `src/tools/index.ts`, where the shared helpers also live), or
  `src/agent/tools/<name>.ts` for an intercepted/provider-orchestrated tool (add
  its `requires` capability tag and, if it is intercepted, its execution branch in
  `Agent.executeToolCall`). The description string is handed to the model — keep
  it accurate; optionally update `media/main.js` rendering.
- **Change what a model is / add a provider / add a model card** → the frozen
  contract is `docs/agents/invariants/model-cards.md`; the shapes, the parser and the
  accessors are in `src/agent/models.ts` (`ModelCard` /
  `ProviderSpec`, `parseCatalog`), the page that edits them
  is `src/chat/ModelPanel.ts` + `src/chat/modelTree.ts` + `media/modeltree.js` +
  `media/modeltree.css` (change `validatePayload` and its client mirror together),
  the host glue is `ChatViewProvider.applyModelCards` /
  `onModelCardsSaved` / `resolveModel` / `refreshKeys`, the routing and the two
  concurrency gates are `src/agent/clients.ts` + `src/agent/requestGate.ts`, and the
  settings are contributed in `package.json`. A per-provider API key is
  `apiKeySecretName()` in `src/chat/modelTree.ts` plus `ChatViewProvider.storeKeyFor`
  / `clearKeyFor`. The guards are `tools/check-models.js` and
  `tools/check-modeltree.js`.
- **Change the chat's model dropdown (or its thinking-level list)** → the host builds
  the `config` message in `SessionRuntime.postConfig()` (`src/chat/runtime.ts`: the
  whole `cards` list + the active card's `efforts` + `model` as a card id), and
  `renderModelSelect` / `renderEffortSelect` in `media/main.js` render it (one
  `optgroup` per provider; the levels follow the active card). The webview must keep
  **no copy of the catalog** — `tools/check-models.js` scans `media/**/*.js` for a
  model id and fails packaging when one appears.
- **Change the agent prompt** → `src/agent/prompt.ts` only (templates +
  placeholders); the loop and tool interception are in
  `src/agent/agent.ts`. See `docs/agents/invariants/system-prompt.md`.
- **Add a setting** → `package.json` `contributes.configuration` +
  `ChatViewProvider.getConfig()`. A setting must take effect **without a window
  reload**: read it at its point of use (the preferred shape), or, if some live
  owner caches it, push it from `ChatViewProvider.onConfigurationChanged()`
  (wired in `extension.ts` from `onDidChangeConfiguration`), which pushes it to the
  live owners (`SessionRuntime.applyDefaultModel` for a card change /
  `applyReplyLanguage`); a value read only once at activation is a bug. A key the
  page and the host both understand (`providers` / `modelCards`) belongs there too,
  not only in the page's save path. Extend the table in
  `docs/agents/invariants/config-keys.md` with the new key.
- **Add or reword a composer prompt snippet** → the shipped texts and the merge over
  `spinney.promptSections` are `src/chat/promptSnippets.ts` (the text is
  user-turn text and, like every string that reaches the model, carries no
  workspace fact — `invariants/system-prompt.md`, hard rule 1); the setting is
  contributed in `package.json` and read in `ChatViewProvider.getConfig()`, it
  rides the `config` message (`SessionRuntime.postConfig`), and the button, menu and
  insertion are `media/main.js` (`openSnippetMenu` / `insertSnippet`) with
  `.snippet-menu` in `media/style.css`. The webview keeps no copy of the list, so a
  settings edit repaints the menu on the next push. The replay check is the
  "snippet button" block in `tools/check-webview.js`.
- **Change the UI** → `media/main.js` (behavior) and/or `media/style.css`
  (styling); the HTML shell is in `getHtml()` in `ChatViewProvider.ts`.
  `style.css` maps every colour token in `:root` to a `--vscode-*` theme variable
  (the hex values are fallbacks only) so the panel follows light/dark/HC themes —
  keep any new colour theme-driven rather than hardcoded. Folding a block
  (thinking / tool card) goes through `setBlockOpen` + the active-block rule
  (`setActive` / `clearActive`, `applyFoldDefault`) — see
  `docs/agents/invariants/streaming-perf.md`.
- **Add or reword a user-visible string** → write it as the English source inside
  one literal: `vscode.l10n.t('…')` in the host, `tr('…')` in `media/main.js`, or
  `%key%` + `package.nls.json` for `package.json`; then add the entry to every
  shipped catalog (`l10n/bundle.l10n.*.json`, `package.nls.*.json`). `npm run
  check:l10n` fails packaging when the two sides drift. See
  `docs/agents/invariants/i18n.md`.
- **Change session persistence** → `loadSessions`/`persist`/`runtimeFor` in
  `ChatViewProvider.ts` and the memento keys (`spinney.state` plus the small
  `spinney.activeSession` / backfill markers); a session's shape (including the P4
  `model`/`effort` seed fields) is in `src/chat/tree.ts` (`normalizeTreeSession` keeps old
  state loadable — no `StoredState` version bump).
- **Change the multi-session / branch model** → `docs/agents/multi-session.md` is the
  frozen contract; the implementation is `src/chat/runtime.ts` (`SessionRuntime`,
  `TurnRun`, `runs`, `workerFor`) plus `src/chat/panels.ts` (`PanelManager`, one tab per
  session) and the per-panel routing in `ChatViewProvider.handlePanelMessage` / `postTo`.
- **Change what a full context window does** (a context rollover) → the frozen contract is
  `docs/agents/invariants/context-rollover.md`; the pieces are `contextBaseId` +
  `contextBase()` and the `pathMessages` cut in `src/chat/tree.ts`,
  `parseContextLengthError()` in `src/agent/models.ts`, `rolloverContext()` /
  `beginTurn({ freshContext })` / the harness resume text / the `contextFull` flag in
  `src/chat/runtime.ts`, the `rolloverTurn` route and its confirm gate in
  `ChatViewProvider.ts`, the meta field in `src/chat/transcript.ts`, the button variant in
  `media/main.js` with `.node-rollover` / `.edge-context` / `.node-ctx-badge` in
  `media/style.css`, the seven strings in `l10n/bundle.l10n.*.json`, and the guard
  `tools/check-context-rollover.js` (`npm run check:rollover`).
- **Background terminals** → `src/chat/backgroundHub.ts` (the `(session, node)`
  registries + session-local ids + the `onRegistered` hook), the
  `// ---- Background terminals ----` / `// ---- Completion signals ----` sections of
  `src/chat/runtime.ts` (the `kind:'bg'` card, notice injection, `postBackgrounds`), the tools in
  `src/tools/background.ts` / `backgroundTools.ts` / `execCommand.ts`, and each job's flying card
  (`renderBgBody`) in `media/main.js` — the in-card dock and `#bg-panel` are both gone.
- **Model / effort (per node, seeded per session)** → the live selection is a
  property of the **node**: `TreeNode.model` / `TreeNode.effort` in `src/chat/tree.ts`,
  resolved by ancestry (the nearest ancestor's card, else the session **seed**) — see
  `tools/model-switch-acceptance.js`. The session-level seed and its retirement
  anchors (`model` a **card id**, `effort` a level name, plus `modelFromSettings` /
  `effortFromSettings`) are the `AgentSession` fields in the same file; the host half
  is `ChatViewProvider.effectiveModel` / `effectiveEffort` (the level is clamped
  against the card that lands, via `normalizeEffort`) and the write path is
  `SessionRuntime.setModel` / `setThinkingEffort` (`applyDefaultModel` on a
  `spinney.model` / card change, which a session with no pick of its own adopts and
  re-clamps). The anchors are the default card id and that card's `defaultEffort`, so
  editing either wins over an older pick.
- **Verify a phase (P1–P4)** → `node tools/harness-test.mjs <suite...|all>` drives the
  live control plane; the suites and what each proves are in
  `docs/agents/multi-session.md` §5.1.
- **Delete a branch / node** → `branchIds` + `detachBranch` in `src/chat/tree.ts`
  (pure data), the `Branch deletion` block in `ChatViewProvider.ts`
  (`deleteBranchInteractive` → modal confirm → `deleteBranch`), the per-node
  transcript removal in `src/chat/transcript.ts` (`removeTranscripts` /
  `removeTranscriptFile`), and the card's `.node-del` button in `media/main.js`.
  The palette command is `spinney.deleteBranch`.
- **Change session titles** → `src/chat/sessionTitles.ts` (gates, digest, prompts,
  fallback) and the "Session titles" block in `ChatViewProvider.ts`
  (`applySessionTitle` / `renameSession` / the auto-title drain + backfill). The
  sidebar commands are `spinney.renameSession` / `spinney.autoRenameSession`;
  the agent-facing tool is `rename_session`.
- **Change the API client** → `src/agent/apiClient.ts`.

