# Where to look when changing

- **Add/change a tool** → `src/tools/index.ts` (define `AgentTool`, register in
  `ToolRegistry`), the tool description string is handed to the model (keep it
  accurate), and optionally update `media/main.js` rendering.
- **Change the agent prompt/behavior** → `src/agent/agent.ts` (`CORE_PROMPT`,
  `buildSystemPrompt`, `identityLines`, `maxTurns`).
- **Add a setting** → `package.json` `contributes.configuration` +
  `ChatViewProvider.getConfig()` / `buildAgent()`.
- **Change the UI** → `media/main.js` (behavior) and/or `media/style.css`
  (styling); the HTML shell is in `getHtml()` in `ChatViewProvider.ts`.
  `style.css` maps every colour token in `:root` to a `--vscode-*` theme variable
  (the hex values are fallbacks only) so the panel follows light/dark/HC themes —
  keep any new colour theme-driven rather than hardcoded.
- **Change session persistence** → `loadSessions`/`persist`/`activateSession` in
  `ChatViewProvider.ts` and the `StorageKey`s.
- **Change the API client** → `src/agent/deepseek.ts`.

