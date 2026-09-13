# Multi-session & multi-branch concurrency (frozen spec)

> Status: **implemented (P1–P4)**, live-verified against this contract. It stays the frozen
> contract for the semantics: every worker (human or sub-agent) builds against this file.
> Change it only with the orchestrator's explicit intent, and change the protocol sections and
> all consumers together.

## 0. What we are unlocking

1. **Multiple session tabs** — one editor tab per session (`ChatPanel` per session, never rebinding).
2. **Free focus switching** — the *view focus* (which node/branch a tab shows, where the
   composer docks) is independent of the *running turn's basis* (which node's history the
   agent is appending to). Switching nodes/branches/tabs is allowed at any time, even while
   a turn streams or a background terminal runs.
3. **Concurrent work** — sessions stream in parallel (P1); within one session, several
   branches may stream in parallel (P3); a background terminal belongs to the **node** that
   spawned it (P2) and never locks another branch/session.

## 1. Confirmed semantics (user decisions — do not re-litigate)

- **Concurrency**: true concurrency. The unit of concurrency is the **turn run**, not the session.
- **Branch-level concurrency**: yes — two branches of the same session may run at once (P3).
- **Tabs**: a session has **exactly one** tab. Re-opening a session focuses its existing tab.
  Different sessions may have tabs open side by side. Closing a tab does **not** delete the session.
- **Composer / Send**: the composer is the focused node's input dock. While the **focused
  node** has a running run, the button is **Stop, not Send** — you cannot send into a running
  node (no queueing). When another branch/session is running, the focused node's composer is
  usable and sending starts a *new concurrent run* there.
- **Stop**: stops only the run of the focused node (and its own sub-agents). Other runs continue.
- **Model / thinking effort**: **per session** (each tab has its own selection, persisted with
  the session; settings provide the default for new sessions).
- **Background terminals**: no standalone panel and no dock. A job renders as a `kind:'bg'`
  sidecar card beside the node that spawned it (the same right-hand grid as the sub-agent
  windows), and its completion notice is injected **into that node's own transcript** (a
  `.bgnotify` block) — no new node, no view focus move. Deleting a branch / clearing / deleting
  a session that owns *running* jobs asks for a modal confirmation and then kills them. Task
  ids are **session-local** (a task id is only resolvable inside its own session).
- **Control plane**: no back-compat obligation — pick the cleanest shape (`hvsc` + this repo's
  own tooling are updated together).

## 2. Architecture

```
ChatViewProvider (coordinator, 1 per window)
├─ sessions / persistence (spinney.state)
├─ PanelManager: Map<sessionId, ChatPanel>   (one tab per session)
├─ titles / transcripts / commands / config / control plane / webview routing
└─ runtimes: Map<sessionId, SessionRuntime>

SessionRuntime (1 per session)
├─ session (tree) + activeNodeId = VIEW focus
├─ runs: Map<nodeId, TurnRun>          (P1: at most one; P3: many)
├─ subAgentPool (per-session budget) / runningSubAgents
├─ background: Map<nodeId, BackgroundRegistry> + id index (P2) + bgNodes (task → card)
├─ completion signals: Map<nodeId, SignalNotice[]> (hop returns: RuntimeHost.queueHopReturn)
└─ model / thinkingEffort (P4)

TurnRun (1 per send = 1 new node; an injected completion-signal turn reuses its node, fresh:false)
├─ nodeId + the node it appends to (turn basis, independent of the view)
├─ agent: Agent                        (P1: session-level agent reused; P3: dedicated per run)
├─ stream coalescing buffers + live tool deltas
├─ uploadController (image attachments)
└─ interrupt bookkeeping for the node it wrote
```

### 2.1 View focus vs turn basis (the load-bearing rule)

- `session.activeNodeId` is the **view focus**: which branch a tab expands, where the composer
  docks, what `path` describes.
- A running turn is bound to **its own node** (`run.nodeId`) and writes into **that node's**
  `displayItems` / `messages`. It never follows the view.
- Consequence: `checkoutNode` must **not** swap the history of a live run. Re-basing the
  agent's history happens at `beginTurn` (a new child of the view focus) and at
  `beginInjectedTurn` (the **same** node, when a queued completion signal finds it idle) — both
  only bind a worker whose node has no live run, which is the safe moment in each case.
- A completion signal is therefore delivered one of two ways, and neither follows the view:
  injected into the node's **running** turn at its next tool boundary (`Agent.setSignalHandler`,
  `agent.ts:625-634`), or as an injected turn on that same node when it is idle
  (`drainSignals` → `beginInjectedTurn`, `fresh:false`). It never creates a node under the owner
  and never moves `session.activeNodeId`.
