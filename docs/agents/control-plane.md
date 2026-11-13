# External control plane & the `hvsc` supervisor

The extension cannot reload its own window and report back — it dies with the
reload. So the reload lifecycle lives **outside** the extension:

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
- `tools/hyper-vscode/hvsc.mjs` + `serve.ps1` — a workspace-local supervisor
  (excluded from the `.vsix` via `.vscodeignore`) that launches/supervises `code`
  windows and drives the reboot. State lives in `tools/hyper-vscode/.state/`:
  `daemon.json` (port/token), `instances.json` (re-adopted after a daemon
  restart), `daemon.log`.

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
| `POST /session/message` | `{sessionId, nodeId, message}` — deliver a message into **one node of one session** and start a turn there, the same delivery the agent's `send_session_message` makes. 200 with `{ok, sessionId, nodeId}` (`nodeId` is the new turn's node); **409** when that node is running a turn or still owns unfinished work (wait and retry), and 409 for an unknown session / node. `sessionId` and `nodeId` are required (400) — this route never means "the active session" |
| `POST /reload-window` | 202, then `workbench.action.reloadWindow` (refuses while a turn, sub-agent or background job is live). An optional body `{ continue: { message, sessionId?, nodeId? } }` is **persisted before the reload** and delivered by the next instance once it is idle; the reply then carries `continueQueued: true` and the caller must not post `/continue`. This is what makes a reboot work when the supervisor dies with the reload (a daemon started from inside the window is a child of it) |

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
while a turn runs) race-free: the reboot fires only once nothing new can start. Do not
weaken it.

**The session tools** (`create_session` / `send_session_message` / `list_sessions` /
`list_nodes`, plus `rename_session`) are the agent-facing half of the same surface,
and they are one capability (`canSessions`, main agent only): a caller that may start
a session and message a node also has to be able to name them, and a sub-agent or a
sidecar card never may.

`create_session` starts a fresh session and gives it its first turn, then returns
**immediately**: the turn is dispatched, not awaited, no tab is opened or focused
(`startFreshSession` runs with `open: false`, so `activeSessionId` does not move), and
the turn still runs and persists — `postTo` simply drops messages for a session with
no tab. The title is the caller's `session_name` applied as a **manual** title
(`applySessionTitle(…, 'manual')`), so the automatic namer never overwrites it.
Nothing reports back on its own, so the result names the new session id and its first
node id and says how to hear back.

`send_session_message` is that way back, and the only channel between conversations
in either direction: `{session_id, session_node_id, prompt}` delivers `prompt` as a
user message to that exact node and starts a turn there, branched off that node
(`onUserMessage` with an explicit `basisNodeId`) — never off whatever tab has focus,
and without moving the window's session pointer. It is **refused** while the target
node is running (`runningNodes().includes(node)`) or still owns unfinished work
(`lockedNodes()`), naming the node and telling the caller to wait or read `list_nodes`;
an unknown session, an unknown node and a sidecar node (a sub-agent window or a
`kind:'bg'` job card) are refused the same way. `POST /session/message` is the same
delivery over the control plane, 409 while the node is busy.

