## Background terminals
- **`exec_command` has one knob — `run_type` — and it says what the call *is*.** There
  is no per-call timeout, no budget, and **no job has a deadline**: a command lives until
  its process ends or something kills it. The three values are the whole contract:

  | `run_type` | behaviour | registered as | locks its node | notifies |
  | --- | --- | --- | --- | --- |
  | `foreground` (**the default**) | runs in this turn and returns its output; a command still running after `spinney.execForegroundSeconds` is **moved to the background** | a node job, at the promotion | **yes**, from the promotion on | yes |
  | `background` | a node job from the start; its id comes back at once | a node job | **yes** | yes |
  | `global` | **fire-and-forget**: bound to this VS Code window | a **global** job (`detached: true` on the task — the field name is the internal one, the value is `global`) | **no** | **no** |

  `spinney.execForegroundSeconds` (seconds, default **30**, minimum 10, maximum
  999999999999) is the **foreground slice**, read live per call
  (`execForegroundSeconds()` in `src/tools/execCommand.ts`, with
  `DEFAULT_EXEC_FOREGROUND_SEC = 30`). It is not a cap and it is not a deadline: when it
  runs out the command is **handed to the hub** — never killed, never refused — and the
  result carries its id, the slice it outlived and what to do next. The old
  `spinney.commandDefaultTimeout` / `spinney.commandMaxForegroundDuration` pair is gone
  from the code, the manifest, the catalogs and the docs; nothing reads it and
  `npm run check:exec` asserts the schema and the description name neither.

  Two consequences are worth stating, because both used to be refusals:

  - **No call is refused for being long.** A build that takes eight minutes needs no
    argument: it runs in the foreground for thirty seconds, then it is a job with a card,
    an id and a completion notice. There is no "ask for a background mode" rule any more,
    so a model cannot lose work by not knowing one.
  - **No job is killed by a clock.** Nothing in the registry, the hub or the prompt sets
    a deadline, so "the budget ran out" is not an ending that exists. `killReason` has no
    `'timeout'` value, `remainingBudgetMs` is gone, and the diagnostics have no
    `bg expire` line (see the lifecycles bullet).

  The one refusal that is left is the **removed arguments** (`removedArgumentError`),
  thrown **before anything is spawned** — no process, no job, nothing started:
  `timeout_behavior was removed; pass run_type "foreground" | "background" | "global".
  There is no per-call timeout any more. Nothing was started.` (the registry adds the
  `Error: ` prefix). A bare `timeout` gets the same sentence: the two went away together,
  and silently ignoring one would read as "my timeout is in force" — the opposite of what
  this model promises.
- **The promotion is the load-bearing behaviour, and its text is the model's contract.**
  `promotionMessage` in `src/tools/execCommand.ts` produces, verbatim:

  ```
  [command moved to background: id 7]
  The command was still running after 30000 ms (30s) in <cwd>, so it was moved to the background when the 30 s foreground slice (spinney.execForegroundSeconds) ran out. Nothing was killed by the move and it keeps running.
  Command: <command>
  Working directory: <cwd>
  You may continue with other work or end your turn: the completion notice for id 7 will reach you when it finishes. Do not poll it — check_command(7) is a status read, not a wait; wait_for_command(7) waits for it and returns the moment it ends; kill_command(7) stops it.
  Output so far:
  <output>
  ```

  The first line is frozen (the guard and `docs/agents/tools.md` quote it byte for byte);
  the second names the **slice**, never a budget, because nothing is about to end the
  command. The closing line is what a model has to read like an instruction: what to do
  instead of waiting (continue other work, or end the turn), what comes back by itself
  (the notice), that a status read is not a wait, that `wait_for_command` *is* the wait,
  and that `kill_command` ends it. That sentence exists because a session in the field
  answered the same silence with **46** status reads back to back.

  `run_type: "background"` returns before any foreground time has passed, and its block is
  the same guidance with `[command started in background: id 7]` at the top.
  `run_type: "detached"` never notifies, and its block says so in as many words, naming
  both readers (`check_command`, `wait_for_command`) and the fact that no notice follows a
  wait either. A promotion is its own kind of ending in the diagnostics: `outcome=promoted`,
  neither `exit` nor anything else, because the process is alive and now belongs to the
  hub — whose card, id and completion notice take over.
