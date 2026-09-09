# AGENTS.md — Minimal Agent Harness

This file is the reference an agent should use instead of re-reading the whole
repo. It describes what the project is, how it is wired together, and the
invariants you must preserve when you change it. Read it first; dive into code
only for the part you are touching.

> This repo *is* the harness that reads `AGENTS.md` at session start and injects
> it into the agent system prompt (see "AGENTS.md snapshot" below). Editing this
> file does **not** change the current session's prompt — it only takes effect
> for a newly started session.

---

## Standard closing procedure (build, install, reload) — MANDATORY

**This is the standard procedure of this workspace.** A change that ships code
(anything under `src/`, `media/`, `package.json`) is *not finished* until it is
installed and the user has been told to reload:

1. `npm run compile` must be clean. `build-deploy.ps1` runs it — fix errors
   first, never package a broken build.
2. Run `powershell -File build-deploy.ps1` as the last step: it compiles,
   packages the `.vsix`, and `code --install-extension --force`s it. Use
   `-NoInstall` only when the user explicitly asked for build-only.
3. **Tell the user to run "Developer: Reload Window"** (`Ctrl+Shift+P` →
   "Developer: Reload Window"). The extension host keeps running the *old* code
   until then, so without the reload the change is invisible. Never claim a code
   change is live before that reload, and never leave step 3 implicit.

Notes:

- A reload restarts the extension host; chat sessions persist in
  `agentHarness.state`, so the conversation survives it.
- **Automated alternative:** if the `hvsc` supervisor is running
  (`tools/hyper-vscode/.state/daemon.json` with a live pid), the reload can be
  driven from the CLI instead of asking the user:
  `node tools/hyper-vscode/hvsc.mjs reboot <instanceId> --continue "<message>"`
  (see "External control plane & the `hvsc` supervisor" below). Never add
  `--wait` from inside a turn — it deadlocks.
- Edits to *this file* also only reach the agent prompt at session start — ask
  the user to reload if the new instructions should apply immediately.
- Docs-only edits (README / `AGENTS.md`) do not need `build-deploy` unless
  the packaged `.vsix` itself should be refreshed.

---

## What this is

A minimal VS Code extension that puts an **agentic coding assistant** in the
Activity Bar sidebar. It drives an autonomous agent via the **official DeepSeek
API** (OpenAI-compatible `chat/completions`, streaming + function calling). The
agent can read/write/edit files, list directories, and run shell commands, and
the user can interrupt it at any time.

**Design ethos:** intentionally small — no framework, no external runtime
dependencies. TypeScript + the VS Code API + Node's global `fetch` +
`child_process`. Every non-trivial behavior belongs in a single place.

## Stack & hard constraints

- **Language/build:** TypeScript (`strict: true`), CommonJS, target ES2022, `tsc`
  (`tsconfig.json`), source in `src/`, emitted to `out/`.
- **Runtime:** VS Code `^1.85.0` and Node 18+ (the VS Code extension host).
  Node's global `fetch` is used for HTTP — there is no `http`/`axios` dep.
- **Runtime deps:** **none.** `node_modules` is only devDependencies
  (`typescript`, `@types/node`, `@types/vscode`, `@vscode/vsce`).
- **Packaging:** `@vscode/vsce` produces a `.vsix`. There is a checked-in
  `minimal-agent-harness-0.0.1.vsix` (gitignored via `*.vsix`).

## Commands

```bash
npm install                                  # dev deps
npm run compile                              # tsc -p ./  (no bundler; tsc only)
npm run watch                                # tsc -watch -p ./ (background task)
node_modules/.bin/vsce package --allow-missing-repository   # build .vsix
powershell -File build-deploy.ps1            # compile + package + install
powershell -File build-deploy.ps1 -NoInstall # compile + package only
```

`build-deploy.ps1` compiles, packages, and `code --install-extension`s the
newest `.vsix`. Use it for quick iteration, then reload the window. This is the
**mandatory last step** of any code change — see "Standard closing procedure"
above.

Launch: F5 (`.vscode/launch.json` → "Run Extension", pre-task `npm: compile`).
`-allow-missing-repository` is required because the repo has no git remote.

## External control plane & the `hvsc` supervisor

The extension cannot reload its own window and report back — it dies with the
reload. So the reload lifecycle lives **outside** the extension:

- `src/http/controlServer.ts` — an opt-in local HTTP control plane
  (`agentHarness.httpApi.enabled`, default **off**; loopback only; bearer token
  written to `<globalStorage>/http/<instanceId>.json`, mode 0600).
- `tools/hyper-vscode/hvsc.mjs` + `serve.ps1` — a workspace-local supervisor
  (excluded from the `.vsix` via `.vscodeignore`) that launches/supervises `code`
  windows and drives the reboot. State lives in `tools/hyper-vscode/.state/`:
  `daemon.json` (port/token), `instances.json` (re-adopted after a daemon
  restart), `daemon.log`.

Control plane routes (all require `Authorization: Bearer <token>`):

| Route | Behaviour |
| --- | --- |
| `GET /health` | `{ok, instanceId, pid, port, busy, sessionId}` |
| `GET /state` | busy + active session/node + the session list |
| `POST /wait-for-finish` | block until idle (`scope:'all'` also waits for sub-agents / background jobs), then flush the last persist. `interrupt:true` is the escape hatch |
| `POST /navigate` | check out a node (and open the panel) |
| `POST /continue` | send a caller-supplied user message that continues from a node |
| `POST /reload-window` | 202, then `workbench.action.reloadWindow` (refuses while busy) |

`hvsc` commands: `serve` / `start` / `status` / `rm` / `reboot` / `jobs`. The
reboot flow is `wait-for-finish` → `reload-window` (shared profile) or kill +
relaunch (`--isolated`) → poll `/health` → `continue`.

Operational rules:

