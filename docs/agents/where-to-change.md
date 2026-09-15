# Where to look when changing

- **Add/change a tool** → the tool's own file: `src/tools/<name>.ts` for a
  registry tool (schema + implementation together; register it in
  `buildTools()` in `src/tools/index.ts`, where the shared helpers also live), or
  `src/agent/tools/<name>.ts` for an intercepted/provider-orchestrated tool (add
  its `requires` capability tag and, if it is intercepted, its execution branch in
  `Agent.executeToolCall`). The description string is handed to the model — keep
  it accurate; optionally update `media/main.js` rendering.
- **Change the agent prompt** → `src/agent/prompt.ts` only (templates +
  placeholders); the loop and tool interception are in
  `src/agent/agent.ts`. See `docs/agents/invariants/system-prompt.md`.
- **Add a setting** → `package.json` `contributes.configuration` +
  `ChatViewProvider.getConfig()`. A setting must take effect **without a window
  reload**: read it at its point of use (the preferred shape), or, if some live
  owner caches it, push it from `ChatViewProvider.onConfigurationChanged()`
  (wired in `extension.ts` from `onDidChangeConfiguration`), which pushes it to the
  live owners (`SessionRuntime.applyDefaultModel` / `applyDefaultEffort` /
  `applyReplyLanguage`); a value read only once at activation is a bug. Extend the table in
  `docs/agents/invariants/config-keys.md` with the new key.
- **Change the UI** → `media/main.js` (behavior) and/or `media/style.css`
  (styling); the HTML shell is in `getHtml()` in `ChatViewProvider.ts`.
  `style.css` maps every colour token in `:root` to a `--vscode-*` theme variable
  (the hex values are fallbacks only) so the panel follows light/dark/HC themes —
  keep any new colour theme-driven rather than hardcoded.
- **Add or reword a user-visible string** → write it as the English source inside
  one literal: `vscode.l10n.t('…')` in the host, `tr('…')` in `media/main.js`, or
  `%key%` + `package.nls.json` for `package.json`; then add the entry to every
  shipped catalog (`l10n/bundle.l10n.*.json`, `package.nls.*.json`). `npm run
  check:l10n` fails packaging when the two sides drift. See
  `docs/agents/invariants/i18n.md`.
- **Change session persistence** → `loadSessions`/`persist`/`runtimeFor` in
  `ChatViewProvider.ts` and the `StorageKey`s; a session's shape (including the P4
  `model`/`effort` fields) is in `src/chat/tree.ts` (`normalizeTreeSession` keeps old
  state loadable — no `StoredState` version bump).
- **Change the multi-session / branch model** → `docs/agents/multi-session.md` is the
  frozen contract; the implementation is `src/chat/runtime.ts` (`SessionRuntime`,
  `TurnRun`, `runs`, `workerFor`) plus `src/chat/panels.ts` (`PanelManager`, one tab per
  session) and the per-panel routing in `ChatViewProvider.handlePanelMessage` / `postTo`.
- **Background terminals** → `src/chat/backgroundHub.ts` (the `(session, node)`
  registries + session-local ids + the `onRegistered` hook), the
  `// ---- Background terminals ----` / `// ---- Completion signals ----` sections of
  `src/chat/runtime.ts` (the `kind:'bg'` card, notice injection, `postBackgrounds`), the tools in
  `src/tools/background.ts` / `backgroundTools.ts` / `execCommand.ts`, and each job's flying card
  (`renderBgBody`) in `media/main.js` — the in-card dock and `#bg-panel` are both gone.
- **Per-session model / effort** → the `model` / `effort` (and `modelFromSettings` /
  `effortFromSettings`) fields on `AgentSession` in `src/chat/tree.ts`, their resolution
  in `ChatViewProvider.effectiveModel` / `effectiveEffort`, and the write path
  `SessionRuntime.setModel` / `setThinkingEffort` (`applyDefaultModel` /
  `applyDefaultEffort` for a settings change).
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
- **Change the API client** → `src/agent/deepseek.ts`.

