## Background terminals
- **`exec_command` has one knob and four behaviors** (`timeout_behavior`: `stop_when_timeout` —
  **the default** — `background_when_timeout`, `start_in_background`, `start_detached`), and this
  matrix is the whole contract. The values are the **job's identity**, not a mode: each one decides
  what is registered, whether the call locks its node, whether it notifies, and whether the job can
  be joined:

  | value | behaviour | registered as | locks its node | notifies | joinable |
  | --- | --- | --- | --- | --- | --- |
  | `stop_when_timeout` (**the default**) | a foreground call, killed at the timeout | nothing | (it is the turn) | - | - |
  | `background_when_timeout` | foreground up to the five-minute limit, then promoted, carrying `timeout − limit` as its own deadline | a node job | **yes** | yes | yes, if its remaining budget fits in a turn |
  | `start_in_background` | a node job from the start | a node job | **yes** | yes | as above |
  | `start_detached` (**new**) | **fire-and-forget**: session-wide | a **detached** job | **no** | **no** | **refused** |

  The knob is
  `spinney.commandMaxForegroundDuration` (seconds, default 300 = 5 minutes), the longest anything may
  hold a turn; `timeout` is the command's **total budget** — foreground plus background, with **no
  ceiling** — and the foreground slice a call may hold the turn for is `min(timeout, limit)`, zero
  for `start_in_background` and `start_detached` (both return before waiting):

  | `timeout` | no behavior / `stop_when_timeout` | `background_when_timeout` | `start_in_background` | `start_detached` |
  | --- | --- | --- | --- | --- |
  | omitted | killed at the limit | **refused before the spawn** | **refused before the spawn** | a detached job with **no deadline** |
  | ≤ limit | killed at the timeout | killed at the timeout, **not** promoted | the whole budget as the job's deadline | the whole budget as the job's deadline |
  | > limit | **refused before the spawn** | promoted at the **limit**, the hub gets `timeout − limit` | the whole budget as the job's deadline | the whole budget as the job's deadline |

  Two refusals carry this vocabulary, and they are the load-bearing part of it:

  - **A node job without a `timeout` is refused before the spawn** — both of the values that would
    register one, `background_when_timeout` and `start_in_background`. A node job with no deadline
    holds its node's composer on Stop until it is killed, so an unbounded lifetime belongs to
    `start_detached` — which is why the same omission is legal there and refused here, and why the
    two node-job values are refused by one function (`needsTimeoutError(behavior)`,
    `src/tools/execCommand.ts`) whose first words name the value that was asked for. It names both
    ways out and ends the way every pre-spawn refusal does: `timeout_behavior "${behavior}" needs a
    timeout: without one the job has no deadline, so nothing ends it on its own and it locks this
    node (the composer shows Stop for it) until something kills it. Either pass a timeout — the
    job's whole budget in seconds, with no ceiling, and the job is killed when it runs out — or pass
    timeout_behavior "start_detached", which is session-wide and fire-and-forget: it locks no node,
    never sends a completion notice, and its result is read with check_background_terminal. Nothing
    was started.` (`${behavior}` is `background_when_timeout` or `start_in_background`, whichever
    the call asked for; no other word of the sentence changes.)
  - **`join_background` on a detached job is refused** — outright, before the finished check, so
    the status does not matter: the job has no deadline and never notifies, and the two things a
    join ever gives back (a bounded wait, a notice to come back on) do not exist for it. The
    refusal names the tool that answers the same question on demand instead:
    `Background terminal 3 is a detached job (timeout_behavior "start_detached"): it is
    session-wide and fire-and-forget, so it never sends a completion notice and no turn ever waits
    for it — joining it is meaningless and this join was refused; nothing changed. Read it with
    check_background_terminal(3) instead: it reports the job's accumulated output, and its exit
    code once the job has ended. If you want to end the command rather than let it run, call
    kill_background(3).`

  Why `start_detached` exists, and what it costs — this is the part not to miss: a job that holds a
  node's composer on Stop means **the owner cannot send a message on that node until the job ends**,
  so a long-lived thing (a dev server, an emulator, a watcher) could only be started by freezing the
  conversation. A detached job is registered **per session**, so any node in that session can check
  it, be refused its join, or kill it. The price is stated plainly: a detached job **never wakes the
  model** — the agent learns its outcome only by asking — so the fire-and-forget spelling is for work
  whose result is not needed to continue.

  `background_when_timeout` runs the command in the foreground up to the slice and, only when the budget
  outlives the slice (`timeout > limit`), promotes it to a background terminal
  at the **limit** instead of killing it: the result names the `id`, the working directory, the fact
  that **nothing was killed** and that it keeps running, the budget the job now has, and the join
  caveat below (`[command moved to background: id 7]`, then the output so far). A call that omitted
  `timeout` never reaches this point — it is refused before the spawn, like `start_in_background`
  (see the refusal above) — so a promotion always has a remainder to hand over. The hub is handed the
  **remainder** (`timeout − limit`), never the budget a second time, because the job's deadline is
  measured from the registration that happens at the promotion. A promotion is its own kind of ending
  in the diagnostics: `outcome=promoted`, neither `exit` nor `timeout`, because the process is alive
  and now belongs to the hub — whose card, id and completion notice take over. `timeout ≤ limit` with
  a background behavior is therefore killed at its timeout and **never** promoted: its budget is spent
  exactly when the slice ends, so a promotion there would be "kill it immediately" in disguise.
  `start_in_background` keeps its spelling and its behaviour: it launches immediately and returns a
  **session-local** `id` with no foreground time to report, and it refuses an omitted `timeout`, as
  `background_when_timeout` does.
  `start_detached` is the fire-and-forget spelling of that shape: it launches immediately and returns
  an id the same way, but the job it registers is **detached** — it keeps the node that started it as
  its owner (its card renders there) and only its **lock** and its **notice** are off: no composer
  Stop, no completion notice — while its id resolves **per session**, so any node in the session can
  check it, be refused its join, or kill it. With **no background access** (a bare
  `ToolRegistry` — the acceptance drivers build one — or a worker with no hub) the default
  `stop_when_timeout` path needs no hub and
  must not throw, which is what keeps the `check:cwd` gate green; an *explicit* background behavior
  there does throw — `Background terminals are not available in this session.` — because that is a
  request the context cannot honour. The id is minted by the hub (`BackgroundHub.mintId`) — a
  monotonic per-session counter, **not** a real OS pid — and is only resolvable inside its own session.