- The daemon must run **outside** VS Code (a standalone terminal, or
  `Start-Process`): a VS Code task and a harness background terminal both die
  with the window (the latter via `dispose()` → `killAll()`).
- Profile **passthrough** is the default (`code -n`, no `--user-data-dir`), so the
  new window shares the user's `workspaceState`. Its env vars do **not** reach
  that window, so the control plane must be enabled in settings
  (`agentHarness.httpApi.enabled`, workspace or user scope). `--isolated` keeps a
  separate profile and allows a hard kill/relaunch.
- Never pass `--wait` to `hvsc reboot` from inside a turn: the supervisor's
  `/wait-for-finish` would wait for that very turn (deadlock). Fire it without
  `--wait` and let the supervisor `/continue` the agent afterwards.
- `/continue` makes the agent run a caller-supplied instruction — a
  **local-trust RCE boundary**. Keep `agentHarness.httpApi.enabled` off unless a
  controller needs it, and never log the token.

## Architecture & data flow

```
User (editor WebviewPanel) <--postMessage--> ChatViewProvider (src/chat)
                                                    | holds per-session Agent + tree
                                                    v
                                        Agent (src/agent/agent.ts)
                                           | streaming loop
                                           v
                                        DeepSeekClient (src/agent/deepseek.ts)
                                           |  tools (function calls)
                                           v
                                        ToolRegistry (src/tools/index.ts)
                                           |  v
+ Sidebar (native TreeView)  SessionsProvider  reads  ChatViewProvider
+                                           +  exec_command -> shell detection (src/tools/shell.ts)
```

1. `extension.ts::activate` creates the sidebar `TreeView` (`agentHarness.sessions`)
   and the commands (`agentHarness.openChat`, `openSession`, `newSession`,
   `deleteSession`, `clear`, `focus`).
2. The webview (`media/main.js`) sends messages (`userMessage`, `checkout`,
   `setModel`, `setThinkingEffort`, `stop`, `clear`, `pickImage`, `setNodeSize`).
   It streams in a sandboxed iframe and loads a vendored `markdown-it.min.js` plus
   `media/tree.js` (pure layout).
3. `ChatViewProvider` owns the `Agent` instance and one **session** per
   conversation. Each session persists its own `messages` (API history) and
   `displayItems` (UI transcript) and is restored from `vscode.Memento`.
5. `Agent.sendUserMessage` pushes a user message and runs the loop: stream an
   assistant turn → if it emits `tool_calls`, execute each tool (emitting
   `toolStart`/`toolEnd`) and append `tool` results → loop → until a plain-text
   answer or `maxTurns` is exceeded.
6. `Agent` emits `AgentEvent`s (`streamDelta`, `reasoningDelta`, `toolCall*`,
   `usage`, `status`, `done`, `interrupted`, `error`); the provider forwards them
   to the webview and mutates the session's `displayItems`.

## File map

- `src/extension.ts` — activation; registers the webview provider + commands.
- `src/chat/ChatViewProvider.ts` — session/persistence, config, image attachment,
  message routing, event→UI mapping, HTML shell, and the editor `WebviewPanel`
  lifecycle (`ensurePanel` / `createPanel` / `postAllState`).
- `src/chat/ChatPanel.ts` — a thin wrapper around a `WebviewPanel` (the chat
  surface in the editor area). Single panel in v1; holds a `sessionId` so several
  panels can live side by side later.
- `src/chat/SessionsProvider.ts` — the native sidebar `TreeDataProvider` listing
  session titles; it re-reads items from `ChatViewProvider` on every refresh.
- `src/chat/tree.ts` — the Chat Tree data model: `TreeNode` / `AgentSession`,
  path assembly (`pathIds` / `pathMessages`), `attachNode`, `pruneSession`,
  and the v1→v2 state migration. Pure data layer, no VS Code UI.
- `src/chat/transcript.ts` — sub-agent transcript dumps: `writeSubAgentTranscript`
  (JSONL, one API message per line, meta + tool stats on line 1),
  `summarizeTranscript` (tool-call / denied-call stats), `sumUsage`,
  `removeTranscriptDir`. Pure fs, no VS Code UI.
- `src/http/controlServer.ts` — the opt-in local HTTP control plane
  (`/health`, `/state`, `/wait-for-finish`, `/navigate`, `/continue`,
  `/reload-window`); token + discovery file, loopback only. See "External control
  plane & the `hvsc` supervisor".
- `tools/hyper-vscode/` — the `hvsc` supervisor (CLI + daemon + `serve.ps1`),
  **not** shipped in the `.vsix`.
- `src/agent/agent.ts` — the agent loop, the **system prompt** (`CORE_PROMPT`,
  `identityLines`, `buildSystemPrompt`), message sanitizing, interrupt/rollback,
  `AGENTS.md` snapshot (static `agentsMdSnapshot`), model/effort switching.
- `src/agent/deepseek.ts` — `DeepSeekClient` (stream SSE over `fetch`,
  `DeepSeekError`), builds `stream: true`, `stream_options.include_usage`,
  `reasoning_effort`. The read loop flushes the `TextDecoder` and parses a final
  `data:` line that arrived without a trailing newline.
- `src/agent/types.ts` — shared types (`Role`, `ThinkingEffort`, `ContentPart`,
  `ChatMessage`, `ToolCall`, `ToolDefinition`, `Usage`, `StreamChunk`,
  `AgentEvent`, `AgentTool`).
- `src/tools/index.ts` — `ToolRegistry` + the tools; path resolution, line-ending
  helpers, argument parsing (strict JSON **or** verbatim frame), `exec_command`
  runner (foreground + background behaviors), and the three background tools.
- `src/tools/background.ts` — `BackgroundRegistry` + `BackgroundTask`,
  `CommandHandle`/`spawnShellCommand` (live output capture, process-tree kill),
  per-session lifecycle.
