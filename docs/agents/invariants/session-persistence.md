## Session persistence & config
- **Where a session really lives: one file per node under the store root** (see
  "the file-backed store" below). The Memento is a **migration source and a
  no-store fallback** now, not the content path: `spinney.state` (v2:
  `{ version, activeSessionId, sessions }`, `STORED_STATE_VERSION = 2`) is read
  once when no session file exists — state written before the store existed — and
  written back only when there is no store at all (a test host, a profile with no
  global storage). `migrateToStore` moves it into the store verifiably and then
  clears the row. **A window that cannot take the workspace lock never writes it**:
  no fallback to the content Memento, no degraded mode (see the ownership rule
  below). The *small* keys are profile state rather than session content and are
  still written there (the active-session pointer, the model defaults) — they describe
  which session this profile had open, not what is inside it.
- Storage keys in the **small** Memento scope (`context.globalState`, or the same
  object in no-repo mode):
  `spinney.activeSession` (the focused tab's session id, **on its own** — see below),
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
  (each deletes transcript dumps from disk first, so a write still queued would
  resurrect a conversation whose files are gone), `controlStartSession` and `startFreshSession`
  (the caller already holds the session id). Hand-off points flush and await:
  `controlWaitForFinish`, `controlReloadWindow`, and `deactivate` →
  `ChatViewProvider.shutdown()`. **A new must-write call site has to opt in
  explicitly** — that is the whole point of the split.
- `persistNow()` reports `chars≈N` on its `[perf]` lines — a size estimate
  accumulated **inline while the payload is built** (a local `chars` counter and an
  `addText()` closure inside `persistNow()`, fed by its `clipItem()` / `countMsg()`
  helpers over every string field of the stored items, messages, titles and `bg*`
  text; `src/chat/ChatViewProvider.ts`, `persistNow` right after its `t0`), **not** a
  `JSON.stringify`: serializing 111 M chars inside
  the operation being measured cost more than most of what those `[perf]` lines were
  about. `countMsg` counts a message's text and image URLs but returns the message
  **unchanged** — messages are stored verbatim (see below). See
  `invariants/streaming-perf.md`.
- Which Memento holds those keys depends on the window (`src/extension.ts`):
  `context.workspaceState` when a workspace folder is open, **`context.globalState`
  when none is** — an empty window's `workspaceState` bucket would make every
  no-repo session invisible the moment a folder is opened, while no-folder
  sessions really belong to the profile (see `docs/agents/no-repo-mode.md`).
  Consequence: session state is shared by every no-folder window of a profile, so
  drive one at a time.
- A session is `{ id, title, createdAt, updatedAt, nodes: Record<id, TreeNode>,
  rootIds, activeNodeId, orphanItems }` — `rootIds` replaced the old single
  `rootId` when the forest landed (a stored `rootId` is read back as
  `rootIds: [rootId]`, and `pruneSession` re-derives the list when it no longer
  describes the tree) — plus `legacyEpoch` (set when a chain was adopted
  retroactively, see `system-prompt.md`), the title bookkeeping
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
- **Messages are persisted verbatim.** There is no storage-side content cap any more:
  `clipMessageForStorage` is gone from the write path, and `persistNow`'s message hook
  only accumulates the `chars≈N` size readout and returns the message untouched. What a
  node stores has to be byte-identical to what was sent to the API, or the provider's
  prefix cache is lost from the first truncated message on after every reload. The
  **display** caps are a different thing and stay (`clipForUi` /
  `clipDisplayItem`, the 8 / 32 / 64 KiB budgets on `displayItems`).
  - The session object is stored with the node's `messages` verbatim, so it now also
    carries `rootIds` (the forest — a v1 `rootId` is read back as `rootIds: [rootId]`
    by `normalizeTreeSession`), `legacyEpoch`, and — per node — `epoch` and
    `imageSources`, plus the seed/selection fields above. All of them are optional
    fields on the same v2 shape: `STORED_STATE_VERSION` did **not** bump.
- **Change detection must be exact inside `messages`.** `src/chat/persistDigest.ts`
  folds every node/header into a numeric digest, and the coverage rule is the point:
  a long string **inside `messages`** (a prompt, an assistant body, a tool result, a
  `text` part, an `image_url.url`, a `file_id`) is hashed **whole**, character for
  character, on the exact path (`foldTextExact`); strings at or below
  `DIGEST_VALUE_MAX` (512) are folded by value; a long string **outside** `messages`
  keeps the cheap `length + first/last 32 chars` probe, because those fields are
  display-only and derived. A length + head/tail probe cannot see a rewrite in the
  middle of a message, and after a reload a silently older node file would mean a
  different prefix with no diagnostic — so `messages` gets the real hash and pays the
  linear read for it. `tools/session-store-acceptance.js` pins this: it perturbs every
  field of a realistic node and requires the digest to move, so a field added to
  `TreeNode` fails that guard until it is covered.

### Phase 3: the file-backed store (wired; the Memento is the migration source)

`src/chat/sessionStore.ts` is the content path now, and `ChatViewProvider` uses it:
`persistNow` builds a payload of only the **changed** sessions, hands each to
`store.writeSession(id, session, summary, dirtyNodes)` and refreshes `index.json`
(`writePayload`). Three measured problems drove it: the row was re-serialized and
rewritten in full on every
write (17.2 M chars, multi-second `persist-done`), it cost 100–250 ms of *blocking* host
work per burst, and it was keyed by the extension id — a rename made every conversation
undiscoverable and the first activation under the new id wrote an empty row over it.

- **One owner window per workspace.** The workspace lock (`locks/<key>.lock`, written
  with the owner id + pid + a heartbeat every `STORE_HEARTBEAT_MS`) is not a
  fallback trigger, it is the invariant: exactly one window reads **and writes** a
  workspace's session data. `openStoreLock()` hands the promise to `lockPending`, so
  the first load and the first write can wait for the answer instead of guessing, and
  `acquireLock` may take over a **stale** lock (a dead pid, or a heartbeat older than
  `LOCK_STALE_MS` = 45 s), so a crashed window never locks the workspace out permanently.
  - The owner: read + write, as before.
  - **Any other window on the same folder is read-only** (`this.readOnly = !acquired`).
    It still loads and browses the store — reading needs no lock — and says so in the
    output channel and with a warning notice in every open session. `persistNow`
    **drops** a queued write in such a window (`persist-skipped read-only=true`): the
    Memento write fallback is **gone**, and with it the whole degraded mode.
    `adoptLegacyEpoch` is skipped too — adopting an epoch is a write.
  - **Every mutation is refused, and the refusal is one sentence.** The turn starts
    are gated inside the runtime: `beginTurn` for a new node (send, fork, rollover)
    and `beginInjectedTurn` for the injected ones — ▶ Continue, the rollover's first
    turn and every background / sub-agent notice. The provider gates the rest of the
    surface directly: the composer's send / fork / rollover entry points post the
    sentence as a notice, `renameSession` returns `{ ok: false, error: readOnlyNotice() }`,
    `newSession`, `deleteSessionsInteractive` and `clear` show it in a warning box and
    return without touching anything, and the control plane's `controlStartSession`
    answers `{ ok: false, error: 'another window owns this workspace’s sessions; this
    window is read-only' }` — a caller of `POST /session/start` gets a refusal, not a
    queued job.
  - **The user sees it before the click.** Every `state` post carries
    `readOnly: host.isReadOnly()`, and the composer paints it: Stop hidden, Send
    **disabled** with the host's own sentence as its title (`READ_ONLY_TITLE`, the
    same catalogue entry as the host's literal). `send()` re-checks the flag, so a
    click can never depend on a repaint having happened.
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
- **A stored session is healed at the read boundary, never by a script.** `SessionStore`
  takes an optional `normalize(session, id)` hook and **every** path out of the reader goes
  through it: `readSessionSync` / `readAllSync` / `rebuildIndex`, the **v1→v2 layout
  migration** (so a converted root is written already in the current shape) and `adoptFrom`
  (which inherits the hook). The store itself stays tree-agnostic and vscode-free, which is
  why the caller supplies the function (`ChatViewProvider.openStore` → `normalizeSession` in
  `tree.ts`) — but the **reader** is where it must run, because every call site reads through
  it: a second place is a second chance to forget. That is the `rootId` → `rootIds` lesson —
  the Memento path healed the pre-forest shape and the store path did not, so after the forest
  landed 43 of 44 files in one workspace came back with `rootIds === undefined`, and
  `postTree`'s `session.rootIds.slice()` threw *after* the webview had already handled
  `reset`: every old conversation opened as an empty session. A heal that throws (or returns
  nothing) is logged and the session is loaded exactly as stored — a repair must never cost
  the content. `tools/session-store-acceptance.js` pins both halves (with the hook, without
  it, the migration writing healed bytes, the throwing heal, and the adoption inheriting it).
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
- **The `via=` readout has exactly two values, and `via=memento` is not a
  degraded mode any more.** `persist-*` lines report `via=store` whenever a store
  object exists and this window holds its lock. The only other case is a window that
  has **no store at all** — `openStore()` returns `null` without `globalStorage`
  (a test host, a stripped profile) — and that window still writes the whole state
  into `spinney.state`, exactly as before. A window that *has* a store but could not
  take the lock is read-only and drops the write instead (the ownership rule above):
  there is deliberately no third state in which one window writes files while another
  writes the row.
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
