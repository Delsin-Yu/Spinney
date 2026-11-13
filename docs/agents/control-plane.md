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
| `GET /state` | `{busy, sessionId, activeNodeId, runningSubAgents, runningBackgrounds, sessions, hops, pendingReceipts}` — the window's `busy`, its active session, its checked-out node, how many sub-agents it is running and whether it owns a running background terminal, plus the session list; each session carries `id`, `title`, `nodes`, `active`, `titleSource`, `titleLocked`, `running`, `runningNodes`, `lockedNodes`, `runningBackgrounds`, `backgroundNodes`, `model`/`modelName`/`effort` — the **checked-out node's** card and level, not a session-wide value (`SessionRuntime.model` is a getter over the node's own card, its nearest ancestor's, else the session seed). `hops` is the in-flight hop list (`{originSessionId, originNodeId, targetSessionId?, returnNodeId?, mode, armedAt, finishRequested?}` — `targetSessionId` is absent until the child session exists, and `finishRequested` is present only once the child called `finish_hop`: an armed hop without it is one whose child has not decided to return yet, because a turn end or an interrupt no longer brings a hop back) and `pendingReceipts` is how many finished children are waiting for their return node to be free |
| `POST /wait-for-finish` | block until idle (`scope:'turn'` default = the active session's run; `scope:'all'` also waits for every sub-agent / background job), then flush the last persist. `timeoutMs` defaults to **30000** ms (the host clamps it to ≤600000); when it expires the reply is **408** `{ok:false, error:'timeout', busy, runningSubAgents, runningBackgrounds, sessionId, nodeId}`. `holdMs` arms a **hold** (`isHeld()`) that refuses every turn start for that long; `interrupt:true` is the escape hatch |
| `POST /navigate` | check out a node (and open/focus that session's tab) |
| `POST /continue` | send a caller-supplied message (`{sessionId?, nodeId?, message}`) that continues from a node — node-scoped, so a run on another branch does not block it |
| `POST /stop` | `{sessionId?, nodeId?}` — with `nodeId` a **union kill**: that node's live run, every background terminal it owns and every sub-agent it is still running, and nothing continues (the notices are written back into that node's history, so they ride the next request instead of opening a turn); without `nodeId`, cancel every run of the session (else the active session) and leave background jobs alone. Returns `{ok, sessionId, nodeId, stopped}`. Nothing running is `stopped: 0`; an unknown session is 409. Never touches the reload hold |
| `POST /session/start` | create a session (`{title?, prompt?}`) or jump to one (`{sessionId, nodeId?, prompt?}`) and send `prompt` as its first turn; `returnTo:true` **requires** `originSessionId` (+ optional `returnNodeId`) and hops back with the answer as a new branch of that origin — when the child session calls its own `finish_hop`, never at a turn end |
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
- Caller is busy, the request has **no `sessionId`** and a `prompt`, and it is not a hop
  → a fresh session is created and started **immediately** (200), running concurrently
  with the caller. That concurrency is the point of P1, not a queued start.
- Caller supplies `sessionId` → the target is resolved explicitly and refused only while
  the **target node** (`nodeId`, else the session's view focus) has a live run — P3, so a
  session streaming on another branch may still accept a start on a free node (200).
- A hop (`returnTo:true`) **does** queue (202 `{ok, queued:true, originSessionId}`): its
  contract is "the caller's turn is over, the fresh session reports back when it calls
  `finish_hop`", so the start
  waits for the **origin session** to be idle (`finishTurn` → `kickHopWork`; other
  sessions may keep running). The origin is **explicit** — `returnTo` without
  `originSessionId` is refused, and `sessionId` + `returnTo` is refused too (a hop always
  creates a fresh session; use `/continue` to bring a message back). A hop is also
  refused while its session owns a running background terminal, and a third mode is not
  accepted with `returnTo` (`fire_and_forget` never returns).
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

**Hop and hop back** (`returnTo:true` + `originSessionId`, and the agent-facing
`hop_session` / `finish_hop` / `list_nodes` tools): a hop queues a fresh session and arms a `Hop`
record. Its child's id is written the moment the session is created — before its first
turn can start — and the *return* trip matches on that id alone, never on "a session
created after the hop was armed", which is how a receipt used to be attributed to the
wrong conversation when a second session was created while the hop was in flight.

A `return_when_finished` child's first prompt carries a model-facing **preamble**
(English, never localized — it is prompt text, not a UI string): it names the origin
session id and the dispatch node, says that **nothing returns automatically**, tells
the child to call `finish_hop` when the work is complete, explains that the optional
`source_session_node_id` chooses where the reply lands, points at
`search_transcripts sessionId=<origin>` for the caller's node ids, and says the user
may interrupt or steer it at any time. The session's title still comes from the
origin's own `title` argument (a provisional seed from the dispatcher's prompt when it
gave none; the preamble never names the child).

**The hopped-to session decides when it returns.** `finish_hop` is advertised only to
the main agent of a session a `return_when_finished` hop started — never to a
`fire_and_forget` child, never to a sub-agent — and it is set **before that session's
first turn**, so the epoch's frozen tool schemas include it. It comes from the
session's own record (`AgentSession.hopOrigin`), not from the in-flight hop, so a
handed-back session keeps the tool (and answers `Error: this session has no armed hop
(it was already handed back, or none was started).`) instead of losing a tool its
frozen set already sent — which would read as setup drift. The argument
`source_session_node_id` must name an existing **non-sidecar** node of the origin
session; anything else is refused with an error naming the problem.

Until `finish_hop` is called the armed hop is **inert**: `maybeDeliverHopReturn` does
nothing at all — no recorded answer, no receipt, no retire — so a turn end, an
interrupt and a Stop leave the hop armed and the caller waiting. That is what makes a
hopped session steerable. Once it is called the existing idle-wait path runs unchanged:
the turn's final assistant text is recorded on `hop.pendingReturn`, and the receipt is
queued when the child session is **idle** — a running turn, a running **node**
background terminal, a running sub-agent batch or a queued completion notice all keep
it waiting, exactly the set `runningNodes()` / `lockedNodes()` reports. `kickHopWork`
re-checks once a second, every later turn end (a steer) refreshes the answer, and the
hop is retired **there**, at the delivery. A detached job (`run_type: "detached"`) is
not part of that set by design: it never reports back, so a dev server cannot hold a
hop forever. Waiting for real idleness is not cosmetic: without it a hop came back
while the child's gate run continued in the background, and the origin went on to clear
the child's repo lock and run its own commands on the same working tree.

The receipt is a **user message** back into the origin session, and it names the
hand-back rather than an exit status:

`[session hop receipt] The child session "<title>" (<childId>) called finish_hop and
handed back its report.` — then, under `Its final reply:`, that turn's final assistant
text (clipped to 8 KB; `(the new session produced no text reply)` when there was none)
and `(search_transcripts sessionId=<childId> has the full trace if you need it)`. There
is no `status:` wording: the child's own call is what ended the hop.

The message branches off the **landing node** — the child's `source_session_node_id`,
else the hop's `returnNodeId`, else the node the hop was dispatched from — and is
delivered by `SessionRuntime.onUserMessage` with an explicit `basisNodeId`, so:

- it does **not** open or focus the origin's tab, and it does not move that session's
  checkout — an answer arriving while the user reads another branch lands quietly;
- it is not a user *send*: no setup-drift dialog (which could fork the tree or swallow
  the answer), no composer clear, no API-key nudge;
- if the landing node is busy, owns a background job, or the reload hold is armed, the
  receipt **waits** in `pendingReceipts` and is retried by `kickHopWork` (200 ms) until
  the node frees up, instead of being dropped while the agent was told it succeeded.

`mode: "fire_and_forget"` is the same hop with no return trip: no receipt, no record
kept, and nothing written into the origin's tree (the child session appears in the
session list, and `search_transcripts` can read it later). Its session carries no
`hopOrigin`, so it never sees `finish_hop`. `list_nodes` renders the
active session's tree (node ids, status, parent, title) so the agent can name a branch
point — node ids are otherwise invisible to the model.

Guards: **one hop per origin session** (a hop in another session is independent, so two
sessions can hop at once), the origin and the return node must exist, `returnNodeId` is
refused with `fire_and_forget`, a hop is refused while its session owns a running
**node** background terminal (`rt.hasRunningNodeBackground()` in `handleHopSession` — a
detached job is fire-and-forget and deliberately does not block a hop), and the
whole tool is off while `spinney.hopSession.enabled` is `false` (`hopEnabled`, apart from
`canHop`, so `list_nodes` / `rename_session` stay). Deleting a session retires every hop
that touches it (origin or child). The hop bookkeeping itself is in memory only: a
window reload drops in-flight hops, and the child's transcript is then the only trace —
though the child keeps its `hopOrigin` and with it the (now inert) `finish_hop` tool.

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