- `src/tools/shell.ts` — cross-platform shell detection for `exec_command`
  (Git Bash > pwsh > Windows PowerShell 5.1 > cmd.exe) with UTF-8 safeguards.
  The WSL launcher (`System32\bash.exe` / `WindowsApps`) is **not** accepted as
  Git Bash (different filesystem, no `zh_CN.UTF-8`, Windows cwd).
- `src/perf.ts` — tiny `[perf]` logger (sink = the Agent Harness output channel).
  `perf()` takes a string **or a thunk**; a thunk is only evaluated when a sink is
  installed, so an expensive line (JSON sizes, byte counts) costs nothing when off.
- `media/main.js` — webview client (tree rendering, pan/zoom, streaming into the
  active node, composer, streaming meter, live tool drafts).
- `media/tree.js` — the Chat Tree layout algorithm (`window.treeLayout`), a pure
  function with no DOM; `main.js` positions cards with it.
- `media/style.css` — chat UI styling (incl. tree node cards / toolbar).
- `media/markdown-it.min.js` — vendored markdown renderer.
- `build-deploy.ps1` — compile + package + install helper.

## Tools (the agent's surface)

| Tool | Args | Behavior |
| --- | --- | --- |
| `read_file` | `path`, `startLine?`, `endLine?` | Returns `File: <path> (N lines, <EOL>)` header + LF-normalized content (line-numbered if a range is given). Always LF content, but reports on-disk EOL. `N` follows the `wc -l` convention (a trailing newline does **not** add a line); `read_file(path, 1, 1)` is the cheap way to get just the count. |
| `write_file` | `path`, `content`, `frame?` | Overwrites; creates parent dirs. Preserves the existing file's line-ending style (converts content to it). New files written as supplied. |
| `replace_in_file` | `path`, `oldText`, `newText`, `frame?` | Exact-substring replace. `oldText` must occur **exactly once** (else error). Matches/writes in normalized LF; preserves on-disk EOL. The replacement is inserted **verbatim** (function-form replace), so `String.replace` dollar-patterns in `newText` stay literal. |
| `list_dir` | `path?`, `glob?`, `recursive?` | Sorted entries; directories suffixed with `/`. `glob` filters against the path relative to the listed dir (`*.ts` = top level, `**/*.ts` = any depth); `recursive` walks subdirs (heavy dirs skipped) and prints relative paths. Capped at 2000 entries with an explicit note. |
| `search_files` | `pattern`, `path?`, `glob?`, `caseSensitive?`, `maxResults?`, `context?` | Regex search returning `file:line: text` (paths **workspace-relative**). `path` may be a **file or a directory**. `maxResults` default 200 / hard cap 300; `context` (0–10) adds surrounding lines with `-` separators (`src/a.ts-11- text`). Hit lines are trimmed + clipped to 160 chars. Heavy dirs skipped; files >1 MB skipped. A capped/short-circuited search appends an explicit `…[search stopped early: …]` note — never silently truncated. |

