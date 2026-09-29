## Config keys (`spinney.*`)
The settings are contributed in **groups**: `contributes.configuration` is an array of
`{ title, properties }` sections — Model & API (`model`, `providers`, `modelCards`) · Chat & Display
(`replyLanguage`, `foldThinking`, `foldToolCalls`, `foldWork`, `promptSections`) · Tools & Execution
(`commandMaxForegroundDuration`, `maxInlineToolOutput`) · Sub-agents
(`maxConcurrentSubagents`, `maxLevel2Subagents`) · Sessions & Transcripts (`autoSessionTitles`,
`saveSessionTranscripts`, `saveSubAgentTranscripts`, `subAgentTranscriptDir`) ·
Control Plane (`httpApi.*`). The
Settings UI renders one section per entry and keeps
the order the properties are declared in, so the array *is* the grouping and the
order; the keys themselves never move, which is why `getConfiguration('spinney')`,
`affectsConfiguration` and every stored value are unaffected. A reader that wants a
property out of the manifest has to flatten the sections first
(`tools/check-models.js`).

The keys are:
`model` (the **default model card id**; the dropdown is built at runtime from
`spinney.modelCards`, so the setting carries no enum), `providers` (object of
provider id → `{ name, baseUrl, balance, concurrency }`; `balance` is the wallet
dialect — `none` / `deepseek` / `openrouter` / `moonshot` — and a row that leaves it
out is declared by host, see `invariants/model-cards.md`), `modelCards` (object of
card id → `{ name, providerId, oaiModel, contextWindow, concurrency, vision: {
enabled, transport }, efforts, defaultEffort }`),
`commandMaxForegroundDuration` (seconds, default 300 = 5 minutes — the **longest
anything may hold a turn**: an `exec_command` foreground call, a `join_background`
wait, a `spawn_agents` / `send_agent_message` `sync` wait. It is read **per call**
— an `exec_command` invocation, a join, a spawn — and never cached;
`commandMaxForegroundDurationSec` in `src/tools/execCommand.ts` is the reader, with a
deliberate local copy in `src/chat/runtime.ts` for the two bounded waits, and a
non-positive/absent value falls back to 300. It is the single knob of the command
budget model: it caps the **foreground slice** (`min(timeout, limit)`, i.e. how long
one call may hold the turn) and it is the number rule **R2** is checked against
(`timeoutTooLongError`). `timeout` is **not** capped — it is the command's **total
budget**, foreground plus background, with **no ceiling** — and a `timeout` above the
limit is **refused before the spawn** unless the call asked for a background
`timeout_behavior` (`background_when_timeout` gives the job the rest of that budget,
`timeout − limit`, as its own deadline; `start_in_background` gives it the whole of
it and is refused **without** a `timeout`, because a node job with no deadline would
hold its node's composer on Stop until it is killed; `start_detached` gives it the
whole of it as a session-wide **detached** job that locks no node, never notifies and
cannot be joined, which is why it — and only it — may omit `timeout`; and a
`background_when_timeout` that omits `timeout` is refused before the spawn exactly as
`start_in_background` is, for the same reason: an unbounded *node* lifetime belongs to
`start_detached` and to nothing else).
A background job carries that budget as its deadline (`BackgroundTask.timeoutMs` /
`deadlineAt`, readable again through `remainingBudgetMs` in `src/tools/background.ts`);
the two keys this replaced — `commandTimeout` (600) and `commandTimeoutMax` (1800) —
were a default plus a ceiling, so an over-long command was silently shortened instead
of becoming a job that says how long it runs and what ended it — see
`invariants/background-terminals.md`),
`replyLanguage` (`auto` — the default, i.e. follow the VS Code display language —
or one of the language tags VS Code ships display translations for; resolved into
the **name** the prompt carries by `replyLanguageName` in
`src/agent/languages.ts` — the tags live only in the setting's `enum`, ordered
`auto`, `en`, `zh-Hans`, `zh-Hant` and then the rest by use, and the setting's
`enumDescriptions` are exactly the names the prompt receives, so the dropdown reads
like the prompt does; a tag CLDR cannot name, or any other name typed into
`settings.json`, is used verbatim),
`foldToolCalls` (default `true`),
`foldThinking` (default `true`; both are the *at rest* default — the block that is
live right now is always expanded, see `docs/agents/invariants/streaming-perf.md`),
`foldWork` (default `true`, **window** scope — the work log of a *finished* turn folds
itself: it folds exactly while zone 3, the answer, is showing, and unfolds while a
turn runs or when there is no answer. A click on the log's own header — or a *released*
light on the card's green dot — hands that card to the user for good, and it applies
immediately, like the two above — see
`docs/agents/invariants/streaming-perf.md`),
`promptSections` (object of display name → text, default `{}`: the composer's own
prompt snippets. The two the extension ships — `Plan` and `Implement Parallel` —
live in `src/chat/promptSnippets.ts`, **not** in this default, so a shipped text can
be refined with the extension; a row whose name matches a shipped one replaces that
snippet's text, any other name adds a row, and a row with an empty name or empty text
is ignored. The texts are user-turn text: the button fills the input box and the user
sends them, so nothing here reaches the system prompt),
`maxConcurrentSubagents` (default 15),
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
- **Models are cards.** Exactly one card is built in — `deepseek-flash` (the
  fallback, used before anything is configured). Everything else is the user's
  `spinney.providers` + `spinney.modelCards`, structured data: the Model Card Tree
  page (`Spinney: Open Model Cards`) is the editor, and the settings row is a read-only
  preview plus a link into `settings.json`. There is no model list in the Settings UI
  (an object setting renders read-only there) and no chat-side **Models** panel — the
  page is the only editor. The page writes the whole desired state through
  `configuration.update`, so a save takes effect exactly like a hand edit. A field
  left out keeps a default (non-vision / the built-in window); a row that cannot be
  parsed is skipped and logged to the output channel (`applyModelCards`). See
  `invariants/model-cards.md` for the two shapes and why nothing is probed.