- **A `timeout` that would outlive a turn is refused, never clamped** — the one rule that keeps the
  single knob a knob. `spinney.commandMaxForegroundDuration` is read live per call
  (`commandMaxForegroundDurationSec()` in `src/tools/execCommand.ts`, with
  `DEFAULT_COMMAND_MAX_FOREGROUND_SEC = 300`), and a `timeout` longer than it with no behavior (or
  with `stop_when_timeout`) throws `timeoutTooLongError` **before the spawn** — no process, no job, nothing
  started, which is the half the model needs or it will go looking for an output that does not
  exist — because a command that may run that long must say *which* kind of background job it is:
  `timeout 1800 s is longer than the 300 s a turn may hold (spinney.commandMaxForegroundDuration).
  A command that may run that long must not hold the turn: pass timeout_behavior "background_when_timeout"
  (300 s in the foreground, the rest of its 1800 s budget in the background) or
  "start_in_background" (the whole 1800 s in the background), or pass a timeout of 300 s or less.
  Nothing was started.` (the registry adds the `Error: ` prefix). The same value set adds the
  other refusal: a node-job value **without** a `timeout` — `start_in_background` and, since this
  change, `background_when_timeout` — is refused before the spawn too,
  naming `start_detached` as the value that owns an unbounded lifetime, because a node job with no
  deadline would hold its node's composer on Stop until it is killed. There is **no ceiling** on
  `timeout` itself — `timeout: 99999` with `start_in_background` is accepted and the whole budget
  travels to the hub — and `spinney.commandTimeout` / `spinney.commandTimeoutMax` no longer exist.
  `tools/exec-timeout-acceptance.js` (`npm run check:timeout`, 52 checks, part of
  `vscode:prepublish`) pins the matrix and the refusal with a settings stub keyed **by name**
  (`commandMaxForegroundDuration` → 1), which is the only way the limit is observable at all — and a
  stub that answered one value for every key would hide a leftover `commandTimeout` read. The key is
  declared in `package.json`'s `contributes.configuration`, and `npm run check:docs` fails the build
  while the user manual's settings reference does not name it: the documentation half of the same
  contract.
