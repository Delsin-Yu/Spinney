## Chat Tree invariants
- Session titles are derived, never authoritative: `AgentSession.title` is shown in
  the sidebar / tab title only, and the automatic namer (`sessionTitles.ts`) may
  rewrite it after a turn. `titleLocked` (set by a manual rename or the
  `rename_session` tool) freezes it, and a rename must never touch `updatedAt`
  (the sidebar sorts by it). Renaming does not change history, branching or the
  prompt in any way.
- `TreeNode.messages` (non-empty) always starts with a `user` role message; the
  system prompt is **never** stored in a node (synthesized per activation).
- The flat API history is `pathMessages(session, activeNodeId)` = `[system, ...path
  nodes' messages]`, and it must go through `Agent.sanitizeMessages` (the sanitized
  copy is **never** written back into the nodes — `pathMessages` returns the nodes'
  own message objects by reference, so `sanitizeMessages` must not mutate them: the
  reasoning→content healing builds a `{ ...msg }` copy). `prefixLen` is measured on the
  sanitized path.
- A turn's message slice is written **once**, in `finishTurn`. `turnPrefixLen` is
  always an index into **`agent.getMessages()`** (which includes the leading system
  message), and it is recorded by `setAgentMessages()` — the single choke point that
  swaps the agent's history (`beginTurn` → the parent's path, the injected
  async-notice turn in `drainSubAgentNotices` → the parent node's path, `checkoutNode`
  → the session / branch / hop-return / panel-restore path). Recording the basis and
  the swap in the same helper is the point: a checkout can replace the history **while
  a turn is streaming**, and an untouched numeric basis then slices from the wrong
  offset, storing ancestor history inside the turn's node. That is how one session
  reached `1,283,056` tokens — a single node had inherited ~1,100 duplicated messages,
  so the next request sent the whole conversation twice while the header still read
  `ctx 65%` (the *previous* turn's `usage.prompt_tokens`). `finishTurn` therefore
  verifies the basis by **identity** (`turnPrefixLen > 0 && messages[turnPrefixLen - 1]
  === turnPrefixTail`) and, when the history was swapped mid-turn, writes nothing and
  logs `[slice]` instead. A queued notice whose node is **not** in the active session
  is dropped, so a batch finishing after a session switch never injects a turn into
  another session's agent. Using a node's own `messages.length` as the basis
  re-includes ancestor history in that node.
- Who owns the node: `beginTurn` creates a fresh node, so its turn **assigns**
  (`node.messages = added`, `turnNodeFresh = true`). An injected turn (async sub-agent
  notice / hop answer) continues a node that already holds the turn that spawned it, so
  it **appends** (`node.messages = [...node.messages, ...added]`, `turnNodeFresh =
  false`) — assigning there replaced the spawning turn's messages with the notice's.
- Branching: every user message creates a new node under the checked-out node;
  sending on a node that already has children makes a sibling (a new branch).
  A branch switch costs only a prefix cache miss — the shared prefix stays cached.
- `attachNode` repairs a missing parent by attaching the node to the **root**
  instead of leaving it unreachable (an orphan would still become the checkout
  point and silently blank the history); `leafOf` skips `kind:'agent'` children,
  so a restored checkout point can never land on a sub-agent sidecar.
- Switching to a different branch resets the pending interruption notice
  (`agent.resetInterruptState()`) unless the new path still ends at the interrupted
  node; `lastInterruptedNodeId` tracks this.
- **Deleting a branch** (`branchIds` / `detachBranch` in `tree.ts`) removes a node
  *and its whole subtree* — sub-agent sidecars included — from `session.nodes`,
  unlinks it from the parent's `children`, and moves `activeNodeId` to the parent
  when the checkout was inside the removed subtree (to `null` when the root went,
  which leaves a valid empty session: `rootId`/`activeNodeId` null, `orphanItems`
  kept). It is pure data — `ChatViewProvider.deleteBranch` owns the rest: the
  matching transcript dumps (see transcripts.md), `lastInterruptedNodeId`,
  `subAgentChildNotices`, `checkoutNode` (agent history + `displayItems`), and the
  `tree`/`path` repaint. It is always gated by a modal confirmation
  (`deleteBranchInteractive`) and refuses while a turn or a sub-agent *inside the
  branch* is running (a live turn must never lose its node). `session.updatedAt`
  is bumped, so the sidebar reorders — a deletion is a content change, unlike a
  rename.
- `node.customSize` (optional `{w,h}`) persists a user-resized card; it survives
  migration via `normalizeTreeSession` and is sent in the `tree` message as `size`.
- Chat render: the webview lays out the **active path** expanded and all other
  nodes collapsed; `path` carries per-node items while `tree` carries structure.
  Checkout re-sends `path` + `panTo` (no `reset`/`tree`) so the tree never tears
  down, and already-rendered nodes are skipped (`_itemsRendered`) to avoid
  re-running markdown.
- Migrating v1 `{messages, displayItems}` splits at each `user` message; items are
  re-attached by walking both lists (best effort) and the original state is backed
  up to `agentHarness.state.v1backup`.

