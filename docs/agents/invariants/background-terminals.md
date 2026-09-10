## Background terminals
- `exec_command` accepts a `timeout_behavior` arg (`stop` default, `move_to_background`,
  `start_in_background`). `start_in_background` launches immediately and returns a
  **session-local** `id`; `move_to_background` runs it in the foreground and, if still running
  at `timeout`, promotes it instead of killing it. The id is minted by the hub
  (`BackgroundHub.mintId`) — a monotonic per-session counter, **not** a real OS pid — and is only
  resolvable inside its own session.
- `BackgroundHub` (`src/chat/backgroundHub.ts`, one per window) owns every job in the window,
  keyed by `(session, node)`: `registries: Map<sessionId, Map<nodeId, BackgroundRegistry>>`
  (`registryFor(owner)` creates lazily) plus a per-session `id → owner` index
  (`lookup(sessionId, id)`). A job therefore belongs to the **node whose turn spawned it** and
  renders inside that node's card — never another branch or session. `listForNode`,
  `listForSession` (each hit tagged with its owner), `runningForNode`, `kill`, `waitFor` all take
  `sessionId`, so a task id never leaks across sessions.
- The tools reach the hub through a `BackgroundAccess` set on the `ToolRegistry`
  (`setBackgroundAccess`): `currentOwner()` is the running turn's **node** — for a node worker it
  closes over `{ sessionId, nodeId }` (`SessionRuntime.workerFor`) — so `exec_command` from node
  X's turn always registers under X. There is no "which run is this?" ambiguity (P3).
- Three tools manage an id: `check_background_terminal(id)`, `kill_background(id)`,
  `join_background(id)` (`join` blocks until it finishes, honours Stop). All resolve the id
  through `hub.lookup` in the calling session.
- When a job finishes (naturally or via kill), `SessionRuntime.onBackgroundFinished` builds a
  notice and queues it; it is delivered **now** when the session is idle, else when the current
  turn ends (`drainBackgroundQueue` → `injectBackgroundNotices`). The notice turn is based on the
  node that **owns** the job (`beginTurn(title, { parentId: ownerNodeId, pan: false })`), never on
  the view, so a job in node X finishing while the user is on node Y lands in X without moving
  anything. `N` queued notices batch into **one** turn; the card is posted per node as a
  `backgroundNotice { nodeId, item }`.
- Tool-initiated kills (`kill_background`) and joins (`join_background`) set `notifyAgent=false`;
  the runtime marks such a task delivered (`task.notifyAgent !== true`) and drops any stale queued
  notice (`taskAlreadyHandled`), so the tool result is the only signal — no duplicate notice.
- The webview has **no** standalone panel (`#bg-panel` is gone): each node card bottom-docks its
  own jobs. `postBackgrounds` sends one flat `{ type: 'backgrounds', tasks }` list, every task
  (`BackgroundInfo`) tagged with `nodeId`; the webview groups by `nodeId` and renders each node's
  dock. The list carries running jobs plus finished ones still **pending delivery**
  (`status === 'finished' && !task.delivered`); once delivered (or handled by a join/kill) a job
  drops out, so the dock never accumulates stale entries. `postBackgrounds` is coalesced (~200ms)
  so a chatty process cannot freeze the webview.
- **Delete / clear / branch deletion:** a session, a cleared conversation or a branch that owns
  *running* jobs asks a modal confirmation first — `confirmKillBackgrounds` for delete/clear,
  `deleteBranchInteractive` for a branch (its count comes from
  `runningBackgroundsForNodes(branchIds)`) — and only then kills the jobs (the process trees are
  torn down). Nothing is killed behind the user's back. A *turn* still streaming refuses the
  delete/clear outright instead of confirming (`rt.isRunning()`).
- **Lifecycles** (`src/tools/background.ts` owns the process plumbing):
  `hub.removeNode(session, node, {kill})` drops one node's jobs + registry (the session counter is
  kept — ids are never reused), `hub.removeSession(session, {kill})` drops a whole session
  (`SessionRuntime.dispose()`), and `hub.killAll()` tears every job down (window dispose) so
  nothing is orphaned. `spawnShellCommand`/`killChildProcess` do the process-tree kill (Windows
  `taskkill /T /F`, otherwise the detached POSIX process group), keep draining output past
  `OUTPUT_CAP` (a per-stream `StringDecoder` keeps a multi-byte character split across pipe chunks
  intact). `ControlSessionInfo.backgroundNodes` reports the nodes that still own a running job, so
  the control plane — and the `background` acceptance suite — can verify ownership survived a view
  move.