- **`wait_for_command` is the wait, and it is a tool because "do not poll" is not
  enforceable by advice.** `wait_for_command(pid, seconds?)` (`src/tools/backgroundTools.ts`)
  waits at most `seconds` — default **30**, clamped to **1–300** (clamped, never refused: a
  wait is a bend of the turn, not a malformed call) — and returns the moment the command
  ends. Two endings, two shapes:
  - **It ends inside the wait** → the full result (exit code, duration, output), and the
    separate completion notice is **suppressed** (`task.notifyAgent = false`), exactly as
    the join tool this replaced did: the result *is* the signal.
  - **The wait runs out** → a **normal result, never an `Error:`** (nothing was malformed;
    an `Error:` would invite a retry with the same id). It says the command is still
    running, that nothing changed, that this is not a failure, and names the three moves
    that are left: `check_command(pid)` is a status read, `wait_for_command(pid)` may be
    called again, and `kill_command(pid)` — or killing it and running a quieter command —
    is the other way out. The notice is **restored** (`notifyAgent = true`) on that path,
    so a job the agent stopped watching still wakes it when it ends.
  - **Stop** aborts the wait: `[command wait was interrupted]`, the notice restored, the
    command untouched. The wait is a `Promise.race` between the hub's own waiter and a
    timer, and the timeout **aborts a local controller** so the waiter leaves the task —
    a timed-out wait leaves no trace.
  - A **global** job may be waited on too; its timeout text adds `This job is global (bound to
    this VS Code window), so no completion notice will arrive for it either: its result is
    read only by asking again (check_command(4) or another wait_for_command(4))`. A timed-out
    wait on a global job keeps `notifyAgent` false, because that flag is the job's identity.
- **Three tools manage a job, and they take a numeric `pid`** —
  `check_command` / `wait_for_command` / `kill_command`, all in
  `src/tools/backgroundTools.ts`, even though what `exec_command` hands back is a
  **session-local** id minted by the hub, not an OS pid. All three resolve the id through
  `hub.lookup` in the calling session, so a job started from another branch of the same
  session is reachable and a job of another session is not. `check_command` is a **status
  read** and says so; `kill_command` tears the tree down and reports what it achieved.
