# Tools (the agent's surface)

| Tool | Args | Behavior |
| --- | --- | --- |
| `read_file` | `path`, `startLine?`, `endLine?` | Returns `File: <path> (N lines, <EOL>)` header + LF-normalized content (line-numbered if a range is given). Always LF content, but reports on-disk EOL. `N` follows the `wc -l` convention (a trailing newline does **not** add a line); `read_file(path, 1, 1)` is the cheap way to get just the count. |
| `write_file` | `path`, `content`, `frame?` | Overwrites; creates parent dirs. Preserves the existing file's line-ending style (converts content to it). New files written as supplied. |
| `replace_in_file` | `path`, `oldText`, `newText`, `frame?` | Exact-substring replace. `oldText` must occur **exactly once** (else error). Matches/writes in normalized LF; preserves on-disk EOL. The replacement is inserted **verbatim** (function-form replace), so `String.replace` dollar-patterns in `newText` stay literal. |
| `list_dir` | `path?`, `glob?`, `recursive?` | Sorted entries; directories suffixed with `/`. `glob` filters against the path relative to the listed dir (`*.ts` = top level, `**/*.ts` = any depth); `recursive` walks subdirs (heavy dirs skipped) and prints relative paths. Capped at 2000 entries with an explicit note. |
| `search_transcripts` | `query?`, `sessionId?`, `kind?`, `caseSensitive?`, `maxResults?`, `context?` | Regex search over the harness's own transcript dumps — the **only** way to recall a previous session (history otherwise lives in the Memento, which no tool can grep). Files are `<root>/<sessionId>/<nodeId>.jsonl` (usually **outside** the workspace, in global storage, so `search_files` cannot reach them). Each hit is `file:line: text` with the **absolute** path, so `read_file` with those line numbers pages the full record; `context` (0–10) uses `-` separators. `query` omitted ⇒ index of sessions (id, files, size, last write, kind mix, titles), or of one session's files with `sessionId`. `kind` = `session` (main-agent turns) / `subagent`. Default 50 hits / hard cap 300; files >8 MB skipped; capped runs say so. **schema 中折叠，用 `list_advanced_tool(topic)` 取接口。** |
| `search_files` | `pattern`, `path?`, `glob?`, `caseSensitive?`, `maxResults?`, `context?` | Regex search returning `file:line: text` (paths **workspace-relative**). `path` may be a **file or a directory**. `maxResults` default 200 / hard cap 300; `context` (0–10) adds surrounding lines with `-` separators (`src/a.ts-11- text`). Hit lines are trimmed + clipped to 160 chars. Heavy dirs skipped; files >1 MB skipped. A capped/short-circuited search appends an explicit `…[search stopped early: …]` note — never silently truncated. |

