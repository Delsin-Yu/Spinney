## System prompt (single template + two hard rules)

- **One file owns the text.** `src/agent/prompt.ts` holds `SYSTEM_PROMPT_TEMPLATE`
  (main agent) and `SUB_AGENT_SYSTEM_PROMPT_TEMPLATE` (sub-agents). Static text is
  written literally, top to bottom, so the file reads as the prompt itself; runtime
  values are `{{placeholder}}` holes. `agent.ts` contains no prompt text — its
  `Agent.systemPrompt` / `Agent.subAgentSystemPrompt` / `Agent.setAgentsMd` are
  thin wrappers kept for their callers.
- Placeholders: `{{identity}}` (harness name + model + reasoning effort, from
  `identityLines()`), `{{environment}}` (OS / shell / agent root + its kind, from
  `process.platform` + `getShell()` + `agentRootInfo()` — `EnvironmentFacts` is
  `{ os, shell, root, rootKind: 'workspace' | 'scratch' }`; in no-repo mode it
  renders a second line stating that relative paths and the default `cwd` are
  based on the harness root, to use absolute paths for real files and not to
  assume a repository layout), `{{agentsMd}}` (the session's snapshot). The
  sub-agent template adds `{{depth}}`, `{{permissions}}`
  and `{{fanOut}}`; it stays lean — identity + environment + three behaviour lines
  — and never repeats the main template.
- `renderPromptTemplate()` fills them. An unknown placeholder name or a malformed
  `{{` **throws and logs to the "Agent Harness" output channel** (the guard for a
  typo'd name; `src/perf.ts`'s `harnessLog` is the sink). It scans the *template*,
  not the rendered output, so a `{{` inside an injected value (an AGENTS.md
  snippet) is data and never an error.
- The builders take the environment facts as an optional parameter, so a caller
  outside the extension host (a test, a dump script) renders deterministically.
  `describeAgent(profile, registryTools, facts?)` in `src/agent/profile.ts` returns
  **both** the prompt and the tools array for one (role, model, effort,
  capabilities) profile — the public answer to "what does the model receive?".
- **No tool list in the prompt.** Every tool's schema is sent in the API request's
  `tools` field (`Agent.getTools()` → `src/agent/deepseek.ts` `body.tools`), so
  repeating signatures in the prompt would only be a second copy to drift. There is
  deliberately no "tool index" placeholder — do not add one.
- **Capabilities are one judgement, used twice.** Each intercepted tool declares a
  `requires` tag (`vision` / `spawn` / `spawnReadOnly` / `hop`) in
  `src/agent/tools/*`; `interceptedDefinitions(capabilities)` filters that single
  list for `getTools()`, and those same flags are what the prompt's `## 分工`
  guidance assumes. A non-vision model therefore never sees `read_image` in `tools`
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
  (`DEFAULT_MODEL`, `visionModelsLabel()`, `isVisionModel()`,
  `contextWindowFor()`). `tools/check-models.js` (`npm run check:models`, run by
  `vscode:prepublish`) fails the build when a `src/**/*.ts` file other than the
  catalog names a model, or when `package.json` / `README.md` / `docs/**` names one
  the catalog does not have.
- Session semantics are unchanged: the prompt is synthesized per activation and
  never stored in a node (`docs/agents/invariants/chat-tree.md`); on a model or
  effort switch only `messages[0]` is rewritten (`refreshSystemIdentity`).
- To read the current prompt, run **`Agent Harness: Show System Prompt`**: it
  renders for the active model + effort and the session's `AGENTS.md` snapshot and
  opens the result in an editor tab.