- **Every agent that can run `exec_command` gets the three management tools, the same
  ones.** They travel together because the default promotion makes the pair indivisible: a
  sub-agent's `npm run compile` becomes a background job after thirty seconds, and the id
  it is handed is worthless unless it can read, wait for or end that job. `subAgentTools`
  (`src/chat/runtime.ts`) therefore exposes `exec_command` **and** `check_command` /
  `wait_for_command` / `kill_command` to a **writable** sub-agent — the same list at depth
  1 and depth 2, since a depth-2 child is built from that one function — and a **read-only**
  sub-agent keeps none of the four (the write list is both blocked and hidden there). Before
  this, a sub-agent that backgrounded a job got an id it could not itself manage and only
  the user (the card's kill button / Stop) could end it.
- **Every background tool result carries the duration** (`formatDuration`,
  `src/duration.ts`): `check_command` answers `Command 3 is running. (command: …, 3.4s
  elapsed)` for a live job, `Command 3 finished with exit code 0 after 3.4s.` for a finished
  one and `Command 3 was killed after 3.1s. (command: …)` for a kill; `kill_command` answers
  `Killed command 3 after 3.4s (command: …).`; and `wait_for_command` answers `Command 3
  finished with exit code 0 after 3.4s.` An unconfirmed kill adds
  `, but the process tree did not report an exit`. A **running** `check_command` answer also
  carries one line of instruction, appended after the status line (which stays
  byte-identical) and before the output: `You may continue with other work or end your
  turn: the completion notice for id 3 will reach you when it finishes. Do not poll it —
  this is a status read, not a wait; wait_for_command(3) waits for it and returns the moment
  it ends.` — or, for a **global** job, `This job never notifies: read it once when you
  actually need the result, not in a loop. wait_for_command(3) waits for it up to the
  seconds you give.` The difference is the whole reason the line exists: a node job will wake
  the turn by itself, a global one never will, and a model told "wait" for a job that
  cannot notify would poll forever. These are **model-facing** strings, so they are
  deliberately not localized — the same locale-free token the webview's chips render, not a
  translated status word.
- **A command must not background itself** (`&`, `nohup`, `disown`, `Start-Process`): the hub
  tracks only the handle it spawned, so a process the shell started on its own has no id, no
  card and no completion notice — its output is never reported — and Stop's union kill may
  leave it running, because the kill tears down the **spawned** tree (`taskkill /T /F` on
  Windows, the detached POSIX process group) and an orphaned or re-parented child escapes
  it. `run_type` is the only way to make a command outlive the call with a card behind it.
  The rule is stated twice, on purpose: in the `exec_command` description (which is what
  every agent, sub-agents included, is sent as a schema) and in the system prompt's
  `## Delegation (when to hand work off)` line about long-running commands.
- **A third "we cannot own it" case sits next to that rule**, recorded here because it
  happened in the field: a command can hand its work to a **long-lived process the harness
  does not own** — an editor addon, a test bridge, a build server. Its children are not in
  the spawned tree, so the union kill and Stop structurally cannot reach them, and their
  output is never reported. That is an **ownership boundary, not a bug**: the hub tracks the
  handle it spawned, and a process someone else spawned was never in that set. The **known
  limitation** is that the harness deliberately does **not** scan for such stray processes —
  there is no `Show Stray Processes` command and no process scanner, because a process table
  does not say which entry belongs to which tool. The remedy is the one above: the runner is
  started by the harness (`exec_command`, in the foreground or with a background `run_type`,
  so it gets a card, an id and a completion notice), or the user stops the stray themselves.
- `BackgroundHub` (`src/chat/backgroundHub.ts`, one per window) owns every job in the window,
  keyed by `(session, node)`: `registries: Map<sessionId, Map<nodeId, BackgroundRegistry>>`
  (`registryFor(owner)` creates lazily) plus a per-session `id → owner` index
  (`lookup(sessionId, id)`). A job therefore belongs to the **node whose turn spawned it** and
  renders beside that node's card — never another branch or session. A **global** job
  (`run_type: "global"`) is not a second kind of bucket: it is a task in that same
  `(session, node)` bucket with `detached: true`, so it keeps its owner, its card and its
  place in every listing and kill — and only its **lock** and its **notice** are off (the
  composer keeps offering Send, the delivery path reads `notifyAgent: false`). Its id
  resolves **per session**, so any node in that session can check it, wait for it, or kill
  it. `listForNode`, `listForSession` (each hit tagged with its owner), `runningForNode`,
  `kill`, `waitFor` all take `sessionId`, so a task id never leaks across sessions.
  `register(owner, handle, command, cwd, detached?)` also fires the `onRegistered` hook once
  per job, synchronously, so the coordinator can create the job's card.
- The tools reach the hub through a `BackgroundAccess` set on the `ToolRegistry`
  (`setBackgroundAccess`): `currentOwner()` is the running turn's **node** — for a node worker
  it closes over `{ sessionId, nodeId }` (`SessionRuntime.workerFor`) — so `exec_command`
  from node X's turn always registers under X. There is no "which run is this?" ambiguity
  (P3).
- **A kill reports what it achieved** (`src/tools/background.ts`): `CommandHandle.kill()` is
  `() => Promise<KillOutcome>` with `KillOutcome = 'exited' | 'no-exit' | 'no-pid'` — the
  child's exit was observed, the kill was issued but no exit arrived before the deadline (so
  the process tree may still be alive), or there was no pid to signal (the spawn never
  succeeded). On Windows the tree is torn down with `execFile('taskkill', ['/PID', pid, '/T',
  '/F'])` (an argument array, never a shell string) and the child's **`exit`** event is then
  awaited for up to `KILL_CONFIRM_MS = 800` ms; on POSIX the detached process group gets
  `SIGTERM`, waits `SIGTERM_GRACE_MS = 300` ms, escalates to `SIGKILL` and waits
  `SIGKILL_CONFIRM_MS = 500` ms (`ESRCH` on the group signal is itself a confirmed exit, and
  an already-exited child answers `'exited'` without signalling anything — which is what makes
  a second `kill()` safe and idempotent). The deadlines bound the *confirmation*, not the
  kill: a stuck or unkillable process must not hold a tool result, or a Stop, open. **Why
  `exit` and not `close`**: `close` additionally waits for the stdio pipes to drain, and a
  grandchild that survived the kill (or a shell that had already left one behind) holds them
  open indefinitely — so `close` may never fire for a process that is already gone. Confirming
  on `close` was exactly the bug that hid a dead process behind a live-looking job.