- **Cards are selectable, not vendored.** `spinney.model` holds the card id a
  session with no pick of its own starts on; the vendored `deepseek-flash` is the
  only id the extension knows at compile time, and the chat's dropdown is built from
  the configured cards (`postConfig`).
- **No other model key exists.** The pre-model-card settings were never released, so
  there is no migration path: `spinney.providers` + `spinney.modelCards` +
  `spinney.model` are the whole model configuration, and a profile without them runs
  on the vendored fallback card.
- A value that is neither a card id, a card name, nor a wire model name is **not**
  used: `resolveModel` falls back to the first usable card and says so in the output
  channel (a stale id must not silently mis-size the indicator or hide images).
- A card's `efforts` is sent as `reasoning_effort` only when the level is not the
  literal `none` (`none` omits the parameter and keeps the effort sentence out of
  the prompt). A session's level that its card does not offer is clamped to the
  card's `defaultEffort` (`normalizeEffort`).
### When a change takes effect (no reload required)
`extension.ts` listens to `onDidChangeConfiguration` and routes an
`spinney.*` change to `ChatViewProvider.onConfigurationChanged(event)`. The
split is **push vs. pull**: a key that is read once and cached somewhere live has
to be *pushed* to that owner; a key read at its point of use is *pulled* and needs
no handling.

