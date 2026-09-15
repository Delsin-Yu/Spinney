## Session persistence & config
- Storage keys: `spinney.state` (v2: `{ version, activeSessionId, sessions }`,
  each session is a **tree** of `TreeNode`; `STORED_STATE_VERSION = 2` and P4 did not
  bump it — the new session fields are optional), `spinney.activeSession` (the
  focused tab's session id, **on its own** — see below),
  `spinney.runtimeConfig` (the
  **default** `model` + `thinkingEffort` record, used by sessions with no pick),
  `spinney.transcriptBackfill` (the one-time historical-dump marker) and
  `spinney.sessionTitleBackfill` (the one-time historical-title marker; left unset
  when a pass is interrupted or the model is unavailable, so it resumes on the next
  activation).
- **Which Memento holds a key matters as much as which key** — VS Code keeps an
  extension's entire `workspaceState` as **one** row (`5ad8cddf…/state.vscdb`, key
  `DE-YU.spinney`, measured at **118,860,732 chars** with every
  one of our keys inside it). So *any* `update` on the content Memento re-serializes
  and rewrites all of it, however small the value: a pointer write was measured as
  `lag blocked 549ms` right after a switch. Hence the split
  (`ChatViewProvider.small` / `readSmall` / `writeSmall`):
  - **content Memento** (`workspaceState`, or `globalState` in no-repo mode):
    `spinney.state` only;
  - **`context.globalState`** (`smallStorage`): `spinney.activeSession`,
    `spinney.runtimeConfig`, `spinney.transcriptBackfill`,
    `spinney.sessionTitleBackfill` — all tiny, all written often.
  A value found only in the content row (state written before this split) is adopted
  on read and written small for next time; the stale copy is deliberately left behind
  (deleting it would rewrite the 119 M chars for a few bytes) and simply loses from
  then on.
- **The row key is the manifest's case; the storage folder is not.** VS Code keys
  each per-extension row by `publisher.name` *as declared* (`DE-YU.spinney`, not
  `de-yu.spinney`) in both `state.vscdb`s, while the `globalStorage` folder and the
  `secret://…"extensionId"` keys are lowercased (shipped `globalValue` is
  `joinPath(globalStorageHome, identifier.value.toLowerCase())`). Field evidence:
  rows `GitHub.copilot-chat` / `JetBrains.resharper-code` sit beside lowercased
  folders, and no lowercase row exists for either. SQLite item keys are
  case-sensitive, so an id change does not move data, it changes which key the
  extension reads: the old tree stays invisible under the old key, and the first
  activation writes a fresh, empty row under the new one. Re-key the rows, not just
  the folder — `tools/migrate-state.mjs` takes the ids in manifest case and derives
  the lowercased folder. VS Code has its own rename migration
  (`extensionStorage.migrate.<from>-<to>` plus `extensionStorage.migrationList` in
  the profile storage), but it only runs for renames the Marketplace reports; a
  locally installed `.vsix` under a new publisher leaves every row behind. This is
  why `<globalStorage>/de-yu.spinney` holds transcripts, scratch, the v1 backup and
  `http/`, but never a conversation. It also does not re-key Secrets, so a renamed
  install asks for the API key again (`secret://…"extensionId"` rows, lowercased).
- **The active-session pointer is its own key** (`spinney.activeSession`, in the
  small scope): a session switch only moves a pointer, and doing it through
  `persist()` re-serialized the whole state (~111 M chars → ~1.6 s of blocked
  extension host) to store one id. `setActiveSession` → `persistActiveSession` writes
  ~40 bytes into the *small* row; every path that moves the pointer goes through it,
  and `persist()` calls it too so the two can never disagree. The read path
  (`loadSessions`) prefers the key and falls back to the blob's `activeSessionId`
  field; a pointer naming a session that no longer exists self-heals to `sessions[0]`.
- **The pre-tree (v1) copy is a file, not a memento key**: `moveV1BackupOut` parks
  `spinney.state.v1backup` as `<globalStorage>/state-v1-backup.json` and drops
  the key — it was ~20 M chars (~15%) of *every* memento write and nothing ever read
  it again (the migration completed long ago). The data is moved, never discarded;
  if the file cannot be written the key stays, with a line in the output channel.
- **Content writes are coalesced** (`PERSIST_DEBOUNCE_MS` 800 ms, ceiling
  `PERSIST_MAX_WAIT_MS` 3 s): a turn with a dozen tool calls used to serialize the
  whole state a dozen times (~1 s of blocked extension host each). `persist()` queues,
  `persistNow()` writes immediately, and the merged write reports `coalesced=n`. The
  call sites that must not be delayed use `persistNow()`:
  `SessionRuntime.finishTurn` and `runSubAgent`'s finish (a finished turn / a
  sub-agent's whole conversation), `finishDeletions`, `clear` and the branch deletion
  (each deletes transcript dumps from disk first, so a stale memento would resurrect
  a conversation whose files are gone), `controlStartSession` and `startFreshSession`
  (the caller already holds the session id). Hand-off points flush and await:
  `controlWaitForFinish`, `controlReloadWindow`, and `deactivate` →
  `ChatViewProvider.shutdown()`. **A new must-write call site has to opt in
  explicitly** — that is the whole point of the split.
- `persist()` reports `chars≈N` — an estimate over the payload's string fields
  (`estimateStateChars`), **not** a `JSON.stringify`: serializing 111 M chars inside
  the operation being measured cost more than most of what those `[perf]` lines were
  about. See `invariants/streaming-perf.md`.
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
  still shadows the `spinney.model` / `spinney.thinkingEffort` setting it was
  made under — editing that setting retires the pick. A session with no pick follows
  `effectiveModel` / `effectiveEffort` → the persisted `spinney.runtimeConfig`
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
