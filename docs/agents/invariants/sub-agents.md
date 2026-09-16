## Sub-agents
- `spawn_agents({ agents: [{ instruction, write (REQUIRED), model? }], mode })` spawns one or more
  parallel sub-agents. `write:true` lets a sub-agent write files / run commands; `write:false` is
  **read-only** (only `read_file` / `list_dir` / `search_files` / `search_transcripts`; the write tools are hidden from the
  model's tool list via `ToolRegistry.withHidden` yet stay registered and **blocked at runtime** by
  `ToolRegistry.withBlocked`, so a hallucinated call still gets a clear denial). Depth is hard-capped at 2 — a depth-2
  sub-agent may not spawn at all — but depth is not the only limit: a **level-1** batch is bounded by
  `spinney.maxConcurrentSubagents` (default **15**, sized into `SubAgentPool` in `src/chat/runtime.ts`),
  the surplus tasks queueing for a free slot, and each parent may start at most
  `spinney.maxLevel2Subagents` (default **2**) depth-2 children, past which the spawn returns
  `Error: this sub-agent may start at most N sub-sub-agents (M already started).` (`src/chat/runtime.ts:3301-3309`).
  A read-only depth-1 sub-agent gets `spawn_readonly_agents` instead of
  `spawn_agents` (`canSpawn = depth < 2 && write`, `canSpawnReadOnly = depth < 2 && !write`): its agent
  specs have no `write` field, `Agent.executeToolCall` rewrites every spec to `write:false` (so a
  smuggled `write` key cannot escalate), and `spawnChildren` clamps a read-only parent's child to
  `write:false` anyway. It resumes its own children with `send_readonly_agent_message` (again no
  `write` override; `handleSubAgentSendMessage` also enforces "target must be a direct child" and
  caps `write` at `caller.write && target.write`). Its system prompt
  (`Agent.subAgentSystemPrompt`, the lean template in `src/agent/prompt.ts`) nudges it to fan out when a task splits into
  independent, reading-heavy parts — without the nudge, read-only sub-agents never
  volunteer to decompose. `mode:'sync'` blocks and returns `{ results }`;
  `mode:'async'` returns
  `{ spawned, async:true, ids, transcriptDir }` immediately and the whole batch settles into **one** completion
  signal for the parent node (`onAsyncBatchDone` `runtime.ts:3747` → `queueSubAgentSignal`
  `runtime.ts:3536`). A signal is delivered either at the parent turn's **next tool boundary** (injected into the running
  turn, so the model reacts on its next hop) or, when the parent is idle, as an injected turn on
  that same node — never as a new node.
