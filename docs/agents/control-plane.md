# External control plane & the deferred reload

The extension cannot reload its own window and report back — it dies with the
reload. So a reload is **requested** over a local HTTP control plane and carried
out by the extension itself at its own idle moment; a **deferred** request is how
a running turn reloads the window it is running in.

- `src/http/controlServer.ts` — an opt-in local HTTP control plane
  (`spinney.httpApi.enabled`, default **off**; loopback only; bearer token
  written to `<globalStorage>/http/<instanceId>.json`, mode 0600). It listens on
  `spinney.httpApi.port`, whose default **`0`** means "let the OS pick an
  ephemeral port" — the real port is only ever in the discovery file. That
  file's name is `<instanceId>.json`, the instance id being `pid-<pid>` by
  default; its `workspace` field is the workspace folder path, or `null` when no
  folder is open.
- **Four env vars bypass the settings entirely** (`src/http/controlServer.ts`):
  `SPINNEY_HTTP=1` enables the plane even when `spinney.httpApi.enabled` is off,
  `SPINNEY_HTTP_PORT` (a positive number) wins over `spinney.httpApi.port`,
  `SPINNEY_HTTP_TOKEN` replaces the per-process random bearer token, and
  `SPINNEY_INSTANCE_ID` replaces the instance id — and therefore the discovery
  file's name.
- `tools/reload-window.mjs` — the one-shot reload script an agent runs as an
  ordinary `exec_command` (excluded from the `.vsix` via `.vscodeignore`). Every
  command is born with `SPINNEY_INSTANCE_ID`, `SPINNEY_DISCOVERY_FILE`,
  `SPINNEY_SESSION_ID` and `SPINNEY_NODE_ID` in its environment
  (`RuntimeHost.controlEnv()` + `BackgroundAccess.spawnEnv`), and the script
  refuses to run without them: no discovery scan, no fallback, and no argument
  that could name another window. It posts one
  `POST /reload-window { idle: true, continue }` and exits. There is no daemon,
  no state directory, and nothing that outlives that one call.

Control plane routes (all require `Authorization: Bearer <token>`):

