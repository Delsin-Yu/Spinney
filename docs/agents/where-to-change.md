# Where to look when changing

- **Add/change a tool** → the tool's own file: `src/tools/<name>.ts` for a
  registry tool (schema + implementation together; register it in
  `buildTools()` in `src/tools/index.ts`, where the shared helpers also live), or
  `src/agent/tools/<name>.ts` for an intercepted/provider-orchestrated tool (add
  its `requires` capability tag and, if it is intercepted, its execution branch in
  `Agent.executeToolCall`). The description string is handed to the model — keep
  it accurate; optionally update `media/main.js` rendering.
- **Change the agent prompt** → `src/agent/prompt.ts` only (templates +
  placeholders); the loop, tool interception and `maxTurns` are in
  `src/agent/agent.ts`. See `docs/agents/invariants/system-prompt.md`.
- **Add a setting** → `package.json` `contributes.configuration` +
  `ChatViewProvider.getConfig()` / `buildAgent()`.
- **Change the UI** → `media/main.js` (behavior) and/or `media/style.css`
  (styling); the HTML shell is in `getHtml()` in `ChatViewProvider.ts`.
  `style.css` maps every colour token in `:root` to a `--vscode-*` theme variable
  (the hex values are fallbacks only) so the panel follows light/dark/HC themes —
  keep any new colour theme-driven rather than hardcoded.
- **Change session persistence** → `loadSessions`/`persist`/`activateSession` in
  `ChatViewProvider.ts` and the `StorageKey`s.
- **Delete a branch / node** → `branchIds` + `detachBranch` in `src/chat/tree.ts`
  (pure data), the `Branch deletion` block in `ChatViewProvider.ts`
  (`deleteBranchInteractive` → modal confirm → `deleteBranch`), the per-node
  transcript removal in `src/chat/transcript.ts` (`removeTranscripts` /
  `removeTranscriptFile`), and the card's `.node-del` button in `media/main.js`.
  The palette command is `agentHarness.deleteBranch`.
- **Change session titles** → `src/chat/sessionTitles.ts` (gates, digest, prompts,
  fallback) and the "Session titles" block in `ChatViewProvider.ts`
  (`applySessionTitle` / `renameSession` / the auto-title drain + backfill). The
  sidebar commands are `agentHarness.renameSession` / `agentHarness.autoRenameSession`;
  the agent-facing tool is `rename_session`.
- **Change the API client** → `src/agent/deepseek.ts`.