> **Oversized results spill to a file.** Every tool whose output is unbounded
> (`search_files`, `search_transcripts`, `list_dir`, `exec_command`,
> `check_background_terminal`, `join_background`) runs its result through
> `limitInline()`: above
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
| `check_background_terminal` | `pid` | Status of a background terminal (running / finished, exit code, output so far). **schema 中折叠，用 `list_advanced_tool(topic)` 取接口。** |
| `kill_background` | `pid` | Kills a background terminal's process tree. Tool-initiated kills suppress the injected completion notice. **schema 中折叠，用 `list_advanced_tool(topic)` 取接口。** |
| `join_background` | `pid` | Blocks until the background terminal finishes and returns its final exit code + output. Honours Stop. **schema 中折叠，用 `list_advanced_tool(topic)` 取接口。** |
| `read_image` | `path` | Not a registry tool — handled by the Agent. Reads the image, uploads it to the DeepSeek Files API, then injects a `user`-role `file` content block (`{ type: 'file', file_id }`) so the vision model sees it. Returns a short confirmation (path → `file-api-…`, bytes). Only valid on the vision model; unsupported format/too large (>64 MiB) return a friendly error. **schema 中折叠，用 `list_advanced_tool(topic)` 取接口。** |
| `spawn_agents` | `agents`, `mode` | Orchestrated by the provider. Spawns parallel sub-agent branches (`write` REQUIRED, `model?`), `mode: 'sync'` blocks returning summaries + each agent's `stats` + `transcript` path, `'async'` returns `{ spawned, async:true, ids, transcriptDir }` and delivers one combined notice when the batch settles. Only on agents whose `canSpawn` is true (`depth < 2 && write`) — a read-only sub-agent never sees it. **schema 中折叠，用 `list_advanced_tool(topic)` 取接口。** |
| `spawn_readonly_agents` | `agents`, `mode` | Read-only fan-out variant: the agent specs have **no `write` field**, so a child can never be writable. Exposed only when `canSpawnReadOnly` (`depth < 2 && !write`), i.e. to a read-only depth-1 sub-agent. Same result shape as `spawn_agents`. **schema 中折叠，用 `list_advanced_tool(topic)` 取接口。** |
| `send_agent_message` | `id`, `message`, `write?`, `model?`, `mode` | Orchestrated by the provider. Resumes a finished sub-agent (`id` from a prior `spawn_agents`) with a follow-up. `sync` returns the resumed result + `stats` + `transcript`, `async` returns `{ resumed, id, async:true }` and delivers the result as a notice. `model` is whitelisted. Only on agents whose `canSpawn` is true (`depth < 2 && write`). The `write?` override is honoured **only for the main agent**; a sub-agent caller goes through `handleSubAgentSendMessage`, which requires the target to be its own direct child and caps `write` at `caller.write && target.write` (no promotion). **schema 中折叠，用 `list_advanced_tool(topic)` 取接口。** |
| `send_readonly_agent_message` | `id`, `message`, `model?`, `mode` | Read-only resume variant: **no `write` override exists** (and a smuggled key is pinned to `false`). Exposed only when `canSpawnReadOnly` (`depth < 2 && !write`), i.e. to a read-only depth-1 sub-agent. Same result shape as `send_agent_message`. **schema 中折叠，用 `list_advanced_tool(topic)` 取接口。** |
| `hop_session` | `prompt`, `title?`, `returnNodeId?` | Orchestrated by the provider. Hands a self-contained task to a **fresh session** and gets its answer back: the hop is queued (the current turn ends), the new session runs `prompt` as its first message, and when that turn finishes the harness switches back and delivers the new session's final answer as an injected user message (`[会话跳转回执] …`), as a **new branch** off `returnNodeId` when given. Main agent only (`setCanHop(true)`), one hop at a time, refused while a background terminal runs. See "Hop and hop back" above. **schema 中折叠，用 `list_advanced_tool(topic)` 取接口。** |
| `list_nodes` | — | Orchestrated by the provider. Renders the active session's chat tree — one line per node (`id`, `turn`/`agent`, status, `parent=<id>`, title) plus the checked-out marker — so the agent can name a node (e.g. `hop_session`'s `returnNodeId`). Main agent only (same `canHop` gate). **schema 中折叠，用 `list_advanced_tool(topic)` 取接口。** |
| `rename_session` | `title`, `sessionId?` | Orchestrated by the provider. Renames a **session** (not a node) and **locks** the title, so the automatic namer never overwrites it. `sessionId` defaults to the active session. Main agent only (same `canHop` gate). Returns the new title. **schema 中折叠，用 `list_advanced_tool(topic)` 取接口。** |
| `list_advanced_tool` | `topic?` | 常驻工具，**不**折叠。无参 → 返回 7 个主题的索引；带 topic → 返回该主题的工具名、参数表和一个例子（不含工作区路径——插件文本不能带工作区事实，深度文档路径见本仓库 `AGENTS.md` 索引的「折叠工具的深度文档」一节）。 |

> `read_image` is **not** resolved by `ToolRegistry.execute` — it is intercepted in `Agent.executeToolCall` because a tool message cannot carry an image block, so the image must be delivered as an injected user message. Likewise `spawn_agents` / `spawn_readonly_agents` / `send_agent_message` / `send_readonly_agent_message` / `hop_session` / `list_nodes` / `rename_session` are intercepted and delegated to the provider (`setSpawnHandler` / `setSendMessageHandler` / `setHopHandler` / `setListNodeHandler` / `setRenameSessionHandler`); a read-only depth-1 sub-agent gets only the `*_readonly_*` pair, a depth-2 sub-agent gets none of them, and an intercepted call when the matching `canSpawn*` / `canHop` flag is false returns an explicit error. The tools sent to the API are just `ToolRegistry.definitions`: the folded registry tools sit in the registry's `hidden` set, and the intercepted tools are no longer appended either, so none of them is advertised. The model pulls an interface on demand with `list_advanced_tool(topic)` and can still call the tool (execution is unchanged) — see `Agent.getTools`.

折叠工具仍**保持注册、可直接调用**，只是不再出现在模型工具列表里；接口摘要在 `src/tools/advancedDocs.ts`（与 schema 同源），深度文档在 `docs/agents/**`。

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