- **A kill that cannot be confirmed says so, and is logged.** `BackgroundRegistry.kill()` and
  `killAll()` stay **synchronous** in their state transition — Stop and the card stay instant,
  and `complete(task, null)` is unchanged — and fire the confirmation **detached**
  (`confirmKill`), because a caller must not wait on the OS. A non-`exited` outcome sets
  `task.killUnconfirmed = true` and writes exactly one diagnostics line:
  `bg kill id=<id> pid=<pid|none> reason=<user|stop|rollover|none> outcome=<exited|no-exit|no-pid> ms=<elapsed>`
  — `reason` is the `killReason` the kill path stamped, and the line exists **only** for a
  confirmation that failed (there is no clean-`expire` line any more, because there is no
  deadline). The task also carries `killConfirm?: Promise<KillOutcome>`, so the tool layer can
  await the confirmation the registry deliberately did not await. A registered handle that
  answers no outcome at all (the plain objects the smoke tests build) is treated as nothing to
  claim: that task keeps the plain wording it had before this existed.
- The two model-facing strings a non-`exited` kill produces: `kill_command` answers ``Killed
  command ${id} after ${dur}, but the process tree did not report an exit (command:
  ${task.command}).`` and `check_command` answers ``Command ${id} was killed after ${dur}, but
  the process tree did not report an exit. (command: ${task.command})``. Confirmed kills keep
  the plain wording byte for byte — `Killed command 3 after 3.4s (command: …).` and `Command 3
  was killed after 3.1s. (command: …)` — because "killed" alone would claim a clean end the OS
  never reported. `tools/exec-kill-acceptance.js` (`npm run check:kill`) pins both halves: a
  confirmed kill is silent and sets nothing, an unconfirmed one raises the flag and logs the
  line.
- **The Windows `taskkill` trap is why the old advice was wrong** (`src/tools/shell.ts`):
  `spawnShellCommand` runs the command through Git Bash, and MSYS rewrites an argument that
  looks like a Unix path into a Windows one before a **native** child sees it — so
  `taskkill /PID 1234 /T /F` reached taskkill as `C:/Program Files/Git/PID …` and was rejected
  with `invalid argument/option`, silently teaching a model that killing a stuck process "does
  not work" (`//F`, the MSYS double-slash escape, was the workaround, and MSYS could de-fang
  that too). `src/tools/shell.ts` now sets `MSYS_NO_PATHCONV: '1'` in the Git Bash env on
  Windows — the switch means nothing to a POSIX bash, so it is not set there — so a native
  tool receives the argument as written and the double-slash workaround is no longer needed.
  `tools/shell-argv-acceptance.js` (`npm run check:shell`, part of `vscode:prepublish`) drives
  the compiled shell selection the way `spawnShellCommand` does (`shell.file` + `buildArgs` +
  `env`) and pins the argv a native child actually receives, because nothing about this
  failure is visible in the tool's source.
- **A job's card is a flying `kind:'bg'` node, not a panel.** `SessionRuntime.onBackgroundRegistered`
  creates it under the owning turn node once per job: `bgTaskId` = the session-local id,
  `bgCommand` = the command, title = the command clipped to 60 chars, and **`bgDetached`** =
  `task.detached === true` — how the job started is a fact of the registration, so the record
  carries it from birth (see the dock bullet: the window's teardown never reaches the terminal
  snapshot). It is a **sidecar**
  exactly like a sub-agent window: `attachNode` keeps sidecars after the turn spine,
  and `isSidecar` (`kind === 'agent' || kind === 'bg'`) keeps it out of the API path
  (`pathMessages`) and out of the checkout chain (`leafOf`). The create path saves and restores
  `session.activeNodeId`, so a job never moves the view focus. The card lives in the same
  right-hand column-major grid as the sub-agent windows.