| Route | Behaviour |
| --- | --- |
| `GET /health` | `{ok, instanceId, pid, port, startedAt, busy, sessionId}` |
| `GET /state` | `{busy, sessionId, activeNodeId, runningSubAgents, runningBackgrounds, sessions}` — the window's `busy`, its active session, its checked-out node, how many sub-agents it is running and whether it owns a running background terminal, plus the session list; each session carries `id`, `title`, `nodes`, `active`, `titleSource`, `titleLocked`, `running`, `runningNodes`, `lockedNodes`, `runningBackgrounds`, `backgroundNodes`, `model`/`modelName`/`effort` — the **checked-out node's** card and level, not a session-wide value (`SessionRuntime.model` is a getter over the node's own card, its nearest ancestor's, else the session seed) |
| `POST /wait-for-finish` | block until idle (`scope:'turn'` default = the active session's run; `scope:'all'` also waits for every sub-agent / background job), then flush the last persist. `timeoutMs` defaults to **30000** ms (the host clamps it to ≤600000); when it expires the reply is **408** `{ok:false, error:'timeout', busy, runningSubAgents, runningBackgrounds, sessionId, nodeId}`. `holdMs` arms a **hold** (`isHeld()`) that refuses every turn start for that long; `interrupt:true` is the escape hatch |
| `POST /navigate` | check out a node (and open/focus that session's tab) |
| `POST /continue` | send a caller-supplied message (`{sessionId?, nodeId?, message}`) that continues from a node — node-scoped, so a run on another branch does not block it |
| `POST /stop` | `{sessionId?, nodeId?}` — with `nodeId` a **union kill**: that node's live run, every background terminal it owns and every sub-agent it is still running, and nothing continues (the notices are written back into that node's history, so they ride the next request instead of opening a turn); without `nodeId`, cancel every run of the session (else the active session) and leave background jobs alone. Returns `{ok, sessionId, nodeId, stopped}`. Nothing running is `stopped: 0`; an unknown session is 409. Never touches the reload hold |
| `POST /session/start` | create a session (`{title?, prompt?}`) or jump to one (`{sessionId, nodeId?, prompt?}`) and send `prompt` as its first turn |
| `POST /session/message` | `{sessionId, message, nodeId?}` — send a prompt into **one session**: one turn on its own active node, exactly like a human's own send. `nodeId` is accepted and validated but addresses nothing (the prompt lands on the active node). 200 with `{ok, sessionId, nodeId, state:'delivered', how:'turn'}`. **409** for an unknown session / node, or for a session that cannot take a prompt now (running a turn, unfinished work, a reload hold, a full context window) — never queued; 400 when `sessionId` or `message` is missing. It carries no round budget and no `from`: an external controller is the human door. |
| `POST /reload-window` | 202, then `workbench.action.reloadWindow`. Without `idle` it is the immediate form: it refuses while a turn, sub-agent or background job is live (409), and a caller that is *itself* a turn is refused by its own existence. An optional body `{ continue: { message, sessionId?, nodeId? } }` is **persisted before the reload** and delivered by the next instance once it is idle; the reply then carries `continueQueued: true` and the caller must not post `/continue`. With `idle: true` it is the **deferred** form: 202 `{ok, deferred: true, continueQueued: true}` and the window waits for its own idle moment (see "Deferred reload"); `continue.sessionId` **and** `continue.nodeId` are then both required (400), because the request that queued it is gone by the time it fires |

**Session jump** (`POST /session/start`): the agent can hand a task to a *fresh*
conversation instead of growing the current one — e.g.
`curl -X POST -H "Authorization: Bearer <token>" -d '{"title":"Audit deps","prompt":"…"}'
http://127.0.0.1:<port>/session/start`. Without `sessionId` a new session is
created, activated and (if no `title`) named from the prompt; with `sessionId` the
caller jumps to that session and optionally sends `prompt` there. It returns
`{ok, sessionId, nodeId, prompted}`.

Sessions are independent now, so "the busy case" only matters where concurrency
cannot help:

- Caller is idle → the session is created/switched and the prompt runs now (200).
- Caller is busy, the request has **no `sessionId`** and a `prompt`
  → a fresh session is created and started **immediately** (200), running concurrently
  with the caller. That concurrency is the point of P1, not a queued start.
- Caller supplies `sessionId` → the target is resolved explicitly and refused only while
  the **target node** (`nodeId`, else the session's view focus) has a live run — P3, so a
  session streaming on another branch may still accept a start on a free node (200).
- Busy without a `prompt` and without a `sessionId` → 409; call
  `POST /wait-for-finish` first.

This is how an agent hands a follow-up task to a new conversation and then keeps
its own turn short.

**The reload hold** (`POST /wait-for-finish {holdMs}`): once the window is idle the
provider stores `controlHoldUntil = Date.now() + holdMs` and `isHeld()` returns true;
**every** turn start is then refused — `SessionRuntime.beginTurn` and `beginInjectedTurn`
both gate on it, so an injected background / sub-agent notice turn cannot sneak in either.
`POST /session/start`, `/continue` and the webview's own send funnel through the same gate
(`dispatchUserMessage`). That is what makes `POST /reload-window` (which itself refuses
while a turn runs) race-free: the reload fires only once nothing new can start. The
deferred path arms this very hold itself, 30 s, at the moment it fires — a queued reload
does **not** hold the window while it waits, or a long turn could never end the way its
own Stop intends. Do not weaken it.

**The session tools** (`create_session` / `send_session_prompt` / `wait_for_session_idle` /
`interrupt_session` / `list_sessions` / `list_nodes`, plus `rename_session`) are the
agent-facing half of the same surface, and they are one capability (`canSessions`, main agent
only): a caller that may start a session also has to be able to prompt it, wait for it and
end what it started, and a sub-agent or a sidecar card never may.

`create_session` starts a fresh session and gives it its first turn, then returns
**immediately**: the turn is dispatched, not awaited, no tab is opened or focused
(`startFreshSession` runs with `open: false`, so `activeSessionId` does not move), and
the turn still runs and persists — `postTo` simply drops messages for a session with
no tab. The title is the caller's `session_name` applied as a **manual** title
(`applySessionTitle(…, 'manual')`), so the automatic namer never overwrites it.
Nothing reports back on its own, so the result names the new session id and says to
report with `send_session_prompt` — the session id is the whole address, so no node id
is carried across.

`send_session_prompt` is that way back, and the only channel between conversations in either
direction: `{session_id, prompt, max_rounds}` starts **one turn** in that session, on its own
active node (`session.activeNodeId`, the node `list_nodes` marks checked out), which is exactly
where a human's send would land. It behaves like a user message because it *is* one: the same
gate (`SessionRuntime.onUserMessage` → `promptBlocker`) decides whether a turn may start, so a
busy session is a refusal naming the node, how long it has been busy, and the two ways out
(`wait_for_session_idle`, `interrupt_session`) — never a queued message. The call blocks until
the **turn has started**, never until the answer is. `max_rounds` is **required** (clamped to
`spinney.sessionMaxRounds`, default 16): the receiver inherits one fewer and can never raise it,
and a node with no rounds left is refused with a sentence that says to report back, not to
re-send from another session. Still refused: an unknown session, a read-only window, a reload
hold, a full context window, and an invalid `max_rounds`. `POST /session/message` is the same
prompt over the control plane: no budget and no `from` (an external controller is the human
door), and its `nodeId` is accepted only to be validated, because the prompt lands on the
session's active node.

`wait_for_session_idle` is the wait that replaces the old 30 s receipt window, shaped like
`wait_for_command`: a slice, not a timeout. It polls `promptBlocker` — the same predicate the
prompt checks, so `idle` means the prompt will be accepted — and answers normally when the
window runs out, naming the node and what is holding it.

`interrupt_session` ends the live work **an agent's prompt started** in that session, and
nothing else: every node whose `lastFrom` names the calling session and which still has a live
turn, background terminals or running sub-agents. The scope is provenance, not position, so a
line a human started is not in the set. It is the union kill `stopNode` already performs
(`POST /stop {nodeId}` is its control-plane twin), and the result reports what died.

`list_sessions` names the window's sessions — id, title, node count, active node,
running-node count, the focused marker and the title bookkeeping — because nothing
else hands the model a session id. `list_nodes` renders one session's tree
(`session_id` defaults to the caller's own) and takes every node's state from the live
runtime: `running` from that session's runs, `busy` from `lockedNodes()`, and
`checked out` only for the session the window is focused on. A session with no runtime
is idle by definition — a turn only runs inside a runtime — so the renderer never
guesses from a stored `status` field, which would resurrect a turn that ended before a
reload. `from=` / `rounds=` are the last prompt's sender and the node's remaining
allowance, which is also what `interrupt_session` reads. `list_nodes` reads another
session through `RuntimeHost` hooks (`runningNodesIn` / `lockedNodesIn`); a runtime owns
one session, the provider owns them all.

**Deferred reload** (`POST /reload-window { idle: true, continue }`): the form a
*command* uses, and the only one that works from inside a turn.
`tools/reload-window.mjs` posts it from the `exec_command` that ran it, gets its
202 back and exits 0; the agent keeps working. What the host does with it:

1. Refuse with **409** when a deferred reload is already queued ("a reload is
   already queued") — one queue, one message, and a second request can never
   silently replace the first node's message.
2. Reply `{ ok: true, deferred: true, continueQueued: true }` **immediately**.
   `continueQueued` is honest at that moment: the queue *is* the promise, and the
   file is written when it fires, not before.
3. Poll every 250 ms (`DEFERRED_RELOAD_POLL_MS`) for `!anyRunningTurn() &&
   !anyRunningSubAgents() && !anyRunningBackground()` — the same set the immediate
   form demands, but *observed* instead of demanded. On idle: clear the poll, arm
   the 30 s hold (`controlHoldUntil`), write the pending continue
   (`writePendingContinue`), flush persist and transcripts exactly as the
   immediate path does, and reload 400 ms later
   (`workbench.action.reloadWindow`).
4. There is **no timeout**: a turn that never ends keeps waiting, and its Stop is
   what ends it. The poll is cleared on `dispose()`.

The continue file is written **at fire time, never at request time**, so a wait
that is abandoned (an extension that never went idle, a window reloaded by hand, a
dispose) leaves nothing behind for the next instance to deliver. The node that
asked is named inside the request (`continue.nodeId`, taken from the script's
environment), so "which node gets the message" is decided once, by the process
that ran the command, and never re-derived from what the window's view happens to
show half a minute later.

**Targets are windows.** A caller finds a window through its discovery file
(`<globalStorage>/http/<instanceId>.json`): the file *is* the identity, the port is
read from it, and a stale file is pruned by its `pid`. `SPINNEY_INSTANCE_ID` is
what names it, so an instance started by hand is addressable like any other. There
is no supervisor record and no adoption step any more: a window that is up has a
discovery file, a window that is gone has none, and nothing else has to be kept in
step.

Operational rules:

- **The window now defers its own reload**, and that is what replaces "a reload can
  only be driven from outside the window". `POST /reload-window` without `idle`
  still refuses with **409** while any turn is live and — checked separately —
  while any sub-agent or **background terminal** is live (`controlReloadWindow`). A
  background terminal *is* one of those, so a job the hub owns can never reload its
  own window: the driver counts itself as busy (measured: 20 consecutive attempts,
  every one `{"ok":false,"error":"sub-agents or background terminals are still
  running","busy":true}`), and a foreground call from inside a turn is refused by
  the first check for the same reason. The deferred form does not ask the window to
  be idle **now** — it asks it to reload when it becomes idle, which the window can
  observe about itself even while a command of that very turn is still running.
  The immediate form stays what a terminal (or `tools/harness-test.mjs`) uses on an
  idle window, and the user's own `Developer: Reload Window` stays the manual
  escape.
- `/continue` makes the agent run a caller-supplied instruction — a
  **local-trust RCE boundary**. Keep `spinney.httpApi.enabled` off unless a
  controller needs it, and never log the token. `SPINNEY_HTTP=1` opens the very
  same boundary without the setting, so an env var that reaches a window is just
  as much a trust decision as the setting is. The token is never handed to a child
  process either: a command receives the **path** of the 0600 discovery file
  (`SPINNEY_DISCOVERY_FILE`) and reads the bearer token from it — which is why
  `tools/reload-window.mjs` cannot be run from a plain terminal (it has no path)
  and why a command's environment is not a credential store.

