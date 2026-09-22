## System prompt (single template + two hard rules)

- **One file owns the system-prompt text.** `src/agent/prompt.ts` holds
  `SYSTEM_PROMPT_TEMPLATE`
  (main agent) and `SUB_AGENT_SYSTEM_PROMPT_TEMPLATE` (sub-agents). Static text is
  written literally, top to bottom, so the file reads as the prompt itself; runtime
  values are `{{placeholder}}` holes. `agent.ts` contains no prompt text — its
  `Agent.systemPrompt` / `Agent.subAgentSystemPrompt` / `Agent.setAgentsMd` are
  thin wrappers kept for their callers. `Agent.setAgentsMd` is the render
  **fallback** snapshot, not the only source: `prompt.currentAgentsMd()` exposes
  that snapshot's *content*, which is what a caller hashes when it freezes a
  prompt (`Epoch.agentsMdHash`) without rendering anything
  (`src/agent/prompt.ts`, `setAgentsMd` / `currentAgentsMd`).
  The one other shipped, model-facing instruction text is
  `SHIPPED_PROMPT_SNIPPETS` in `src/chat/promptSnippets.ts` (the `Plan` /
  `Implement Parallel` snippets). It is **user-turn** text: the composer inserts it
  into the input box, the user may edit it, and it travels as the message they
  send — so it never reaches the system prompt and is not part of the template.
- Placeholders: `{{identity}}` (harness name + model + reasoning effort, from
  `identityLines()`), `{{environment}}` (OS / shell / agent root + its kind, from
  `process.platform` + `getShell()` + `agentRootInfo()` — `EnvironmentFacts` is
  `{ os, shell, root, rootKind: 'workspace' | 'scratch' }`; in no-repo mode it
  renders a second line stating that relative paths and the default `cwd` are
  based on the harness root, to use absolute paths for real files and not to
  assume a repository layout), `{{language}}` (the `## Language` line, from
  `languageLine(language)` — the value is the language **name** resolved from
  `spinney.replyLanguage` by `replyLanguageName` (`auto` → the VS Code display
  language, a tag → its CLDR name), with `DEFAULT_REPLY_LANGUAGE` ('English') as
  the floor when nothing resolves) and
  `{{agentsMd}}` (the AGENTS.md snapshot in force — the module-global one
  `setAgentsMd` fixed at activation; `prompt.systemPrompt` takes an optional
  `agentsMd` argument so a caller *could* pass its own snapshot, but the shipped
  freeze path passes none, so one snapshot per window is what every epoch renders
  and hashes. Per-session snapshots are listed in `plans/session-epoch.md` §4.2 and
  are **not** implemented). The
  sub-agent template adds `{{depth}}`, `{{permissions}}`
  and `{{fanOut}}`; it stays lean — identity + environment + its dispatch line and
  two behaviour lines — and never repeats the main template.
- `renderPromptTemplate()` fills them. An unknown placeholder name or a malformed
  `{{` **throws and logs to the "Spinney" output channel** (the guard for a
  typo'd name; `src/perf.ts`'s `harnessLog` is the sink). It scans the *template*,
  not the rendered output, so a `{{` inside an injected value (an AGENTS.md
  snippet) is data and never an error.
- The builders take the environment facts as an optional parameter, so a caller
  outside the extension host (a test, a dump script) renders deterministically.
  `describeAgent(profile, registryTools, facts?)` in `src/agent/profile.ts` returns
  **both** the prompt and the tools array for one (role, model, effort,
  capabilities) profile — the public answer to "what does the model receive?".
- **No tool list in the prompt.** Every tool's schema is sent in the API request's
  `tools` field (`Agent.getTools()` → `src/agent/apiClient.ts` `body.tools`), so
  repeating signatures in the prompt would only be a second copy to drift. There is
  deliberately no "tool index" placeholder — do not add one. The schema set is part
  of the frozen envelope all the same: the node that starts an epoch records the
  schemas it advertised (`Epoch.tools`), every descendant pins them
  (`Agent.setToolSchemas` in `beginTurn`), and a chain whose tool implementation is
  gone answers the call as an ordinary tool error instead of gaining or losing a
  schema inside a prefix it has already sent.
- **Capabilities are one judgement, used twice.** Each intercepted tool declares a
  `requires` tag (`vision` / `spawn` / `spawnReadOnly` / `hop`) in
  `src/agent/tools/*`; `interceptedDefinitions(capabilities)` filters that single
  list for `getTools()`, and those same flags are what the prompt's
  `## Delegation (when to hand work off)` guidance assumes. A non-vision model
  therefore never sees `read_image` in `tools`
  (the runtime guard in `executeReadImage` stays as a fallback), and switching the
  model updates the identity line and the tool list together.
