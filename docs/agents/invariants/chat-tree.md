## Chat Tree invariants
- Session titles are derived, never authoritative: `AgentSession.title` is shown in
  the sidebar / tab title only, and the automatic namer (`sessionTitles.ts`) may
  rewrite it after a turn. `titleLocked` (set by a manual rename or the
  `rename_session` tool) freezes it, and a rename must never touch `updatedAt`
  (the sidebar sorts by it). Renaming does not change history, branching or the
  prompt in any way.
- `TreeNode.messages` (non-empty) always starts with a `user` role message; the
  system prompt is **never** stored in a node (synthesized per activation).
- A branch's flat API history is `pathMessages(session, nodeId)` = `[system, ...path
  nodes' messages]`. `SessionRuntime.buildPath` builds it when a run starts on that node
  (`beginTurn` / `beginInjectedTurn`) and hands it to `agent.setMessages`. `session.activeNodeId`
  is only the **view focus** (which branch the tab shows, where the composer docks): it names the
  path the *next* user turn branches from, not the node a live run is writing to. The history must
  go through `Agent.sanitizeMessages` (the sanitized copy is **never** written back into the nodes
  — `pathMessages` returns the nodes' own message objects by reference, so `sanitizeMessages` must
  not mutate them: the reasoning→content healing builds a `{ ...msg }` copy). `prefixLen` is
  measured on the sanitized path.
