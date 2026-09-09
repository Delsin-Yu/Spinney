## Chat Tree invariants
- `TreeNode.messages` (non-empty) always starts with a `user` role message; the
  system prompt is **never** stored in a node (synthesized per activation).
- The flat API history is `pathMessages(session, activeNodeId)` = `[system, ...path
  nodes' messages]`, and it must go through `Agent.sanitizeMessages` (the sanitized
  copy is **never** written back into the nodes — `pathMessages` returns the nodes'
  own message objects by reference, so `sanitizeMessages` must not mutate them: the
  reasoning→content healing builds a `{ ...msg }` copy). `prefixLen` is measured on the
  sanitized path.
- A turn's message slice is written **once**, in `finishTurn`, as
  `node.messages = agent.getMessages().slice(turnPrefixLen)`; run `done` /
  `interrupted` / `error` all end there. `turnPrefixLen` is therefore always an
  index into **`agent.getMessages()`** (which includes the leading system message):
  `beginTurn` uses `agent.getMessages().length` after `setMessages(buildPath(...))`,
  and the injected async-notice turn in `drainSubAgentNotices` does the same (it
  pins the history to the parent node with `buildPath` first). A queued notice whose
  node is **not** in the active session is dropped, so a batch finishing after a
  session switch never injects a turn into another session's agent. Using a node's own
  `messages.length` as the basis re-includes ancestor history in that node.
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

