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

> **Tool choice is stated twice on purpose.** Reach for the tool that names the work —
> reading, listing, searching, session history each have one — and keep the shell for what no
> tool covers (builds, tests, version control, running a program); a read-only command is not a
> free way to look around. The rule is written in two places, deliberately: the system prompt's
> `## Calling conventions` bullet, and the tool descriptions — `exec_command` states the shell
> half, while `read_file` / `list_dir` / `search_files` each state what their own implementation
> does that the shell equivalent cannot (a line range and a line count; the heavy-directory
> exclusions and a bounded entry cap; heavy and binary skips with *excluded* told apart from
> *absent*, plus one hard time budget that a shell grep does not have). `exec_command`'s
> description states the ban outright — no `grep` / `rg` / `findstr` / `Select-String` in the
> shell, only a genuinely large sweep that needs a long-running job. That is the same deliberate duplication recorded for the no-self-background rule in
> `docs/agents/invariants/background-terminals.md`:142-149.

| Tool | Args | Behavior |
| --- | --- | --- |
| `read_file` | `path`, `startLine?`, `endLine?` | Returns `File: <path> (N lines, <EOL>)` header + LF-normalized content (line-numbered if a range is given). Always LF content, but reports on-disk EOL. `N` follows the `wc -l` convention (a trailing newline does **not** add a line); `read_file(path, 1, 1)` is the cheap way to get just the count. A requested range over **256 KiB** comes back as an explicit `[TRUNCATED: …]` head/tail excerpt, never silently: the header gives the range's byte size, what was kept and omitted, and either "read a smaller line range" or — when one line is wider than the head, which a line range cannot fix — "use `search_files` to find a short slice"; it also says the text must not be used as `replace_in_file` `oldText`. |
| `write_file` | `path`, `content` | Overwrites; creates parent dirs. Preserves the existing file's line-ending style (converts content to it). New files written as supplied. `content` is a plain JSON string (newlines escaped as `\n`); a value that is the removed verbatim frame answers the sentinel below and writes nothing. |
| `append_file` | `path`, `content` | Appends `content` to the end of a file, creating the file and its parents when it is absent. An existing file keeps its line-ending style (the content is converted to it, the pair `write_file` uses); a new file is written exactly as supplied. Answers `Appended to <path> (N lines added, M lines total).` — the way to build a **large** file: `write_file` the first part, then append in bounded chunks. The bytes are added exactly as given, so start the content with a newline when the file does not already end with one; `N` / `M` count lines the way `write_file`'s `(N lines, EOL)` does. `content` is a plain JSON string, and the removed verbatim frame hits the same sentinel as in `write_file`. |
| `replace_in_file` | `path`, `oldText`, `newText` | Exact-substring replace. `oldText` must occur **exactly once** (else error). Matches/writes in normalized LF; preserves on-disk EOL. The replacement is inserted **verbatim** (function-form replace), so `String.replace` dollar-patterns in `newText` stay literal. `oldText` / `newText` are plain JSON strings; either one being the removed verbatim frame answers the sentinel below. |
| `list_dir` | `path`, `glob?`, `recursive?` | Sorted entries; directories suffixed with `/`. `glob` filters against the path relative to the listed dir (`*.ts` = top level, `**/*.ts` = any depth); `recursive` walks subdirs (heavy dirs skipped) and prints relative paths. Capped at 2000 entries with an explicit note. |
| `search_transcripts` | `query?`, `sessionId?`, `kind?`, `caseSensitive?`, `maxResults?`, `context?` | Regex search over the harness's own transcript dumps — the **only** way to recall a previous session (history otherwise lives in the Memento, which no tool can grep). Files are `<root>/<sessionId>/<nodeId>.jsonl` (usually **outside** the workspace, in global storage, so `search_files` cannot reach them). Each hit is `file:line: text` with the **absolute** path, so `read_file` with those line numbers pages the full record; `context` (0–10) uses `-` separators. `query` omitted ⇒ index of sessions (id, files, size, last write, kind mix, titles), or of one session's files with `sessionId`. `kind` = `session` (main-agent turns) / `subagent`. Default 50 hits / hard cap 300; files >8 MB skipped; capped runs say so. It carries the **same one hard budget** as `search_files` — `spinney.searchTimeoutSeconds`, read live — checked between files by the scan itself; a budget stop answers the same shape of sentence as an `Error:` line with **no hits and no count** (`Error: search_transcripts timed out after N s …`), so a page that stopped mid-history is never read as the end of the history. |
| `search_files` | `pattern`, `path?`, `glob?`, `caseSensitive?`, `maxResults?`, `context?` | Regex search returning `file:line: text` (paths **workspace-relative**, or **absolute** when no folder is open — a default search of the empty scratch root is not a way to find your files). `path` may be a **file or a directory**. `maxResults` default 200 / hard cap 300; `context` (0–10) adds surrounding lines with `-` separators (`src/a.ts-11- text`). Hit lines are trimmed + clipped to 160 chars. **The search runs in a ripgrep child process**, probed in this order: the **vendored** `media/vendor/ripgrep/<platform>-<arch>/rg` (shipped with the extension, so the path does not depend on the host — `PROVENANCE.md` there), VS Code's bundled binary under `env.appRoot` (the universal `ripgrep-universal/bin/<platform>-<arch>/` layout, the older single-binary one), then `rg` on `PATH`; a candidate that fails to spawn is forgotten **alone** and the next one is tried, so one broken binary no longer disables ripgrep for the session. A whole-tree scan therefore never occupies the extension host's JS thread; when no candidate can run, or rg refuses the pattern (it has no lookaround/backreferences), the same search falls back to the original in-process walk, and the tool says which one ran (`via=rg|walk` on the `[perf] search-files` line). **One hard time budget for the whole call** — `spinney.searchTimeoutSeconds` (default 10, min 1, max 600, read live) — covers the slot queued behind the work budget, the rg child *and* the fallback walk, so a call can no longer spend 20 s on each. Running out of it is **not** a partial page: the result is exactly `Error: search_files timed out after N s (spinney.searchTimeoutSeconds) while searching <root>. No results are returned. Narrow the path, tighten the pattern, add a glob, or lower context; if even a simple query times out, ask the user to raise spinney.searchTimeoutSeconds.` — no hits, no count. The child is still killed as soon as the match cap is reached (that is what makes "does this exist?" cheap). **Scope is workspace-invariant**: `search.exclude`, `files.exclude` and `.gitignore` are honored when the root is **inside** the open workspace folder, and a narrowed result says so with `…[scope: search.exclude/files.exclude/.gitignore honored]`, so *excluded* is never mistaken for *absent*; a root **outside** it (global storage, another repository, a parent of the folder) is searched **without** those two settings, because they describe the workspace, and says `…[scope: the root is outside the workspace — …not applied]` instead. `.git` is always excluded, and the `SKIP_DIRS` set (`node_modules`, `.git`, `out`, `dist`, `build`, `.spinney`) is passed to rg as `--glob=!**/<dir>/**` so both paths prune the same directories. **Binary files are skipped** in both paths (a font or a generated table yields no mojibake hit), and a file over **8 MB** is skipped. A capped/short-circuited search appends an explicit `…[search stopped early: …]` note (match cap / file ceiling / oversized files) — never silently truncated; the deadline has no note because it has no results. |

