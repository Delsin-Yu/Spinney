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
  renders beside that node's card — never another branch or session. `listForNode`,
  `listForSession` (each hit tagged with its owner), `runningForNode`, `kill`, `waitFor` all take
  `sessionId`, so a task id never leaks across sessions. `register` also fires the
  `onRegistered` hook (`backgroundHub.ts:46`, called at `backgroundHub.ts:104-107`) once per job,
  synchronously, so the coordinator can create the job's card.
- The tools reach the hub through a `BackgroundAccess` set on the `ToolRegistry`
  (`setBackgroundAccess`): `currentOwner()` is the running turn's **node** — for a node worker it
  closes over `{ sessionId, nodeId }` (`SessionRuntime.workerFor`) — so `exec_command` from node
  X's turn always registers under X. There is no "which run is this?" ambiguity (P3).
- Three tools manage an id: `check_background_terminal(id)`, `kill_background(id)`,
  `join_background(id)` (`join` blocks until it finishes, honours Stop). All resolve the id
  through `hub.lookup` in the calling session.
- **A job's card is a flying `kind:'bg'` node, not a dock.** `SessionRuntime.onBackgroundRegistered`
  (`runtime.ts:2360`) creates it under the owning turn node once per job: `bgTaskId` = the
  session-local id, `bgCommand` = the command, title = the command clipped to 60 chars
  (`runtime.ts:2371-2377`). It is a **sidecar** exactly like a sub-agent window: `attachNode`
  keeps sidecars after the turn spine (`tree.ts:249-262`), and `isSidecar` (`tree.ts:349-351`,
  `kind === 'agent' || kind === 'bg'`) keeps it out of the API path (`pathMessages`,
  `tree.ts:302-311`) and out of the checkout chain (`leafOf`, `tree.ts:328-340`). The create path
  saves and restores `session.activeNodeId` (`runtime.ts:2368-2376`), so a job never moves the
  view focus. The card lives in the same right-hand column-major grid as the sub-agent windows
  (`media/tree.js` `isSidecarKind` `tree.js:53-56`, `agentKids` `tree.js:99-101`).
- **Webview rendering:** there is no standalone panel and no dock at the bottom of a card any more
  (`#bg-panel`, `.node-bg`, `.bg-dock-*`, `.bg-item*` are gone). `renderBgBody`
  (`main.js:821-861`) fills a `kind:'bg'` card from the tree node's own meta plus the latest
  snapshot: head = `#taskId` + status + elapsed, body = the command and the output tail, and a
  `kill` button (`main.js:852-858`, posts `killBackground { id }`) only while the job runs.
- **Snapshot:** `postBackgrounds` sends one flat `{ type: 'backgrounds', tasks }` list, every task
  (`BackgroundInfo`, `runtime.ts:139-157`) tagged with `nodeId` (its owner), `cardNodeId` (the
  `kind:'bg'` card mirroring it, `runtime.ts:2284`) and `pendingDelivery`. The list carries running
  jobs plus finished ones still awaiting delivery (`runtime.ts:2320-2323`); a delivered job drops
  out, but its card keeps the persisted terminal state. The webview keys the snapshot by `task.id`
  and patches the card of each tree node with a `bgTaskId` (`main.js:868-887`); the host coalesces
  the snapshot (~200 ms, `runtime.ts:2301-2311`) so a chatty process cannot freeze the webview.
- **Completion → injected into the owning node.** `onBackgroundFinished` (`runtime.ts:2390`) first
  snapshots the terminal state onto the card (`snapshotBackgroundCard`, `runtime.ts:2406-2421`:
  `bgExitCode`, `bgKilled`, `bgElapsedMs`, `bgOutputTail` (≤800 chars), `bgCommand`, node status
  `done`/`interrupted`) — the hub is in-memory, the card must outlive it — then queues one
  `SignalNotice` (`runtime.ts:2442-2458`, `pushSignal` `runtime.ts:2465`, 75 ms debounce
  `runtime.ts:2479`) keyed by the **owner** node (`nodeId: owner.nodeId`, never the view focus).
- Delivery has two paths, and neither creates a node:
  - owner turn still running → the agent hook `Agent.setSignalHandler` (`agent.ts:261`,
    `agent.ts:344`; wired in `workerFor`, `runtime.ts:433`) is called after the **whole** tool batch
    of an assistant round (`agent.ts:625-634`) and pushes one combined `user` message
    (`combineSignalText`, `runtime.ts:166-178`), so the model sees the notice on its **next
    request**, mid-turn (`takeSignalsFor`, `runtime.ts:2494-2513`);
  - owner node idle → `drainSignals` (`runtime.ts:2524-2591`) delivers the same text as an
    **injected turn on that same node** (`beginInjectedTurn`, `runtime.ts:1110`, `fresh:false`:
    no node is created, no view focus moves), gated per node (`isNodeLive`, `runtime.ts:2057`) and
    by `host.isHeld()`.
