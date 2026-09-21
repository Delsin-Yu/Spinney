# Tools (the agent's surface)

> **Path base.** Every relative `path` — and `exec_command`'s default `cwd` —
> resolves against the **harness root** (`agentRootInfo()`): the workspace folder
> when one is open, otherwise the no-repo scratch folder
> `<globalStorage>/no-workspace`. Nothing else serves as a path base. See
> `docs/agents/no-repo-mode.md`.
>
> **Drive paths.** On Windows, `resolvePath` first reads a leading `/<letter>/`
> as an MSYS/Git-Bash drive path (`/d/Repos/x` → `D:\Repos\x`), but only when that
> drive exists. Without it the path survives as "rooted at the current drive"
> (win32 `path.isAbsolute` calls `/d/…` absolute), so the model's bash-shaped path
> silently became `D:\d\Repos\x` — a wrong file, or a `spawn … ENOENT` when it was
> a `cwd`. The rule is unconditional once the drive exists, so a `/dev/null` on
> Windows is read as `D:\dev\null`; that is the accepted trade, because the model
> that writes `/d/…` means the drive.

| Tool | Args | Behavior |
| --- | --- | --- |
| `read_file` | `path`, `startLine?`, `endLine?` | Returns `File: <path> (N lines, <EOL>)` header + LF-normalized content (line-numbered if a range is given). Always LF content, but reports on-disk EOL. `N` follows the `wc -l` convention (a trailing newline does **not** add a line); `read_file(path, 1, 1)` is the cheap way to get just the count. |
| `write_file` | `path`, `content`, `frame?` | Overwrites; creates parent dirs. Preserves the existing file's line-ending style (converts content to it). New files written as supplied. |
| `replace_in_file` | `path`, `oldText`, `newText`, `frame?` | Exact-substring replace. `oldText` must occur **exactly once** (else error). Matches/writes in normalized LF; preserves on-disk EOL. The replacement is inserted **verbatim** (function-form replace), so `String.replace` dollar-patterns in `newText` stay literal. |
| `list_dir` | `path`, `glob?`, `recursive?` | Sorted entries; directories suffixed with `/`. `glob` filters against the path relative to the listed dir (`*.ts` = top level, `**/*.ts` = any depth); `recursive` walks subdirs (heavy dirs skipped) and prints relative paths. Capped at 2000 entries with an explicit note. |
| `search_transcripts` | `query?`, `sessionId?`, `kind?`, `caseSensitive?`, `maxResults?`, `context?` | Regex search over the harness's own transcript dumps — the **only** way to recall a previous session (history otherwise lives in the Memento, which no tool can grep). Files are `<root>/<sessionId>/<nodeId>.jsonl` (usually **outside** the workspace, in global storage, so `search_files` cannot reach them). Each hit is `file:line: text` with the **absolute** path, so `read_file` with those line numbers pages the full record; `context` (0–10) uses `-` separators. `query` omitted ⇒ index of sessions (id, files, size, last write, kind mix, titles), or of one session's files with `sessionId`. `kind` = `session` (main-agent turns) / `subagent`. Default 50 hits / hard cap 300; files >8 MB skipped; capped runs say so. |
| `search_files` | `pattern`, `path?`, `glob?`, `caseSensitive?`, `maxResults?`, `context?` | Regex search returning `file:line: text` (paths **workspace-relative**, or **absolute** when no folder is open — a default search of the empty scratch root is not a way to find your files). `path` may be a **file or a directory**. `maxResults` default 200 / hard cap 300; `context` (0–10) adds surrounding lines with `-` separators (`src/a.ts-11- text`). Hit lines are trimmed + clipped to 160 chars. **The search runs in a ripgrep child process** (VS Code's bundled `rg`, found under `env.appRoot` — the universal `ripgrep-universal/bin/<platform>-<arch>/` layout, the older single-binary one, then `rg` on `PATH`), so a whole-tree scan never occupies the extension host's JS thread; when no `rg` can be found or it refuses the pattern (it has no lookaround/backreferences) the same search falls back to the original in-process walk, and the tool says which one ran (`via=rg|walk` on the `[perf] search-files` line). The child is killed as soon as the match cap is reached (that is what makes "does this exist?" cheap) and at a 20 s deadline. **`search.exclude`, `files.exclude` and `.gitignore` are honored** — a path the user excluded is never reported, and a result that was narrowed says so with `…[scope: search.exclude/files.exclude/.gitignore honored]`, so *excluded* is never mistaken for *absent*. **Binary files are skipped** in both paths (a font or a generated table yields no mojibake hit). Files >1 MB are skipped, and `out/`, `dist/`, `node_modules/.git` and the agent's own `.spinney/` scratch stay out of a repo-wide walk. A capped/short-circuited search appends an explicit `…[search stopped early: …]` note (match cap / deadline / file ceiling / oversized files) — never silently truncated. |

> **Oversized results spill to a file.** Every tool whose output is unbounded
> (`search_files`, `search_transcripts`, `list_dir`, `exec_command`,
> `check_background_terminal`, `join_background`) runs its result through
> `limitInline()`: above
> `spinney.maxInlineToolOutput`
> (default 32768 bytes, `0` = always inline) the full text is written to
> `<agentRoot>/.spinney/tool-output/<tool>-<id>.txt` (under the workspace
> folder, or `<globalStorage>/no-workspace/.spinney/tool-output/` with no
> folder open) and only the absolute path,
> byte/line count and an 8-line preview are returned — so a `context`-heavy search
> on a big file or a chatty command cannot flood the context. The spilled file is a
> normal file:
> `read_file` can page it, and `search_files` can grep it **by its exact path**
> (`.spinney` is in `SKIP_DIRS`, so repo-wide walks skip it). A write failure
> falls back to inlining, so a result is never lost.
| `exec_command` | `command` (alias `cmd`), `cwd?`, `timeout?`, `timeout_behavior?` | Runs through the detected shell (`getShell()`), returns combined stdout+stderr trimmed, and **always leads with a timing line that also names the working directory** (`[exit 0 in 3.4s · cwd D:\repo]`, `[command exited with code 3 in 3.4s · cwd …]`, … — see "Timing in tool results"). The model-facing point of the `cwd` half is behavioural: every command already starts in the harness root, and a model that sees the directory on every result stops prefixing the same `cd <root> && …` to every command (in the transcripts of one workspace: 10 333 `exec_command` calls, **1** used the `cwd` argument and ~3 400 carried a redundant `cd` to the root). `cwd` is **relative to the harness root or absolute**; it is resolved through `resolvePath` (so `/d/…` means `D:\…` on Windows, see "Path base") and **checked before the spawn**: a missing path or a file answers `the working directory "x" → <resolved> does not exist / is not a directory. Pass cwd relative to the harness root (…), or omit cwd to run in the root.` — without that check, `spawn` reports the failure as `spawn <shell.exe> ENOENT`, blaming the shell and teaching the model that the `cwd` argument is broken. `timeout` is in **seconds** and is the command's **total budget** — foreground plus background, with **no ceiling** — because the one thing that is capped is how long a call may hold the turn: `spinney.commandMaxForegroundDuration` (seconds, default **300** = 5 minutes; `DEFAULT_COMMAND_MAX_FOREGROUND_SEC` in `src/tools/execCommand.ts`), read live per call, so a settings change applies to the next command. There are no other timeout keys — `spinney.commandTimeout` and `spinney.commandTimeoutMax` are gone. **`timeout_behavior` defaults to `stop`**, and the two together are the whole model (full matrix and the verbatim messages in "Timeout, budgets and the `exec` diagnostics" below): timeout omitted and no behavior → killed at the limit; `timeout ≤ limit` with no behavior or `stop` → killed at the timeout; `timeout > limit` with no behavior or `stop` → **refused before the spawn** (a command that may run that long must say *which* background job it is); `timeout > limit` with `move_to_background` → promoted at the **limit**, the hub getting the **rest** of the budget (`timeout − limit`) as the job's own deadline; `timeout ≤ limit` with a background behavior → killed at the timeout, **not** promoted, because the budget is spent exactly when the slice ends; a background behavior with `timeout` omitted → a job with **no deadline**; `start_in_background` → the whole budget as the deadline, launched immediately (id back at once, and no foreground time to report). `timeout` is a total budget and not a hold on the turn, which is why `timeout: 99999` with `start_in_background` is accepted outright. Errors/timeouts/aborts are prefixed with a `[...]` note. With **no background access** (a bare `ToolRegistry`, which is what the acceptance drivers build) the default `stop` path needs no hub and must not throw — `npm run check:cwd` depends on that — while an explicit background behavior there answers `Background terminals are not available in this session.` The description and the system prompt both state the other half of that contract: **never background the command inside the shell** (`&`, `nohup`, `disown`, `Start-Process`) — a process the harness did not spawn has no card, no `id` and no notice, so it can neither be joined nor killed by Stop — and **never hand the work to a long-lived process the harness does not own** (an editor addon, a test bridge, a build server): its children sit outside the spawned tree, so Stop cannot reach them and their output is never reported, which is worse than a lost card. `timeout_behavior` is the only tracked way to outlive the call. |
| `check_background_terminal` | `pid` | Status of a background terminal (running / finished, exit code, output so far), with the elapsed time in the answer: `Background terminal 3 is running. (command: …, 3.4s elapsed)`, `Background terminal 3 finished with exit code 0 after 3.4s.`, or `Background terminal 3 was killed after 3.1s. (command: …)`. A job with a **budget** names it: `Background terminal 3 is running. (command: …, 12m 30s of its 30m 0s budget elapsed)`. An ending the budget caused is told apart from a kill — `Background terminal 3 was killed after 30m 0s — its 30m 0s budget ran out. (command: …)` — because "killed" alone would blame the user for an ending the harness chose (`killReason: 'timeout'`). A kill that could not be confirmed adds `, but the process tree did not report an exit`. |
| `kill_background` | `pid` | Kills a background terminal's process tree, answering `Killed background terminal 3 after 3.4s (command: …).` — or `Killed background terminal 3 after 3.4s, but the process tree did not report an exit (command: …).` when no exit was observed, because "killed" alone would claim a clean end the OS never reported. Tool-initiated kills suppress the injected completion notice. |
| `join_background` | `pid` | Blocks until the background terminal finishes and returns its final exit code + output, naming the duration (`Background terminal 3 finished with exit code 0 after 3.4s.`). Honours Stop. **Gated by the same limit**: a job that still has more of its budget left than a turn may wait is refused outright, in a **plain result** (not an `Error:` — nothing was malformed, and an `Error:` would invite a retry with the same id): `Background terminal 3 has 27m 30s of its 30m 0s budget left, which is longer than the 300 s a turn may wait, so this join was refused and nothing changed. End your turn instead: the completion notice for id 3 will reach you when it finishes (check_background_terminal(3) reports it sooner). If you want to end the command rather than wait for it, call kill_background(3).` A job with **no deadline** is refused for the same reason: `Background terminal 3 has no deadline, so it can run longer than the 300 s a turn may wait, and this join was refused — nothing changed. End your turn instead: the completion notice for id 3 will reach you when it finishes (check_background_terminal(3) reports it sooner). If you want to end the command rather than wait for it, call kill_background(3).` A finished job is never gated (there is no wait to bound, and a refusal would tell the model to expect a notice for a job that already ended); a job with ≤ the limit left joins exactly as before. |
| `read_image` | `path` | Not a registry tool — handled by the Agent. Reads the image and queues it for injection as a `user`-role image block; **how** depends on the card's `vision.transport` (`tryReadImage`, `src/agent/agent.ts:996-1005`): a `deepseek` card **uploads** it to the Files API and injects `{ type: 'file', file_id }`, answering `Loaded image <path> -> file-api-… (…, N KiB)`; an `openai` card uploads nothing — the bytes ride along inline as a `data:` URL in an `image_url` part and the confirmation reads `Loaded image <path> inline (N KiB)`. Either way the tool message carries only the short confirmation, never the bytes. Only valid on the vision model; unsupported format/too large (>64 MiB) return a friendly error. The call is **timed like any other**, so a slow read is marked by the generic prefix. |
| `spawn_agents` | `agents`, `mode` | Orchestrated by the provider. Spawns parallel sub-agent branches (`write` REQUIRED, `model?`), `mode: 'sync'` waits at most `spinney.commandMaxForegroundDuration` and returns summaries + each agent's `stats` + `transcript` path. A batch still running at the limit **escapes** — it must not hold the turn — and the result becomes `{"spawned":N,"async":true,"escaped":true,"waitedMs":300000,"ids":[…],"done":[…],"running":[…],"note":"The batch is still running after 300 s; it is now delivered as a batch notice. End your turn: the notice carries every summary when the last one finishes.","transcriptDir":…}`, with every summary arriving later as that one batch notice. `'async'` returns `{ spawned, async:true, ids, transcriptDir }` and delivers the same notice when the batch settles (unchanged). The batch is delivered **exactly once** — the tool result on the normal path, the notice on the escape path — which is why the escape branch must not mark the cards delivered (`node.delivered`), or the notice would render as an already-delivered batch and the summaries would never reach the model. Only on agents whose `canSpawn` is true (`depth < 2 && write`) — a read-only sub-agent never sees it. Two caps beyond the depth limit: a **level-1** batch is bounded by `spinney.maxConcurrentSubagents` (default **15**, `SubAgentPool`, the surplus queues) and each parent may start at most `spinney.maxLevel2Subagents` (default **2**) depth-2 children (`runtime.ts:3301-3309`), past which the spawn returns `Error: this sub-agent may start at most N sub-sub-agents (M already started).` |
| `spawn_readonly_agents` | `agents`, `mode` | Read-only fan-out variant: the agent specs have **no `write` field**, so a child can never be writable. Exposed only when `canSpawnReadOnly` (`depth < 2 && !write`), i.e. to a read-only depth-1 sub-agent. Same result shape as `spawn_agents`. |
| `send_agent_message` | `id`, `message`, `write?`, `model?`, `mode` | Orchestrated by the provider. Resumes a finished sub-agent (`id` from a prior `spawn_agents`) with a follow-up. `sync` waits at most the same limit (`spinney.commandMaxForegroundDuration`) and otherwise escapes through the same batch-notice path (`{"resumed":true,"async":true,"escaped":true,"waitedMs":…,"note":…}`, one delivery either way), `async` returns `{ resumed, id, async:true }` and delivers the result as a notice. `model` is resolved to a card (id / display name / wire name; unknown ⇒ `Error: unknown model "…".`). Only on agents whose `canSpawn` is true (`depth < 2 && write`). The `write?` override is honoured **only for the main agent**; a sub-agent caller goes through `handleSubAgentSendMessage`, which requires the target to be its own direct child and caps `write` at `caller.write && target.write` (no promotion). |
| `send_readonly_agent_message` | `id`, `message`, `model?`, `mode` | Read-only resume variant: **no `write` override exists** (and a smuggled key is pinned to `false`). Exposed only when `canSpawnReadOnly` (`depth < 2 && !write`), i.e. to a read-only depth-1 sub-agent. Same result shape as `send_agent_message`. |
| `hop_session` | `prompt`, `title?`, `returnNodeId?` | Orchestrated by the provider. Hands a self-contained task to a **fresh session** and gets its answer back: the hop is queued (the current turn ends), the new session runs `prompt` as its first message, and when that turn finishes the harness switches back and delivers the new session's final answer as an injected user message beginning `[session hop receipt] The task you dispatched to the new session "…" (…) has finished (status: …).` followed by its final reply (`src/chat/ChatViewProvider.ts:1861-1863`), as a **new branch** off `returnNodeId` when given. Main agent only (`setCanHop(true)`), one hop at a time, refused while a background terminal runs. See "Hop and hop back" in `docs/agents/control-plane.md`. |
| `list_nodes` | — | Orchestrated by the provider. Renders the active session's chat tree — one indented line per node, `- <id>  [<kind>[, delivered][, status][, checked out]] parent=<id>  <title>` (the ` parent=<id>` part is omitted for the root) — so the agent can name a node (e.g. `hop_session`'s `returnNodeId`). The kind mark is `turn` / `agent` / `bg` and the bracket also carries `delivered` for a sidecar whose notice already reached its reader, so `kind:'bg'` job cards **do** appear here (a sub-agent's line shows its `agentStatus`). Main agent only (same `canHop` gate). |
| `rename_session` | `title`, `sessionId?` | Orchestrated by the provider. Renames a **session** (not a node) and **locks** the title, so the automatic namer never overwrites it. `sessionId` defaults to the active session. Main agent only (same `canHop` gate). Returns the new title. |
> `read_image` is **not** resolved by `ToolRegistry.execute` — it is intercepted in `Agent.executeToolCall` because a tool message cannot carry an image block, so the image must be delivered as an injected user message. Likewise `spawn_agents` / `spawn_readonly_agents` / `send_agent_message` / `send_readonly_agent_message` / `hop_session` / `list_nodes` / `rename_session` are intercepted and delegated to the provider (`setSpawnHandler` / `setSendMessageHandler` / `setHopHandler` / `setListNodeHandler` / `setRenameSessionHandler`); a read-only depth-1 sub-agent gets only the `*_readonly_*` pair, a depth-2 sub-agent gets none of them, and an intercepted call when the matching `canSpawn*` / `canHop` flag is false returns an explicit error. **Every** tool is advertised with its full schema: `Agent.getTools` sends `ToolRegistry.definitions` plus the intercepted tools the agent's flags allow, so the model always sees the complete surface — there is no folded/gradual disclosure and no interface-fetch tool (`list_advanced_tool` was removed).

## Timeout, budgets and the `exec` diagnostics

One setting bounds a turn — `spinney.commandMaxForegroundDuration` (seconds, default 300 = 5
minutes) — and what it bounds is the **foreground slice**, which is `min(timeout, limit)` for every
behavior except `start_in_background` (zero: that one never waits). `timeout` itself is the
command's **total budget** (foreground + background) with **no ceiling**, so the matrix is the whole
model:

| `timeout` | no behavior / `stop` | `move_to_background` | `start_in_background` |
| --- | --- | --- | --- |
| omitted | killed at the limit | a job with **no deadline** | a job with **no deadline** |
| ≤ limit | killed at the timeout | killed at the timeout, **not** promoted | the whole budget as the job's deadline |
| > limit | **refused before the spawn** | promoted at the **limit**; the hub gets `timeout − limit` | the whole budget as the job's deadline |

Two cells carry the reasoning. `timeout ≤ limit` with a background behavior is **not** promoted
because the budget is spent exactly when the slice ends, so promoting it would be "kill it
immediately" in disguise; and a promotion hands over the **remainder** (`timeout − limit`) rather
than the budget a second time, because the hub measures the job's deadline from the registration it
performs at that moment — "1 minute in the foreground and 30 minutes in the background" was really
30 minutes when the whole budget travelled twice.

The refusal (`timeoutTooLongError`, `src/tools/execCommand.ts`) is thrown **before the spawn** —
no process, no job, nothing was started — with the registry's `Error: ` prefix:

```
Error: timeout 1800 s is longer than the 300 s a turn may hold (spinney.commandMaxForegroundDuration). A command that may run that long must not hold the turn: pass timeout_behavior "move_to_background" (300 s in the foreground, the rest of its 1800 s budget in the background) or "start_in_background" (the whole 1800 s in the background), or pass a timeout of 300 s or less. Nothing was started.
```

When a command *is* promoted, the result is this block — the model's contract, verbatim
(`promotionMessage` in `src/tools/execCommand.ts`):

```
[command moved to background: id 7]
The command was still running after 300000 ms (5m 0s) in <cwd>, so it was moved to the background with the rest of its 1500000 ms budget; it will be killed when that budget runs out. Nothing was killed by the move and it keeps running.
Command: <command>
Working directory: <cwd>
check_background_terminal(7) looks at it, kill_background(7) stops it. Do not join it unless less than 300 s of its budget is left: end your turn and the completion notice for id 7 will reach you.
Output so far:
<output>
```

`<id>` is the background terminal's session-local id, `5m 0s` is `formatDuration` of the foreground
time (i.e. ~the limit), the quoted `1500000 ms` is the budget the **hub** is handed — the remainder,
not the call's whole budget — and the `Output so far:` line appears only when the command produced
something. The join sentence states the gate `join_background` enforces. A job with **no deadline**
(a background behavior that omitted `timeout`) says so in the same sentence instead: `… so it was
moved to the background with no deadline instead of a budget.`

`start_in_background` returns before any foreground time has passed, so its result is:

```
[command started in background: id 7]
Command: <command>
Working directory: <cwd>
check_background_terminal(7) looks at it and kill_background(7) stops it. Do not join it unless less than 300 s of its budget is left (a job with no deadline cannot be joined at all): end your turn and the completion notice for id 7 will reach you.
```

Either way the job is registered **under the node whose turn spawned it** (`BackgroundHub.register`
with the job's budget), not under whoever happens to be looking, so it renders beside that node's
card and its completion notice returns to that branch.

The tool `description` was rewritten for this model — it is the only copy a sub-agent ever sees —
and still carries the three substrings a gate asserts:
`Never put the command in the background yourself`,
`instead of prefixing the command with "cd <dir> && "` and `or an absolute path`. It now also names
`spinney.commandMaxForegroundDuration` / "5 minutes" and says a longer timeout has to ask for a
background mode, while the deleted `spinney.commandTimeout` / `spinney.commandTimeoutMax` are gone
from it — `npm run check:timeout` asserts both halves.

**Diagnostics.** One `[perf]` line per event, English, on the diagnostics log (see
`docs/agents/invariants/streaming-perf.md`). `cmd=` is `redactCommand` from `src/redact.ts`
(whitespace collapsed, secret-looking values masked, clipped to 120 chars with a `…(+N chars)` tail),
and `pid=none` means "no pid yet" (a spawn failure, or a shell not created yet):

- `exec start pid=<pid|none> timeout=<foregroundSec>s budget=<budgetSec>s|none behavior=<stop|move_to_background|start_in_background> cwd=<cwd> cmd=<redacted>`
  — the call as it was executed, *after* the default and the slice were resolved: `timeout=` is the
  foreground slice (how long this call may hold the turn), `budget=` is the call's whole budget, and
  `budget=none` only when a background behavior omitted `timeout` — a job with no deadline.
- `exec still-running pid=<pid|none> ms=<elapsed> out=<chars> cmd=<redacted>` — a 30 s unref'd
  heartbeat while a foreground command holds the turn: a shell waiting for input, or a network call
  with no deadline, used to write *nothing*, so a hung command was invisible in the log.
- `exec end pid=<pid|none> outcome=<exit|timeout|aborted|start-fail|truncated|promoted> code=<code|none> ms=<elapsed>`
  — one line per foreground call, whatever ended it; `promoted` means it was handed to the background
  hub (the command is still running — neither `exit` nor `timeout` is true), and `truncated`
  outranks `exit`, so a nonzero code is never read without the `OUTPUT_CAP` flood that caused it.
- `exec kill pid=<pid|none> outcome=<exited|no-exit|no-pid|unknown> ms=<elapsed>` — written once a
  kill issued by this call has actually landed; `unknown` is a kill that rejected, and saying so is
  better than claiming one of the three real outcomes.

Three more lines describe the *background* half, and they are the budget's trail:

- `bg register id=<id> pid=<pid|none> budget=<n>s|none` — a command became a background job, under
  the budget the hub registered it with (`none` = no deadline).
- `bg expire id=<id> pid=<pid|none> budget=<n>s|none ms=<elapsed>` — the harness killed the job at
  its own deadline. A clean budget kill is recorded **here** and nowhere else, which is exactly why
  the line exists: the `bg kill` line below is written only when something went wrong.
- `bg kill id=<id> pid=<pid|none> reason=<user|stop|timeout|rollover|none> outcome=<exited|no-exit|no-pid|unknown> ms=<elapsed>`
  — written **only when the confirmation failed**, so the log carries an entry for a kill that could
  not be confirmed (`reason` says who asked for it: the tool/card/Stop all read as `stop`, and
  `timeout` is the budget).

**What a kill reports.** `CommandHandle.kill()` is **async** and resolves
`'exited' | 'no-exit' | 'no-pid'` — the old shape returned as soon as the signal had been *sent* (or
`taskkill` had run, which only says taskkill ran), so Stop, the terminal card and the tool result all
claimed a clean end while the tree could still be alive. On Windows it runs
`taskkill /PID … /T /F` via `execFile` and then waits for the child's **`exit`** event — never
`close`, which also waits for the stdio pipes to drain and therefore never arrives when a leftover
grandchild holds them — for up to **800 ms**; on POSIX the child leads its own process group, so the
group is signalled: `SIGTERM` → **300 ms** → `SIGKILL` → **500 ms**. `'no-pid'` is a spawn that never
produced a pid, `'no-exit'` a deadline that passed without one, and it never rejects. The
confirmation is fired detached so `BackgroundRegistry.kill` stays synchronous (Stop and the card
must be instant); `kill_background` / `check_background_terminal` are the callers that await it, and
they say `… but the process tree did not report an exit …` when it failed. A kill the **budget**
caused is named as such everywhere (`killReason: 'timeout'`, `isBudgetKill`): `check_background_terminal`
and the completion notice both read `was killed after 30m 0s — its 30m 0s budget ran out`, because a
job that was promoted so the turn could end must not read as work the user stopped.

**Git Bash rewrites arguments — and the fix is in `src/tools/shell.ts`.** The Git Bash environment
carries `MSYS_NO_PATHCONV: '1'` on Windows, so a **native** tool receives the argument as written:
`taskkill /PID 67188 /T /F` used to reach taskkill as `invalid argument/option` on
`C:/Program Files/Git/PID` — MSYS had rewritten `/PID` into a Windows path — and three stuck
processes were never killed. The `//F` / `//IM` double-slash workaround is **obsolete**.
`npm run check:shell` pins the argv a native child actually receives (`MSYS_NO_PATHCONV` is
Windows-only; a POSIX bash has no such conversion, so it must not leak there).

## Timing in tool results

Every call is measured by the **Agent** (`Agent.executeToolCall`), for the main agent and for
sub-agents alike — `read_image` included, although it is intercepted rather than resolved by
`ToolRegistry`. The elapsed time goes into the model-facing result and into the `kind:'tool'`
display item (`startedAt` / `ms`), which is what the webview's chip ticks from and freezes on. One
format is used everywhere, from `formatDuration` (`src/duration.ts`, mirrored in `media/main.js`
because no host string arrives per tick): under 1000 ms → `420ms`, under 10 s → `3.4s`, under 60 s
→ `42s`, under 60 min → `3m 12s`, otherwise `1h 3m`. The token is locale-free and deliberately
**not** localized — it is read by the model, not by the user.

- **`exec_command` always leads with its own timing line**, first in the result, one of:
  `[exit 0 in 3.4s · cwd D:\repo]`, `[command exited with code 3 in 3.4s · cwd …]`,
  `[command timed out after 300000 ms (ran 300.2s) · cwd …]`,
  `[command output exceeded 16777216 bytes; truncated after 3.4s · cwd …]`,
  `[command was interrupted after 3.4s · cwd …]`, or
  `[command failed to start after 0.01s: <message> (shell <shell.exe>) · cwd …]` — the cwd half is
  the directory the command actually ran in (the harness root unless a `cwd` argument moved it),
  and it rides this line for the same reason the duration does: every command starts in the root,
  and saying so on every result is what stops the model from prefixing `cd <root> && …` defensively.
  It is first
  **on purpose**: an oversized result is spilled by `limitInline`, whose preview keeps only the
  first 8 lines, so a timing line anywhere lower is the first thing lost — exactly for the long
  command whose duration matters most. A **promoted** command is the one exception to "leads with its
  timing line": its first line is the notice itself, `[command moved to background: id 7]`, and the
  duration rides inside it (`The command was still running after 300000 ms (5m 0s) in …`), next to
  the budget the hub was handed; `start_in_background` is unchanged, because it returns before any
  foreground time has passed.
- **Every other text result gets a generic prefix — but only from 1 second up.** A call that took at
  least 1000 ms starts with `[<tool-name> 3.4s]` (e.g. `[search_files 3.4s]`); a fast call stays
  unmarked, so the common case costs no context. `exec_command` never gets this prefix: its own
  status line already carries the time.
- **The `spawn_*` / `send_*` results are JSON, so they carry `durationMs` inside it.** A text prefix
  would break a caller that parses the result, so `spawn_agents`, `spawn_readonly_agents`,
  `send_agent_message` and `send_readonly_agent_message` report the duration as a JSON field: per
  sub-agent, plus one `durationMs` for the whole sync batch.
- **A call that is still streaming its arguments shows no chip at all** — the clock starts with the
  call, not with the drafted arguments.

Deeper per-tool notes live in `docs/agents/**` — the tool group in `AGENTS.md`'s
index maps each area (sub-agents, background terminals, transcripts, vision) to
its document.

The registry tools live under `src/tools/` with their execution code — one file per tool
(`readFile.ts`, `writeFile.ts`, `replaceInFile.ts`, `listDir.ts`, `searchFiles.ts`,
`searchTranscripts.ts`, `execCommand.ts`) except the three background tools
(`check_background_terminal` / `kill_background` / `join_background`), which share
`src/tools/backgroundTools.ts`; `background.ts` holds the process plumbing they and
`exec_command` use. The intercepted ones (`read_image`, `spawn_*`, `send_*`, `hop_session`,
`list_nodes`, `rename_session`) live in `src/agent/tools/` with a `requires`
capability tag and are executed by `Agent.executeToolCall`.

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

**The markers must stand outside the JSON** — and that is the whole contract:
`parseArgs` is **JSON-first** (a successful `JSON.parse` wins, the frame branch
then never runs), and nothing in the code reads the `frame` flag (it only
*declares* intent). So the one shape agents keep producing —

```
write_file({"path": "a.ts", "frame": true, "content": "<<<RAW:content>>>\n...\n<<<END_RAW:content>>>"})
```

— is valid JSON, the markers frame nothing, and they land in the file verbatim.
Measured on this machine's transcripts: 28 such calls out of 962 `frame: true`
calls (~2%), ≥6 files polluted across 3 workspaces, one `.mjs` then dying with
`SyntaxError: Unexpected token '<<'`. Failures were **silent** — the tool result
still read `Wrote … (N lines)`.

Both tools therefore reject that shape up front via `embeddedFrameError` (in
`src/tools/index.ts`), with an error that names the cause and shows the correct
form. The check is anchored on **both** boundaries: markers in the middle of a
payload are legitimate file text (a fixture, or this very document), and only a
payload *entirely* wrapped in `<<<RAW:key>>>…<<<END_RAW:key>>>` is the mistake.
It errors rather than silently stripping — a rewrite would be unrecoverable
(there is no way to tell the two apart at that point) and would mask the mistake
instead of teaching the shape.

The wording that carried the contract lives in the tool `description`s (the prompt
carries no tool list, so a description is the only plugin-side place a model can
learn the shape); see `docs/agents/invariants/agent-authoring.md`.

Required arguments are validated **before** the tool body runs (`ToolRegistry.execute`
against the schema it advertises), so an absent value never surfaces as the
tool's own complaint about the symptom: `exec_command` called without `command`
answers `Error: exec_command is missing required argument "command". It sent: ….
Parameters: command, cwd, timeout, timeout_behavior.` — plus a `Did you mean …?`
hint when a sent key is a near-miss of the required one. One name is additionally
folded in as an alias: `exec_command` accepts `cmd` for `command` (only when
`command` is absent — a correct call is never touched). Aliases + validation live
in `ARG_ALIASES` / `applyArgAliases` / `missingArgumentError` in `src/tools/index.ts`.