> **Oversized results spill to a file.** Every tool whose output is unbounded
> (`search_files`, `search_transcripts`, `list_dir`, `exec_command`,
> `check_command`, `wait_for_command`) runs its result through
> `limitInline()`: above
> `spinney.maxInlineToolOutput`
> (default 32768 bytes, `0` = always inline) the full text is written to
> `<agentRoot>/.spinney/tool-output/<tool>-<id>.txt` (under the workspace
> folder, or `<globalStorage>/no-workspace/.spinney/tool-output/` with no
> folder open) and only the absolute path,
> byte/line count and a preview are returned — so a `context`-heavy search
> on a big file or a chatty command cannot flood the context. The preview is the
> first up-to-8 lines **cut to 2048 characters**: a line count alone is not a
> bound, because a minified JSON or a bundled asset is one line of megabytes.
> That exact shape broke a node once — a 7.7 MB single-line `grep` hit was inlined
> whole as the "8-line preview", the next request asked for 2.78 M tokens against a
> 1,048,576-token window, and every retry was a 400 because the tool message lives
> in `messages` for good. When the preview had to be clipped the pointer says so,
> names the first line's length, and tells the model that a smaller line range will
> not help (search the spilled file instead). The spilled file is a
> normal file:
> `read_file` can page it, and `search_files` can grep it **by its exact path**
> (`.spinney` is in `SKIP_DIRS`, so repo-wide walks skip it). A write failure
> falls back to inlining, so a result is never lost.
>
> **One result, one ceiling, whatever the tool.** `Agent` runs every text result
> through `capToolResult` before it becomes a `tool` message: above **512 KiB** the
> text is replaced by a head/tail excerpt with the byte counts and a marker. The
> tools above cap themselves, and `read_file` has its own 256 KiB ceiling, so this
> is a backstop for a tool that forgets — the failure mode it prevents is a node
> that can never send again, not a single expensive turn. `read_image` is
> unaffected: its tool message is a short confirmation, never the bytes.
| `exec_command` | `command` (alias `cmd`), `cwd?`, `run_type?` | Runs through the detected shell (`getShell()`), returns combined stdout+stderr trimmed, and **always leads with a timing line that also names the working directory** (`[exit 0 in 3.4s · cwd D:\repo]`, `[command exited with code 3 in 3.4s · cwd …]`, … — see "Timing in tool results"). **It is not a search tool.** No `grep` / `rg` / `findstr` / `Select-String` / `find`: `search_files` and `search_transcripts` answer a search with exclusions, a scope echo, binary skipping and one hard time budget, while a shell grep has no budget at all — one wide pattern can hold the turn and report nothing. The one case that belongs here is a genuinely large sweep (a whole drive, several repositories) that needs a long-running job: that is a background job, not a foreground grep. The model-facing point of the `cwd` half is behavioural: every command already starts in the harness root, and a model that sees the directory on every result stops prefixing the same `cd <root> && …` to every command (in the transcripts of one workspace: 10 333 `exec_command` calls, **1** used the `cwd` argument and ~3 400 carried a redundant `cd` to the root). `cwd` is **relative to the harness root or absolute**; it is resolved through `resolvePath` (so `/d/…` means `D:\…` on Windows, see "Path base") and **checked before the spawn**: a missing path or a file answers `the working directory "x" → <resolved> does not exist / is not a directory. Pass cwd relative to the harness root (…), or omit cwd to run in the root.` — without that check, `spawn` reports the failure as `spawn <shell.exe> ENOENT`, blaming the shell and teaching the model that the `cwd` argument is broken. **`run_type` is the one knob and it says what the call is** — `foreground` (the default: run it in this turn and return the output; a command still running after `spinney.execForegroundSeconds`, default **30** s, is **moved to the background**, never killed and never refused), `background` (a node job from the start: its id back at once, the composer shows Stop until it ends, and its completion notice reaches the agent) or `detached` (a session-wide, fire-and-forget job: locks no node, never notifies). There is **no per-call timeout and no deadline**: a job runs until its process ends or something kills it. A call that still sends `timeout` or `timeout_behavior` is refused **before anything is spawned** with the exact sentence in "Run types and the `exec` diagnostics" below. Errors/aborts are prefixed with a `[...]` note. With **no background access** (a bare `ToolRegistry`, which is what the acceptance drivers build) a foreground call still runs, it is just never promoted (there is nowhere to hand it to) — `npm run check:cwd` depends on that — while `background` / `detached` there answer `Background terminals are not available in this session.` The description and the system prompt both state the other half of that contract: **never background the command inside the shell** (`&`, `nohup`, `disown`, `Start-Process`) — a process the harness did not spawn has no card, no `id` and no notice, so it can neither be waited for nor killed by Stop — and **never hand the work to a long-lived process the harness does not own** (an editor addon, a test bridge, a build server): its children sit outside the spawned tree, so Stop cannot reach them and their output is never reported, which is worse than a lost card. The description also states the two habits the tools exist for: **never sleep to wait** for a command and **never poll** a running one — `wait_for_command` waits, `check_command` is a status read. |
| `check_command` | `pid` | Status of a command started by `exec_command`: running / finished, the exit code, the output so far, with the elapsed time — `Command 3 is running. (command: …, 3.4s elapsed)`, `Command 3 finished with exit code 0 after 3.4s.`, `Command 3 was killed after 3.1s. (command: …)`. A kill that could not be confirmed adds `, but the process tree did not report an exit`. It is a **status read, not a wait**: a running answer appends one line of instruction after the status line (which stays byte-identical) and before the output — `You may continue with other work or end your turn: the completion notice for id 3 will reach you when it finishes. Do not poll it — this is a status read, not a wait; wait_for_command(3) waits for it and returns the moment it ends.` — or, for a **detached** job, `This job never notifies: read it once when you actually need the result, not in a loop. wait_for_command(3) waits for it up to the seconds you give.` The tool description says the same thing up front, because the field failure it prevents is real: an agent answered a promoted job with 46 back-to-back checks. |
| `wait_for_command` | `pid`, `seconds?` | **The wait.** Waits at most `seconds` (default **30**, clamped to **1–300**) and returns the moment the command ends: if it ends inside the wait the answer is its result (`Command 3 finished with exit code 0 after 3.4s.` plus the full output) and the separate completion notice is suppressed (`notifyAgent = false`, exactly as the old `join_background` did). If the wait runs out first the answer is a **normal result, never an `Error:`** — nothing was malformed, the command simply outlived the wait — and it restores the notice: `Command 3 is still running after this 30 s wait (command: …, 42s elapsed); nothing changed and the command keeps running. This is not a failure: the command simply outlived the wait. check_command(3) is a status read, not a wait; wait_for_command(3) may be called again to wait longer; kill_command(3) stops it, and if it is noisier or slower than the work needs, killing it and running a quieter command is the other way out.` It honours **Stop** (`[command wait was interrupted]`, with the notice restored and the command untouched) and it works on a **detached** job too — its timeout text adds `This job is detached, so no completion notice will arrive for it either: its result is read only by asking again`. A command that already ended returns its result at once. |
| `kill_command` | `pid` | Kills the command's process tree, answering `Killed command 3 after 3.4s (command: …).` — or `Killed command 3 after 3.4s, but the process tree did not report an exit (command: …).` when no exit was observed, because "killed" alone would claim a clean end the OS never reported. A tool-initiated kill suppresses the injected completion notice, and a command that already ended answers `Command 3 is not running (exit code …).` instead of killing twice. |
| `web_search` | `query`, `count?` | Registry tool, **keyless and configless**. Runs the built-in backend chain (`src/tools/webBackends.ts`) over one query: machine formats first (`bing-rss`, `hn`, `stackexchange`, `github` JSON/RSS), then the region-relevant HTML engines (`so360`/`baidu`/`sogou` with `data-mdurl`/`data-url` real URLs, `bing` as a fallback), merging and de-duplicating (`normalizeUrl`: no fragment, no tracking parameters, no `www.`, no trailing slash) until `count` (default 8, max 20) or a 25 s budget is spent. Every attempt is classified (`ok`/`empty`/`parse-empty`/`unexpected`/`blocked`/`rate-limited`/`http-error`/`timeout`/`aborted`) and a failure opens a cooldown — `blocked`/`parse-empty` 30 min, `rate-limited` 10 min, `timeout`/`http-error` 2 min ×3 — held **in memory for the extension host** (a reload forgets it). The header names the winner (`… from bing-rss(10) in 717ms`) and an `attempts:` line names every outcome, skipped backends included; a silent engine swap would be undebuggable. All backends in cooldown are tried anyway, so "nothing answered" still arrives as a per-backend diagnosis. The result carries the untrusted-data sentence. Measured on the target network: 6 relevant Chinese results in 717 ms, answered by `bing-rss`. One row (`deepseek`) is a **card-declared opt-in**: it POSTs to the card provider’s `/v1/tools/search` with that provider’s own key (or the `spinney.searchKey.deepseek` override), is billed per request, is spaced to the account’s 5 QPS, and answers `disabled` without a request when the card says `builtin` (`docs/agents/web-search.md` §"The paid row"). |
| `web_fetch` | `url` | Registry tool. Fetches one http(s) URL and returns it as Markdown (HTML), verbatim text, or pretty JSON. Follows redirects by hand (`redirect: 'manual'`, max 5) so **every hop** is re-checked, sends a browser User-Agent, honours the page charset through `decodeBody` (`gbk`/`gb2312`/`gb18030` → `gbk`, `latin1` → `windows-1252`), streams the body and stops at **2 MB**, and gates on content type (no binaries/PDF). `publicUrlProblem` refuses `localhost`/`*.local`/`*.internal` and every private, loopback, link-local, CGNAT and reserved range — the parse half being WHATWG `new URL()`, which normalizes `2130706433`, `0x7f.0.0.1` and `127.0.0.1\@evil.com` to the host the socket would use. **Runs no JavaScript**: a client-rendered page comes back thin and the result says so. HTML → Markdown is hand-written (`src/tools/webHtml.ts`, zero dependencies): script/style/nav/header/footer/iframe/svg dropped, headings/paragraphs/lists/links/emphasis/code/tables kept, and never a space inserted at a tag boundary (CJK). DNS rebinding between the check and the connection is a documented residual risk. When the card’s `searchProvider` is `deepseek` and the local extraction comes back **empty**, `POST <baseUrl>/v1/tools/fetch` is tried — after the same address check, on the final URL — and its Markdown is returned marked `via the provider's fetch API`; a per-URL 403/404 is a sentence, not a cooldown. |
| `read_image` | `path`, `rect?` | Not a registry tool — handled by the Agent. Reads the image and queues it for injection as a `user`-role image block; **how** depends on the card's `vision.transport` (`tryReadImage`, `src/agent/agent.ts`): a `deepseek` card **uploads** it to the Files API and injects `{ type: 'file', file_id }`, answering `Loaded image <path> -> file-api-… (…, N KiB)`; an `openai` card uploads nothing — the bytes ride along inline as a `data:` URL in an `image_url` part and the confirmation reads `Loaded image <path> inline (N KiB)`. Either way the tool message carries only the short confirmation, never the bytes. `rect` is an optional region (`{x, y, w, h}`, in **source pixels**) and the bytes are **transformed before the upload** (`transformImage`, `src/agent/imageTransform.ts`), so the bytes that ever reach the request are the small ones: crop to `rect` — validated by `normalizeRect` against the size `readImageSize` read from the header (PNG `IHDR`, JPEG `SOFn`), clamped to the image, a malformed one answered as an error sentence — then downscale to a longest side of `IMAGE_TARGET_MAX_SIDE` (1024). PNG and JPEG are done **natively**; GIF / WebP / interlaced or 16-bit PNG **pass through unchanged** (and stay covered by the brake below). A transformed result is re-encoded as PNG, one format for every upload; `changed: false` means `bytes` is the input, verbatim. Because the endpoint charges a **flat** cost per image (it resizes to ~800×800 and bills ~384 tokens whatever was uploaded), `rect` costs the same as the whole image and shows that region at full detail — which makes it a **zoom**, not only a saving. The tool result therefore names the **source** dimensions (the transform's `sourceWidth` / `sourceHeight`, not the reduced ones) and tells the model how to zoom — re-read with a `rect` over the region of interest — so a model that wants detail re-reads with a small `rect` instead of asking for a bigger image. **Before the upload, a brake runs.** The runtime supplies the accounting (`setImageAccounting`: the bytes behind every image part the next request would carry) and the ceiling is the card's transport — `MAX_REQUEST_IMAGE_BYTES` (200 MB) for a `deepseek` upload, `INLINE_REQUEST_BODY_BYTES` (48 MiB) for the inline one — less the `IMAGE_BUDGET_RATIO` (0.9) margin, because the next request already carries what is in use and a brake that fired exactly at the wall would arrive one image too late. An image that would cross it is **not attached**: the call answers with an ordinary `Error:` line naming how much is in use and **what to do instead** — delegate the looking to a sub-agent (`spawn_agents`), because a fresh, empty history can carry images this chain can no longer carry and reports back in text. The refusal is a **decision aid, not a failure of the tool**: the image was readable and the call was well-formed, and the chain simply cannot spend the bytes — so the sentence also forbids describing an image that was never seen and retrying that same call, and names the `⧉` rollover (a new window starts without the images too) as the other way forward. It degrades by capability: a depth-2 sub-agent (which cannot spawn) is told to report the failure instead of delegating, and a non-vision card never sees `read_image` at all. Only valid on the vision model; unsupported format/too large (>64 MiB) return a friendly error. The call is **timed like any other**, so a slow read is marked by the generic prefix. |
| `spawn_agents` | `agents`, `mode` | Orchestrated by the provider. Spawns parallel sub-agent branches (`write` REQUIRED, `model?`), `mode: 'sync'` waits at most `spinney.subAgentSyncSeconds` (default 300) and returns summaries + each agent's `stats` + `transcript` path. A batch still running at the limit **escapes** — it must not hold the turn — and the result becomes `{"spawned":N,"async":true,"escaped":true,"waitedMs":300000,"ids":[…],"done":[…],"running":[…],"note":"The batch is still running after 300 s; it is now delivered as a batch notice. End your turn: the notice carries every summary when the last one finishes.","transcriptDir":…}`, with every summary arriving later as that one batch notice. `'async'` returns `{ spawned, async:true, ids, transcriptDir }` and delivers the same notice when the batch settles (unchanged). The batch is delivered **exactly once** — the tool result on the normal path, the notice on the escape path — which is why the escape branch must not mark the cards delivered (`node.delivered`), or the notice would render as an already-delivered batch and the summaries would never reach the model. Only on agents whose `canSpawn` is true (`depth < 2 && write`) — a read-only sub-agent never sees it. Two caps beyond the depth limit: a **level-1** batch is bounded by `spinney.maxConcurrentSubagents` (default **15**, `SubAgentPool`, the surplus queues) and each parent may start at most `spinney.maxLevel2Subagents` (default **2**) depth-2 children (`runtime.ts:3301-3309`), past which the spawn returns `Error: this sub-agent may start at most N sub-sub-agents (M already started).` |
| `spawn_readonly_agents` | `agents`, `mode` | Read-only fan-out variant: the agent specs have **no `write` field**, so a child can never be writable. Exposed only when `canSpawnReadOnly` (`depth < 2 && !write`), i.e. to a read-only depth-1 sub-agent. Same result shape as `spawn_agents`. |
| `send_agent_message` | `id`, `message`, `write?`, `model?`, `mode` | Orchestrated by the provider. Resumes a finished sub-agent (`id` from a prior `spawn_agents`) with a follow-up. `sync` waits at most the same window (`spinney.subAgentSyncSeconds`) and otherwise escapes through the same batch-notice path (`{"resumed":true,"async":true,"escaped":true,"waitedMs":…,"note":…}`, one delivery either way), `async` returns `{ resumed, id, async:true }` and delivers the result as a notice. `model` is resolved to a card (id / display name / wire name; unknown ⇒ `Error: unknown model "…".`). Only on agents whose `canSpawn` is true (`depth < 2 && write`). The `write?` override is honoured **only for the main agent**; a sub-agent caller goes through `handleSubAgentSendMessage`, which requires the target to be its own direct child and caps `write` at `caller.write && target.write` (no promotion). |
| `send_readonly_agent_message` | `id`, `message`, `model?`, `mode` | Read-only resume variant: **no `write` override exists** (and a smuggled key is pinned to `false`). Exposed only when `canSpawnReadOnly` (`depth < 2 && !write`), i.e. to a read-only depth-1 sub-agent. Same result shape as `send_agent_message`. |
| `hop_session` | `prompt`, `title?`, `mode?`, `returnNodeId?` | Orchestrated by the provider. Hands a self-contained task to a **fresh session** and gets its answer back **when that session decides to return**: the hop is queued (the current turn ends), the new session runs `prompt` as its first message — prefixed with a model-facing preamble that says nothing returns automatically and that it must call its own `finish_hop` — and the harness delivers the report only once that session has **called `finish_hop`** *and* is **idle** (no running turn, no running node background job, no sub-agent batch, no queued notice): an injected user message beginning `[session hop receipt] The child session "…" (…) called finish_hop and handed back its report.` followed by its final reply (`src/chat/ChatViewProvider.ts`, `maybeDeliverHopReturn` / `deliverHopReturn`). Nothing returns before that call — a turn end, an interrupt and a Stop leave the hop armed and re-checked once a second — so the user can steer the hopped-to session; after the call, a later turn end (a steer) still refreshes the answer. The answer lands as a **new branch off the landing node** — the child's `source_session_node_id`, else `returnNodeId`, else the node the hop was dispatched from — and `mode: "fire_and_forget"` skips the return trip entirely (no receipt, nothing written into the origin's tree, no `finish_hop` in the child; `returnNodeId` is refused there). The receipt is not a user send: it does not focus the origin's tab, move its checkout, clear its composer, or ask the frozen-setup question, and it waits for a busy landing node instead of being dropped. Main agent only, and only while `spinney.hopSession.enabled` is on (`hopEnabled`, apart from `canHop`); one hop per origin session, refused while a background terminal runs. See "Hop and hop back" in `docs/agents/control-plane.md`. |
| `finish_hop` | `source_session_node_id?` | Orchestrated by the provider. **The hopped-to session decides when it returns**: this is the child's own hand-back, and it is advertised **only** to the main agent of a session a `return_when_finished` hop started — never to a `fire_and_forget` child, never to a sub-agent. It returns `Handed back. …` and marks the hop (`Hop.finishRequested`); the delivery itself is the existing idle-wait path, so the child's final reply of that turn is what comes back. `source_session_node_id` must name an existing, non-sidecar node of the **origin** session and picks the landing node (else the hop's `returnNodeId`, else the dispatch node); a node that does not exist, or a sidecar card, is answered with an `Error:` naming the problem. A second call answers `Error: this session has no armed hop (it was already handed back, or none was started).` The capability comes from the session's own record (`AgentSession.hopOrigin`, `canFinishHop` / `requires: 'finishHop'`), not from the live hop, so the tool an epoch froze never disappears from a handed-back chain. |
| `list_nodes` | — | Orchestrated by the provider. Renders the active session's chat tree — one indented line per node, `- <id>  [<kind>[, delivered][, status][, checked out]] parent=<id>  <title>` (the ` parent=<id>` part is omitted for the root) — so the agent can name a node (e.g. `hop_session`'s `returnNodeId` or `finish_hop`'s `source_session_node_id`). The kind mark is `turn` / `agent` / `bg` and the bracket also carries `delivered` for a sidecar whose notice already reached its reader, so `kind:'bg'` job cards **do** appear here (a sub-agent's line shows its `agentStatus`). Main agent only (same `canHop` gate). |
| `rename_session` | `title`, `sessionId?` | Orchestrated by the provider. Renames a **session** (not a node) and **locks** the title, so the automatic namer never overwrites it. `sessionId` defaults to the **caller's own** session (the agent's, not the focused tab). Main agent only (same `canHop` gate). Returns the new title. |
> `read_image` is **not** resolved by `ToolRegistry.execute` — it is intercepted in `Agent.executeToolCall` because a tool message cannot carry an image block, so the image must be delivered as an injected user message. Likewise `spawn_agents` / `spawn_readonly_agents` / `send_agent_message` / `send_readonly_agent_message` / `hop_session` / `list_nodes` / `rename_session` are intercepted and delegated to the provider (`setSpawnHandler` / `setSendMessageHandler` / `setHopHandler` / `setFinishHopHandler` / `setListNodeHandler` / `setRenameSessionHandler`); a read-only depth-1 sub-agent gets only the `*_readonly_*` pair, a depth-2 sub-agent gets none of them, and an intercepted call when the matching `canSpawn*` / `canHop` / `hopEnabled` / `canFinishHop` flag is false returns an explicit error (`hop_session` has its own flag: `spinney.hopSession.enabled` removes it while `list_nodes` / `rename_session` stay, and `finish_hop` belongs to the session a hop started and to nobody else). **Every** tool is advertised with its full schema: `Agent.getTools` sends `ToolRegistry.definitions` plus the intercepted tools the agent's flags allow, so the model always sees the complete surface — there is no folded/gradual disclosure and no interface-fetch tool (`list_advanced_tool` was removed). `read_image`'s plumbing is unchanged by this: it is still one intercepted tool in one file (`src/agent/tools/readImage.ts`, `requires: 'vision'`), and the brake, the `rect` argument, the transform call and the upload all happen inside that same interception. What is new lives *beside* the tool, not in it — the frozen transform half in `src/agent/imageTransform.ts`, and the pure codec modules it drives (`pngCodec.ts`, `imageResample.ts`, `jpegDecode.ts`, split as `jpegEntropy.ts` / `jpegReconstruct.ts` behind a frozen seam) — see the note on the intercepted tools' file layout below.