`list_sessions` names the window's sessions — id, title, node count, active node,
running-node count, the focused marker and the title bookkeeping — because nothing
else hands the model a session id. `list_nodes` renders one session's tree
(`session_id` defaults to the caller's own) and takes every node's state from the live
runtime: `running` from that session's runs, `busy` from `lockedNodes()`, and
`checked out` only for the session the window is focused on. A session with no runtime
is idle by definition — a turn only runs inside a runtime — so the renderer never
guesses from a stored `status` field, which would resurrect a turn that ended before a
reload. `list_nodes` reads another session through two `RuntimeHost` hooks
(`runningNodesIn` / `lockedNodesIn`); a runtime owns one session, the provider owns
them all.

`hvsc` commands: `serve` / `start` / `status` / `adopt` / `rm` / `reboot` / `jobs`.
The reboot flow is `wait-for-finish` → `reload-window` (shared profile) or kill +
relaunch (`--isolated`) → poll `/health` → `continue`. The shared-profile reload sends
its `--continue` **in the reload request** (`POST /reload-window { continue }`): the
extension persists it and the next instance delivers it, so the daemon may die with the
reload — which it does whenever it was started from inside the window — without losing
the message; only when the extension replies without `continueQueued` (an older build)
does the daemon post `/continue` after the new instance is up. `hvsc start --no-workspace`
launches a `code` window with no folder open (`workspace: null` is a first-class
instance identity: matching treats two nulls as a match, so no workspace path is
required).

**Targets are windows, not records.** A window the daemon never launched (the user
opened it, or a previous daemon did) has no record, so `hvsc reboot <id>` used to
be impossible for it. Now an unknown target is *adopted on first use*:
`hvsc reboot --current --continue "…"` targets the window the command runs inside
(the harness terminal's process ancestry contains that window's extension-host pid
= its discovery file), `--workspace <path>` targets the one live window with that
folder open, and a bare `pid-19940` targets a discovery file directly. `hvsc status`
lists both records and windows nobody owns; `hvsc adopt …` registers one without
rebooting. An adopted record is **reload-only** (`isolated: false`, `rm --kill`
refuses it): its main process is shared with every other window of the user's
profile, so killing it is never an option. Ambiguous or unknown targets fail with
the list of live windows instead of reloading the wrong one.

Matching a record to a control plane is ordered (id → same workspace + appeared
after we launched/reloaded it, newest first → the one live window on that
workspace), and *all* candidates are probed. That is what survives a reload (new
extension host, new port, new instance id) and what keeps a lingering discovery
file of the dying instance from shadowing its replacement.

Operational rules:

- The daemon must run **outside** VS Code (a standalone terminal, or
  `Start-Process`): a VS Code task and a harness background terminal both die
  with the window (the latter via `dispose()` → `killAll()`).
- Profile **passthrough** is the default (`code -n`, no `--user-data-dir`), so the
  new window shares the user's `workspaceState`. When `code -n` merely attaches to
  an already-running main process, its env vars do **not** reach the new window, so
  the control plane must be enabled in settings (`spinney.httpApi.enabled`,
  workspace or user scope); `hvsc` therefore also sets `SPINNEY_HTTP=1` and
  `SPINNEY_INSTANCE_ID` on every `code` it launches itself. `--isolated` keeps a
  separate profile and allows a hard kill/relaunch.
- Never pass `--wait` to `hvsc reboot` from inside a turn: the supervisor's
  `/wait-for-finish` would wait for that very turn (deadlock). Fire it without
  `--wait` and let the supervisor `/continue` the agent afterwards.
- **A reload can only be driven from outside the window.** `POST /reload-window`
  refuses with **409** while any turn is live, and — checked separately — while any
  sub-agent or **background terminal** is live (`controlReloadWindow`). A harness
  background terminal *is* one of those, so a job the hub owns can never reload its
  own window: the driver counts itself as busy (measured: 20 consecutive attempts,
  every one `{"ok":false,"error":"sub-agents or background terminals are still
  running","busy":true}`). A foreground call from inside a turn is refused by the
  first check for the same reason. The driver therefore has to be the supervisor
  (`wait-for-finish` → idle → `reload-window`), a plain terminal issuing those same
  two requests, or the user's own `Developer: Reload Window`. An agent that promises
  a self-reload from inside its own turn is promising something the gate forbids;
  when the supervisor is down, ask the user instead of improvising a driver.
- `/continue` makes the agent run a caller-supplied instruction — a
  **local-trust RCE boundary**. Keep `spinney.httpApi.enabled` off unless a
  controller needs it, and never log the token. `SPINNEY_HTTP=1` opens the very
  same boundary without the setting, so an env var that reaches a window is just
  as much a trust decision as the setting is.

