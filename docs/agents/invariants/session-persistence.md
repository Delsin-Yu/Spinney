## Session persistence & config
- Storage keys: `agentHarness.state` (v2: `{ version, activeSessionId, sessions }`,
  each session is a **tree** of `TreeNode`; `STORED_STATE_VERSION = 2` and P4 did not
  bump it — the new session fields are optional), `agentHarness.runtimeConfig` (the
  **default** `model` + `thinkingEffort` record, used by sessions with no pick),
  `agentHarness.transcriptBackfill` (the one-time historical-dump marker) and
  `agentHarness.sessionTitleBackfill` (the one-time historical-title marker; left unset
  when a pass is interrupted or the model is unavailable, so it resumes on the next
  activation).
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
  `titleAutoNodes` — see `sessionTitles.ts`) and, since P4, the per-session selection
  (`model`, `effort`, and the `modelFromSettings` / `effortFromSettings` retirement
  anchors — all optional, so old state loads unchanged via `normalizeTreeSession`). A
  rename never touches `updatedAt`, so it cannot reorder the sidebar.
- **Model/effort are per session (P4):** a tab's dropdown pick writes onto the session
  (`SessionRuntime.setModel` / `setThinkingEffort` → `session.model` / `session.effort`,
  then `persist()`), so each tab keeps its own selection across a reload.
  `sessionModelPick` / `sessionEffortPick` (in `tree.ts`) honour a pick only while it
  still shadows the `agentHarness.model` / `agentHarness.thinkingEffort` setting it was
  made under — editing that setting retires the pick. A session with no pick follows
  `effectiveModel` / `effectiveEffort` → the persisted `agentHarness.runtimeConfig`
  record → the setting. An explicit pick also calls `persistRuntimeConfig`, which
  updates that global record as the **seed for sessions created later**; it never
  touches an existing session's own choice. `applyDefaultModel` / `applyDefaultEffort`
  are how a changed setting reaches a session that has no pick.
- **One tab per session** (`PanelManager`, keyed `sessionId → ChatPanel`): opening a
  session focuses its existing tab (`ensure`), a duplicate panel VS Code restores from
  serialization is disposed (`adopt`), and closing a tab only unmaps it (`onClosed`) —
  the session itself is not deleted. The mapping is never rebound.
- **Runtimes are created lazily** (`ChatViewProvider.runtimeFor`), only when a session is
  opened / navigated / started. Construction seeds the model/effort and the view-derived
  counters but builds **no** history (`buildPath` runs at `beginTurn`), so a session
  nobody opened never pays for an agent history.
- **Deleting a session** (`deleteSessionNow`) drops its runtime (killing the background
  terminals it owns), its tab, its transcript dumps, and any queued session start / armed hop
  pointing at it; `finishDeletions` then keeps the window with at least one session, moves the
  active pointer and persists/refreshes **once**. The sidebar is **multi-select**
  (`canSelectMany`): the inline trash bucket on an item that is part of a multi-selection deletes
  the **whole selection** (`deleteSessionsInteractive`) behind one modal — the context menu is
  deliberately not used, because right-clicking the list drops the selection. Sessions with a live
  *turn* are skipped and reported rather than silently dropped, and running background terminals
  are killed only after that confirmation.
- Streaming items land in the **run's own node** (`TurnRun.items` = `node.displayItems`,
  written only by that run's agent) and are persisted with it, so a view change never
  redirects the stream into another node.
- `persist()` writes a **clipped copy** of each node's messages
  (`clipMessageForStorage`, 64 KiB per message content): the in-memory history
  keeps the full payload, but one huge tool result cannot make every persist write
  tens of MiB into the memento.