- A turn's message slice is written **once**, in `finishTurn`, and the basis is recorded where the
  history is swapped: `beginTurn` (a fresh node, based on the parent's path — `opts.parentId`
  overrides it for an injected notice) and `beginInjectedTurn` (a sub-agent / background-notice
  turn, based on the node it continues) each call `worker.agent.setMessages(buildPath(...))` and
  record `run.prefixLen` / `run.prefixTail` from the result in the same block, so the basis and the
  array cannot drift apart. `prefixLen` is always an index into **`agent.getMessages()`** (which
  includes the leading system message). `checkoutNode` no longer swaps any history at all — it only
  moves the **view** (each node has its own worker; see the one-agent-per-node bullet) — but a
  node's worker can still be re-based by a *later* run, so an untouched numeric basis would slice
  from the wrong offset and store ancestor history inside the turn's node. That is how one session
  reached `1,283,056` tokens — a single node had inherited ~1,100 duplicated messages, so the next
  request sent the whole conversation twice while the header still read `ctx 65%` (the *previous*
  turn's `usage.prompt_tokens`). `finishTurn` therefore verifies the basis by **identity**
  (`prefixLen > 0 && messages[prefixLen - 1] === prefixTail`) and, when the history was swapped
  mid-turn, writes nothing and logs `[slice]` instead. A queued notice whose node is **not** in the
  session is dropped, so a batch finishing after a session switch never injects a turn into another
  session's agent. Using a node's own `messages.length` as the basis re-includes ancestor history in
  that node.
- **One agent per node** (`SessionRuntime.workerFor`): every node that has ever run a turn owns a
  worker — its own `Agent` (history = `buildPath(session, nodeId)`, and its sub-agent / hop /
  rename / event hooks all close over that node) plus its own `ToolRegistry` (whose
  `BackgroundAccess.currentOwner()` is that node). A run is `runs.set(nodeId, run)`
  (`runs: Map<nodeId, TurnRun>`), so a new turn is refused only when **that node** already has a
  live run — `beginTurn` checks `runs.has(parentId)`, `beginInjectedTurn` checks `runs.has(node.id)`
  — which is the composer's Stop-not-Send rule in the UI. Two *different* nodes of one session may
  stream at once. `isRunning()` = `busy || runs.size > 0`; `runningNodes()` = `runs.keys()`.
- Who owns the node: `beginTurn` creates a fresh node, so its run **assigns**
  (`node.messages = added`, `run.fresh = true`). `beginInjectedTurn` continues a node that already
  holds the turn that spawned it, so its run **appends** (`node.messages = [...node.messages,
  ...added]`, `run.fresh = false`) — assigning there would replace the spawning turn's messages
  with the notice's.
- Branching: every user message creates a new node under the checked-out node;
  sending on a node that already has children makes a sibling (a new branch).
  A branch switch costs only a prefix cache miss — the shared prefix stays cached.
- `attachNode` repairs a missing parent by attaching the node to the **root**
  instead of leaving it unreachable (an orphan would still become the checkout
  point and silently blank the history); `leafOf` skips `kind:'agent'` children,
  so a restored checkout point can never land on a sub-agent sidecar.
- Interrupt bookkeeping is **per node** (`interruptedNodes: Map<nodeId, Agent>`): an interrupted
  run records its worker (`interruptedNodes.set(run.nodeId, run.agent)`), whose `Agent` already
  captured the aborted tool call via `Agent.markInterrupted`. When a new run starts on
  a child, `beginTurn` looks up the parent (`interruptedNodes.get(parentId)`) and either transfers
  the pending notice with `Agent.transferInterruptTo(source)` (which hands it to the new worker and
  resets the source) or, if the parent is not the interrupted one, clears the new worker's stale
  notice with `Agent.resetInterruptState()`. Keyed by node, so two branches of one session cannot
  clobber each other's notice — this replaced the session-wide `lastInterruptedNodeId`.
- **Deleting a branch** (`branchIds` / `detachBranch` in `tree.ts`) removes a node
  *and its whole subtree* — sub-agent sidecars included — from `session.nodes`,
  unlinks it from the parent's `children`, and moves `activeNodeId` to the parent
  when the checkout was inside the removed subtree (to `null` when the root went,
  which leaves a valid empty session: `rootId`/`activeNodeId` null, `orphanItems`
  kept). It is pure data — `ChatViewProvider.deleteBranch` owns the rest: the matching
  transcript dumps (see transcripts.md), and `SessionRuntime.afterBranchDetach(ids)`
  drops the removed nodes' workers + pending interruption notices + queued child
  notices, kills the background jobs they owned (`hub.removeNode(..., { kill: true })`),
  re-checks out the survivor and repaints (`tree` / `path`). It is always gated by a modal confirmation
  (`deleteBranchInteractive`) and refuses while a turn or a sub-agent *inside the
  branch* is running (a live turn must never lose its node). `session.updatedAt`
  is bumped, so the sidebar reorders — a deletion is a content change, unlike a
  rename.
- `node.customSize` (optional `{w,h}`) persists a user-resized card; it survives
  migration via `normalizeTreeSession` and is sent in the `tree` message as `size`.
- **Stream routing (the load-bearing rule):** every streaming message carries an explicit `nodeId`
  — `delta` / `thinkingDelta` / `usage` / `toolCallDelta` / `toolStart` / `toolEnd` / `done` /
  `interrupted` / `error` — and the webview routes each one to *that* node's card. It must
  **never** infer the stream target from the view. `tree.viewId` = `session.activeNodeId` (the view
  focus); `tree.activeId` = `activeStreamNodeId()` (the view run's node, else any live run, else
  `null`) and is only a routing hint. The webview expands/docks on `viewId ?? activeId`. A
  streaming node that is not on the view path still has a card in the DOM (every node gets one) and
  its deltas land in that card while it is collapsed.
- Chat render: the webview lays out the **view path** expanded and all other nodes collapsed;
  `path` describes the **view** (`pathIds(session, session.activeNodeId)`) while `tree` carries
  structure. Checkout re-sends `path` + `panTo` (no `reset`/`tree`) so the tree never tears down,
  and already-rendered nodes are skipped (`_itemsRendered`) to avoid re-running markdown.
- Migrating v1 `{messages, displayItems}` splits at each `user` message; items are
  re-attached by walking both lists (best effort) and the original state is backed
  up to `spinney.state.v1backup`.