- **Webview rendering:** there is no standalone panel and no dock at the bottom of a card any
  more (`#bg-panel`, `.node-bg`, `.bg-dock-*`, `.bg-item*` are gone) — the one dock the webview
  has is the **window-global** `#term-dock` (its own bullet below), which is a second view of the
  same jobs. `renderBgBody` fills a `kind:'bg'` card from the tree node's own meta plus the latest
  snapshot, **through the shared body builder** (`buildBgBody`: the status row of `#taskId` +
  status + the **elapsed chip** (and the same value as the card head's status chip), then the
  command and the output tail — the same three parts a dock row renders, so the two views cannot
  disagree) — plus a `kill` button (built by
  `killBackgroundButton`, which posts `killBackground { id }`) only while the job runs. A
  **global** job's card also wears the `global` badge: `treeMessage` sets `bgDetached` from
  the **live task** (the hub's `lookup`), never from the node, so a card restored after a
  reload — which has no task left to ask — renders as the plain record it is, and the badge
  says why that job's composer stayed on Send. Its tooltip names `check_command` /
  `wait_for_command`, the tools that read it.
- **The elapsed chip is rendered locally, from clocks the host sends.** The snapshot ships
  `startedAt` and `finishedAt`, never a counter: a running card ticks its chip from
  `startedAt` on a **250 ms `setInterval` in the webview**, so a command that prints nothing
  for minutes still shows a moving number and the host never pushes a snapshot just to advance
  the display. A finished card freezes the chip at `finishedAt - startedAt` (the host's own
  value — the local ticker stops, it never keeps counting), and a record card restored after a
  restart, which has no live task, shows the node's persisted `bgElapsedMs`. Both numbers go
  through `formatDuration` (`src/duration.ts`, mirrored in `media/main.js`, because no host
  string arrives per tick); the token is locale-free and deliberately **not** localized —
  `420ms`, `3.4s`, `42s`, `3m 12s`, `1h 3m`.
- **Snapshot:** `postBackgrounds` sends one flat `{ type: 'backgrounds', tasks }` list, every
  task (`BackgroundInfo`) tagged with `nodeId` (its owner), `cardNodeId` (the `kind:'bg'` card
  mirroring it) and `pendingDelivery`, and carrying the job's two **clocks** — `startedAt` plus
  `finishedAt` (`null` while it runs). A pre-computed `elapsed` field is gone: the webview
  derives the number, so no snapshot has to be sent per second. The list carries running jobs
  plus finished ones still awaiting delivery; a delivered job drops out, but its card keeps the
  persisted terminal state. The webview keys the snapshot by `task.id` and patches the card of
  each tree node with a `bgTaskId` (`renderBackgrounds`, `media/main.js`); the host coalesces
  the snapshot (~200 ms) so a chatty process cannot freeze the webview.
- **The window-global terminal dock.** Every **`global`** command of the window — running or
  finished, whatever session — is also one list, on **every** chat tab. A `background` job is a
  node job and lives on the card beside its node; it is never here (the dock is the only place a
  session-wide job that never notifies can be seen or killed). `#term-dock` is a `fixed` element
  at the top-right of the body (`z-index` 1500: above the cards and the autoscroll origin at 1000,
  below the node / snippet menus at 2000), with a collapsible header `Terminals · {0} running` and
  one row per job. It is a **view** of the same jobs, never a second state: a row's body is
  `buildBgBody` — the builder the `kind:'bg'` card uses — plus the session title, the `kill`
  button while the job runs, the `global` / `Delivered` badges, the local elapsed chip and the
  **✕** when the job is finished. The host broadcasts it as `backgroundsGlobal`
  (`ChatViewProvider.globalBackgroundJobs` / `postBackgroundsGlobal`), coalesced ~200 ms exactly
  like the per-session snapshot, to **every** open panel; a tab that comes up (`ready`) is sent
  one at once, so a reload never shows an empty dock until the next job happens to change.
  Membership is decided by the **live** task (`task.detached === true`) and, for a job whose
  process is gone, by the durable `bgDetached` flag written onto its record, so a reload draws
  the same dock. That flag is written **at registration** (`onBackgroundRegistered`), not only
  when the job ends: the window's own teardown disposes every runtime (`dispose()` marks it
  `dead`) and only then kills the jobs, so `onBackgroundFinished` returns before it could
  snapshot anything, and a global job still running at window close would otherwise lose its
  dock row — the record, normalized to `interrupted`, would come back invisible. The terminal
  snapshot writes it again, so a task read at its end cannot settle a record that disagrees.
  Two traps that are already paid for: a registration must clear a stale
  `bgDismissed` entry for its id (dismissals persist, the id counter does not — it restarts at 1
  after every reload), and the record's `kind` can only say `background`, so a notice's producer
  travels separately (`DisplayItem.producer`) or a repaint draws a sub-agent batch as a terminal.
  `jobs[]` is de-duplicated by `(sessionId, id)` — a task id is session-local, so the pair is a
  job's identity and the same number in two sessions is two jobs — and built from the live hub
  tasks of every session **plus** the persisted `kind:'bg'` record nodes of every session
  (delivered ones included: the hub is in-memory, the record is what survives a reload).
  Each entry carries `sessionId`, `sessionTitle`, `id`, `cardNodeId`, `command`, `status`,
  `exitCode`, `killed`, `detached`, `startedAt`, `finishedAt`, `outputTail`, `delivered` and
  `dismissed`. `detached` is the **live** task's flag (a restored record has no task to ask,
  exactly like the card's `bgDetached`), and `startedAt` / `finishedAt` are the host clocks the
  row's chip ticks from and freezes at. Order: running first, then finished, newest first inside
  each group; a job whose card is gone (its branch was deleted while the process still runs) keeps
  its row with `cardNodeId: null`, because the process is real and the dock is the only place left
  that could kill it. The rows are diffed by a per-row signature, so a job that prints repaints
  **its own row** and nothing else, and the dock lives outside `#tree-canvas`: no dock repaint ever
  runs `relayout()`. Three actions, each resolved in the session that **owns** the job:
  `killBackground {sessionId, id}` (the id travels with its session, so any tab can kill any
  session's job; the owning runtime is created on demand — which is what paints the job's card and
  delivers the kill's notice), `dismissBackground {sessionId, cardNodeId}` and
  `clearFinishedBackgrounds` (every finished job of the window, every session). The membership
  rule has its own guard: `tools/dock-acceptance.js` (`npm run check:dock`, part of
  `vscode:prepublish`) drives `globalBackgroundJobs` on a fake `this` — the live flag, the durable
  record, the dismissal, the stale-dismissal clear on registration, the orphan row and the same id
  in two sessions — and drives the kill path through a real `SessionRuntime` and hub, because this
  is the one method that decides what the dock lists and it had no guard at all.
- **Removing a job from the dock is a field on the record, not a deletion.**
  `TreeNode.bgDockDismissed` (`kind:'bg'` only, `true` or absent) is persisted with the session, so
  a reload keeps the removal without a second store; the provider keeps the in-memory view as a
  set of `(sessionId, taskId)` handles, rebuilt from the sessions at load (`rebuildBgDismissed`,
  and forgotten with a session or a cleared conversation). Every dismissal writes the record
  through `persistNow()` and reposts the snapshot. **Two removal gestures stay separate:** the
  tree's delete (a card's own delete button / `deleteBranch`) removes the record and its branch,
  while the dock's ✕ only stops listing it — the card keeps its terminal state, its `Delivered`
  badge and its place in the owning node's grid. A **running** job can never be dismissed (the ✕
  is not rendered for one and the host refuses it), so the dock can never hide work in progress;
  `Clear finished` skips a running job for the same reason, and the webview refuses a row that
  still arrives with `dismissed: true` — the host filters dismissed jobs out, so the two halves of
  that rule are independent.
