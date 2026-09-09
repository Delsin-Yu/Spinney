## Background terminals
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