- **The notice block renders inside the owning card:** `renderSignalCards` (`runtime.ts:2646-2677`)
  pushes `DisplayItem.kind:'background'` into that node's own `displayItems` (so a reload re-renders
  it) and posts `backgroundNotice { nodeId, item }`; the webview's `addBackgroundNotice`
  (`main.js:694-712`) appends a `.msg.bgnotify` block whose badge is `BG` for a job and `SUB` for a
  sub-agent batch. An injected signal is deliberately **never** a `kind:'user'` display item — a
  replayed user item would be skipped or would clobber the pinned prompt. Because a job can be
  delivered mid-stream, `backgroundNotice` first finalizes the streaming answer
  (`main.js:2451-2457`). `N` notices queued at the same boundary merge into **one** message (D2).
- **`Delivered` / terminal snapshot (D1).** `TreeNode.delivered` (`tree.ts:75`) means the
  completion signal reached its reader: the card is settled when the notice is delivered
  (`settleSignals`, `runtime.ts:2679-2695`, followed by a `postTree()`), the job leaves the
  `backgrounds` snapshot, and the card stays as a record with a `Delivered` badge
  (`main.js:896-911`, `.node-delivered-badge`) plus its persisted `bg*` terminal fields. A
  tool-initiated kill/join (`notifyAgent=false`) skips the notice and settles the card directly
  (`runtime.ts:2395-2402`). After a restart the card survives `pruneSession` (`tree.ts:454-463`),
  but never claims to be live: the generic normalization turns a stored `running` into
  `interrupted` (`tree.ts:437-441`) and `delivered` is forced true (`tree.ts:447-453`), because the
  hub is in-memory and the process was torn down. Its body is then rendered from the node's `bg*`
  snapshot (`main.js:799-818`).
- Stale notices are dropped, not delivered: `signalStale` (`runtime.ts:2632-2641`) discards a
  signal whose task was joined/killed through a tool (`notifyAgent !== true`) or whose owning node
  is gone. `onKillBackground` (`runtime.ts:2699-2711`, a card's kill button) asks for
  `notifyAgent: true`, so the model is told about the kill at the next delivery point.
- While an external controller holds the window (`host.isHeld()`), the hook returns `[]` and the
  idle drain backs off (500 ms, `runtime.ts:2343-2349`) instead of starting a turn — the reload
  must not be refused with "agent is busy".
- **Delete / clear / branch deletion:** a session, a cleared conversation or a branch that owns
  *running* jobs asks a modal confirmation first — `confirmKillBackgrounds` for delete/clear,
  `deleteBranchInteractive` for a branch (its count comes from
  `runningBackgroundsForNodes(branchIds)`) — and only then kills the jobs (the process trees are
  torn down). Nothing is killed behind the user's back. A *turn* still streaming refuses the
  delete/clear outright instead of confirming (`rt.isRunning()`). Clearing drops the queue and the
  card index (`runtime.ts:2744-2745`); detaching a branch drops the signals queued for the removed
  nodes, calls `hub.removeNode(..., { kill: true })` and forgets the cards whose nodes are gone
  (`runtime.ts:2766-2791`). A `bg` card has no children, so its own delete button
  (`deleteBranch`) is equivalent to deleting that one record.
- **Lifecycles** (`src/tools/background.ts` owns the process plumbing):
  `hub.removeNode(session, node, {kill})` drops one node's jobs + registry (the session counter is
  kept — ids are never reused), `hub.removeSession(session, {kill})` drops a whole session
  (`SessionRuntime.dispose()`), and `hub.killAll()` tears every job down (window dispose) so
  nothing is orphaned. `spawnShellCommand`/`killChildProcess` do the process-tree kill (Windows
  `taskkill /T /F`, otherwise the detached POSIX process group), keep draining output past
  `OUTPUT_CAP` (a per-stream `StringDecoder` keeps a multi-byte character split across pipe chunks
  intact). `ControlSessionInfo.backgroundNodes` is unchanged: it reports the **owning turn nodes**
  (from the hub's per-`(session, node)` registries, `runtime.ts:482-490`), so the control plane —
  and the `background` acceptance suite — can verify ownership survived a view move. The `kind:'bg'`
  cards are display-only and never appear there.