- **Completion → injected into the owning node.** `onBackgroundFinished` first snapshots the
  terminal state onto the card (`snapshotBackgroundCard`: `bgExitCode`, `bgKilled`,
  `bgElapsedMs`, `bgOutputTail` (≤800 chars), `bgCommand`, node status `done`/`interrupted`) —
  the hub is in-memory, the card must outlive it — then queues one `SignalNotice`
  (`buildBackgroundSignal`; `pushSignal`; 75 ms debounce `scheduleSignalDrain`) keyed by the
  **owner** node (`nodeId: owner.nodeId`, never the view focus). The notice text and the card's
  status text both name how long the job ran: the notice reads
  ``Background command `cmd` (id 3) finished with exit code 0 after 3.4s.`` (`… was killed by
  the user after 3.4s.` for a kill), while the card's status line is the compact `exit 0 (3m
  12s)` (`killed (3m 12s)` for a kill).
- Delivery has two paths, and neither creates a node:
  - owner turn still running → the agent hook `Agent.setSignalHandler` is called after the
    **whole** tool batch of an assistant round and pushes one combined `user` message
    (`combineSignalText`), so the model sees the notice on its **next** request, mid-turn;
  - owner node idle → `drainSignals` delivers the same text as an **injected turn on that same
    node** (`beginInjectedTurn`, `fresh:false`: no node is created, no view focus moves), gated
    per node (`isNodeLive`) and by `host.isHeld()`.
- **The notice block renders inside the owning card:** `renderSignalCards` pushes
  `DisplayItem.kind:'background'` into that node's own `displayItems` (so a reload re-renders
  it) and posts `backgroundNotice { nodeId, item }`; the webview's `addBackgroundNotice`
  appends a `.msg.bgnotify` block whose badge is `BG` for a job and `SUB` for a sub-agent batch.
  An injected signal is deliberately **never** a `kind:'user'` display item — a replayed user
  item would be skipped or would clobber the pinned prompt. Because a job can be delivered
  mid-stream, `backgroundNotice` first finalizes the streaming answer. `N` notices queued at
  the same boundary merge into **one** message (D2).
- **`Delivered` / terminal snapshot (D1).** `TreeNode.delivered` means the completion signal
  reached its reader: the card is settled when the notice is delivered (`settleSignals`,
  followed by a `postTree()`), the job leaves the `backgrounds` snapshot, and the card stays as
  a record with a `Delivered` badge plus its persisted `bg*` terminal fields. A tool-initiated
  kill or a `wait_for_command` that carried the result (`notifyAgent=false`) skips the notice
  and settles the card directly. A **global** job is the third ending no notice follows, and
  the only one that is structural rather than incidental: `onBackgroundFinished` returns before
  a `SignalNotice` is ever built — nothing is queued for a tool boundary, nothing is injected
  into an idle owner, nothing is written back — and it settles the card itself (`delivered`
  flips, the terminal state is repainted), because the agent was never the waiter: it asks with
  `check_command` or `wait_for_command`. After a restart the card survives `pruneSession`, but
  never claims to be live: the generic normalization turns a stored `running` into
  `interrupted` and `delivered` is forced true, because the hub is in-memory and the process was
  torn down. Its body is then rendered from the node's `bg*` snapshot (`outputTailFor`,
  `media/main.js`).
- Stale notices are dropped, not delivered: `signalStale` discards a signal whose task was
  waited on / killed through a tool (`notifyAgent !== true`) or whose owning node is gone.
  `onKillBackground` (a card's kill button) asks for `notifyAgent: true`, so the model is told
  about the kill at the next delivery point.
- While an external controller holds the window (`host.isHeld()`), the hook returns `[]` and the
  idle drain backs off (500 ms) instead of starting a turn — the reload must not be refused with
  "agent is busy".
- **Stop is a union kill, and it never continues the conversation.** The composer's bottom-right
  button is Stop while a node runs *or* while it still owns unfinished work (`state.lockedNodes`);
  there is no separate banner and the input stays usable, exactly as while a turn streams.
  Pressing it (`SessionRuntime.stop(nodeId)`, `POST /stop {nodeId}`) stops that node's turn,
  kills every background terminal it owns — *and* the terminals its running sub-agents own,
  since a sub-agent's `exec_command` registers under the sub-agent's node (`killJobsOf`) — and
  aborts **the whole sub-agent subtree** (`subAgentSubtree`: a depth-1 sub-agent may be running
  depth-2 children), then suppresses the notices that would have followed. Nothing is dropped:
  each notice is **written back** (`queueWriteback` / `flushWritebacks`) into that node's own
  history as a `user` message and rendered in its card as the usual `.bgnotify` block, so it
  reaches the model with the next prompt / ▶ Continue and cannot start a turn on its own. A
  notice produced below a sidecar is retargeted to the turn node that owns the line
  (`turnOwnerOf`), because a sidecar's history is never sent. The node is remembered in
  `stoppedLines` until the user continues that line, so a stopped sub-agent is **never resumed**
  by its own settling children (`onAsyncBatchDone` / `deliverResumeAsync` / `pushSignal` all
  redirect there). A turn that is still winding down defers the write (`finishTurn` flushes
  again, and the signal drain retries), so the text can never slip past a request built in
  between. The fine-grained path is unchanged: a card's ✕ kills that one job *and* tells the
  model (`notifyAgent: true`). A **`wait_for_command` whose wait is interrupted by Stop** is a
  small, separate path: it answers `[command wait was interrupted]`, restores the job's notice
  and leaves the command running, because stopping the *wait* is not stopping the **work** —
  the union kill above is what ends the work, and it runs on the same node.
- **A context rollover is the union kill's third caller** (`SessionRuntime.rolloverContext`,
  see `context-rollover.md`). It begins with the *same* path a Stop takes — the node's
  background terminals, its whole sub-agent subtree (with the terminals the sub-agents own) and
  any notice already queued for it, all converted into **writebacks** into that node's own card
  and history — and only the aftermath differs: P is flushed and explicitly **re-dumped**, so
  the kill notices and the jobs' terminal state survive on disk even though a `kind:'bg'` card
  has no dump of its own (that is why the kill record has to carry the job's command, final
  state and output tail), and the new window's harness text points at that file as the copy to
  read. Leaving the jobs running would be wrong twice over: their completion notices are
  addressed to a line nobody continues from, and their results could never reach the new window,
  which by construction sends none of the old history — the model would be told about work it
  cannot see. The rollover also awaits each killed sub-agent's settle promise (~2 s, bounded)
  before composing the message, because a sub-agent's dump is written inside its own `finish`
  handler.
- **Delete / clear / branch deletion:** a session, a cleared conversation or a branch that owns
  *running* jobs asks a modal confirmation first — `confirmKillBackgrounds` for delete/clear,
  `deleteBranchInteractive` for a branch (its count comes from `runningBackgroundsForNodes`) —
  and only then kills the jobs (the process trees are torn down). Nothing is killed behind the
  user's back. A *turn* still streaming refuses the delete/clear outright instead of confirming
  (`rt.isRunning()`). Clearing drops the queue and the card index; detaching a branch drops the
  signals queued for the removed nodes, calls `hub.removeNode(..., { kill: true })` and forgets
  the cards whose nodes are gone. A `bg` card has no children, so its own delete button
  (`deleteBranch`) is equivalent to deleting that one record.
- **Lifecycles** (`src/tools/background.ts` owns the process plumbing): `BackgroundTask` carries
  `startedAt` plus `finishedAt: number | null` — `finishedAt` is stamped once when the job settles
  (exit, kill, or a failed start) and is what a snapshot's chip freezes on, while the card's
  persisted `bgElapsedMs` is the same subtraction done once when the terminal state is snapshotted.
  A task has **no deadline field at all**: the `timeoutMs` / `deadlineAt` pair, the single armed
  `setTimeout`, the registry's `budgetTimers` map and `remainingBudgetMs` were deleted with the
  budget model, so a job simply runs. A **global** job carries `detached: boolean` — set once at
  `register` (its last argument) and never changed afterwards — and the registry sets
  `notifyAgent: false` together with it, because that is the mechanism the delivery path already
  understands. The coordinator needs to read only `detached` for the lock rule, and the job itself
  is counted like any other by `runningCount`: "detached" is a **lock and notice** rule, not a
  reason to hide a running process from Stop, the delete/clear confirmation or the control plane.
  Exactly two `[perf]` lines describe the background half: `bg register id=<id> pid=<pid|none>
  detached=<true|false>` (no `budget=` field) and `bg kill id=<id> pid=<pid|none>
  reason=<user|stop|rollover|none> outcome=<exited|no-exit|no-pid|unknown> ms=<elapsed>`, the
  latter written **only** when the confirmation failed. `hub.removeNode(session, node, {kill})`
  drops one node's jobs + registry (the session counter is kept — ids are never reused),
  `hub.removeSession(session, {kill})` drops a whole session (`SessionRuntime.dispose()`), and
  `hub.killAll()` tears every job down (window dispose) so nothing is orphaned.
  `spawnShellCommand`/`killChildProcess` do the process-tree kill and report the `KillOutcome`
  above (Windows `taskkill /T /F`, otherwise the detached POSIX process group), and the handle
  keeps draining output past `OUTPUT_CAP` (a per-stream `StringDecoder` keeps a multi-byte
  character split across pipe chunks intact).
  `tools/exec-runtime-acceptance.js` (`npm run check:exec`, part of `vscode:prepublish`) pins the
  whole model: the default `foreground` and its promotion, the three run types, the removed
  argument sentence as the model reads it, a job surviving well past the foreground slice with
  no `timeoutMs` / `deadlineAt` / `remainingBudgetMs` / `bg expire` anywhere, `wait_for_command`
  finishing early (notice suppressed) and timing out (a normal result, notice restored), the
  Stop abort path, and `check_command` / `kill_command` against a real registry. It stubs the
  settings **keyed by name** (`execForegroundSeconds` → 1 s), so a leftover read of a deleted
  key has nowhere to hide and the whole guard runs in about ten seconds.
  `ControlSessionInfo.backgroundNodes` is unchanged: it reports the **owning turn nodes** (from
  the hub's per-`(session, node)` registries), so the control plane — and the `background`
  acceptance suite — can verify ownership survived a view move. The `kind:'bg'` cards are
  display-only and never appear there.
- **A background terminal cannot drive an immediate window reload.** `POST /reload-window`
  refuses while any sub-agent or **node** background terminal is live (`controlReloadWindow` →
  `anyRunningBackground()` → `hasRunningNodeBackground()`; a `detached` job is fire-and-forget and
  deliberately does not block a reload), so a hub-owned job that calls it is refused by its own
  existence, and a foreground call from inside a turn is refused by the turn check. What a command
  **can** do is ask for a **deferred** reload — `node tools/reload-window.mjs --message "…"`, i.e.
  `POST /reload-window { idle: true, continue }`: the window reloads itself once this node, its
  sub-agents and its background terminals are all quiet, and the message is delivered back to the
  node that asked. See `control-plane.md`.
