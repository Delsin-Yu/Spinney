## Session persistence & config
- Storage keys: `agentHarness.state` (v2: `{ version, activeSessionId, sessions }`,
  each session is a **tree** of `TreeNode`), `agentHarness.runtimeConfig`
  (`model` + `thinkingEffort`) and `agentHarness.transcriptBackfill` (the
  one-time historical-dump marker).
- A session is `{ id, title, createdAt, updatedAt, nodes: Record<id, TreeNode>,
  rootId, activeNodeId, orphanItems }`.
- `this.displayItems` points at the **checked-out node's** `displayItems` during a
  turn (set in `checkoutNode` / `beginTurn`), so streamed items land in the right
  node and are persisted with it.
- Model/effort selections are user-overridable at runtime and persisted;
  settings provide the fallback defaults.
- `persist()` writes a **clipped copy** of each node's messages
  (`clipMessageForStorage`, 64 KiB per message content): the in-memory history
  keeps the full payload, but one huge tool result cannot make every persist write
  tens of MiB into the memento.