> **Oversized results spill to a file.** Every tool whose output is unbounded
> (`search_files`, `list_dir`, `exec_command`, `check_background_terminal`,
> `join_background`) runs its result through `limitInline()`: above
> `agentHarness.maxInlineToolOutput`
> (default 32768 bytes, `0` = always inline) the full text is written to
> `.agent-harness/tool-output/<tool>-<id>.txt` (workspace-relative; the system
> temp dir when no folder is open) and only the absolute path,
> byte/line count and an 8-line preview are returned — so a `context`-heavy search
> on a big file or a chatty command cannot flood the context. The spilled file is a
> normal file:
> `read_file` can page it, and `search_files` can grep it **by its exact path**
> (`.agent-harness` is in `SKIP_DIRS`, so repo-wide walks skip it). A write failure
> falls back to inlining, so a result is never lost.
| `exec_command` | `command`, `cwd?`, `timeout?`, `timeout_behavior?` | Runs through the detected shell (`getShell()`), returns combined stdout+stderr trimmed. Errors/timeouts/aborts are prefixed with a `[...]` note. `timeout_behavior` = `stop` (default, kill on timeout) / `move_to_background` (promote a still-running command to a background terminal and return its id) / `start_in_background` (launch immediately, return id, don't wait). |
| `check_background_terminal` | `pid` | Status of a background terminal (running / finished, exit code, output so far). |
| `kill_background` | `pid` | Kills a background terminal's process tree. Tool-initiated kills suppress the injected completion notice. |
| `join_background` | `pid` | Blocks until the background terminal finishes and returns its final exit code + output. Honours Stop. |
| `read_image` | `path` | Not a registry tool — handled by the Agent. Reads the image, uploads it to the DeepSeek Files API, then injects a `user`-role `file` content block (`{ type: 'file', file_id }`) so the vision model sees it. Returns a short confirmation (path → `file-api-…`, bytes). Only valid on the vision model; unsupported format/too large (>64 MiB) return a friendly error. |
| `spawn_agents` | `agents`, `mode` | Orchestrated by the provider. Spawns parallel sub-agent branches (`write` REQUIRED, `model?`), `mode: 'sync'` blocks returning summaries + each agent's `stats` + `transcript` path, `'async'` returns `{ spawned, async:true, ids, transcriptDir }` and delivers one combined notice when the batch settles. Only on agents whose `canSpawn` is true (`depth < 2 && write`) — a read-only sub-agent never sees it. |
| `spawn_readonly_agents` | `agents`, `mode` | Read-only fan-out variant: the agent specs have **no `write` field**, so a child can never be writable. Exposed only when `canSpawnReadOnly` (`depth < 2 && !write`), i.e. to a read-only depth-1 sub-agent. Same result shape as `spawn_agents`. |
| `send_agent_message` | `id`, `message`, `write?`, `model?`, `mode` | Orchestrated by the provider. Resumes a finished sub-agent (`id` from a prior `spawn_agents`) with a follow-up. `sync` returns the resumed result + `stats` + `transcript`, `async` returns `{ resumed, id, async:true }` and delivers the result as a notice. `model` is whitelisted. Only on agents whose `canSpawn` is true (`depth < 2 && write`). The `write?` override is honoured **only for the main agent**; a sub-agent caller goes through `handleSubAgentSendMessage`, which requires the target to be its own direct child and caps `write` at `caller.write && target.write` (no promotion). |
| `send_readonly_agent_message` | `id`, `message`, `model?`, `mode` | Read-only resume variant: **no `write` override exists** (and a smuggled key is pinned to `false`). Exposed only when `canSpawnReadOnly` (`depth < 2 && !write`), i.e. to a read-only depth-1 sub-agent. Same result shape as `send_agent_message`. |

> `read_image` is **not** resolved by `ToolRegistry.execute` — it is intercepted in `Agent.executeToolCall` because a tool message cannot carry an image block, so the image must be delivered as an injected user message. Likewise `spawn_agents` / `spawn_readonly_agents` / `send_agent_message` / `send_readonly_agent_message` are intercepted and delegated to the provider (`setSpawnHandler` / `setSendMessageHandler`); a read-only depth-1 sub-agent gets only the `*_readonly_*` pair, a depth-2 sub-agent gets none of them, and an intercepted call when the matching `canSpawn*` flag is false returns an explicit error. The tools sent to the API are `[...ToolRegistry.definitions, READ_IMAGE_TOOL, ...(canSpawn ? [SPAWN_AGENTS_TOOL, SEND_AGENT_MESSAGE_TOOL] : []), ...(canSpawnReadOnly ? [SPAWN_READONLY_AGENTS_TOOL, SEND_READONLY_AGENT_MESSAGE_TOOL] : [])]` (see `Agent.getTools`).

Argument parsing is tolerant: strict JSON **or** the verbatim-frame form. The
frame form lets a tool carry large/multi-line content without JSON escaping:

```
{ "path": "src/a.ts" }
<<<RAW:content>>>
...verbatim file text...
<<<END_RAW:content>>>
```

The JSON header holds small fields; each `<<<RAW:label>>>` block is captured
verbatim and merged into `args`. Use it for `write_file`/`replace_in_file`
content. See `parseArgs` in `src/tools/index.ts`.

## Critical invariants & gotchas

### Line endings
- `read_file` always returns **LF**-normalized content (the canonical form for
  the model) and reports the on-disk EOL in its header (`CRLF`/`CR`/`LF`).
- `write_file` and `replace_in_file` preserve the **existing** file's EOL
  (converting content to match); never flip a CRLF file to LF.
- Use `read_file` output **verbatim** as `replace_in_file` `oldText`. Matching is
  done on LF, so CRLF-on-disk never breaks a match.
- Most source files in this repo are **CRLF**; `src/tools/shell.ts` and
  `.gitignore` are **LF**.

### AGENTS.md snapshot (this file)
- `ChatViewProvider.loadAgentsMd()` reads `./AGENTS.md` **once** at construction
  (session start) and calls `Agent.setAgentsMd(...)`.
- `Agent` stores it in a static `agentsMdSnapshot` and appends it to the system
  prompt under `## Workspace AGENTS.md (project instructions)`.
- Later edits to `AGENTS.md` do **not** propagate into an existing session.
- The identity line (model + reasoning effort) is the leading system prompt and
  is rewritten in place when model/effort changes — see `refreshSystemIdentity`.

### Conversation validity / sanitizing
- Every assistant message with `tool_calls` must be immediately followed by a
  `tool` response for each `tool_call_id` or the API rejects the request (400).
- `Agent.sanitizeMessages` drops dangling `tool_calls` and orphan `tool`
  messages when a session is restored, and is applied in `loadSessions`.
- The leading system message's identity is refreshed to the current model/effort
  on load; the rest of the history is preserved.

### Interrupt / abort / rollback
- `Agent.cancel()` aborts an `AbortController`; `exec_command` and the SSE stream
  both watch the signal. `deepseek.ts` re-checks the signal before every read and
  after every buffered SSE line.
- On interruption the partial output/reasoning streamed so far is preserved as a
  single "checkpoint" assistant message (no `tool_calls` — those are always
  incomplete) via `Agent.preservePartialTurn`. The rest of the turn (completed
  tool iterations, etc.) is rolled back. This lets the next turn see where the
  model cut off and self-correct.
- On a non-interrupt error the partial assistant/tool messages of the turn are
  rolled back (`messages.splice(turnStartIndex)`) so history stays valid.
- `requestAssistantMessage` normalizes a cancellation (whether from the harness
  `isStopped` checks or a network-level abort thrown by the stream generator)
  into an `InterruptedError` carrying the partial `content`/`reasoning`.
- `exec_command` on Windows uses `taskkill /T /F` to kill the whole process tree
  (a plain `child.kill()` only kills the shell and leaves grandchildren alive).
- If the previous turn was interrupted, a `user`-role `INTERRUPT_NOTICE` message
  is injected before the user's next message. When the stop landed while a tool
  call was being streamed, the notice is prefixed with the exact tool that was in
  progress (e.g. `` `write_file` tool call that writes to `path` ``) via
  `buildInterruptNotice`, so the model knows what it was doing and can re-issue or
  correct it; otherwise it falls back to the generic text. It tells the model the
  partial output was discarded and leaves it to the model to decide whether the
  new message is a steering correction (continue) or a fresh request (restart) —
  it does **not** force a restart.
- `Agent.sanitizeMessages` (applied on session restore) treats an assistant
  message without `tool_calls` as valid, so a preserved checkpoint message
  followed by a `user` message is safe on resume.

### Session persistence & config
- Storage keys: `agentHarness.state` (v2: `{ version, activeSessionId, sessions }`,
  each session is a **tree** of `TreeNode`) and `agentHarness.runtimeConfig`
  (`model` + `thinkingEffort`).
- A session is `{ id, title, createdAt, updatedAt, nodes: Record<id, TreeNode>,
  rootId, activeNodeId, orphanItems }`.
- `this.displayItems` points at the **checked-out node's** `displayItems` during a
  turn (set in `checkoutNode` / `beginTurn`), so streamed items land in the right
  node and are persisted with it.
- Model/effort selections are user-overridable at runtime and persisted;
  settings provide the fallback defaults.
- `persist()` writes a **clipped copy** of each node's messages
  (`clipMessageForStorage`, 64 KiB per message content): the in-memory history
  keeps the full payload, but one huge tool result cannot make every persist write
  tens of MiB into the memento.

### Chat Tree invariants
- `TreeNode.messages` (non-empty) always starts with a `user` role message; the
  system prompt is **never** stored in a node (synthesized per activation).
- The flat API history is `pathMessages(session, activeNodeId)` = `[system, ...path
  nodes' messages]`, and it must go through `Agent.sanitizeMessages` (the sanitized
  copy is **never** written back into the nodes — `pathMessages` returns the nodes'
  own message objects by reference, so `sanitizeMessages` must not mutate them: the
  reasoning→content healing builds a `{ ...msg }` copy). `prefixLen` is measured on the
  sanitized path.
- A turn's message slice is written **once**, in `finishTurn`, as
  `node.messages = agent.getMessages().slice(turnPrefixLen)`; run `done` /
  `interrupted` / `error` all end there. `turnPrefixLen` is therefore always an
  index into **`agent.getMessages()`** (which includes the leading system message):
  `beginTurn` uses `agent.getMessages().length` after `setMessages(buildPath(...))`,
  and the injected async-notice turn in `drainSubAgentNotices` does the same (it
  pins the history to the parent node with `buildPath` first). A queued notice whose
  node is **not** in the active session is dropped, so a batch finishing after a
  session switch never injects a turn into another session's agent. Using a node's own
  `messages.length` as the basis re-includes ancestor history in that node.
- Branching: every user message creates a new node under the checked-out node;
  sending on a node that already has children makes a sibling (a new branch).
  A branch switch costs only a prefix cache miss — the shared prefix stays cached.
- `attachNode` repairs a missing parent by attaching the node to the **root**
  instead of leaving it unreachable (an orphan would still become the checkout
  point and silently blank the history); `leafOf` skips `kind:'agent'` children,
  so a restored checkout point can never land on a sub-agent sidecar.
- Switching to a different branch resets the pending interruption notice
  (`agent.resetInterruptState()`) unless the new path still ends at the interrupted
  node; `lastInterruptedNodeId` tracks this.
- `node.customSize` (optional `{w,h}`) persists a user-resized card; it survives
  migration via `normalizeTreeSession` and is sent in the `tree` message as `size`.
- Chat render: the webview lays out the **active path** expanded and all other
  nodes collapsed; `path` carries per-node items while `tree` carries structure.
  Checkout re-sends `path` + `panTo` (no `reset`/`tree`) so the tree never tears
  down, and already-rendered nodes are skipped (`_itemsRendered`) to avoid
  re-running markdown.
- Migrating v1 `{messages, displayItems}` splits at each `user` message; items are
  re-attached by walking both lists (best effort) and the original state is backed
  up to `agentHarness.state.v1backup`.

### Background terminals
- `exec_command` accepts a `timeout_behavior` arg (`stop` default, `move_to_background`,
  `start_in_background`). `start_in_background` launches a command immediately and returns
  an opaque `id`; `move_to_background` runs it in the foreground and, if it is still running
  at `timeout`, promotes it instead of killing it. The `id` is a per-session token (a monotonic
  counter), **not** a real OS pid.
- Background jobs are tracked by a per-session `BackgroundRegistry` (`sessionRegistries` in
  `ChatViewProvider`). The active registry is set onto the `ToolRegistry` on session activation
  (`setBackgroundRegistry`). Because a session with a running background job is **locked** (cannot
  be switched away, deleted, or cleared), the active session is always the owner of the running jobs.
- Three tools manage a background id: `check_background_terminal(pid)`, `kill_background(pid)`,
  `join_background(pid)` (blocks until it finishes, honours Stop).
- When a background task finishes (or is killed by the user from the panel), the harness delivers it to
  the agent as a **dedicated card** (a `background` display item, not a user bubble). It is injected
  **now** if the agent is idle, otherwise **queued**; all queued notices for the active session are then
  flushed **together in a single turn** when the current turn ends (`drainBackgroundQueue` →
  `injectBackgroundNotices`), so `N` finished jobs cause exactly one agent turn, not `N`.
- Tool-initiated kills (`kill_background`) and joins (`join_background`) set `notifyAgent=false`, and the
  provider drops a stale queued notice for such a task at delivery time (`taskAlreadyHandled`), so the
  tool result is the only signal the agent sees — no duplicate injected notice.
- `spawnShellCommand`/`killChildProcess` (in `src/tools/background.ts`) handle the process-tree kill
  (Windows `taskkill /T /F`, otherwise a POSIX process group — the child is spawned
  `detached` so `process.kill(-pid, 'SIGTERM')` tears down the whole tree) and keep
  draining output past `OUTPUT_CAP` so a
  background command cannot block or balloon memory. Output is decoded with a per-stream
  `StringDecoder`, so a multi-byte character split across pipe chunks is not turned into U+FFFD.
- On session delete or extension deactivate, `killAll()` tears down every running background job so
  nothing is orphaned. `clear()`/`new`/`switch`/`delete` are blocked while a background job runs.
- The webview renders a "Background" panel (`#bg-panel`) listing **still-running** tasks (with a
  collapsible output and a Kill button) plus finished jobs that are **pending delivery** (their notice
  has not reached the agent yet). Once the notice is delivered (or the agent was already informed via a
  join/kill tool result, `task.delivered`), the job drops out of the panel, so it never accumulates
  stale entries. The session bar is disabled while `sessionLocked` (busy OR any background job running).
- `postBackgrounds` is coalesced (~200ms) so a chatty process cannot freeze the webview.

### Sub-agents
- `spawn_agents({ agents: [{ instruction, write (REQUIRED), model? }], mode })` spawns one or more
  parallel sub-agents. `write:true` lets a sub-agent write files / run commands; `write:false` is
  **read-only** (only `read_file` / `list_dir` / `search_files`; the write tools are hidden from the
  model's tool list via `ToolRegistry.withHidden` yet stay registered and **blocked at runtime** by
  `ToolRegistry.withBlocked`, so a hallucinated call still gets a clear denial). Depth is hard-capped at 2 — a depth-2
  sub-agent may not spawn at all. A read-only depth-1 sub-agent gets `spawn_readonly_agents` instead of
  `spawn_agents` (`canSpawn = depth < 2 && write`, `canSpawnReadOnly = depth < 2 && !write`): its agent
  specs have no `write` field, `Agent.executeToolCall` rewrites every spec to `write:false` (so a
  smuggled `write` key cannot escalate), and `spawnChildren` clamps a read-only parent's child to
  `write:false` anyway. It resumes its own children with `send_readonly_agent_message` (again no
  `write` override; `handleSubAgentSendMessage` also enforces "target must be a direct child" and
  caps `write` at `caller.write && target.write`). Its system prompt
  (`Agent.subAgentSystemPrompt`) nudges it to fan out when a task splits into
  independent, reading-heavy parts — without the nudge, read-only sub-agents never
  volunteer to decompose. `mode:'sync'` blocks and returns `{ results }`;
  `mode:'async'` returns
  `{ spawned, async:true, ids }` immediately and the outcome is delivered as **one** injected notice
  when the batch settles. An async **resume** whose owner is a sub-agent is routed through
  `queueSubAgentChildNotice` (queued for that sub-agent's next finish, or auto-resumed) instead of the
  main agent's notice queue.
- `send_agent_message({ id, message, write?, model?, mode })` resumes a **finished** sub-agent (the
  `id` from a prior `spawn_agents`) with a follow-up `message`. `sync` blocks and returns the resumed
  result; `async` returns immediately and delivers the result as a notice. `model` is validated against
  the `MODELS` whitelist (unknown → error). A still-running target returns `still running`.
- A sub-agent is a `kind:'agent'` node — a **display-only sidecar**: its own conversation is a separate
  history and `pathMessages` (in `tree.ts`) skips it, so it never leaks into the parent's API path. On
  finish the sub-agent's conversation (minus the synthesized system prompt) is stored in `node.messages`
  so a follow-up can continue it, even across a restart.
- **Transcript dumps (`node.agentTranscript`):** because the caller can only ever see the sub-agent's
  summary, `runSubAgent`'s `finish` also writes the whole conversation to disk as **JSONL**
  (`src/chat/transcript.ts`) and returns the absolute path: `spawn_agents` sync results carry
  `stats` (tool-call / denied-call counts) plus `transcript` per agent, `send_agent_message` sync
  results carry them too, and the async notices append
  `· transcript: <path>` to each line. Line 1 is a `meta` record (ids, spec, status, summary, system
  prompt, `stats.toolCalls` / `stats.deniedToolCalls` / `stats.usage`); every following line is one API
  message (`{type:'message', index, ...}`), so `read_file` can page it and `search_files` can grep it.
  A resume **overwrites** the same `<nodeId>.jsonl` with the extended conversation. The folder is
  `<agentHarness.subAgentTranscriptDir>/<sessionId>/` (workspace-relative) or, by default,
  `<globalStorage>/transcripts/<sessionId>/`; `agentHarness.saveSubAgentTranscripts` (default true) can
  turn it off. A write failure is logged to the output channel and never breaks the run. The folder is
  deleted with its session (`deleteSession`) or when the conversation is cleared (`clear`).
- Async results for a **sub-agent parent** (a depth-1 sub-agent that spawned depth-2 children in async
  mode) are routed by `queueSubAgentChildNotice`: if the parent is still running the notice is queued and
  delivered at its next finish (`flushSubAgentChildNotices`); if it already finished it is auto-resumed
  with the notice — the mirror of the main agent's async delivery (`subAgentNoticeQueue`).
- A sub-agent branch is checked-out as **read-only** (composer disabled); only the parent drives it via
  `spawn_agents` / `send_agent_message`. `onKillAgent` aborts a running sub-agent from its card's ✕.
- **Stream routing invariant:** the webview streams `nodeId`-less (main-agent) deltas into `messagesEl`,
  which the provider pins via `mainStreamNodeId()` = `activeTurnNode?.id ?? session.activeNodeId`. That target
  must **never** be a sub-agent sidecar. `spawnChildren` therefore restores `session.activeNodeId` to
  `activeTurnNode?.id ?? prevActive` (captured before `attachNode`) instead of `parent.id` — restoring to
  `parent.id` broke **nested** spawns (where the parent is itself a sub-agent), pinning `messagesEl` to a
  sub-agent card and letting the main agent's reply leak into that window. `drainSubAgentNotices` also calls
  `postPath()` before the injected resume turn streams, re-pinning the target. Keep this invariant; the data
  lives on the parent node regardless (only the live DOM target was wrong).
- **Layout invariant (`media/tree.js`):** agent windows must be laid out **recursively** — `place(a, ax, ay)`
  (not just `pos[a] = {x,y}`), with `subWidth(a)` reserving horizontal space and `subHeight(a)` driving the
  vertical stack. Otherwise an agent node's own children (a depth-2 sub-agent spawned by a depth-1 sub-agent)
  never get a position, so its card collapses onto the origin and its connector is misplaced. `agentExpanded`
  walks up the agent ancestors so a depth-2 sub-agent stays open beside its expanded depth-1 parent.

### Streaming / long-session performance
- SSE tokens are **not** forwarded 1:1. `ChatViewProvider` coalesces `streamDelta` /
  `reasoningDelta` / `toolCallDelta` (~50ms) and only then `postMessage`s to the webview.
- The webview paints a streaming answer as a plain `Text` node (`appendData`);
  markdown-it runs **once** when the answer is finalized (`done` / `toolStart` /
  `interrupted` / `error`). Re-parsing the whole reply on every token is what used
  to freeze the sidebar after a long session.
- Tool cards shown in the UI (and persisted `displayItems`) cap args (~8 KiB) and
  result (~32 KiB). Agent `messages` still carry the full tool payload for the model.
- Transcript scrolling is **per-card**: each node's `.node-items` (and each
  thinking body) has a `createScrollController` with a green lock dot
  (`attachLock`). It defaults to locked (pinned to bottom), starts green, and
  dims when the user scrolls up. During streaming `followActive` calls
  `scrollToBottom()` which respects the lock (manual scrolling wins); expanding a
  card calls `lock()` which re-engages it. The tree viewport itself is a pannable
  canvas (pan/zoom/fit), not a scroll container.
- `[perf]` lines (request JSON size, assistant-round, tool timings, persist, stream
  flush) go to the **Agent Harness** output channel. Open View → Output → "Agent Harness".

### Config keys (`agentHarness.*`)
`apiKey` (or `DEEPSEEK_API_KEY` env), `model`, `baseUrl`, `commandTimeout`
(seconds, default 120), `maxTurns` (default 20), `contextWindow` (0 = auto),
`thinkingEffort` (`none|low|medium|high`), `foldToolCalls` (default `true`),
`foldThinking` (default `true`), `maxConcurrentSubagents` (default 15),
`maxLevel2Subagents` (default 2), `saveSubAgentTranscripts` (default `true`),
`subAgentTranscriptDir` (default `""` = global storage; else workspace-relative),
`maxInlineToolOutput` (bytes, default `32768`; `0` = always inline — above it a
tool result spills to a temp file). `SubAgentPool` clamps `maxConcurrentSubagents`
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

### Vision / images
- Only `deepseek-v4-flash-vision-exp` and `deepseek-v4.1-flash-expires-on-0910`
  accept images; other models return a 400. Image content blocks are **only
  allowed in `user` messages** (`system` / `assistant` / `tool` reject them).
- **User-attached images** (file picker `pickImage` / clipboard paste) and
  **agent-read images** (`read_image`) are both uploaded to the DeepSeek Files
  API (`POST /files`, `purpose=user_data`) and referenced by the returned
  `file-api-…` id via a `file` content block
  (`{ type: 'file', file_id }`). The `onUserMessage` path uploads each
  attachment (`ChatViewProvider`) before sending; `read_image` uploads in the
  Agent (`tryReadImage`). The API auto-resizes to ~800×800 and caps each image
  at **384 tokens**, so no client-side downscaling is needed.
- Files-referenced images may be up to **64 MiB** and are **not** subject to the
  48 MiB request-body limit (inline base64 `image_url` is, but is no longer used
  for new images). Supported formats: JPEG, PNG, GIF, WebP (detected from
  content, not the filename). `content` size cap is enforced with a friendly
  error in the tool; the attach path reports per-image upload failures and omits
  them.
- PNG uploads get a structural check on top of magic-byte detection
  (`imageIntegrityError` in `types.ts`, called by `uploadFile`): every chunk CRC
  and the `IEND` terminator are verified, so a truncated/corrupt PNG is rejected
  locally with a reason (`bad CRC in the IDAT chunk`, …) instead of a provider
  400.
- When the active model is not the vision model, image blocks in the history are
  **hidden, not removed** (see `messagesForCurrentModel` in `agent.ts`): the
  stored `messages` keep the original image blocks, but the copy sent to the API
  replaces each `image_url`/`file` block with a `[image hidden: …]` text part so
  the request does not 400. Switching back to the vision model restores the
  image blocks automatically. `read_image` returns a similar friendly error, and
  the provider drops newly attached images with a notice.
- A **provider-rejected image** (a 400 matching `/unsupported image/i`, e.g. a
  file the local integrity check cannot catch) follows the same hide-not-remove
  rule: `Agent.markRejectedImages` records the offending `file_id`/`image_url` in
  `Agent.rejectedImageIds` — only the message DeepSeek names in `.messages[<n>]`,
  otherwise every image in the history — and `messagesForCurrentModel` replaces
  it with `[image removed: …]` on every later request;
  `requestAssistantMessage` retries up to 8 times, emitting a `status` event.
  The stored history keeps the original block (never mutated), and the id set
  deliberately survives session switches: ids are unique per upload, so it only
  prevents repeating the same 400.
- Uploads are abortable: the attach path (`onUserMessage`) and `read_image`
  (`tryReadImage`) both pass an `AbortSignal` to `uploadFile`, so pressing Stop
  mid-upload rejects with `DeepSeekError('Upload aborted.')` and is treated as an
  interruption rather than a failed upload.
- The webview hides image thumbnails (history and the composer preview) when the
  active model is not the vision model (`updateImageVisibility` in `main.js`
  toggles a `hide-images` class on `#messages` / `#attachments`), and refuses to
  queue a pending attachment with an inline hint. The conversation data is kept
  and the thumbnails reappear when a vision model is selected again.

### Agent-authoring notes
- The agent is instructed to **default to Simplified Chinese (zh-Hans)** for
  replies (eager, not just allowed) and to keep code, paths, identifiers, and
  command output in their original form (see `CORE_PROMPT`'s `## Language`).
  Do not add English-only output requirements to the model.
- `CORE_PROMPT` also carries an **"Ask instead of guessing"** rule (ask one short
  clarifying question when a request is genuinely ambiguous rather than silently
  settling on a reading) and a light **"Tone"** section inviting playful, concise,
  friendly replies (borrowed from the community DeepSeek persona), gated by a
  **"Correctness always wins"** rule that keeps the tone from ever compromising
  accuracy — and drops it entirely in serious/high-stakes contexts.
- The harness trusts the model to emit tool calls; there is no validation of text
  answers, only tool-argument parsing.

## Where to look when changing

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

## Computer use (Windows desktop GUI)

A local, stateless CLI can drive the Windows desktop (mouse, keyboard,
screenshots, window list/focus, UI Automation trees). It is **not** part of this
repo — it lives with the user's Cursor skills:

- Binary: `C:\Users\DE-YU\.cursor\skills\computer-use\bin\computer-use.exe`
  (also on `PATH` as `computer-use`; use the absolute path if `PATH` is not
  available in the current shell).
- Full docs: `C:\Users\DE-YU\.cursor\skills\computer-use\SKILL.md` (usage) and
  `reference.md` (complete CLI surface + response shapes). Read them before a
  non-trivial session.
- **Artifacts go to the workspace scratch space** (never `C:\Temp`): pass
  `--path .agent-harness/screenshots` so every capture lands in the same
  gitignored folder as the rest of the agent's scratch (see "Agent scratch space"
  below).

Every invocation runs **one action** and prints one JSON object on stdout
(`ok`, `command`, plus payload fields). Exit codes: `0` ok, `1` bad arguments,
`2` runtime error. Parse the JSON; do not treat stderr text as the result.

**When to use it:** only when a task genuinely needs the GUI (click/type, inspect
on-screen UI, focus a window, capture a screenshot, drive an app with no CLI).
Prefer a real CLI/API — this repo's tools or `exec_command` — whenever one
exists; the desktop is the last resort, not the first.

**The loop:**

1. `computer-use window find --title "*App*"` (or `window list`) → pick `hwnd`.
2. Explore: `computer-use window snapshot --hwnd <hwnd> --focus` → read the YAML
   `snapshot` and pick a `ref` (prefer this over `uia dump`).
3. Act, preferring UI Automation actions over synthetic clicks:
   `uia set-value --hwnd <hwnd> --ref eN --value "…"`, `uia invoke`, `uia toggle`,
   `uia select`; fall back to `mouse click --hwnd <hwnd> --ref eN --focus`.
4. Verify with a fresh `window snapshot` — refs change after the UI updates.
5. Screenshots: `screenshot --path .agent-harness/screenshots --hwnd <hwnd> --focus`
   (or `--ref eN --pad 12` for a POI crop), then `read_image <png>` to actually
   look at it. Prefer a crop over a full-screen shot.

**Safety / shared desktop (the user is often active):**

- Never assume the foreground window, cursor position, or window bounds persist
  between tool calls or turns — the user may move the mouse or the window.
- Do **not** run parallel `exec_command` calls that mutate or depend on desktop
  state (focus, click, type, screenshot of an hwnd).
- Prefer `--hwnd`/`--ref` (or `--coord window|client` offsets resolved *in the
  same script*) over absolute screen points; re-resolve `hwnd`/bounds inside the
  script instead of reusing coordinates from an older screenshot.
- Do not use `mouse drag` or destructive key chords unless the user asked for it.
- When UIA is empty (games/D3D/canvas), stop retrying UIA: chain focus +
  screenshot in one command, click by `--coord window|client` from a fresh find,
  and read a crop.
- Close apps you launched when the user asked to finish; don't leave helper
  processes running.

**Common commands:**

```text
computer-use window list
computer-use window find --title "*Notepad*"
computer-use window snapshot --hwnd 0x00040C1A --focus
computer-use uia set-value --hwnd 0x00040C1A --ref e3 --value "hello"
computer-use uia invoke --hwnd 0x00040C1A --ref e15
computer-use mouse click --hwnd 0x00040C1A --ref e12 --focus
computer-use mouse click --hwnd 0x00040C1A --coord window --x 40 --y 45 --focus
computer-use key tap --hwnd 0x00040C1A --key a
computer-use screenshot --path .agent-harness/screenshots --hwnd 0x00040C1A --focus
computer-use uia from-point --x 640 --y 360
```

`--hwnd` accepts `0x` hex or decimal; `--ref` accepts `e12` or `12`;
`--coord window` = offsets from the outer window rect, `--coord client` = client
area. One **logical** step per decision; when the user may be active, chain
focus + act + verify in a single command so intermediate state cannot drift.

### Agent scratch space

All agent-produced artifacts live in the workspace-local, gitignored
`.agent-harness/` (excluded from the `.vsix` too) and are safe to delete:

| Path | Contents |
| --- | --- |
| `.agent-harness/screenshots/` | `computer-use screenshot` output (pass `--path`) |
| `.agent-harness/tool-output/` | oversized `search_files`/`list_dir`/`exec_command`/background results (`limitInline`) |

`.agent-harness` is in the tools' `SKIP_DIRS`, so `list_dir`/`search_files` walks
skip it — grep a spilled file by its **exact path** instead. Never write scratch
files to `C:\Temp` or the repo root; if a new kind of artifact appears, give it a
subfolder here.

## Testing convention

There is no automated test suite. Verification is manual: run in the Extension
Development Host (F5) and exercise read/write/exec against a scratch file
(`_e2e.txt` is a leftover scratch fixture, safe to ignore or delete). Before a
release, confirm `npm run compile` is clean and `build-deploy.ps1` succeeds.