- Therefore `mainStreamNodeId()` is replaced by explicit routing: **every** streaming message
  carries `nodeId`. The webview must never infer the stream target from the view.

### 2.3 P3: node workers (one agent per node)

A `TurnRun` no longer borrows a session-wide agent. The runtime keeps a **node
worker** per node that has ever run a turn:

```
nodeWorkers: Map<nodeId, { agent: Agent; tools: ToolRegistry }>
```

- The agent's history is `buildPath(session, nodeId)` — rebased when a run starts on that node.
- The tools are a fresh `ToolRegistry` whose `BackgroundAccess.currentOwner()` **is that node**, so
  `exec_command` from node X's turn always registers under X (no "which run is this?" ambiguity),
  and the sub-agent handlers (`spawn_agents` / `send_agent_message` / `list_nodes`) close over the
  same node instead of consulting "the active turn".
- A run is `runs.set(nodeId, run)`; `isRunning()` = `runs.size > 0`; `runningNodes()` = the keys.
  A new turn is refused only when **that node** already has a live run — which is exactly what the
  composer's Stop-not-Send rule enforces in the UI. Two *different* nodes of one session may stream
  at once.
- Interrupt bookkeeping is per node: `interruptedNodes: Map<nodeId, Agent>` records which node's
  agent holds a pending interruption notice; starting a run on node M with parent P either transfers
  P's pending notice into M's agent (`Agent.transferInterruptTo`) or clears it
  (`Agent.resetInterruptState`) — the same rule as P1, but keyed by node so concurrent branches do
  not clobber each other.
- Model / effort changes apply to every node worker of the session (they are per-session settings).
- `stop {nodeId}` cancels that node's agent only; without `nodeId` it cancels every run of the
  session. The control plane exposes the same as `POST /stop {sessionId?, nodeId?}`.

### 2.2 Tree/stream messages

- `path` = the **view** path (`pathIds(session, session.activeNodeId)`).
- `tree.activeId` = the node currently streaming (may be `null`), `tree.viewId` = the view focus.
  The webview expands/docks on `viewId ?? activeId`, and routes stream deltas by their `nodeId`.
- A streaming node that is not on the view path still has a card in the DOM (every node gets a
  card); its deltas land in that card while it is collapsed.

## 3. Protocol (host ⇄ webview) — frozen

### 3.1 host → webview

| message | shape | notes |
| --- | --- | --- |
| `state` | `{ sessionId, busy, status, runningNodes: string[] }` | `busy` = any run in the session; `runningNodes` = nodes with a live run. Composer shows Stop iff `runningNodes.includes(viewFocusId)`. |
| `tree` | `{ activeId, viewId, rootId, nodes[] }` | `activeId` = stream target; `viewId` = view focus. Each node carries `kind` (`'turn' \| 'agent' \| 'bg'`), `delivered` (sidecars only) and, for a `kind:'bg'` card, its terminal snapshot (`bgTaskId` / `bgCommand` / `bgExitCode` / `bgKilled` / `bgElapsedMs` / `bgOutputTail`) so the card re-renders without asking the in-memory hub. A `kind:'agent'` node carries **`itemCount` and no `items`**: its transcript is fetched with `loadAgentItems` when the card is expanded (a session switch used to ship 2.3 MB of sidecar transcripts, and 10 k DOM elements for 8 cards). |
| `path` | `{ ids, nodes[] }` | the **view** path. Its `nodes[].items` are complete (a checked-out node — including a sidecar — must render immediately). |
| `agentItems` | `{ id, items }` | answer to `loadAgentItems`: that sub-agent card's transcript (`clipDisplayItem`-ed). |
| `nodeUpdate` | `{ id, status, title, usage }` | unchanged. |
| `panTo` | `{ id }` | unchanged (host pans the view, not the stream target). |
| `delta` / `thinkingDelta` | `{ nodeId, text }` | **`nodeId` now always present.** |
| `usage` | `{ nodeId, usage }` | idem. |
| `toolCallDelta` | `{ nodeId, index, id, name, args }` | idem. |
| `toolStart` / `toolEnd` | `{ nodeId, ... }` | idem. |
| `done` / `interrupted` / `error` | `{ nodeId, ... }` | idem: clears that node's live tool cards / tps meter. |
| `backgrounds` | `{ tasks: Array<Task & { nodeId, cardNodeId, pendingDelivery }> }` | replaces `background`: flat list, each task tagged with its owning node **and** with the `kind:'bg'` card that mirrors it (`cardNodeId`, null when the branch is gone). The webview keys it by `task.id` and patches that card instead of grouping by `nodeId`; `#bg-panel` and the in-card dock are gone. |
| `backgroundNotice` | `{ nodeId, item }` | appended inside that node's card as a `.msg.bgnotify` block (`item.kind: 'background' \| 'subagent'` picks the `BG` / `SUB` badge). Injected at a tool boundary of a running turn, so the webview finalizes the streaming answer before it adds the block. |
| `status`, `notice`, `config`, `context`, `sessionStats`, `balance`, `user`, `imagePicked`, `reset` | unchanged | `reset` is per-tab (each tab is its own webview). |

