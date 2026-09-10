## Session persistence & config
- Storage keys: `agentHarness.state` (v2: `{ version, activeSessionId, sessions }`,
  each session is a **tree** of `TreeNode`), `agentHarness.runtimeConfig`
  (`model` + `thinkingEffort`), `agentHarness.transcriptBackfill` (the
  one-time historical-dump marker) and `agentHarness.sessionTitleBackfill` (the
  one-time historical-title marker; left unset when a pass is interrupted or the
  model is unavailable, so it resumes on the next activation).
- Which Memento holds those keys depends on the window (`src/extension.ts`):
  `context.workspaceState` when a workspace folder is open, **`context.globalState`
  when none is** — an empty window's `workspaceState` bucket would make every
  no-repo session invisible the moment a folder is opened, while no-folder
  sessions really belong to the profile (see `docs/agents/no-repo-mode.md`).
  Consequence: session state is shared by every no-folder window of a profile, so
  drive one at a time.
- A session is `{ id, title, createdAt, updatedAt, nodes: Record<id, TreeNode>,
  rootId, activeNodeId, orphanItems }` plus the title bookkeeping
  (`titleSource: 'provisional'|'auto'|'manual'`, `titleLocked`, `titleAutoAt`,
  `titleAutoNodes` — see `sessionTitles.ts`). A rename never touches `updatedAt`,
  so it cannot reorder the sidebar.
- `this.displayItems` points at the **checked-out node's** `displayItems` during a
  turn (set in `checkoutNode` / `beginTurn`), so streamed items land in the right
  node and are persisted with it.
- Model/effort selections are user-overridable at runtime and persisted;
  settings provide the fallback defaults.
- `persist()` writes a **clipped copy** of each node's messages
  (`clipMessageForStorage`, 64 KiB per message content): the in-memory history
  keeps the full payload, but one huge tool result cannot make every persist write
  tens of MiB into the memento.

