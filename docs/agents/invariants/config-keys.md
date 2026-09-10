## Config keys (`agentHarness.*`)
`apiKey` (or `DEEPSEEK_API_KEY` env), `model`, `modelTable`, `baseUrl`, `commandTimeout`
(seconds, default 600 = 10 minutes — the default for `exec_command` when the tool
call does not pass its own `timeout`; a non-positive/absent value falls back to
600), `maxTurns`
(default 20), `contextWindow` (0 = use the catalog's window; a `modelTable` row
beats it), `thinkingEffort`
(`none|low|medium|high`, default `medium` — `none` omits `reasoning_effort`),
`foldToolCalls` (default `true`),
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
- Models: exactly one is vendored — `deepseek-flash` (DeepSeek-V4.1-Flash,
  `contextWindow: 1_048_576`, `vision: true`). Everything else is the user's
  `agentHarness.modelTable`, structured data (the setting's own UI is a read-only
  preview plus a link into the JSON; the chat's **Models** panel is the editor):

  ```json model-table
  "agentHarness.modelTable": {
    "deepseek-v4-pro": { "vision": false, "max_tokens": 1048576 },
    "another-model":   { "vision": true,  "max_tokens": 200000 }
  }
  ```

  An entry for `deepseek-flash` overrides the vendored entry; any other id is
  added to the dropdown. A missing field keeps the vendored value for that id, or
  non-vision / `1_048_576` for a new one. Entries that cannot be parsed are
  skipped and logged to the output channel (`applyModelTable`). The setting's
  description links straight into `settings.json`; see
  `invariants/model-capabilities.md` for why the data is structured, why the
  editor is the JSON itself, and why nothing is probed.
- Context windows default to `DEFAULT_CONTEXT_WINDOW` (= the vendored model's
  `1_048_576`); precedence is `modelTable` row → `agentHarness.contextWindow` →
  catalog → default (`ChatViewProvider.getContextWindow`).
- A model the catalog does not know is **not** used: `resolveModel` falls back to
  `DEFAULT_MODEL` and says so in the output channel (a stale id must not silently
  mis-size the indicator or hide images).
- `thinkingEffort` sends `reasoning_effort` only when not `none`.

### When a change takes effect (no reload required)
`extension.ts` listens to `onDidChangeConfiguration` and routes an
`agentHarness.*` change to `ChatViewProvider.onConfigurationChanged(event)`. The
split is **push vs. pull**: a key that is read once and cached somewhere live has
to be *pushed* to that owner; a key read at its point of use is *pulled* and needs
no handling.

| Key | Applied | Mechanism |
| --- | --- | --- |
| `apiKey`, `baseUrl` | next request (even mid-turn) | pulled into the shared `DeepSeekClient` via `configure()` — the main agent and every sub-agent hold that instance |
| `maxTurns` | next tool round (main agent) / next `spawn_agents` (sub-agents) | pushed: `Agent.setMaxTurns`; sub-agents re-read it at spawn |
| `contextWindow` | immediately | pushed: recompute + `postContext()` |
| `modelTable` | immediately | pushed: `applyModelTable()` (re-parse + install) → `postConfig()` (dropdown + image affordances) → `getContextWindow`/`postContext` for the row's own model |
| `maxConcurrentSubagents` | immediately (raising wakes queued tasks; lowering drains) | pushed: `SubAgentPool.setMaxConcurrent` |
| `model`, `thinkingEffort` | immediately when *that key* changed, else the dropdown selection wins | pushed through `onSetModel` / `onSetThinkingEffort`; skipped while a turn is running, like the dropdowns |
| `foldToolCalls`, `foldThinking` | immediately, incl. cards already on screen | pushed: `postConfig()` → the webview re-applies the default to existing cards |
| `httpApi.enabled`, `httpApi.port` | immediately | pushed: `ControlServer.restart()` (rebind the listener; disabling just leaves `start()` a no-op) |
| `commandTimeout`, `maxInlineToolOutput`, `maxLevel2Subagents`, `saveSessionTranscripts`, `saveSubAgentTranscripts`, `subAgentTranscriptDir`, `autoSessionTitles` | immediately | pulled at the point of use (they already were — no listener needed) |

- **`model` / `thinkingEffort` arbitration:** the chat dropdowns persist their
  pick in the `agentHarness.runtimeConfig` Memento. The pick shadows the setting
  only while the setting is unchanged: `persistRuntimeConfig` also stores the
  setting values in force (`modelFromSettings` / `effortFromSettings`), and
  `loadRuntimeConfig` falls back to the setting when they differ. So editing the
  setting (live or while VS Code is closed) wins over an older pick; a pick made
  after the edit keeps winning. A record without those fields predates the rule
  and is trusted.
- **Not a setting:** the `AGENTS.md` snapshot is taken once per activation
  (`loadAgentsMd`), so that one still needs a window reload — see
  `invariants/agents-md-snapshot.md`.