## Run types and the `exec` diagnostics

`exec_command` has **one knob**, `run_type`, and it says what the call *is* — never how
long it may run. There is no per-call timeout, no budget, and **no job has a deadline**:
a command lives until its process ends or something kills it.

| `run_type` | behaviour | registered as | locks its node | notifies |
| --- | --- | --- | --- | --- |
| `foreground` (**the default**) | runs in this turn and returns its output; a command still running after `spinney.execForegroundSeconds` is **moved to the background** — never killed, never refused | a node job, at the promotion | **yes**, from the promotion on | yes |
| `background` | a node job from the start, its id back at once | a node job | **yes** | yes |
| `detached` | **fire-and-forget**: session-wide | a **detached** job | **no** | **no** |

`spinney.execForegroundSeconds` (seconds, default **30**, minimum 10, maximum
999999999999; `DEFAULT_EXEC_FOREGROUND_SEC` in `src/tools/execCommand.ts`) is the
**foreground slice**, read live per call. It is not a cap and not a deadline: it is the
point at which a running command is handed to the hub, so a build that takes a minute
needs no argument, no timeout and no second thought — it simply becomes a job with a
card, an id and a completion notice, and nothing is lost. The shipped default is
deliberately short for the same reason: the promotion is cheap and it keeps the turn
interactive.

