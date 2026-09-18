## Transcripts & `search_transcripts`
- **Layout:** `<root>/<sessionId>/<nodeId>.jsonl`, one file per main-agent turn
  (`kind:'session'`) and per sub-agent run (`kind:'subagent'`). Node ids are
  unique per session, so both kinds coexist in one folder. `<root>` is
  `<spinney.subAgentTranscriptDir>` (relative to the agent root — the
  workspace folder, or the no-repo scratch folder `<globalStorage>/no-workspace`)
  or, by default, `<globalStorage>/transcripts/` — i.e. **outside** the
  workspace, which is why `search_transcripts` exists (`search_files` cannot walk
  there).
- **Why main-agent turns are dumped:** session history lives only in the Memento
  (`spinney.state`, a sqlite blob) and is clipped to 64 KiB per message on
  persist, so no tool can grep it. `SessionRuntime.finishTurn` (in
  `src/chat/runtime.ts`) calls the provider's `dumpSessionTranscript(node,
  session, status)` → `writeSessionTranscript`, which
  mirrors the node's stored messages (so a turn a later injected notice turn
  reuses is rewritten, exactly like the node). Gated by
  `spinney.saveSessionTranscripts` (default true); skipped for `kind:'agent'`
  nodes and empty turns; a failure is logged and never breaks the turn.
- **A context rollover re-dumps the node it leaves, on purpose.** The rollover's
  union kill writes its kill notices into that node's history through the
  writeback path, and `flushWritebacks()` only writes the history — unlike
  `finishTurn` it never dumps — while the `kind:'bg'` job cards it stopped have no
  turn and therefore no dump of their own. Without the explicit
  `dumpSessionTranscript(P, session, P.status)` the only copy of what those
  terminals produced would be the Memento, and the new window's harness text points
  at that file; so the kill record must **carry the job's command, final state and
  output tail**, because it is the only durable copy of them (see
  `context-rollover.md`).
- **The write is queued, and a deletion wins over it.** A dump is 700 KB–1 MB of
  JSONL and a storm of sub-agents finishes dozens at once, so `writeTranscriptFile`
  serializes the body synchronously (that is CPU work on data already in memory, and
  a serialization error still throws *there*, where the caller turns it into a
  `[transcript] …` line) and hands `mkdir` + `writeFile` to an async queue
  (`src/chat/transcript.ts`, one drain at a time, a later body for a path replacing
  the pending one). Two rules follow, and both are pinned in
  `tools/transcript-queue-acceptance.js`:
  - **A deletion cancels first.** `removeTranscripts` / `removeTranscriptFile` /
    `removeTranscriptDir` cancel every queued write they cover *before* removing, and
    **tombstone** one already in flight so it is deleted again when it lands —
    otherwise a dump written a moment later resurrects what
    `invariants/session-persistence.md` calls "the files are gone". A dump that was
    only ever queued counts as removed, and a new write for that path clears the
    tombstone.
  - **A queued dump counts as present** (`hasPendingTranscriptWrite`), which is what
    `SessionRuntime.rolloverTranscriptOnDisk` asks: queueing it is what makes it
    present, and only a deletion cancels it. `existsSync` stays for a dump written by
    an earlier turn.
  `flushTranscripts()` resolves when the queue is empty and is awaited at the **same
  hand-off points as `flushPersist()`** — `controlWaitForFinish`,
  `controlReloadWindow` (both flushes, then the reload) and `shutdown()` — because a
  reboot that does not await it loses the last turn's dump. Errors that are still
  synchronous (argument validation, `JSON.stringify`) surface exactly as before; an
  async write failure is swallowed (the module has no output channel) and never
  breaks the turn.
- **One-time backfill:** sessions whose turns finished *before* the dumps
  existed have no JSONL, so `search_transcripts` cannot see them (their only
  copy is the Memento). `ChatViewProvider.scheduleTranscriptBackfill` runs once
  per install (marker `spinney.transcriptBackfill` in the Memento, 1.5 s
  after activation, yielding every 25 nodes): it walks every restored tree and
  dumps each node with no file on disk — **an existing dump is never
  overwritten**. Reconstructed dumps carry `backfilled:true` in their meta (and
  `backfilled=true` in the rendered line); their `startedAt`/`endedAt` are both
  the node's `createdAt` (a tree node keeps no end time) and a historical
  sub-agent's meta has an empty `systemPrompt` (it is not stored on the node).
  The marker is only written after a completed pass, so an interrupted pass
  resumes next activation; turning `saveSessionTranscripts` off skips it and
  leaves the marker unset (enabling it later backfills).
- **A session transcript deliberately omits the system prompt** (it is identical
  boilerplate including AGENTS.md and would match every file). Sub-agent dumps
  keep it, and `renderTranscriptLine` never renders it, so a search can never be
  drowned by it. Meta fields: `nodeId`, `sessionId`, `sessionTitle`, `parentId`,
  `pathIds`, `title`, `model`, `status`, `prompt`, `summary`, `stats`, plus
  `contextBaseId` — present **only** when this turn's node starts a new context
  window, i.e. when no ancestor's messages are sent any more
  (`context-rollover.md`). `pathIds` stays the full parent chain even then: the
  meta describes the tree, not the request prefix.
- **Search:** `searchTranscripts` renders each line (`[role] text → tool(args)`,
  meta as `[meta] key=value …`) and greps the rendered text, so JSON escaping
  never hides a hit; `kind` filtering reads the meta line's `kind` (missing ⇒
  `subagent`, the legacy format). Hits carry absolute paths and real line numbers
  (1:1 with the file), so `read_file` follows up directly. It is **async** (a
  `statSync`/`readFileSync` sweep of a whole transcript root is itself a host-thread
  stall, and a search walks up to `MAX_TRANSCRIPT_FILES` files): the returned text is
  byte for byte what the synchronous version built, and the `await` in
  `src/tools/searchTranscripts.ts` sits *inside* its `try` so an invalid regex still
  answers `Error: invalid regex: …`. `listTranscriptSessions` (the cheap index
  branch) is still synchronous on purpose.
- **Deleting a branch deletes its dumps** so the on-disk record never outlives the
  history that produced it: `removeTranscripts(dir, nodeIds)` removes
  `<dir>/<nodeId>.jsonl` per id (ids are validated against `^[A-Za-z0-9_-]+$`, so
  a corrupt/hostile id cannot escape the folder) and `removeTranscriptFile(path)`
  removes one recorded absolute path (a sub-agent's `agentTranscript` may point at
  a transcript root the `subAgentTranscriptDir` setting has since changed). Both
  are best-effort and return whether a file was actually removed; the backfill
  never re-creates a dump for a node that is no longer in the tree.
- **Roots are resolved at call time** via `ToolRegistry.setTranscriptRoots(() =>
  [provider.transcriptRoot()])` — a settings change needs no tool rebuild, and
  `subset()` sub-agents inherit the parent registry's resolver.
- **Read-only sub-agents get `search_transcripts` too** (it is a pure read tool).

