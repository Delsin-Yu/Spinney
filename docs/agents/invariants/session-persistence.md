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
- `persistNow()` reports `chars≈N` on its `[perf]` lines — a size estimate
  accumulated **inline while the payload is built** (a local `chars` counter and an
  `addText()` closure inside `persistNow()`, fed by its `clipItem()` / `clipMsg()`
  helpers over every string field of the stored items, messages, titles and `bg*`
  text; `src/chat/ChatViewProvider.ts` ~:1005-1014 and ~:1088-1092), **not** a
  `JSON.stringify`: serializing 111 M chars inside
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
- **Model/effort are per node, seeded per session:** the turn a node carries records the
  card and level it ran with (`TreeNode.model` / `TreeNode.effort`), and a follow-up
  resolves through the node's ancestry — its own, else the nearest ancestor's, else the
  session seed. `session.model` / `session.effort` are that seed (a dropdown pick writes
  them too, so the next session inherits it). `session.model` is a **card id** and
  `session.effort` a level that card offers (a level it does not offer is clamped to the
  card's `defaultEffort`, `normalizeEffort`).
  `sessionModelPick` / `sessionEffortPick` (in `tree.ts`) honour a pick only while it
  still shadows the `spinney.model` value (the default card id) it was made under, and
  the card's own `defaultEffort` — editing either retires the pick. A session with no
  pick follows
  `effectiveModel` / `effectiveEffort` → the persisted `spinney.runtimeConfig`
  record → the setting. An explicit pick also calls `persistRuntimeConfig`, which
  updates that global record as the **seed for sessions created later**; it never
  touches an existing session's own choice. `applyDefaultModel`
  is how a changed setting reaches a session that has no pick.
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

### Phase 3: the file-backed store (module landed; the provider still uses the Memento)

`src/chat/sessionStore.ts` is the replacement for the one big row, and it is **not wired
into `ChatViewProvider` yet** — the layout below is what the wiring will read and write.
Three measured problems drive it: the row is re-serialized and rewritten in full on every
write (17.2 M chars, multi-second `persist-done`), it costs 100–250 ms of *blocking* host
work per burst, and it is keyed by the extension id — a rename made every conversation
undiscoverable and the first activation under the new id wrote an empty row over it.

- **A root that survives a rename — but only with discovery.** The store's own root is
  `<globalStorage>/spinney/`: a *fixed* last segment, overridable by the `spinney.dataDir`
  setting (`defaultDataRoot(globalStorage, override)`). That alone is **not** enough, and
  the first live migration proved it: VS Code's `context.globalStorageUri` is
  `<profile>/globalStorage/<publisher.name>` — **the parent folder is the extension id** —
  so a rename moves the whole tree and the files become invisible. What actually survives
  is the pair: `SessionStore.discover([...siblings])` + `adoptFrom(root)`, run at
  activation whenever this root has no session for the workspace *and* the Memento row is
  empty (i.e. the state a rename leaves). The candidates are every sibling
  `<profile>/globalStorage/<other-id>/spinney` — found by listing the profile's
  `globalStorage` — plus the default location under the current id when `dataDir` pins the
  root somewhere else. Adoption only **reads** the other root; the sessions are copied into
  the live one, and a placeholder session created because this root looked empty is moved to
  `.trash`. A rename therefore costs one activation where the sidebar is briefly empty, then
  the history is back.
- **One subfolder per workspace**: `sessions/<workspaceKey>/`, the key a digest of the
  workspace folder's uri (`workspaceKeyFor`), `no-workspace` when no folder is open. That
  keeps today's "another folder shows other sessions" behaviour while leaving **one root
  to back up**.
- **The index is a cache.** `index.json` holds the sidebar-sized `SessionSummary[]`;
  `rebuildIndex()` reconstructs it from the files alone, so nothing that can be lost
  orphans the content. A corrupt or foreign session file is skipped and reported —
  one bad file never costs the rest of the history.
- **Every write is atomic and keeps one generation**: `.tmp` → the old file renamed to
  `.bak` → the tmp renamed over it (all renames), so a reader always sees a complete
  version and a `.tmp`-only leftover is ignored.
- **What a write costs, measured**: a turn end writes the changed node plus the header
  (27–70 KB for an 18 MB session, `persist-queued` 5–8 ms, `persist-phases` splitting that into
  change detection / build / queue). The one exception is the **first write of a window**,
  which re-serializes everything because the digest map starts empty (measured 60–90 ms of
  host work), and the **v1→v2 layout migration**, which runs once per root at activation and
  writes one folder per session (measured 19.3 MB / 72 files / ~480 ms, in the background).
  `persist-written ms=… writes=… skipped=… chars=…` reports a persist's *own* bytes; `writes=0
  skipped=N` means its content was coalesced into a later write for the same path, which is
  the queue working and not a missing measurement.
- **A deletion moves to `.trash/<ts>/`**, never unlinks (the rule the v1 state backup
  already follows), and it cancels a write still queued for that path first.
- **One writer per workspace**: `locks/<key>.lock` with a heartbeat; a lock held by a live
  owner is refused, one whose heartbeat is older than `LOCK_STALE_MS` or whose pid is gone
  is taken over, so a killed window cannot brick the store. A window that cannot take the
  lock does **not** fall back to "read-only": it keeps writing the **Memento** (`via=memento`
  on its `persist-*` lines) and says so in the output channel. That is the one combination
  that both keeps the user's window working and guarantees no two windows ever write the
  same session file.
- **Discovery and adoption** make a rename a non-event: `SessionStore.discover(candidates)`
  orders the roots that look like ours, and `adoptFrom(otherRoot)` imports another root's
  sessions (existing ids untouched, the source never modified).
- Writes go through the shared coalescing queue (`fileWriteQueue.ts`): the answer is
  synchronous, the bytes are not, a later body for one path replaces the pending one, and
  `flush()` belongs at the same hand-off points as `flushPersist()` / `flushTranscripts()`.
- `tools/session-store-acceptance.js` pins all of it windowless — including the rename-survival
  path: adopt, discovery order, and no cross-talk between workspaces.
- **The root also holds the diagnostics logs** (`perf-<pid>.log`, one per window, bounded and
  trimmed — see `streaming-perf.md`), so the data folder is the one folder to back up *and* the
  one folder a user is told to look in when they are asked for a log.