| Key | Applied | Mechanism |
| --- | --- | --- |
| `providers`, `modelCards` | immediately | pushed: `applyModelCards()` (re-parse + install the catalog) → `ClientRegistry.applyCatalog()` (re-point every provider client at its `baseUrl`, install the two concurrency limits) → every runtime's `postConfig()` (both dropdowns + image affordances) and `applyDefaultModel` for sessions with no pick; a `providers` change also fires `refreshBalance()` for every session, so editing a row's `balance` dialect takes effect with it |
| `model` | immediately when *that key* changed, and only for sessions **without a pick of their own** (a per-tab dropdown pick wins) | pushed through `SessionRuntime.applyDefaultModel` (driven by `onConfigurationChanged`); a running session is skipped, like the dropdowns |
| `maxConcurrentSubagents` | immediately (raising wakes queued tasks; lowering drains) | pushed: `SubAgentPool.setMaxConcurrent` |
| `replyLanguage` | immediately when *that key* changed (a running session is skipped) | pushed: `ChatViewProvider.getConfig()` resolves the setting to a language **name** (`auto` → `vscode.env.language`, a tag → its CLDR name, via `replyLanguageName`), and `SessionRuntime.applyReplyLanguage` pushes that name to every node worker's `Agent.setReplyLanguage`, which rewrites `messages[0]`; a session with history gets the cache-miss notice. **No per-session pick**: the language is a property of the reader, so the setting is the only source (`SessionRuntime.replyLanguage` is seeded from it at construction). Re-picking `auto` when the display language is already in force resolves to the same name and is a no-op |
| `foldToolCalls`, `foldThinking`, `foldWork` | immediately, incl. cards already on screen | pushed: `postConfig()` → the webview re-applies the default to existing cards (`foldWork` re-runs the card's automatic work-log fold after the push, which is how a finished card folds or unfolds without a repaint) |
| `promptSections` | immediately, incl. a chat tab already open | pushed: `postConfig()` → the webview rebuilds the snippet menu from `snippets` (it keeps no copy of the list, and the shipped rows are merged in again on every push, so a renamed or emptied row shows up at once) |
| `httpApi.enabled`, `httpApi.port` | immediately | pushed: `ControlServer.restart()` (rebind the listener; disabling just leaves `start()` a no-op) |
| `commandMaxForegroundDuration`, `maxInlineToolOutput`, `maxLevel2Subagents`, `saveSessionTranscripts`, `saveSubAgentTranscripts`, `subAgentTranscriptDir`, `autoSessionTitles` | immediately | pulled at the point of use (they already were — no listener needed; the limit is read **per call** — an `exec_command` invocation, a join, a spawn — and never cached, so a change applies to the next call and never to a call already waiting) |

- **`model` / `thinkingEffort` arbitration (P4):** the selection belongs to the **node**.
  A turn records the card and level it ran with on the node it creates; a follow-up
  resolves through the node's ancestry (own → nearest ancestor → the session seed). The
  dropdown's value is that resolution for the node in view, and an explicit pick is a
  **pending** choice for the next send on it — consumed by that turn, forgotten on a
  checkout, and silent (no notice, no persist) when it names the card the node already
  uses. `session.model` + `modelFromSettings` still hold the **seed** (see
  `invariants/session-persistence.md`), written by an explicit pick and honoured only
  while the setting it was made under is unchanged: `sessionModelPick` ignores a pick
  whose anchor no longer matches, so editing `spinney.model` (or a card's
  `defaultEffort`, which is the effort's anchor) wins over an older pick and a pick made
  after the edit keeps winning. The *global*
  `spinney.runtimeConfig` Memento is now only the **default for sessions with no pick**
  (`effectiveModel` → `loadRuntimeConfig` → the setting) and the seed for sessions
  created later (`persistRuntimeConfig`). A stored record without the anchor fields
  predates the rule and is trusted.
- **A wrong window or a missing image capability is a card field:** edit it in the
  Model Card Tree page. (There is no global override and no other model key — the
  pre-model-card settings never shipped.)
- **Not a setting:** the `AGENTS.md` snapshot is taken once per activation
  (`loadAgentsMd`), so that one still needs a window reload — see
  `invariants/agents-md-snapshot.md`.

### Secrets are the one exception
`spinney.apiKey` was removed as a setting. Each provider's API key now lives in VS
Code SecretStorage — one entry per provider: `spinney.apiKey` for the built-in
provider, `spinney.apiKey.<providerId>` for every other
(`apiKeySecretName` in `src/chat/modelTree.ts`), with the `DEEPSEEK_API_KEY`
environment variable as the fallback for the built-in provider only. It is read
asynchronously when a request needs it (`ClientRegistry` caches it per provider), set
from the page's per-provider key fields, and set or cleared with the
`Spinney: Set API Key` / `Spinney: Clear API Key` commands, both of which take an
optional provider id (the palette defaults to the built-in provider). `refreshKeys`
invalidates the cache and re-reads, so a new key is live without a reload. It is
therefore **not** part of the "every `spinney.*` change applies immediately" rule.
Every other `spinney.*` setting still applies at the moment you change it.
