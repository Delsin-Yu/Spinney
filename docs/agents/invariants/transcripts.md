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
  persist, so no tool can grep it. `ChatViewProvider.finishTurn` calls
  `dumpSessionTranscript(node, session, status)` → `writeSessionTranscript`, which
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
  (1:1 with the file), so `read_file` follows up directly.
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

