# AGENTS.md — Spinney

> This file is both an index and the workspace instructions injected into the agent at session start. The body lives in `docs/agents/`: before you touch a part of the code, read its page. The snapshot is taken once, when the extension host starts (the `ChatViewProvider` constructor), so an edit to this file needs a window reload to take effect.

---

## Standard closing procedure: compile, build-deploy, reload (mandatory)

A change to anything under `src/`, `media/`, or `package.json` is not finished until these three steps pass:

1. `npm run compile` must be clean. `build-deploy.ps1` runs it first, so never package a broken build.
2. Package and install. On POSIX: `npm run package`. On Windows: `powershell -File build-deploy.ps1`, which compiles, packages the `.vsix`, and runs `code --install-extension --force`. Add `-NoInstall` only when the user explicitly asks for a build-only run.
3. Ask the user to run `Ctrl+Shift+P` → "Developer: Reload Window". The extension host keeps running the old code until then, so do not claim a change is live before the reload, and do not leave this step for the user to guess.

- Automated alternative: when the `hvsc` supervisor is running (a live pid in `tools/hyper-vscode/.state/daemon.json`), drive the reload with `node tools/hyper-vscode/hvsc.mjs reboot <instanceId> --continue "<message>"`; when the current window did not start under hvsc (no instanceId), use `reboot --current`, which adopts the current window (reload only, never kill). Never add `--wait` inside a turn; it deadlocks.
- A docs-only change (`README.md` / `AGENTS.md`) does not need `build-deploy`, unless the packaged `.vsix` should be refreshed too.
- A reload restarts the extension host; sessions live in `spinney.state`, so the conversation survives it.

## Versioning

- The version follows SemVer. We are at `0.x`, which is pre-1.0: a breaking change bumps the minor version only.
- Tag every release as `vX.Y.Z`.
- `vscode:prepublish` (compile plus the four guards) is the release gate: a release does not ship when that script fails.
- `CHANGELOG.md` uses the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## Hard invariants (read before you touch code)

- Every assistant message that carries `tool_calls` must be followed by the matching `tool` response, or the API returns 400; resuming a session goes through `Agent.sanitizeMessages`.
- The system prompt is fixed at session start; a model/effort switch rewrites `messages[0]` in place. The template, its placeholders, and the two hard rules live in `docs/agents/invariants/system-prompt.md`. To see what the model really receives: run `Spinney: Show System Prompt`.
- The system prompt is not stored in a node; it is re-synthesized on every activation. A node's history starts with a user message.
- The prompt holds no tool list: the schemas travel in the API `tools` field. Each tool's schema, implementation, and capability gate (`vision` / `spawn` / `spawnReadOnly` / `hop`) live in one file.
- Do not trust memory for line endings: `read_file` returns LF, and `write_file` / `replace_in_file` keep the on-disk EOL. See `docs/agents/invariants/line-endings.md`.
- `media/vendor/non-layered-tidy-tree-layout/` is a vendored, hash-pinned layout engine (@2.0.2): do not edit it, do not upgrade it, and do not add it to `package.json`.
- Each session owns exactly one tab (`PanelManager.ensure`): reopening focuses the existing tab; closing the tab does not delete the session.
- View focus (`session.activeNodeId`) and the running turn's base (`run.nodeId`) are independent, so switching node, branch, or tab is always allowed; every streaming message carries an explicit `nodeId`, and the webview never infers the stream target.
- Sessions really run in parallel; different nodes in one session can run at the same time. Only a second send to the same node is rejected (`runs: Map<nodeId, TurnRun>`); the composer then shows Stop (`state.runningNodes`) instead of Send.
- A background terminal belongs to the node that started it (`BackgroundHub` keys on `(session, node)`) and does not lock other branches or sessions; deleting a branch or session, or clearing it, while tasks still run shows a modal confirm first, then kills the processes too (`confirmKillBackgrounds`).
- Model and thinking effort are per session (one per `SessionRuntime`; the default comes from the global record / setting).
- `host.isHeld()` blocks every turn start (the `/wait-for-finish` hold, including injected background and sub-agent notification turns): self-driven reloads win the race through it, so do not weaken it.
- `npm run check:models` fails packaging when a model id is hard-coded in `src/**`: always read model names from `src/agent/models.ts`.
- Every user-visible string is localized, and each one is written as the English source inside a single `vscode.l10n.t('…')` (host) or `tr('…')` (webview) literal — never concatenated, never a template literal, because `npm run check:l10n` extracts the keys from exactly that shape and fails packaging when a shipped catalog misses one. The webview cannot call `vscode.l10n`; the host injects the catalog as `window.__spinneyL10n`. See `docs/agents/invariants/i18n.md`.
- `npm run check:webview` loads `media/main.js` into an in-memory DOM before packaging and replays every provider message type; a "reference to a deleted identifier" inside a webview callback is silent in the real UI (it freezes on stale values), and this guard exists to catch it.

## Directory (the body lives in `docs/agents/`)

- What this is / how to run it: `what-this-is` · `stack` · `commands` · `architecture` · `file-map` (find a file) · `where-to-change` (do not know where to change)
- Prompt: `invariants/system-prompt` (template + rules) · `invariants/agent-authoring` (edit the prompt) · `invariants/agents-md-snapshot`
- Model capabilities: `invariants/model-capabilities` (why only `deepseek-flash` is vendored, the `spinney.modelTable` shape, why nothing is probed)
- Tools: `tools` (add or change a tool, the verbatim frame syntax) · `invariants/sub-agents` (spawn_* / send_*) · `invariants/background-terminals` (exec_command and background terminals) · `invariants/transcripts` (search_transcripts) · `invariants/vision-images` (read_image)
- Sessions and persistence: `invariants/conversation-validity` · `invariants/session-persistence` (persistence + rename_session auto-naming and locking) · `invariants/chat-tree` (branch / checkout) · `invariants/interrupt-rollback` · `invariants/api-retries` (10-step backoff on transient failures + the ▶ Continue card button)
- Multi-session / concurrency: `multi-session` (multi-tab + session/branch concurrency, the frozen P1–P4 contract) · the acceptance driver `tools/harness-test.mjs` (dev-only, not shipped in the `.vsix`)
- Control plane / desktop: `control-plane` (includes hop_session / list_nodes)
- Other invariants: `invariants/line-endings` · `invariants/config-keys` · `invariants/streaming-perf` · `invariants/vendored-deps`
- UI text / i18n: `invariants/i18n` (one catalog per language, the two lookup paths, the `check:l10n` guard, what is deliberately left English)
- No-workspace mode (no folder open): `no-repo-mode` (root, session storage, behavior differences)
- Acceptance and artifacts: `testing` · `scratch-space`
