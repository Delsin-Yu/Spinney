## Config keys (`agentHarness.*`)
`apiKey` (or `DEEPSEEK_API_KEY` env), `model`, `baseUrl`, `commandTimeout`
(seconds, default 120), `maxTurns` (default 20), `contextWindow` (0 = auto),
`thinkingEffort` (`none|low|medium|high`), `foldToolCalls` (default `true`),
`foldThinking` (default `true`), `maxConcurrentSubagents` (default 15),
`maxLevel2Subagents` (default 2), `saveSubAgentTranscripts` (default `true`),
`saveSessionTranscripts` (default `true` — dump each main-agent turn; the
one-time historical backfill is keyed by the Memento marker
`agentHarness.transcriptBackfill`),
`autoSessionTitles` (default `true` — name a session from its conversation after
the first turn and refresh it when the conversation grows; a manual rename locks
the title; the one-time historical backfill is keyed by the Memento marker
`agentHarness.sessionTitleBackfill`),
`subAgentTranscriptDir` (default `""` = global storage; else relative to the
**agent root** — the workspace folder, or the no-repo scratch folder
`<globalStorage>/no-workspace`; now the root for **both** transcript kinds),
`maxInlineToolOutput` (bytes, default `32768`; `0` = always inline — above it a
tool result spills to `<agentRoot>/.agent-harness/tool-output/`). `SubAgentPool` clamps `maxConcurrentSubagents`
to **≥ 1** (a non-positive limit would otherwise deadlock every sub-agent).
`httpApi.enabled` (default `false` — the local control plane) and `httpApi.port`
(default `0` = ephemeral).
- Models: `deepseek-chat`, `deepseek-reasoner`, `deepseek-v4-flash`,
  `deepseek-v4-pro`, `deepseek-v4-flash-vision-exp`,
  `deepseek-v4.1-flash-expires-on-0910`.
- Context windows: all default to `1_000_000` tokens (see `CONTEXT_WINDOWS` /
  `DEFAULT_CONTEXT_WINDOW`); `agentHarness.contextWindow` overrides.
- `deepseek-reasoner` may not support tool calling — use `deepseek-chat` for the
  agentic loop.
- `thinkingEffort` sends `reasoning_effort` only when not `none`.