- **`join_background` is gated by the same limit** (`src/tools/backgroundTools.ts`), because a turn
  must not wait longer than it may hold. A running job with more of its budget left than the limit is
  refused — the gate is read **before** the task is touched, since a refused join must leave
  everything as it was — with a **plain result**, not an `Error:` (nothing was malformed, and an
  `Error:` would invite a retry with the same pid); the wording is deliberately imperative, because
  ending the turn is the action that will actually reach the result:
  `Background terminal 3 has 27m 30s of its 30m 0s budget left, which is longer than the 300 s a turn
  may wait, so this join was refused and nothing changed. End your turn instead: the completion
  notice for id 3 will reach you when it finishes (check_background_terminal(3) reports it sooner).
  If you want to end the command rather than wait for it, call kill_background(3).` A job with **no
  deadline** (`remainingBudgetMs(task)` → `null`) cannot be waited on at all and is refused for the
  same reason, saying so instead of naming a budget: `Background terminal 3 has no deadline, so it
  can run longer than the 300 s a turn may wait, and this join was refused — nothing changed. End
  your turn instead: the completion notice for id 3 will reach you when it finishes
  (check_background_terminal(3) reports it sooner). If you want to end the command rather than wait
  for it, call kill_background(3).`. Since this change the
  only value that can register such a job is `start_detached` with `timeout` omitted, and a detached
  job is refused by the check just below, which runs first — so this wording is what the gate answers
  for a task whose `timeoutMs` is `undefined`, the registry-level statement of the same rule. A
  **detached** job (`start_detached`) is refused as well, and that refusal says why instead of naming
  a budget: the job has no deadline and never notifies, so there is nothing to wait for — the caller
  is told to read it with `check_background_terminal(3)` and to end it with `kill_background(3)`. It is
  refused outright, before the finished check, so its status does not matter. A finished job is never
  gated (the wait
  returns at once, so there is nothing to bound, and a refusal would tell the model to expect a notice
  for a job that already ended), and a job with ≤ the limit left joins exactly as before.
  `remainingBudgetMs(task)` is what the gate reads: `null` is the contract's "no deadline", never
  "0 left".
- **A command must not background itself** (`&`, `nohup`, `disown`, `Start-Process`): the hub
  tracks only the handle it spawned, so a process the shell started on its own has no id, no
  card and no completion notice — its output is never reported — and Stop's union kill may leave
  it running, because the kill tears down the **spawned** tree (`taskkill /T /F` on Windows, the
  detached POSIX process group) and an orphaned or re-parented child escapes it.
  `timeout_behavior` is the only way to make a command outlive the call with a card behind it.
  The rule is stated twice, on purpose: in the `exec_command` description (which is what every
  agent, sub-agents included, is sent as a schema) and in the system prompt's
  `## Delegation (when to hand work off)` line about long-running commands.
- **A third "we cannot own it" case sits next to that rule**, recorded here because it happened
  in the field: a command can hand its work to a **long-lived process the harness does not own**
  — an editor addon, a test bridge, a build server. Its children are not in the spawned tree, so
  the union kill and Stop structurally cannot reach them, and their output is never reported.
  That is an **ownership boundary, not a bug**: the hub tracks the handle it spawned, and a
  process someone else spawned was never in that set. The **known limitation** is that the
  harness deliberately does **not** scan for such stray processes — there is no `Show Stray
  Processes` command and no process scanner, because a process table does not say which entry
  belongs to which tool. The remedy is the one above: the runner is started by the harness
  (`exec_command` in the foreground, or through `timeout_behavior`, so it gets a card, an id and
  a completion notice), or the user stops the stray themselves.