### 3.2 webview → host

| message | shape | notes |
| --- | --- | --- |
| `userMessage` | `{ text, attachments }` | targets the **view focus** node of *this tab's* session. |
| `checkout` | `{ id }` | view focus change; allowed while anything runs. |
| `stop` | `{ nodeId? }` | stop that node's run (omit ⇒ every run of this session). |
| `killBackground` | `{ id }` | resolved in this session (session-local ids). |
| `loadAgentItems` | `{ id }` | that sub-agent card was expanded and wants its transcript (`tree` sent only `itemCount`); the host answers with `agentItems`. |
| `deleteBranch`, `setNodeSize`, `killAgent`, `clear`, `pickImage`, `setModel`, `setThinkingEffort`, `openExternal`, `layoutDiagnostic`, `ready` | unchanged | `clear` clears **this session**. |

All webview→host messages are handled **in the context of the panel's session**
(`handlePanelMessage(panel, message)`), never "the active session".

## 4. Module ownership (parallel work must respect this)

| file | owner | phase |
| --- | --- | --- |
| `src/chat/ChatViewProvider.ts` | orchestrator | P1–P4 |
| `src/chat/runtime.ts` (new) | orchestrator | P1 |
| `src/chat/panels.ts` (new) | orchestrator | P1 |
| `src/chat/backgroundHub.ts` (new) | tools worker | P2 |
| `src/tools/background.ts`, `index.ts`, `backgroundTools.ts`, `execCommand.ts` | tools worker | P2 |
| `media/main.js`, `media/style.css` | webview worker | P1 + P2/P3 |
| `tools/harness-test.mjs` (new, not shipped) | test worker | P1+ |
| `docs/agents/**` | orchestrator (+ reviewer) | P4 |

### 4.1 Frozen tools-side API (P2)

```ts
/** src/chat/backgroundHub.ts — one hub per window; registries are per (session, node). */
export interface BackgroundOwner { sessionId: string; nodeId: string }
export interface BackgroundHit { owner: BackgroundOwner; task: BackgroundTask }
export class BackgroundHub {
  registryFor(owner: BackgroundOwner): BackgroundRegistry;      // lazily creates
  register(owner: BackgroundOwner, handle: CommandHandle, command: string, cwd: string,
           notifyAgent?: boolean): number;                      // mints a SESSION-LOCAL id
  lookup(sessionId: string, id: number): BackgroundHit | undefined;
  listForNode(sessionId: string, nodeId: string): BackgroundTask[];
  listForSession(sessionId: string): BackgroundHit[];
  runningForNode(sessionId: string, nodeId: string): number;
  removeNode(sessionId: string, nodeId: string, opts?: { kill?: boolean }): void;
  removeSession(sessionId: string, opts?: { kill?: boolean }): void;
  killAll(): void;
}

/** What the tools get: the owner they register into + the hub they resolve ids in. */
export interface BackgroundAccess {
  currentOwner(): BackgroundOwner | null;   // the running turn's node, else the view node
  hub: BackgroundHub;
}
```

`makeExecCommandTool(access, ...)` / `makeCheckBackgroundTool(access)` /
`makeKillBackgroundTool(access)` / `makeJoinBackgroundTool(access)`. `ToolRegistry` keeps a
`BackgroundAccess` (set once per session runtime) instead of a single `BackgroundRegistry`.

## 5. Phases & acceptance

Each phase ends with: `npm run compile` clean → `npm run check:webview` clean →
`powershell -File build-deploy.ps1` → reload → run the acceptance checks below.

- **P1 — multi-tab + per-session runtime** (foundation).
  `PanelManager` (one tab per session, restore N tabs, focus = active), `SessionRuntime`
  holding all per-session state, view-focus vs turn-basis split, free checkout/tab-switch
  while a turn streams, concurrent sessions.
  *Accept*: two sessions streaming simultaneously into their own tabs; switching tabs while
  one runs does not disturb it; checkout while a run streams keeps the run's messages
  (no `[slice]` line in the output channel, node history correct).
