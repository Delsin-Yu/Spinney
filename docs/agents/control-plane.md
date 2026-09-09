# External control plane & the `hvsc` supervisor

The extension cannot reload its own window and report back — it dies with the
reload. So the reload lifecycle lives **outside** the extension:

- `src/http/controlServer.ts` — an opt-in local HTTP control plane
  (`agentHarness.httpApi.enabled`, default **off**; loopback only; bearer token
  written to `<globalStorage>/http/<instanceId>.json`, mode 0600).
- `tools/hyper-vscode/hvsc.mjs` + `serve.ps1` — a workspace-local supervisor
  (excluded from the `.vsix` via `.vscodeignore`) that launches/supervises `code`
  windows and drives the reboot. State lives in `tools/hyper-vscode/.state/`:
  `daemon.json` (port/token), `instances.json` (re-adopted after a daemon
  restart), `daemon.log`.

Control plane routes (all require `Authorization: Bearer <token>`):

| Route | Behaviour |
| --- | --- |
| `GET /health` | `{ok, instanceId, pid, port, busy, sessionId}` |
| `GET /state` | busy + active session/node + the session list |
| `POST /wait-for-finish` | block until idle (`scope:'all'` also waits for sub-agents / background jobs), then flush the last persist. `interrupt:true` is the escape hatch |
| `POST /navigate` | check out a node (and open the panel) |
| `POST /continue` | send a caller-supplied user message that continues from a node |
| `POST /session/start` | create a session (`{title?, prompt?}`) or jump to one (`{sessionId, nodeId?, prompt?}`) and send `prompt` as its first turn; `returnTo:true` (+ `returnNodeId?`) hops back with the answer as a new branch; refuses while busy (except the queued fresh-session case) |
| `POST /reload-window` | 202, then `workbench.action.reloadWindow` (refuses while busy) |

**Session jump** (`POST /session/start`): the agent can hand a task to a *fresh*
conversation instead of growing the current one — e.g.
`curl -X POST -H "Authorization: Bearer <token>" -d '{"title":"Audit deps","prompt":"…"}'
http://127.0.0.1:<port>/session/start`. Without `sessionId` a new session is
created, activated and (if no `title`) named from the prompt; with `sessionId` the
caller jumps to that session and optionally sends `prompt` there. It returns
`{ok, sessionId, nodeId, prompted}`.

The harness drives **one session at a time**, so the busy case matters:

- Caller is idle → the session is created/switched and the prompt runs now (200).
- Caller is busy (the agent calling it is, by definition, mid-turn) and supplies a
  `prompt` → the request is **queued** (202 `{ok, queued:true}`) and runs the
  moment the current turn finishes (`finishTurn` → `runPendingSessionStart`). Only
  one start may be queued at a time.
- Busy without a `prompt`, or with a `sessionId` → 409; call
  `POST /wait-for-finish` first.

This is how an agent hands a follow-up task to a new conversation and then keeps
its own turn short.

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
node must exist, a hop is refused while a background terminal runs, and the return
waits for the harness to be idle (`runPendingSessionStart` also polls
`activeSessionHasRunningBackground()`). A failed return logs to the agent output
channel and drops the result — the child's transcript is still on disk.

`hvsc` commands: `serve` / `start` / `status` / `rm` / `reboot` / `jobs`. The
reboot flow is `wait-for-finish` → `reload-window` (shared profile) or kill +
relaunch (`--isolated`) → poll `/health` → `continue`.

Operational rules:

- The daemon must run **outside** VS Code (a standalone terminal, or
  `Start-Process`): a VS Code task and a harness background terminal both die
  with the window (the latter via `dispose()` → `killAll()`).
- Profile **passthrough** is the default (`code -n`, no `--user-data-dir`), so the
  new window shares the user's `workspaceState`. Its env vars do **not** reach
  that window, so the control plane must be enabled in settings
  (`agentHarness.httpApi.enabled`, workspace or user scope). `--isolated` keeps a
  separate profile and allows a hard kill/relaunch.
- Never pass `--wait` to `hvsc reboot` from inside a turn: the supervisor's
  `/wait-for-finish` would wait for that very turn (deadlock). Fire it without
  `--wait` and let the supervisor `/continue` the agent afterwards.
- `/continue` makes the agent run a caller-supplied instruction — a
  **local-trust RCE boundary**. Keep `agentHarness.httpApi.enabled` off unless a
  controller needs it, and never log the token.

