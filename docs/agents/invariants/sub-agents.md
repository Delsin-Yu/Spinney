## Sub-agents
- `spawn_agents({ agents: [{ instruction, write (REQUIRED), model? }], mode })` spawns one or more
  parallel sub-agents. `write:true` lets a sub-agent write files / run commands; `write:false` is
  **read-only** (only `read_file` / `list_dir` / `search_files` / `search_transcripts`; the write tools are hidden from the
  model's tool list via `ToolRegistry.withHidden` yet stay registered and **blocked at runtime** by
  `ToolRegistry.withBlocked`, so a hallucinated call still gets a clear denial). Depth is hard-capped at 2 — a depth-2
  sub-agent may not spawn at all. A read-only depth-1 sub-agent gets `spawn_readonly_agents` instead of
  `spawn_agents` (`canSpawn = depth < 2 && write`, `canSpawnReadOnly = depth < 2 && !write`): its agent
  specs have no `write` field, `Agent.executeToolCall` rewrites every spec to `write:false` (so a
  smuggled `write` key cannot escalate), and `spawnChildren` clamps a read-only parent's child to
  `write:false` anyway. It resumes its own children with `send_readonly_agent_message` (again no
  `write` override; `handleSubAgentSendMessage` also enforces "target must be a direct child" and
  caps `write` at `caller.write && target.write`). Its system prompt
  (`Agent.subAgentSystemPrompt`) nudges it to fan out when a task splits into
  independent, reading-heavy parts — without the nudge, read-only sub-agents never
  volunteer to decompose. `mode:'sync'` blocks and returns `{ results }`;
  `mode:'async'` returns
  `{ spawned, async:true, ids }` immediately and the outcome is delivered as **one** injected notice
  when the batch settles. An async **resume** whose owner is a sub-agent is routed through
  `queueSubAgentChildNotice` (queued for that sub-agent's next finish, or auto-resumed) instead of the
  main agent's notice queue.
- `send_agent_message({ id, message, write?, model?, mode })` resumes a **finished** sub-agent (the
  `id` from a prior `spawn_agents`) with a follow-up `message`. `sync` blocks and returns the resumed
  result; `async` returns immediately and delivers the result as a notice. `model` is validated against
  the `MODELS` whitelist (unknown → error). A still-running target returns `still running`.
- A sub-agent is a `kind:'agent'` node — a **display-only sidecar**: its own conversation is a separate
  history and `pathMessages` (in `tree.ts`) skips it, so it never leaks into the parent's API path. On
  finish the sub-agent's conversation (minus the synthesized system prompt) is stored in `node.messages`
  so a follow-up can continue it, even across a restart.
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
  mode) are routed by `queueSubAgentChildNotice`: if the parent is still running the notice is queued and
  delivered at its next finish (`flushSubAgentChildNotices`); if it already finished it is auto-resumed
  with the notice — the mirror of the main agent's async delivery (`subAgentNoticeQueue`).
- A sub-agent branch is checked-out as **read-only** and the composer pane is **hidden** while such a node
  is focused (`setComposerVisible(false)` in `setActiveLeaf`); only the parent drives it via
  `spawn_agents` / `send_agent_message`. `onKillAgent` aborts a running sub-agent from its card's ✕.
- **Stream routing invariant:** the webview streams `nodeId`-less (main-agent) deltas into `messagesEl`,
  which the provider pins via `mainStreamNodeId()` = `activeTurnNode?.id ?? session.activeNodeId`. That target
  must **never** be a sub-agent sidecar. `spawnChildren` therefore restores `session.activeNodeId` to
  `activeTurnNode?.id ?? prevActive` (captured before `attachNode`) instead of `parent.id` — restoring to
  `parent.id` broke **nested** spawns (where the parent is itself a sub-agent), pinning `messagesEl` to a
  sub-agent card and letting the main agent's reply leak into that window. `drainSubAgentNotices` also calls
  `postPath()` before the injected resume turn streams, re-pinning the target. Keep this invariant; the data
  lives on the parent node regardless (only the live DOM target was wrong).
- **Layout invariant (`media/tree.js`):** agent windows must be laid out **recursively** — `layoutSub(a)`
  (not just `pos[a] = {x,y}`), so an agent node's own children (a depth-2 sub-agent spawned by a depth-1
  sub-agent) get their own positions and connectors. Otherwise its card collapses onto the origin and its
  connector is misplaced. The turn spine and the sidecar reservation are owned by the vendored engine: each
  node's box is inflated by its sidecar block (`agentGap + blockW` wide, `max(cardH, blockH)` tall), so no
  other card can overlap a window or sit between a parent card and its own sub-agents. `agentExpanded`
  walks up the agent ancestors so a depth-2 sub-agent stays open beside its expanded depth-1 parent.