- **P2 — node-local background + flying job card**.
  `BackgroundHub`, session-local ids, a `kind:'bg'` card beside the owning node (created by the
  hub's `onRegistered` hook), the completion notice injected into the owning node's own turn,
  modal-confirm-then-kill on delete/clear, `#bg-panel` and the in-card dock removed.
  *Accept*: two nodes each own jobs, shown beside them in their own cards; a notice for node X
  arrives in X's own transcript (no new node, no focus move) even when the view sits on node Y.
- **P3 — branch-level concurrency**.
  `runs: Map<nodeId, TurnRun>` with a dedicated agent per run, per-node Stop, per-node
  composer (Send vs Stop), per-node interrupt bookkeeping.
  *Accept*: two branches of one session stream in parallel; Stop on one leaves the other
  running; 3–4 concurrent runs across sessions keep every message in the right node.
- **P4 — config / control plane / docs / guards**.
  Per-session model+effort, `/state` + `/wait-for-finish` session/node scoping,
  `/session/start` starts immediately (return trip still queued for a busy origin),
  docs + `check:webview` samples.

### 5.1 Acceptance evidence

The acceptance driver is `tools/harness-test.mjs` (dev tooling, excluded from the `.vsix`):
`node tools/harness-test.mjs <suite...|all>`. It drives the **live** control plane (discovery
file + bearer token) and polls `GET /state` — deliberately **not** `/wait-for-finish`, because
the caller is itself a turn, so blocking on "idle" would deadlock. Each suite proves one
invariant:

| suite | proves |
| --- | --- |
| `concurrency` | two sessions report a live run in the **same** `/state` sample (P1). |
| `background` | a `start_in_background` job's ownership (`sessions[].backgroundNodes`) survives a `/navigate` that moves the **view** to another node (P2). |
| `branch` | two nodes of **one** session stream at once; a second send on a live node is refused; `POST /stop {nodeId}` stops only that node (P3). |
| `navigation` | `/navigate` + `/continue` on one session leave another session's run undisturbed (P1). |
| `health` | `/health` + `/state` shape and the session list. |
| `selftest` | the driver's own pure helpers, no window needed. |

`SKIP <suite>: missing <field>` means the host does not expose a `/state` field the suite
asserts (phased tolerance — the field→phase map is `FIELD_PHASE`); a suite `FAIL`s only when the
host **contradicts** an asserted fact (a session that should be running reports idle, a turn's
message landing in another session's transcript, duplicate session ids, …). The suite list is
`SUITES`.

Rules that keep a reboot verifiable (the self-driving loop):

- `POST /wait-for-finish {holdMs}` arms a hold (`ChatViewProvider.isHeld()`), and **every** turn
  start is refused while it is armed — `beginTurn` and `beginInjectedTurn` both gate on it, and
  the completion-signal hook returns nothing while it is held (`runtime.ts:2502-2506`) — injected
  background/sub-agent notice turns included. `/reload-window` itself refuses while a
  turn runs, so the hold is what closes the race: once idle, nothing new can start.
- Restore the **focus before** the reboot: `wait-for-finish`'s `{sessionId, nodeId}` is what the
  daemon carries into `/continue`, so the window must already show the intended session/node.
- Use **sync** sub-agents only: an async batch may settle across the reload and inject a notice
  turn that races it.

## 6. Test plan (autonomous)

- `tools/harness-test.mjs` drives the local control plane (discovery file in globalStorage,
  bearer token) and asserts host behaviour end-to-end: concurrent `session/start`s,
  `state.runningNodes`, message ownership in `spinney.state`, background ownership,
  delete/clear rules. It is the P1–P4 acceptance harness.
- `npm run check:webview` must replay every message shape above (add samples per phase).
- Smoke-testable pure modules (`tree.ts`, `backgroundHub.ts` with a fake `CommandHandle`)
  are exercised with `node -e` where possible.

## 7. Invariants / docs to update (P4)

`AGENTS.md` (drop "one session at a time / background locks the session"),
`invariants/background-terminals.md`, `invariants/chat-tree.md` (stream routing invariant),
`invariants/session-persistence.md`, `invariants/sub-agents.md` (stream routing),
`invariants/streaming-perf.md`, `control-plane.md`, `file-map.md`, `where-to-change.md`,
plus this file's status line.

## 8. Progress ledger

Live status lives in `.spinney/progress.md` (scratch): phase, last green compile,
what is deployed, and the exact next action.