The one refusal that is left is the **removed arguments** (`removedArgumentError`), which
fires before anything is spawned — no process, no job, nothing started:

```
Error: timeout_behavior was removed; pass run_type "foreground" | "background" | "detached". There is no per-call timeout any more. Nothing was started.
```

(`src/tools/index.ts` adds the `Error: ` prefix; the sentence itself is unchanged — the
guard pins it byte for byte.) A call that still sends a bare `timeout` gets the same
sentence, because the two went away together and a silent ignore would read as "my
timeout is in force".

The three results are the model's contract, verbatim (`promotionMessage`,
`backgroundStartMessage`, `detachedStartMessage` in `src/tools/execCommand.ts`).

A **promotion** — a foreground call that outlived its slice. The first line is frozen
(the guard and this document quote it byte for byte); the second names the **slice** it
outlived, never a budget, because nothing is about to end the command:

```
[command moved to background: id 7]
The command was still running after 30000 ms (30s) in <cwd>, so it was moved to the background when the 30 s foreground slice (spinney.execForegroundSeconds) ran out. Nothing was killed by the move and it keeps running.
Command: <command>
Working directory: <cwd>
You may continue with other work or end your turn: the completion notice for id 7 will reach you when it finishes. Do not poll it — check_command(7) is a status read, not a wait; wait_for_command(7) waits for it and returns the moment it ends; kill_command(7) stops it.
Output so far:
<output>
```