- **A sub-agent's tool surface is a subset — and it excludes the background tools.** `subAgentTools`
  (`src/chat/runtime.ts:3086-3097`) builds from `workerFor(node).tools`, so a sub-agent sees exactly
  `read_file` / `list_dir` / `search_files` / `search_transcripts` (plus `write_file` /
  `replace_in_file` / `exec_command` when it is writable) and nothing else. `check_background_terminal` /
  `kill_background` / `join_background` are **not** in that list: a sub-agent that backgrounds a job
  (`exec_command` with `timeout_behavior = move_to_background` / `start_in_background`) still gets its
  session-local id back, but a call to any of the three answers `Error: unknown tool "…"` — a job id it
  cannot manage. The job registers under the **sub-agent's own** node (see "A sub-agent's tools/handlers
  are bound to the sub-agent's own node" below) and its completion notice does reach the sub-agent; only
  the user (the job card's kill button, or Stop on the owning line) can kill it.
- `send_agent_message({ id, message, write?, model?, mode })` resumes a **finished** sub-agent (the
  `id` from a prior `spawn_agents`) with a follow-up `message`. `sync` blocks and returns the resumed
  result; `async` returns immediately and delivers the result as a notice. `model` is not a wire-name
  whitelist: it goes through `parseModelOverride` → `resolveCard` (`src/chat/runtime.ts:3177-3186`), so any
  spelling a card resolves by — its card id, its display name or its wire name — is accepted and anything
  unknown answers `Error: unknown model "…".` (`src/chat/runtime.ts:3183`). A still-running target
  returns `still running`.
- A sub-agent is a `kind:'agent'` node — a **display-only sidecar**: its own conversation is a separate
  history and `pathMessages` (in `tree.ts`) skips it, so it never leaks into the parent's API path. On
  finish the sub-agent's conversation (minus the synthesized system prompt) is stored in `node.messages`
  so a follow-up can continue it, even across a restart.
- A node whose async sub-agent batch is still running (or whose batch notice is already
  queued for it) reports in `state.lockedNodes`, so the composer offers **Stop** there.
  That Stop (`SessionRuntime.stop(nodeId)`) aborts the batch **and its depth-2 children**
  (`subAgentSubtree`), and each notice is **written back** into the owning turn node's
  history (`queueWriteback` → `flushWritebacks`; a sidecar's notice is retargeted with
  `turnOwnerOf`, since a sidecar's history is never sent), so it travels with the user's
  next prompt instead of opening a turn. The stopped line is remembered
  (`stoppedLines`) until the user continues it, so a stopped sub-agent is never resumed
  when its own children settle. A batch the user did not stop keeps the normal delivery
  (injected at a tool boundary, or as an injected turn on the parent). A depth-2 batch
  belongs to its depth-1 parent — whose composer is hidden — not to the main node, but a
  Stop on the main node still reaches it. See
  `invariants/background-terminals.md` for the same rule on jobs.
- **`Delivered`:** a sidecar node carries `delivered` (`tree.ts:110`) once its outcome reached its
  reader, which is what the card's `Delivered` badge shows (`media/main.js:1211-1224`, `applyDeliveredBadge`).
  A `sync` `spawn_agents` / `send_agent_message` hands the summary back as the caller's tool result, so
  `finish` sets it directly (`runtime.ts:3384-3388` for a spawn batch, `runtime.ts:3233-3237` for a
  resume); an async batch sets it when its notice is actually delivered (`settleSignals`,
  `runtime.ts:4216-4231`, followed by a `postTree()`). A sub-agent that was still running when the host
  went away is normalized to `killed` on load (`tree.ts:555-558`) and stays as a record card.
- **Transcript dumps (`node.agentTranscript`):** because the caller can only ever see the sub-agent's
  summary, `runSubAgent`'s `finish` also writes the whole conversation to disk as **JSONL**
  (`src/chat/transcript.ts`, `kind: 'subagent'`) and returns the absolute path: `spawn_agents` sync
  results carry `stats` (tool-call / denied-call counts) plus `transcript` per agent,
  `send_agent_message` sync results carry them too, and the async notices append
  `· transcript: <path>` to each line. Line 1 is a `meta` record (ids, spec, status, summary, system
  prompt, `stats.toolCalls` / `stats.deniedToolCalls` / `stats.usage`); every following line is one API
  message (`{type:'message', index, ...}`), so `read_file` can page it and `search_transcripts` can
  grep it. A resume **overwrites** the same `<nodeId>.jsonl` with the extended conversation. Folder,
  config and the shared search surface are described in "Transcripts" above.
- Async results for a **sub-agent parent** (a depth-1 sub-agent that spawned depth-2 children in async
  mode) take the same path as the main agent's (D3): `queueSubAgentSignal` (`runtime.ts:3536`)
  queues the signal under the parent node when the parent is live — the parent's own
  `Agent.setSignalHandler` hook (`runtime.ts:3473`) then injects it at its next tool boundary, so a
  depth-1 sub-agent learns about its depth-2 children **mid-turn**, exactly like the main agent — and
  resumes the parent with the notice when it already finished (its history is not in the API path, so
  it cannot receive an injected turn; the idle drain does the same, `runtime.ts:4094-4106`). Either way
  the notice lands inside the parent node's own card as a `.bgnotify` block (`renderSignalCards`,
  `runtime.ts:4191`) — a child's completion never opens a node under it.
- A sub-agent branch is checked-out as **read-only** and the composer pane is **hidden** while such a node
  is focused (`setComposerVisible(false)` in `setActiveLeaf`); only the parent drives it via
  `spawn_agents` / `send_agent_message`. `onKillAgent` aborts a running sub-agent from its card's ✕.
- **Stream routing invariant:** every streaming message now carries an explicit `nodeId` (P1); there is no
  `nodeId`-less "main agent" stream and no `mainStreamNodeId()` any more. The webview routes each delta to the
  card of the node named in the message, and `tree.activeId`/`activeStreamNodeId()` is only a hint. So a
  sub-agent's own deltas stream into its **own** card, and the main agent's reply can never leak into a
  sub-agent window just because the view moved. A sub-agent node is a `kind:'agent'` sidecar (`pathMessages`
  skips it, so it never enters the parent's API path), but it still owns its card, its run key and its worker.
- **A sub-agent's tools/handlers are bound to the sub-agent's own node:** `subAgentTools(job.node, write)`
  builds from `workerFor(job.node).tools`, so its `BackgroundAccess.currentOwner()` is that node — an
  `exec_command` a sub-agent backgrounds registers under the **sub-agent's** node, not the parent's — and its
  `spawn_agents` / `send_agent_message` handlers close over the same node instead of consulting "the active
  turn" (ambiguous once two branches run at once, P3).
- **Layout invariant (`media/tree.js`):** agent windows must be laid out **recursively** — `layoutSub(a)`
  (not just `pos[a] = {x,y}`), so an agent node's own children (a depth-2 sub-agent spawned by a depth-1
  sub-agent) get their own positions and connectors. Otherwise its card collapses onto the origin and its
  connector is misplaced. The same grid holds the `kind:'bg'` background job cards: the layout treats both
  sidecar kinds alike (`isSidecarKind`, `media/tree.js:89`; `agentKids`, `media/tree.js:140`), so a job occupies
  the next free lattice cell exactly like a sub-agent window, with no second geometry. The turn spine and
  the sidecar reservation are owned by the vendored engine: each
  node's box is inflated by its sidecar grid (`agentGap + blockW` wide, `max(cardH, blockH)` tall), so no
  other card can overlap a window or sit between a parent card and its own sub-agents. The grid is
  **column-major with a bounded row count** (`agentMaxRows`, 4): at most 4 cells per column and the
  next cell opens a new column to the right, with `agentVGap` between cells and `agentColGap` between
  columns. Rows are **not** aligned across columns: each column is its own stack of cells, its extent
  is each cell's own subtree box height, and the column's natural stack is
  `agentTopPad + Σ extent + (n−1)·agentVGap` — the block is as tall as its tallest column. The free
  space of a shorter column (`blockHeight − that column's stack`) is spread **evenly** over that
  column's cards (the integer remainder going to the topmost cards first), so every column ends flush
  at the block's bottom line and no hole is left between a parent's cards; a deep branch therefore
  costs only its own column, never a dead gap in a shallower one. Each sidecar card is also
  **stretched** to fill its cell: `layoutTree` returns a `stretch` map (id → pixel height) covering
  every sidecar card, and `main.js` renders that card at exactly that height (setting `height` and
  `max-height`, since `.node` caps at 600px) — a sub-agent that spawned sub-agents therefore has its
  own card running down to the bottom of its own sub-grid instead of ending early beside it; turn
  cards are never stretched, and there is deliberately no cap on the stretch. The one exception is a
  cell that carries material below the card's own extent — a turn child hanging under a sidecar, a
  shape no live path builds (turn nodes are only created under a non-sidecar basis) — where the card
  stops at that extent so the child keeps its room and the cell's spare slot space stays empty.
  Those gaps
  (`agentVGap` / `agentColGap` / `agentTopPad`) are still the only card-free lines, which is what
  makes the `cells` corridors card-free by construction — `main.js drawEdges()` routes every
  parent→sub-agent connector through them (an orthogonal elbow), so no connector crosses a card
  either. Widening the grid (`agentColGap` / `agentMaxRows`) without updating that routing table
  still puts connectors on top of cards.
  `agentExpanded`
  walks up the agent ancestors so a depth-2 sub-agent stays open beside its expanded depth-1 parent.
  These invariants are enforced by `tools/check-tree-grid.js` (`npm run check:grid`, in the
  `vscode:prepublish` chain) over synthetic shapes plus the real session `mu2zn79jlv7b23`, so
  drifting geometry fails packaging instead of shipping.

