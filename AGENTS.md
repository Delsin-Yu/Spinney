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
newest `.vsix`. Use it for quick iteration, then reload the window.

Launch: F5 (`.vscode/launch.json` → "Run Extension", pre-task `npm: compile`).
`-allow-missing-repository` is required because the repo has no git remote.

## Architecture & data flow

```
User (sidebar webview)  <--postMessage-->  ChatViewProvider (src/chat)
                                                    | holds per-session Agent
                                                    v
                                        Agent (src/agent/agent.ts)
                                           | streaming loop
                                           v
                                        DeepSeekClient (src/agent/deepseek.ts)
                                           |  tools (function calls)
                                           v
                                        ToolRegistry (src/tools/index.ts)
                                           |  v
                                           +  exec_command -> shell detection (src/tools/shell.ts)
```

1. `extension.ts::activate` registers the webview view provider
   (`agentHarness.chat`) and two commands (`agentHarness.focus`, `agentHarness.clear`).
2. The webview (`media/main.js`) sends messages (`userMessage`, `stop`,
   `switchSession`, `setModel`, `clear`, `pickImage`, …). It streams in a
   sandboxed iframe; it cannot import VS Code's own renderer, so it loads a
   vendored `markdown-it.min.js`.
3. `ChatViewProvider.resolveWebviewView` wires the message handler and returns
   the HTML shell (CSP-safe, `nonce` scripts).
4. `ChatViewProvider` owns the `Agent` instance and one **session** per
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
- `src/chat/ChatViewProvider.ts` — webview provider, session/persistence,
  config, image attachment, message routing, event→UI mapping, HTML shell.
- `src/agent/agent.ts` — the agent loop, the **system prompt** (`CORE_PROMPT`,
  `identityLines`, `buildSystemPrompt`), message sanitizing, interrupt/rollback,
  `AGENTS.md` snapshot (static `agentsMdSnapshot`), model/effort switching.
- `src/agent/deepseek.ts` — `DeepSeekClient` (stream SSE over `fetch`,
  `DeepSeekError`), builds `stream: true`, `stream_options.include_usage`,
  `reasoning_effort`.
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
- `src/perf.ts` — tiny `[perf]` logger (sink = the Agent Harness output channel).
- `media/main.js` — webview client (rendering, composer, streaming meter,
  auto-scroll, live tool drafts).
- `media/style.css` — chat UI styling.
- `media/markdown-it.min.js` — vendored markdown renderer.
- `build-deploy.ps1` — compile + package + install helper.

## Tools (the agent's surface)

| Tool | Args | Behavior |
| --- | --- | --- |
| `read_file` | `path`, `startLine?`, `endLine?` | Returns `File: <path> (N lines, <EOL>)` header + LF-normalized content (line-numbered if a range is given). Always LF content, but reports on-disk EOL. |
| `write_file` | `path`, `content`, `frame?` | Overwrites; creates parent dirs. Preserves the existing file's line-ending style (converts content to it). New files written as supplied. |
| `replace_in_file` | `path`, `oldText`, `newText`, `frame?` | Exact-substring replace. `oldText` must occur **exactly once** (else error). Matches/writes in normalized LF; preserves on-disk EOL. |
| `list_dir` | `path?` | Sorted entries; directories suffixed with `/`. |
| `exec_command` | `command`, `cwd?`, `timeout?`, `timeout_behavior?` | Runs through the detected shell (`getShell()`), returns combined stdout+stderr trimmed. Errors/timeouts/aborts are prefixed with a `[...]` note. `timeout_behavior` = `stop` (default, kill on timeout) / `move_to_background` (promote a still-running command to a background terminal and return its id) / `start_in_background` (launch immediately, return id, don't wait). |
| `check_background_terminal` | `pid` | Status of a background terminal (running / finished, exit code, output so far). |
| `kill_background` | `pid` | Kills a background terminal's process tree. Tool-initiated kills suppress the injected completion notice. |
| `join_background` | `pid` | Blocks until the background terminal finishes and returns its final exit code + output. Honours Stop. |
| `read_image` | `path` | Not a registry tool — handled by the Agent. Reads the image, uploads it to the DeepSeek Files API, then injects a `user`-role `file` content block (`{ type: 'file', file_id }`) so the vision model sees it. Returns a short confirmation (path → `file-api-…`, bytes). Only valid on the vision model; unsupported format/too large (>64 MiB) return a friendly error. |

> `read_image` is the only tool **not** resolved by `ToolRegistry.execute`; it is intercepted in `Agent.executeToolCall` because a tool message cannot carry an image block, so the image must be delivered as an injected user message. The tools sent to the API are `[...ToolRegistry.definitions, READ_IMAGE_TOOL]` (see `Agent.getTools`).

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
- Storage keys: `agentHarness.state` (sessions incl. `messages` + `displayItems`)
  and `agentHarness.runtimeConfig` (`model` + `thinkingEffort`).
- `ChatViewProvider` holds `sessions`/`activeSessionId`; a session is
  `{ id, title, createdAt, updatedAt, messages, displayItems }`.
- The active session's `displayItems` is `this.displayItems` (the same array
  reference is pointed at the session), so in-memory mutations during a turn are
  persisted. Do **not** reassign it.
