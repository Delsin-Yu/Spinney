# External control plane & the `hvsc` supervisor

The extension cannot reload its own window and report back — it dies with the
reload. So the reload lifecycle lives **outside** the extension:

- `src/http/controlServer.ts` — an opt-in local HTTP control plane
  (`spinney.httpApi.enabled`, default **off**; loopback only; bearer token
  written to `<globalStorage>/http/<instanceId>.json`, mode 0600). Its discovery
  file's `workspace` field is the workspace folder path, or `null` when no folder
  is open.
- `tools/hyper-vscode/hvsc.mjs` + `serve.ps1` — a workspace-local supervisor
  (excluded from the `.vsix` via `.vscodeignore`) that launches/supervises `code`
  windows and drives the reboot. State lives in `tools/hyper-vscode/.state/`:
  `daemon.json` (port/token), `instances.json` (re-adopted after a daemon
  restart), `daemon.log`.

Control plane routes (all require `Authorization: Bearer <token>`):

| Route | Behaviour |
| --- | --- |
| `GET /health` | `{ok, instanceId, pid, port, startedAt, busy, sessionId}` |
| `GET /state` | window `busy` + active session/node + the session list; each session carries `id`, `title`, `nodes`, `active`, `titleSource`, `titleLocked`, `running`, `runningNodes`, `lockedNodes`, `runningBackgrounds`, `backgroundNodes`, `model`, `effort` |
| `POST /wait-for-finish` | block until idle (`scope:'turn'` default = the active session's run; `scope:'all'` also waits for every sub-agent / background job), then flush the last persist. `holdMs` arms a **hold** (`isHeld()`) that refuses every turn start for that long; `interrupt:true` is the escape hatch |
| `POST /navigate` | check out a node (and open/focus that session's tab) |
| `POST /continue` | send a caller-supplied message (`{sessionId?, nodeId?, message}`) that continues from a node — node-scoped, so a run on another branch does not block it |
| `POST /stop` | `{sessionId?, nodeId?}` — cancel that node's run, or (no `nodeId`) every run of the session (else the active session); returns `{ok, sessionId, nodeId, stopped}`. Nothing running is `stopped: 0`; an unknown session is 409. Never touches the reload hold |
| `POST /session/start` | create a session (`{title?, prompt?}`) or jump to one (`{sessionId, nodeId?, prompt?}`) and send `prompt` as its first turn; `returnTo:true` (+ `returnNodeId?`) hops back with the answer as a new branch |
| `POST /reload-window` | 202, then `workbench.action.reloadWindow` (refuses while a turn, sub-agent or background job is live) |

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
- A hop (`returnTo:true`) **does** queue (202 `{ok, queued:true}`): its contract is "your
  turn is over, the fresh session reports back", and the return trip needs the origin idle
  (`finishTurn` → `runPendingSessionStart`, which waits for `globallyIdle()`). Only one
  start may be queued at a time; a hop is also refused while its session owns a running
  background terminal.
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

**Hop and hop back** (`returnTo:true` + `returnNodeId`, and the agent-facing
`hop_session` / `list_nodes` tools): the queued fresh session is started with an
armed `hopReturn` record, so when its turn finishes the provider queues the
*return* trip — a `session/start` back to the origin session carrying that turn's
final assistant text (`[会话跳转回执] …`, clipped to 8 KB, plus the child's
`sessionId` for `search_transcripts`). With `returnNodeId` the return first checks
out that node, so the answer lands as a **new branch** off it instead of
continuing the current line of conversation; without it the origin's checked-out
node is used. The origin agent therefore resumes in a new turn with the child's
answer. `list_nodes` renders the active session's tree (node ids, status, parent,
title) so the agent can name that node — node ids are otherwise invisible to the
model. Guards: one hop at a time (`hopReturn` armed), the origin and the return
node must exist, a hop is refused while its session owns a running background terminal
(`rt.hasRunningBackground()` in `handleHopSession`), and the return waits for the whole
harness to be idle (`runPendingSessionStart` polls `globallyIdle()`, which also covers
sub-agents and background jobs). A failed return logs to the agent output channel and
drops the result — the child's transcript is still on disk.

`hvsc` commands: `serve` / `start` / `status` / `adopt` / `rm` / `reboot` / `jobs`.
The reboot flow is `wait-for-finish` → `reload-window` (shared profile) or kill +
relaunch (`--isolated`) → poll `/health` → `continue`. `hvsc start --no-workspace`
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
  new window shares the user's `workspaceState`. Its env vars do **not** reach
  that window, so the control plane must be enabled in settings
  (`spinney.httpApi.enabled`, workspace or user scope). `--isolated` keeps a
  separate profile and allows a hard kill/relaunch.
- Never pass `--wait` to `hvsc reboot` from inside a turn: the supervisor's
  `/wait-for-finish` would wait for that very turn (deadlock). Fire it without
  `--wait` and let the supervisor `/continue` the agent afterwards.
- `/continue` makes the agent run a caller-supplied instruction — a
  **local-trust RCE boundary**. Keep `spinney.httpApi.enabled` off unless a
  controller needs it, and never log the token.