`<id>` is the job's session-local id, `30 s` is the configured slice, and the `Output so
far:` block appears only when the command produced something. The closing line is the
one a model has to read like an instruction: it says what to do instead of waiting
(continue other work, or end the turn), what will come back by itself (the completion
notice), that a status read is not a wait, that `wait_for_command` is the wait, and that
`kill_command` ends it. It is worded that way because a session in the field answered the
same silence with **46** status reads back to back.

`run_type: "background"` returns before any foreground time has passed:

```
[command started in background: id 7]
Command: <command>
Working directory: <cwd>
You may continue with other work or end your turn: the completion notice for id 7 will reach you when it finishes. Do not poll it — check_command(7) is a status read, not a wait; wait_for_command(7) waits for it and returns the moment it ends; kill_command(7) stops it.
```

`run_type: "detached"` never notifies, and its block says so:

```
[command started detached: id 7]
Command: <command>
Working directory: <cwd>
This job is session-wide and fire-and-forget: it locks no node (the composer stays on Send for it) and no completion notice will be sent, so check_command(7) is how its result is read. wait_for_command(7) waits for it up to the seconds you give and returns the moment it ends — no notice follows that wait. kill_command(7) stops it. It has no deadline and runs until it ends or is killed.
```

Every job keeps the node that started it as its **owner** — its card renders there and it
is torn down with that node or session — and `detached` changes exactly two things: it
**locks no node** (the composer keeps offering Send) and it **never notifies**.

The two settings that remain are read live, so a change applies to the next call:

- `spinney.execForegroundSeconds` — the foreground slice above (`execForegroundSeconds()`
  in `src/tools/execCommand.ts`);
- `spinney.subAgentSyncSeconds` — how long a `spawn_agents` / `send_agent_message` call in
  `sync` mode may hold the turn (`subAgentSyncSeconds()` in `src/chat/runtime.ts`,
  `DEFAULT_SUB_AGENT_SYNC_SEC = 300`). A batch still running at that point escapes: the
  tool returns the ids and the summaries arrive later as one batch notice.

The deleted keys — `spinney.commandDefaultTimeout`, `spinney.commandMaxForegroundDuration`
and, before them, `spinney.commandTimeout` / `spinney.commandTimeoutMax` — are gone from
the code, the manifest, the catalogs and this document; `npm run check:exec` asserts that
the schema and the description name neither.

The tool `description` was rewritten for this model — it is the only copy a sub-agent ever
sees — and still carries the three substrings a gate asserts:
`Never put the command in the background yourself`,
`instead of prefixing the command with "cd <dir> && "` and `or an absolute path`. It also
states the three run types, that `spinney.execForegroundSeconds` is when a foreground
command moves itself, that there is **no per-call timeout**, that a job lives until it
ends or is killed, and the two rules a model gets wrong without them: **never sleep to
wait for a command and never poll one** — `wait_for_command` waits, `check_command` is a
status read.

**Diagnostics.** One `[perf]` line per event, English, on the diagnostics log (see
`docs/agents/invariants/streaming-perf.md`). `cmd=` is `redactCommand` from
`src/redact.ts` (whitespace collapsed, secret-looking values masked, clipped to 120 chars
with a `…(+N chars)` tail), and `pid=none` means "no pid yet" (a spawn failure, or a shell
not created yet):

- `exec start pid=<pid|none> run_type=<foreground|background|detached> cwd=<cwd> cmd=<redacted>`
  — the call as it was executed. No timeout field, no budget field: `run_type` is the
  whole of what the call decided.
- `exec still-running pid=<pid|none> ms=<elapsed> out=<chars> cmd=<redacted>` — a 30 s
  unref'd heartbeat while a foreground command holds the turn: a shell waiting for input,
  or a network call that never returns, used to write *nothing*, so a hung command was
  invisible in the log.
- `exec end pid=<pid|none> run_type=foreground outcome=<exit|aborted|start-fail|truncated|promoted> code=<code|none> ms=<elapsed>`
  — one line per **foreground** call, whatever ended it; `promoted` means it was handed
  to the hub (the command is still running — neither `exit` nor anything else is true),
  and `truncated` outranks `exit`, so a nonzero code is never read without the `OUTPUT_CAP`
  flood that caused it. A `background` / `detached` start has no `exec end` line: it never
  held the turn, and `bg register` is its record.
- `exec kill pid=<pid|none> outcome=<exited|no-exit|no-pid|unknown> ms=<elapsed>` — written
  once a kill issued by this call has actually landed; `unknown` is a kill that rejected,
  and saying so is better than claiming one of the three real outcomes.

Two more lines describe the *background* half. There is no expiration line, because
nothing expires:

- `bg register id=<id> pid=<pid|none> detached=<true|false>` — a command became a job, and
  whether that job locks and notifies. There is no `budget=` field any more.
- `bg kill id=<id> pid=<pid|none> reason=<user|stop|rollover|none> outcome=<exited|no-exit|no-pid|unknown> ms=<elapsed>`
  — written **only when the confirmation failed**, so the log carries an entry for a kill
  that could not be confirmed (`reason` says who asked for it: the tool, the card and Stop
  all read as `stop`; there is no `timeout`).

**What a kill reports.** `CommandHandle.kill()` is **async** and resolves
`'exited' | 'no-exit' | 'no-pid'` — the old shape returned as soon as the signal had been
*sent* (or `taskkill` had run, which only says taskkill ran), so Stop, the terminal card and
the tool result all claimed a clean end while the tree could still be alive. On Windows it
runs `taskkill /PID … /T /F` via `execFile` and then waits for the child's **`exit`**
event — never `close`, which also waits for the stdio pipes to drain and therefore never
arrives when a leftover grandchild holds them — for up to **800 ms**; on POSIX the child
leads its own process group, so the group is signalled: `SIGTERM` → **300 ms** →
`SIGKILL` → **500 ms**. `'no-pid'` is a spawn that never produced a pid, `'no-exit'` a
deadline that passed without one, and it never rejects. The confirmation is fired detached
so `BackgroundRegistry.kill` stays synchronous (Stop and the card must be instant);
`kill_command` / `check_command` are the callers that await it, and they say
`… but the process tree did not report an exit …` when it failed.

**Git Bash rewrites arguments — and the fix is in `src/tools/shell.ts`.** The Git Bash
environment carries `MSYS_NO_PATHCONV: '1'` on Windows, so a **native** tool receives the
argument as written: `taskkill /PID 67188 /T /F` used to reach taskkill as
`invalid argument/option` on `C:/Program Files/Git/PID` — MSYS had rewritten `/PID` into a
Windows path — and three stuck processes were never killed. The `//F` / `//IM`
double-slash workaround is **obsolete**. `npm run check:shell` pins the argv a native child
actually receives (`MSYS_NO_PATHCONV` is Windows-only; a POSIX bash has no such
conversion, so it must not leak there).

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
  `[command output exceeded 16777216 bytes; truncated after 3.4s · cwd …]`,
  `[command was interrupted after 3.4s · cwd …]`, or
  `[command failed to start after 0.01s: <message> (shell <shell.exe>) · cwd …]` — the cwd half is
  the directory the command actually ran in (the harness root unless a `cwd` argument moved it),
  and it rides this line for the same reason the duration does: every command starts in the root,
  and saying so on every result is what stops the model from prefixing `cd <root> && …` defensively.
  It is first
  **on purpose**: an oversized result is spilled by `limitInline`, whose preview keeps only the
  first lines (cut to a small character budget), so a timing line anywhere lower is the first thing
  lost — exactly for the long command whose duration matters most. A **promoted** command is the one
  exception to "leads with its timing line": its first line is the notice itself,
  `[command moved to background: id 7]`, and the duration rides inside it (`The command was still
  running after 30000 ms (30s) in …`), next to the foreground slice it outlived. The two
  background run types are unchanged, because they return before any foreground time has passed.
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
(`readFile.ts`, `writeFile.ts`, `appendFile.ts`, `replaceInFile.ts`, `listDir.ts`,
`searchFiles.ts`, `searchTranscripts.ts`, `execCommand.ts`) except the three command-management tools
(`check_command` / `wait_for_command` / `kill_command`), which share
`src/tools/backgroundTools.ts`; `background.ts` holds the process plumbing they and
`exec_command` use. The two web tools are the same shape with a shared spine:
`webSearch.ts` / `webFetch.ts` are the tools, `webBackends.ts` is the backend table,
the failure classification and the cooldown, `webHtml.ts` is the dependency-free HTML
layer, and `webSearchDiagnostics.ts` renders the `Spinney: Test Web Search Backends`
report — see `docs/agents/web-search.md`, and `npm run check:websearch` for the guard
that pins every parser against a saved response. The intercepted ones (`read_image`, `spawn_*`, `send_*`, `hop_session`, `finish_hop`,
`list_nodes`, `rename_session`) live in `src/agent/tools/` with a `requires`
capability tag and are executed by `Agent.executeToolCall`. `read_image` keeps exactly
that shape — one file, `src/agent/tools/readImage.ts`, `requires: 'vision'`, with the
pre-upload transform called from the interception — and its transform half lives beside
the tool rather than inside it: `npm run check:image` / `check:jpeg` drive
`src/agent/imageTransform.ts` and the codecs from plain node (see `testing.md`), and **no
new user-visible string** arrives with any of it — the refusal, the zoom hint and the size
note are model-facing English, the `MAX_IMAGE_BYTES` precedent, so no l10n catalog
changes.