- Model/effort selections are user-overridable at runtime and persisted;
  settings provide the fallback defaults.

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
  (Windows `taskkill /T /F`, otherwise `SIGTERM`) and keep draining output past `OUTPUT_CAP` so a
  background command cannot block or balloon memory.
- On session delete or extension deactivate, `killAll()` tears down every running background job so
  nothing is orphaned. `clear()`/`new`/`switch`/`delete` are blocked while a background job runs.
- The webview renders a "Background" panel (`#bg-panel`) listing **still-running** tasks (with a
  collapsible output and a Kill button) plus finished jobs that are **pending delivery** (their notice
  has not reached the agent yet). Once the notice is delivered (or the agent was already informed via a
  join/kill tool result, `task.delivered`), the job drops out of the panel, so it never accumulates
  stale entries. The session bar is disabled while `sessionLocked` (busy OR any background job running).
- `postBackgrounds` is coalesced (~200ms) so a chatty process cannot freeze the webview.

### Streaming / long-session performance
- SSE tokens are **not** forwarded 1:1. `ChatViewProvider` coalesces `streamDelta` /
  `reasoningDelta` / `toolCallDelta` (~50ms) and only then `postMessage`s to the webview.
- The webview paints a streaming answer as a plain `Text` node (`appendData`);
  markdown-it runs **once** when the answer is finalized (`done` / `toolStart` /
  `interrupted` / `error`). Re-parsing the whole reply on every token is what used
  to freeze the sidebar after a long session.
- Tool cards shown in the UI (and persisted `displayItems`) cap args (~8 KiB) and
  result (~32 KiB). Agent `messages` still carry the full tool payload for the model.
- Auto-scroll is a lock/unlock controller in `media/main.js`
  (`createScrollController`). It defaults to locked (pinned to the newest output)
  and unlocks when the user scrolls up. A programmatic `scrollTop = max` fires a
  scroll event too, and the stream may have grown the content before that event
  is delivered — so events that land on/below the last programmatic top are
  ignored (otherwise the view silently unlocked mid-stream and stopped
  following). While the user is actively scrolling (`wheel` / `touchmove` /
  `pointerdown` / `keydown`, ~150 ms) snapping pauses so an intentional scroll
  up wins. A `ResizeObserver` on `#messages` re-pins on container resize.
  `#scroll-lock` is the green light at the bottom of the scrollbar (lit =
  locked), hidden while the transcript does not overflow.
- `[perf]` lines (request JSON size, assistant-round, tool timings, persist, stream
  flush) go to the **Agent Harness** output channel. Open View → Output → "Agent Harness".

### Config keys (`agentHarness.*`)
`apiKey` (or `DEEPSEEK_API_KEY` env), `model`, `baseUrl`, `commandTimeout`
(seconds, default 120), `maxTurns` (default 20), `contextWindow` (0 = auto),
`thinkingEffort` (`none|low|medium|high`).
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
- When the active model is not the vision model, image blocks in the history are
  **hidden, not removed** (see `messagesForCurrentModel` in `agent.ts`): the
  stored `messages` keep the original image blocks, but the copy sent to the API
  replaces each `image_url`/`file` block with a `[image hidden: …]` text part so
  the request does not 400. Switching back to the vision model restores the
  image blocks automatically. `read_image` returns a similar friendly error, and
  the provider drops newly attached images with a notice.
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
- **Change session persistence** → `loadSessions`/`persist`/`activateSession` in
  `ChatViewProvider.ts` and the `StorageKey`s.
- **Change the API client** → `src/agent/deepseek.ts`.

## Testing convention

There is no automated test suite. Verification is manual: run in the Extension
Development Host (F5) and exercise read/write/exec against a scratch file
(`_e2e.txt` is a leftover scratch fixture, safe to ignore or delete). Before a
release, confirm `npm run compile` is clean and `build-deploy.ps1` succeeds.