- `BackgroundHub` (`src/chat/backgroundHub.ts`, one per window) owns every job in the window,
  keyed by `(session, node)`: `registries: Map<sessionId, Map<nodeId, BackgroundRegistry>>`
  (`registryFor(owner)` creates lazily) plus a per-session `id → owner` index
  (`lookup(sessionId, id)`). A job therefore belongs to the **node whose turn spawned it** and
  renders beside that node's card — never another branch or session. A **detached** job
  (`start_detached`) is not a second kind of bucket: it is a task in that same `(session, node)`
  bucket with `detached: true`, so it keeps its owner, its card and its place in every listing and
  kill — and only its **lock** and its **notice** are off (the composer keeps offering Send, the
  delivery path reads `notifyAgent: false`). Its id resolves **per session**, so any node in that
  session can check it, be refused its join, or kill it. `listForNode`,
  `listForSession` (each hit tagged with its owner), `runningForNode`, `kill`, `waitFor` all take
  `sessionId`, so a task id never leaks across sessions. `register(owner, handle, command, cwd, timeoutMs?)`
  also fires the `onRegistered` hook (`backgroundHub.ts:46`, called at `backgroundHub.ts:106`) once
  per job, synchronously, so the coordinator can create the job's card — and it hands the
  `timeoutMs` it was given (the promotion's **remainder**) straight to `BackgroundRegistry.register`,
  which is where that budget's timer is armed.
- The tools reach the hub through a `BackgroundAccess` set on the `ToolRegistry`
  (`setBackgroundAccess`): `currentOwner()` is the running turn's **node** — for a node worker it
  closes over `{ sessionId, nodeId }` (`SessionRuntime.workerFor`) — so `exec_command` from node
  X's turn always registers under X. There is no "which run is this?" ambiguity (P3).
- Three tools manage a job: `check_background_terminal(pid)`, `kill_background(pid)`,
  `join_background(pid)` — the argument is a numeric **`pid`** in all three, not `id`
  (`src/tools/backgroundTools.ts`), even though what `exec_command` hands back is a
  **session-local** id, not an OS pid. `join` blocks until the job finishes and honours Stop — subject
  to the join gate above, which refuses the wait whenever the job still has more of its budget left
  than a turn may wait. All three resolve the id through `hub.lookup` in the calling session — and none
  of them is in a
  **sub-agent's** tool registry: `subAgentTools` (`src/chat/runtime.ts:3086-3097`) exposes only
  `read_file` / `list_dir` / `search_files` / `search_transcripts` (+ `write_file` /
  `replace_in_file` / `exec_command` when writable), so a sub-agent that backgrounds a job gets an
  id it cannot itself manage — a call to any of the three answers `Error: unknown tool "…"`. The
  job registers under the sub-agent's own node, its notice still reaches the sub-agent, and only
  the user (the job card's kill button / Stop on that line) can kill it.
- **Every background tool result carries the duration** (`formatDuration`, `src/duration.ts`):
  `check_background_terminal` answers `Background terminal 3 is running. (command: …, 3.4s elapsed)`
  for a live job, `Background terminal 3 finished with exit code 0 after 3.4s.` for a finished one
  and `Background terminal 3 was killed after 3.1s. (command: …)` for a kill;
  `kill_background` answers `Killed background terminal 3 after 3.4s (command: …).`; and
  `join_background` answers `Background terminal 3 finished with exit code 0 after 3.4s.`. A job with
  a **budget** names how much of it has gone — `Background terminal 3 is running. (command: …, 12m 30s
  of its 30m 0s budget elapsed)` — and an ending the budget caused is told apart from a kill:
  `Background terminal 3 was killed after 30m 0s — its 30m 0s budget ran out. (command: …)`, because
  `killReason: 'timeout'` is not the user's doing. An unconfirmed kill adds
  `, but the process tree did not report an exit`. These
  are **model-facing** strings, so they are deliberately not localized — the same locale-free token
  the webview's chips render, not a translated status word.
- **A kill reports what it achieved** (`src/tools/background.ts`): `CommandHandle.kill()` is
  `() => Promise<KillOutcome>` with `KillOutcome = 'exited' | 'no-exit' | 'no-pid'` — the child's
  exit was observed, the kill was issued but no exit arrived before the deadline (so the process
  tree may still be alive), or there was no pid to signal (the spawn never succeeded). On Windows
  the tree is torn down with `execFile('taskkill', ['/PID', pid, '/T', '/F'])` (an argument
  array, never a shell string) and the child's **`exit`** event is then awaited for up to
  `KILL_CONFIRM_MS = 800` ms; on POSIX the detached process group gets `SIGTERM`, waits
  `SIGTERM_GRACE_MS = 300` ms, escalates to `SIGKILL` and waits `SIGKILL_CONFIRM_MS = 500` ms
  (`ESRCH` on the group signal is itself a confirmed exit, and an already-exited child answers
  `'exited'` without signalling anything — which is what makes a second `kill()` safe and
  idempotent). The deadlines bound the *confirmation*, not the kill: a stuck or unkillable
  process must not hold a tool result, or a Stop, open. **Why `exit` and not `close`**: `close`
  additionally waits for the stdio pipes to drain, and a grandchild that survived the kill (or a
  shell that had already left one behind) holds them open indefinitely — so `close` may never
  fire for a process that is already gone. Confirming on `close` was exactly the bug that hid a
  dead process behind a live-looking job.
- **A kill that cannot be confirmed says so, and is logged.** `BackgroundRegistry.kill()` and
  `killAll()` stay **synchronous** in their state transition — Stop and the card stay instant,
  and `complete(task, null)` is unchanged — and fire the confirmation **detached**
  (`confirmKill`), because a caller must not wait on the OS. A non-`exited` outcome sets
  `task.killUnconfirmed = true` and writes exactly one diagnostics line:
  `bg kill id=<id> pid=<pid|none> reason=<user|stop|timeout|rollover|none> outcome=<exited|no-exit|no-pid> ms=<elapsed>`
  — `reason` is the `killReason` the kill path stamped, and the line exists **only** for a
  confirmation that failed, so a clean budget kill is recorded by its own `bg expire` line instead
  (see the lifecycles bullet). The task also
  carries `killConfirm?: Promise<KillOutcome>`, so the tool layer can await the confirmation the
  registry deliberately did not await. A registered handle that answers no outcome at all (the
  plain objects the smoke tests build) is treated as nothing to claim: that task keeps the plain
  wording it had before this existed.
- The two model-facing strings a non-`exited` kill produces: `kill_background` answers
  ``Killed background terminal ${id} after ${dur}, but the process tree did not report an exit
  (command: ${task.command}).`` and `check_background_terminal` answers ``Background terminal
  ${id} was killed after ${dur}, but the process tree did not report an exit. (command:
  ${task.command})``. Confirmed kills keep the old wording byte for byte — `Killed background
  terminal 3 after 3.4s (command: …).` and `Background terminal 3 was killed after 3.1s.
  (command: …)` — because "killed" alone would claim a clean end the OS never reported.
  `tools/exec-kill-acceptance.js` (`npm run check:kill`) pins both halves: a confirmed kill is
  silent and sets nothing, an unconfirmed one raises the flag and logs the line.
- **The Windows `taskkill` trap is why the old advice was wrong** (`src/tools/shell.ts`):
  `spawnShellCommand` runs the command through Git Bash, and MSYS rewrites an argument that
  looks like a Unix path into a Windows one before a **native** child sees it — so
  `taskkill /PID 1234 /T /F` reached taskkill as `C:/Program Files/Git/PID …` and was rejected
  with `invalid argument/option`, silently teaching a model that killing a stuck process "does
  not work" (`//F`, the MSYS double-slash escape, was the workaround, and MSYS could de-fang that
  too). `src/tools/shell.ts` now sets `MSYS_NO_PATHCONV: '1'` in the Git Bash env on Windows —
  the switch means nothing to a POSIX bash, so it is not set there — so a native tool receives
  the argument as written and the double-slash workaround is no longer needed.
  `tools/shell-argv-acceptance.js` (`npm run check:shell`, part of `vscode:prepublish`) drives
  the compiled shell selection the
  way `spawnShellCommand` does (`shell.file` + `buildArgs` + `env`) and pins the argv a native
  child actually receives, because nothing about this failure is visible in the tool's source.
- **A job's card is a flying `kind:'bg'` node, not a dock.** `SessionRuntime.onBackgroundRegistered`
  (`runtime.ts:3891`) creates it under the owning turn node once per job: `bgTaskId` = the
  session-local id, `bgCommand` = the command, title = the command clipped to 60 chars
  (`runtime.ts:3902`). It is a **sidecar** exactly like a sub-agent window: `attachNode`
  keeps sidecars after the turn spine (`tree.ts:321-338`), and `isSidecar` (`tree.ts:462`,
  `kind === 'agent' || kind === 'bg'`) keeps it out of the API path (`pathMessages`,
  `tree.ts:416`) and out of the checkout chain (`leafOf`, `tree.ts:443`). The create path
  saves and restores `session.activeNodeId` (`runtime.ts:3901-3907`), so a job never moves the
  view focus. The card lives in the same right-hand column-major grid as the sub-agent windows
  (`media/tree.js` `isSidecarKind` `tree.js:89`, `agentKids` `tree.js:140`).
- **Webview rendering:** there is no standalone panel and no dock at the bottom of a card any more
  (`#bg-panel`, `.node-bg`, `.bg-dock-*`, `.bg-item*` are gone). `renderBgBody` fills a `kind:'bg'`
  card from the tree node's own meta plus the latest snapshot: a status row of `#taskId` + status +
  the **elapsed chip** (and the same value as the card head's status chip), then the command and the
  output tail, plus a `kill` button (built by `killBackgroundButton`, which posts
  `killBackground { id }`) only while the job runs. A **detached** job's card also wears the
  `shared` badge: `treeMessage` sets `bgDetached` from the **live task** (the hub's `lookup`), never
  from the node, so a card restored after a reload — which has no task left to ask — renders as the
  plain record it is, and the badge says why that job's composer stayed on Send.
- **The elapsed chip is rendered locally, from clocks the host sends.** The snapshot ships
  `startedAt` and `finishedAt`, never a counter: a running card ticks its chip from `startedAt` on a
  **250 ms `setInterval` in the webview**, so a command that prints nothing for minutes still shows
  a moving number and the host never pushes a snapshot just to advance the display. A finished card
  freezes the chip at `finishedAt - startedAt` (the host's own value — the local ticker stops, it
  never keeps counting), and a record card restored after a restart, which has no live task, shows
  the node's persisted `bgElapsedMs`. Both numbers go through `formatDuration` (`src/duration.ts`,
  mirrored in `media/main.js`, because no host string arrives per tick); the token is locale-free
  and deliberately **not** localized — `420ms`, `3.4s`, `42s`, `3m 12s`, `1h 3m`.
- **Snapshot:** `postBackgrounds` sends one flat `{ type: 'backgrounds', tasks }` list, every task
  (`BackgroundInfo`) tagged with `nodeId` (its owner), `cardNodeId` (the
  `kind:'bg'` card mirroring it) and `pendingDelivery`, and carrying the job's two **clocks** —
  `startedAt` plus `finishedAt` (`null` while it runs). A pre-computed `elapsed` field is gone: the
  webview derives the number, so no snapshot has to be sent per second. The list carries running
  jobs plus finished ones still awaiting delivery (`runtime.ts:3851-3854`); a delivered job drops
  out, but its card keeps the persisted terminal state. The webview keys the snapshot by `task.id`
  and patches the card of each tree node with a `bgTaskId` (`renderBackgrounds`,
  `media/main.js:1183-1202`); the host coalesces
  the snapshot (~200 ms, `runtime.ts:3832-3841`) so a chatty process cannot freeze the webview.
- **Completion → injected into the owning node.** `onBackgroundFinished` (`runtime.ts:3921`) first
  snapshots the terminal state onto the card (`snapshotBackgroundCard`, `runtime.ts:3938`:
  `bgExitCode`, `bgKilled`, `bgElapsedMs`, `bgOutputTail` (≤800 chars), `bgCommand`, node status
  `done`/`interrupted`) — the hub is in-memory, the card must outlive it — then queues one
  `SignalNotice` (`buildBackgroundSignal` `runtime.ts:3973`; `pushSignal` `runtime.ts:3996`;
  75 ms debounce `scheduleSignalDrain` `runtime.ts:4016`) keyed by the **owner** node
  (`nodeId: owner.nodeId`, never the view focus). The notice text and the card's status text both
  name how long the job ran: the notice reads
  ``Background command `cmd` (id 3) finished with exit code 0 after 3.4s.``, while the card's status
  line is the compact `exit 0 (3m 12s)` (`killed (3m 12s)` for a kill). A job the **budget** ended
  replaces the whole clause — ``was killed after 30m 0s — its 30m 0s budget ran out`` (`isBudgetKill`,
  i.e. `killReason === 'timeout'`) — because the command was promoted so the turn *could* end, and
  "was killed by the user" would blame the wrong cause; assembling it from the verdict rather than
  appending `after …` to a kill clause is what keeps it from saying the same thing three times.
- Delivery has two paths, and neither creates a node:
  - owner turn still running → the agent hook `Agent.setSignalHandler` (`agent.ts:402`; wired in
    `workerFor` at `runtime.ts:925`, and per sub-agent at `runtime.ts:3473`) is called after the **whole** tool batch
    of an assistant round (`agent.ts:687-696`) and pushes one combined `user` message
    (`combineSignalText`, `runtime.ts:376-388`), so the model sees the notice on its **next
    request**, mid-turn (`takeSignalsFor`, `runtime.ts:4031`);
  - owner node idle → `drainSignals` (`runtime.ts:4061`) delivers the same text as an
    **injected turn on that same node** (`beginInjectedTurn`, `runtime.ts:2044`, `fresh:false`:
    no node is created, no view focus moves), gated per node (`isNodeLive`, `runtime.ts:3583`) and
    by `host.isHeld()`.
- **The notice block renders inside the owning card:** `renderSignalCards` (`runtime.ts:4191`)
  pushes `DisplayItem.kind:'background'` into that node's own `displayItems` (so a reload re-renders
  it) and posts `backgroundNotice { nodeId, item }`; the webview's `addBackgroundNotice`
  (`media/main.js:1007-1027`) appends a `.msg.bgnotify` block whose badge is `BG` for a job and `SUB` for a
  sub-agent batch. An injected signal is deliberately **never** a `kind:'user'` display item — a
  replayed user item would be skipped or would clobber the pinned prompt. Because a job can be
  delivered mid-stream, `backgroundNotice` first finalizes the streaming answer
  (`media/main.js:3341-3343`). `N` notices queued at the same boundary merge into **one** message (D2).
- **`Delivered` / terminal snapshot (D1).** `TreeNode.delivered` (`tree.ts:110`) means the
  completion signal reached its reader: the card is settled when the notice is delivered
  (`settleSignals`, `runtime.ts:4216-4231`, followed by a `postTree()`), the job leaves the
  `backgrounds` snapshot, and the card stays as a record with a `Delivered` badge
  (`media/main.js:1211-1224`, `.node-delivered-badge`) plus its persisted `bg*` terminal fields. A
  tool-initiated kill/join (`notifyAgent=false`) skips the notice and settles the card directly
  (`runtime.ts:3926-3933`). A **detached** job is the third ending no notice follows, and the only
  one that is structural rather than incidental: `onBackgroundFinished` returns before a
  `SignalNotice` is ever built — nothing is queued for a tool boundary, nothing is injected into an
  idle owner, nothing is written back — and it settles the card itself (`delivered` flips, the
  terminal state is repainted), because the agent was never the waiter: it asks with
  `check_background_terminal`. After a restart the card survives `pruneSession` (`tree.ts:531-590`),
  but never claims to be live: the generic normalization turns a stored `running` into
  `interrupted` (`tree.ts:550-554`) and `delivered` is forced true (`tree.ts:564-566`), because the
  hub is in-memory and the process was torn down. Its body is then rendered from the node's `bg*`
  snapshot (`outputTailFor`, `media/main.js:1126-1129`).
- Stale notices are dropped, not delivered: `signalStale` (`runtime.ts:4174`) discards a
  signal whose task was joined/killed through a tool (`notifyAgent !== true`) or whose owning node
  is gone. `onKillBackground` (`runtime.ts:4235`, a card's kill button) asks for
  `notifyAgent: true`, so the model is told about the kill at the next delivery point.
- While an external controller holds the window (`host.isHeld()`), the hook returns `[]` and the
  idle drain backs off (500 ms, `runtime.ts:3874-3880`) instead of starting a turn — the reload
  must not be refused with "agent is busy".
- **Stop is a union kill, and it never continues the conversation.**
  The composer's bottom-right button is Stop while a node runs *or* while it still owns
  unfinished work (`state.lockedNodes`); there is no separate banner and the input stays
  usable, exactly as while a turn streams. Pressing it (`SessionRuntime.stop(nodeId)`,
  `POST /stop {nodeId}`) stops that node's turn, kills every background terminal it owns
  — *and* the terminals its running sub-agents own, since a sub-agent's `exec_command`
  registers under the sub-agent's node (`killJobsOf`) — and aborts **the whole sub-agent
  subtree** (`subAgentSubtree`: a depth-1 sub-agent may be running depth-2 children),
  then suppresses the notices that would have followed. Nothing is dropped: each notice
  is **written back** (`queueWriteback` / `flushWritebacks`) into that node's own history
  as a `user` message and rendered in its card as the usual `.bgnotify` block, so it
  reaches the model with the next prompt / ▶ Continue and cannot start a turn on its own.
  A notice produced below a sidecar is retargeted to the turn node that owns the line
  (`turnOwnerOf`), because a sidecar's history is never sent. The node is remembered in
  `stoppedLines` until the user continues that line, so a stopped sub-agent is **never
  resumed** by its own settling children (`onAsyncBatchDone` / `deliverResumeAsync` /
  `pushSignal` all redirect there). A turn that is still winding down defers the write
  (`finishTurn` flushes again, and the signal drain retries), so the text can never slip
  past a request built in between. The fine-grained path is unchanged: a card's ✕ kills
  that one job *and* tells the model (`notifyAgent: true`).
- **A context rollover is the union kill's third caller** (`SessionRuntime.rolloverContext`,
  see `context-rollover.md`). It begins with the *same* path a Stop takes — the node's
  background terminals, its whole sub-agent subtree (with the terminals the sub-agents own)
  and any notice already queued for it, all converted into **writebacks** into that node's
  own card and history — and only the aftermath differs: P is flushed and explicitly
  **re-dumped**, so the kill notices and the jobs' terminal state survive on disk even
  though a `kind:'bg'` card has no dump of its own (that is why the kill record has to
  carry the job's command, final state and output tail), and the new window's harness text
  points at that file as the copy to read. Leaving the jobs running would be wrong twice
  over: their completion notices are addressed to a line nobody continues from, and their
  results could never reach the new window, which by construction sends none of the old
  history — the model would be told about work it cannot see. The rollover also awaits each
  killed sub-agent's settle promise (~2 s, bounded) before composing the message, because a
  sub-agent's dump is written inside its own `finish` handler.
- **Delete / clear / branch deletion:** a session, a cleared conversation or a branch that owns
  *running* jobs asks a modal confirmation first — `confirmKillBackgrounds` for delete/clear,
  `deleteBranchInteractive` for a branch (its count comes from
  `runningBackgroundsForNodes(branchIds)`) — and only then kills the jobs (the process trees are
  torn down). Nothing is killed behind the user's back. A *turn* still streaming refuses the
  delete/clear outright instead of confirming (`rt.isRunning()`). Clearing drops the queue and the
  card index (`runtime.ts:4282-4283`); detaching a branch drops the signals queued for the removed
  nodes, calls `hub.removeNode(..., { kill: true })` and forgets the cards whose nodes are gone
  (`runtime.ts:4318-4329`). A `bg` card has no children, so its own delete button
  (`deleteBranch`) is equivalent to deleting that one record.
- **Lifecycles** (`src/tools/background.ts` owns the process plumbing): `BackgroundTask` carries
  `startedAt` plus `finishedAt: number | null` — `finishedAt` is stamped once when the job settles
  (exit, kill, or a failed start) and is what a snapshot's chip freezes on, while the card's
  persisted `bgElapsedMs` is the same subtraction done once when the terminal state is snapshotted.
  A **detached** job carries `detached: boolean` — set once at `register` (its last argument, after
  the budget) and never changed afterwards — and the registry sets `notifyAgent: false` together
  with it, because that is the mechanism the delivery path already understands. The coordinator
  needs to read only `detached` for the lock rule, and the job itself is counted like any other by
  `runningCount`: "detached" is a **lock and notice** rule, not a reason to hide a running process
  from Stop, the delete/clear confirmation or the control plane.
  A job that was given a **budget** carries it too: `timeoutMs` (the total it may run, set only by
  `register`'s last argument) and `deadlineAt` (`startedAt + timeoutMs`) — a deadline rather than a
  countdown, so what is left can be read at any moment through `remainingBudgetMs(task)` (`null` for
  a job with no budget, `max(0, deadlineAt − now)` otherwise, never a negative number, and a clock
  read rather than a state read). Exactly **one** `setTimeout` is armed at `register()` for the time
  left, kept in the registry's own `budgetTimers` map so the task stays a plain data record,
  `unref()`ed (a budget is not a reason for the host to stay alive) and cleared in `complete()` —
  the one place every ending goes through — so a command that ends by itself leaves no timer behind.
  When it fires, `expireBudget` kills the job through the registry's **single kill path**, `killTask`,
  with `killReason: 'timeout'`: the same method `kill` (`'stop'` — `kill_background`, the card's kill
  button and Stop are one method from inside the registry) and `killAll` (`'rollover'` — session or
  node delete, clear, window rollover) use, so a deadline guarantees exactly what Stop guarantees
  (the immediate `finished` transition, the detached confirmation, the hook, the `killed` flag) and
  only the reason differs. The budget's trail is three `[perf]` lines:
  `bg register id=<id> pid=<pid|none> budget=<n>s|none`,
  `bg expire id=<id> pid=<pid|none> budget=<n>s|none ms=<elapsed>` (the harness killed the job at its
  own deadline — the **only** record of a clean budget kill, which is why the line exists at all) and
  `bg kill id=<id> pid=<pid|none> reason=<user|stop|timeout|rollover|none> outcome=<exited|no-exit|no-pid> ms=<elapsed>`,
  written only when the confirmation failed.
  `tools/bg-budget-acceptance.js` (`npm run check:budget`, 51 checks, part of `vscode:prepublish`)
  pins it: a 500 ms budget kills at about its deadline with `killReason: 'timeout'` and
  `remainingBudgetMs` reading `0` afterwards, an unbudgeted job is still running a second later and
  reads `null` (not `0`), a live job's remaining budget counts down, and the join gate refuses both
  the over-budget and the no-deadline shape.
  `hub.removeNode(session, node, {kill})` drops one node's jobs + registry (the session counter is
  kept — ids are never reused), `hub.removeSession(session, {kill})` drops a whole session
  (`SessionRuntime.dispose()`), and `hub.killAll()` tears every job down (window dispose) so
  nothing is orphaned. `spawnShellCommand`/`killChildProcess` do the process-tree kill and report
  the `KillOutcome` above (Windows `taskkill /T /F`, otherwise the detached POSIX process group),
  and the handle keeps draining output past `OUTPUT_CAP` (a per-stream `StringDecoder` keeps a
  multi-byte character split across pipe chunks intact).
  `ControlSessionInfo.backgroundNodes` is unchanged: it reports the **owning turn nodes**
  (from the hub's per-`(session, node)` registries, `runtime.ts:1025`), so the control plane —
  and the `background` acceptance suite — can verify ownership survived a view move. The `kind:'bg'`
  cards are display-only and never appear there.
- **A background terminal cannot drive a window reload.** `POST /reload-window` refuses while
  any sub-agent or **node** background terminal is live (`controlReloadWindow` →
  `anyRunningBackground()` → `hasRunningNodeBackground()`; a `start_detached` job is
  fire-and-forget and deliberately does not block a reload), so a hub-owned job that
  calls it is refused by its own existence, and a foreground call from inside a turn is refused
  by the turn check. A reload has to come from outside the window — the `hvsc` supervisor, a
  terminal issuing `wait-for-finish` + `reload-window`, or the user. This is the one action a job
  the hub owns can never perform for the window that owns it; see `control-plane.md`.
