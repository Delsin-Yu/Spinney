## Config keys (`spinney.*`)
`model`, `modelTable`, `baseUrl`, `commandTimeout`
(seconds, default 600 = 10 minutes — the default for `exec_command` when the tool
call does not pass its own `timeout`; a non-positive/absent value falls back to
600), `contextWindow` (0 = use the catalog's window; a `modelTable` row
beats it), `thinkingEffort`
(`none|low|medium|high`, default `medium` — `none` omits `reasoning_effort`),
`replyLanguage` (`auto` — the default, i.e. follow the VS Code display language —
or one of the language tags VS Code ships display translations for; resolved into
the **name** the prompt carries by `replyLanguageName` in
`src/agent/languages.ts` — the tags live only in the setting's `enum`, ordered
`auto`, `en`, `zh-Hans`, `zh-Hant` and then the rest by use, and the setting's
`enumDescriptions` are exactly the names the prompt receives, so the dropdown reads
like the prompt does; a tag CLDR cannot name, or any other name typed into
`settings.json`, is used verbatim),
`foldToolCalls` (default `true`),
`foldThinking` (default `true`), `maxConcurrentSubagents` (default 15),
`maxLevel2Subagents` (default 2), `saveSubAgentTranscripts` (default `true`),
`saveSessionTranscripts` (default `true` — dump each main-agent turn; the
one-time historical backfill is keyed by the Memento marker
`spinney.transcriptBackfill`),
`autoSessionTitles` (default `true` — name a session from its conversation after
the first turn and refresh it when the conversation grows; a manual rename locks
the title; the one-time historical backfill is keyed by the Memento marker
`spinney.sessionTitleBackfill`),
`subAgentTranscriptDir` (default `""` = global storage; else relative to the
**agent root** — the workspace folder, or the no-repo scratch folder
`<globalStorage>/no-workspace`; now the root for **both** transcript kinds),
`maxInlineToolOutput` (bytes, default `32768`; `0` = always inline — above it a
tool result spills to `<agentRoot>/.spinney/tool-output/`). `SubAgentPool` clamps `maxConcurrentSubagents`
to **≥ 1** (a non-positive limit would otherwise deadlock every sub-agent).
`httpApi.enabled` (default `false` — the local control plane) and `httpApi.port`
(default `0` = ephemeral).
- Models: exactly one is vendored — `deepseek-flash` (DeepSeek-V4.1-Flash,
  `contextWindow: 1_048_576`, `vision: true`). Everything else is the user's
  `spinney.modelTable`, structured data (the setting's own UI is a read-only
  preview plus a link into the JSON; the chat's **Models** panel is the editor):

  ```json model-table
  "spinney.modelTable": {
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
  `1_048_576`); precedence is `modelTable` row → `spinney.contextWindow` →
  catalog → default (`ChatViewProvider.getContextWindow`).
- A model the catalog does not know is **not** used: `resolveModel` falls back to
  `DEFAULT_MODEL` and says so in the output channel (a stale id must not silently
  mis-size the indicator or hide images).
- `thinkingEffort` sends `reasoning_effort` only when not `none`.

### When a change takes effect (no reload required)
`extension.ts` listens to `onDidChangeConfiguration` and routes an
`spinney.*` change to `ChatViewProvider.onConfigurationChanged(event)`. The
split is **push vs. pull**: a key that is read once and cached somewhere live has
to be *pushed* to that owner; a key read at its point of use is *pulled* and needs
no handling.

| Key | Applied | Mechanism |
| --- | --- | --- |
| `baseUrl` | next request (even mid-turn) | pulled into the shared `DeepSeekClient` via `configure()` — the main agent and every sub-agent hold that instance |
| `contextWindow` | immediately | pushed: recompute + `postContext()` |
| `modelTable` | immediately | pushed: `applyModelTable()` (re-parse + install) → `postConfig()` (dropdown + image affordances) → `getContextWindow`/`postContext` for the row's own model |
| `maxConcurrentSubagents` | immediately (raising wakes queued tasks; lowering drains) | pushed: `SubAgentPool.setMaxConcurrent` |
| `model`, `thinkingEffort` | immediately when *that key* changed, and only for sessions **without a pick of their own** (a per-tab dropdown pick wins) | pushed through `SessionRuntime.applyDefaultModel` / `applyDefaultEffort` (driven by `onConfigurationChanged`); a running session is skipped, like the dropdowns |
| `replyLanguage` | immediately when *that key* changed (a running session is skipped) | pushed: `ChatViewProvider.getConfig()` resolves the setting to a language **name** (`auto` → `vscode.env.language`, a tag → its CLDR name, via `replyLanguageName`), and `SessionRuntime.applyReplyLanguage` pushes that name to every node worker's `Agent.setReplyLanguage`, which rewrites `messages[0]`; a session with history gets the cache-miss notice. **No per-session pick**: the language is a property of the reader, so the setting is the only source (`SessionRuntime.replyLanguage` is seeded from it at construction). Re-picking `auto` when the display language is already in force resolves to the same name and is a no-op |
| `foldToolCalls`, `foldThinking` | immediately, incl. cards already on screen | pushed: `postConfig()` → the webview re-applies the default to existing cards |
| `httpApi.enabled`, `httpApi.port` | immediately | pushed: `ControlServer.restart()` (rebind the listener; disabling just leaves `start()` a no-op) |
| `commandTimeout`, `maxInlineToolOutput`, `maxLevel2Subagents`, `saveSessionTranscripts`, `saveSubAgentTranscripts`, `subAgentTranscriptDir`, `autoSessionTitles` | immediately | pulled at the point of use (they already were — no listener needed) |

- **`model` / `thinkingEffort` arbitration (P4):** each tab's dropdown writes its pick
  **onto its session** (`session.model` / `session.effort` + `modelFromSettings` /
  `effortFromSettings` — see `invariants/session-persistence.md`), so a pick is per
  session and survives a reload with it. It shadows the setting only while that setting is
  unchanged: `sessionModelPick` / `sessionEffortPick` ignore a pick whose anchor no longer
  matches, so editing the setting wins over an older pick and a pick made after the edit
  keeps winning. The *global* `spinney.runtimeConfig` Memento is now only the
  **default for sessions with no pick** (`effectiveModel` / `effectiveEffort` →
  `loadRuntimeConfig` → the setting) and the seed for sessions created later
  (`persistRuntimeConfig`). A stored record without the anchor fields predates the rule and
  is trusted.
- **Not a setting:** the `AGENTS.md` snapshot is taken once per activation
  (`loadAgentsMd`), so that one still needs a window reload — see
  `invariants/agents-md-snapshot.md`.

### Secrets are the one exception
`spinney.apiKey` was removed as a setting. The API key now lives in VS Code
SecretStorage (`context.secrets.get('spinney.apiKey')`, with the
`DEEPSEEK_API_KEY` environment variable as the fallback) and is read
asynchronously when a request needs it — set it with the `Spinney: Set API Key`
command and remove it with `Spinney: Clear API Key`. It is therefore **not** part
of the "every `spinney.*` change applies immediately" rule. Every other
`spinney.*` setting still applies at the moment you change it.