- **Hard rule 1 — no workspace facts in plugin text.** Text that ships with the
  extension and reaches the model (the templates, every tool `description`, tool
  error messages) must contain **no workspace-specific facts**: no paths such as
  `docs/agents/…`, no script names such as `npm run compile`, no repo layout, no
  file names. Other users install this extension into unrelated workspaces, where
  such a fact is simply wrong. Workspace facts belong in the workspace's own
  `AGENTS.md` snapshot (and the docs it points at). Facts the harness *detects* at
  runtime (OS, shell, agent root) may be injected through `{{environment}}` —
  they are observations, not assumptions baked into the text.
- **Hard rule 2 — no model ids in plugin text.** `src/agent/models.ts` is the only
  place a model id may appear; everything else derives names at runtime
  (`DEFAULT_MODEL`, `cardDisplayName()`, `visionCardsLabel()`, `isVisionCard()`).
  The model the agent runs on is whatever **card** the user configured, so the
  prompt's identity line carries that card's display name — never a compiled-in id.
  `tools/check-models.js` (`npm run check:models`, run by
  `vscode:prepublish`) fails the build when a `src/**/*.ts` file other than the
  catalog names a model, or when `package.json` / `README.md` / `docs/**` names one
  the catalog does not have.
- **The reply language is user-facing only.** `spinney.replyLanguage` (a dropdown
  of `auto` + the language tags VS Code ships display translations for — `en`,
  `zh-Hans`, `zh-Hant` first, then the rest by use, each labelled with the name the
  prompt will carry) fills the
  main template's `{{language}}` line with a language name; the sub-agent template
  keeps `Answer in English`, because a sub-agent reports to the agent that
  dispatched it and never to the user. A change is a **setup** change, not a
  rewrite: `SessionRuntime.applyReplyLanguage` records the new name for the nodes
  frozen from here on and repaints the composer's drift marking
  (`[config] replyLanguage=… (new nodes; frozen chains keep theirs)`); every chain
  already frozen keeps the line it was rendered with, no `messages[0]` is touched,
  and there is no cache-miss notice any more.
- **The prompt is stored now — once per epoch.** When a chain starts, the node that
  starts it renders the prompt **once** and keeps the bytes
  (`TreeNode.epoch.prompt`, `Epoch` in `src/chat/tree.ts`): `SessionRuntime.freezeEpoch`
  (`src/chat/runtime.ts`) is the only caller of a render on the request path. Every
  descendant of that node reuses the frozen bytes through `epochForNode(session,
  nodeId)` — the nearest ancestor-or-self that carries an envelope, the same walk
  shape as `contextBase()` — and nothing re-renders it: not a reload, not a
  restart, not a settings change, not a version bump, not a tool that no longer
  exists.
  - `Epoch` also carries the endpoint facts (`cardId`, `effort`, `replyLanguage`,
    `providerId`, `baseUrl`, `wireModel`, `vision`, `visionTransport`), the frozen
    tool schemas, the content hashes the drift check compares (`templateHash`,
    `agentsMdHash`, `toolsetHash`) and `frozenAt`. `cardId` is a **card id**, never a
    wire model name.
  - The stored envelope is validated by **shape at read time**: `normalizeEpoch`
    drops one whose `prompt` is not a string, and `epochForNode` ignores it, so a
    truncated or foreign value can never make a request fail and needs no repair
    pass.
  - A chain with **no** envelope — a session loaded before the epoch model landed —
    still renders live (`buildPath` → `systemPromptFor`), so nothing breaks while it
    waits to be adopted; `SessionRuntime.adoptLegacyEpoch` freezes one onto the node
    that starts the checked-out chain at the first load, marks it `legacy: true` and
    the session `legacyEpoch`, and logs `[epoch] adopted legacy chain …`. That
    freeze is a one-time approximation (the old bytes are gone), and it is skipped in
    a read-only window.
  - The prompt is stored **outside** `messages`, on the node, exactly like
    `imageSources`: a node's own `messages` still never contain a `system` role
    message, and `pruneSession` still deletes a stored one
    (`src/chat/tree.ts`, the `m.role !== 'system'` filter — its comment still says
    "synthesized per activation", the filter is what counts).
- To read a prompt, run **`Spinney: Show System Prompt`**
  (`ChatViewProvider.showSystemPrompt` → `SessionRuntime.systemPromptText`): it
  renders the **live** setup — the checked-out node's card and level *with any
  pending dropdown pick*, the current reply language, the AGENTS.md snapshot in
  force — and opens the result in an editor tab. For a session with no runtime yet it
  renders the default card + level instead. It therefore shows what a **new** node
  would freeze, not the bytes a frozen chain is sending. Showing the frozen bytes
  first, with the live render as a labelled second section, is `plans/session-epoch.md`
  §12 item 2 and is **not** implemented.