Arguments are **strict JSON only** — the classic OpenAI-compatible contract, one
shape and no second syntax (`parseArgs` in `src/tools/index.ts`). The **verbatim
frame form is gone**: it let a call carry unescaped multi-line content as a short
JSON header line followed by labeled marker blocks, and it was removed rather than
fixed, because the shape it kept producing was *valid JSON anyway* — the markers
wrapped inside the string value. That was silent: the markers landed in the file
while the tool result still read `Wrote … (N lines)`. Measured on this machine's
transcripts, 28 such calls out of 962 that used the form (~2%), ≥6 files polluted
across 3 workspaces, one `.mjs` then dying with `SyntaxError: Unexpected token
'<<'`. With the form removed there is no syntax to mistake: every value is an
escaped JSON string, and a file too large for one call is built with `write_file`
first and `append_file` in bounded chunks after it.

What is left is one **non-parsing sentinel**, not a parser: a value that *is* the
old frame — entirely wrapped in the open and close markers of the same key — makes
`write_file` / `append_file` / `replace_in_file` answer
`Error: the verbatim frame form was removed from this harness; send the value as a
plain JSON string instead. Nothing was written.` (`verbatimFrameError` in
`src/tools/index.ts`). The check is anchored on **both** boundaries: markers in the
middle of a payload are legitimate file text (a fixture, or a document about this
history), and only a value that *is* the frame can be nothing but the removed form.
It refuses rather than silently stripping — a rewrite would be unrecoverable (there
is no way to tell the two apart at that point) and would mask the mistake instead
of teaching the plain shape.

The wording that carries the contract lives in the tool `description`s (the prompt
carries no tool list, so a description is the only plugin-side place a model can
learn the shape); see `docs/agents/invariants/agent-authoring.md`.

Required arguments are validated **before** the tool body runs (`ToolRegistry.execute`
against the schema it advertises), so an absent value never surfaces as the
tool's own complaint about the symptom: `exec_command` called without `command`
answers `Error: exec_command is missing required argument "command". It sent: ….
Parameters: command, cwd, run_type.` — plus a `Did you mean …?`
hint when a sent key is a near-miss of the required one. One name is additionally
folded in as an alias: `exec_command` accepts `cmd` for `command` (only when
`command` is absent — a correct call is never touched). Aliases + validation live
in `ARG_ALIASES` / `applyArgAliases` / `missingArgumentError` in `src/tools/index.ts`.

