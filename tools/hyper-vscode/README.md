# Hyper-Vscode (`hvsc`)

Workspace-local supervisor for VS Code instances. It is **not** shipped with the
extension (`.vscodeignore` excludes `tools/`).

It exists because the extension cannot reload its own window and report back — it
dies with the reload. So the supervisor owns the process lifecycle and talks to
the extension's opt-in control plane to know when it is safe to restart and to
wake the agent up afterwards.

## Pieces

| Piece | Where | Role |
| --- | --- | --- |
| `hvsc` daemon | this folder (`hvsc.mjs serve`) | launches/supervises `code` windows, exposes the reboot API |
| `serve.ps1` | this folder | bootstrap that starts the daemon outside VS Code |
| control plane | the extension (`spinney.httpApi.enabled`) | `/health`, `/state`, `/wait-for-finish`, `/navigate`, `/continue`, `/reload-window` |
| discovery file | `<globalStorage>/http/<instanceId>.json` | port + bearer token the daemon reads (0600) |
| daemon state | `.state/daemon.json`, `.state/instances.json`, `.state/daemon.log` | token/port, instances (launched **or adopted**, re-adopted after a daemon restart), append-only log |

## Profiles

`hvsc start` launches with **profile passthrough** by default (no
`--user-data-dir`), so the new window shares the user's profile and therefore the
same `workspaceState` — the chat session the supervisor wants to talk to.

Consequences:

- `code -n` attaches to the already-running main process, so the daemon's env
  vars (`SPINNEY_INSTANCE_ID`, `DEEPSEEK_API_KEY`, …) do **not** reach the
  new window. Enable the control plane in the user's settings instead:
  `"spinney.httpApi.enabled": true`. The instance id then becomes
  `pid-<extension-host pid>` and the daemon matches it by workspace + launch time
  (see *No-repo mode* below for the no-folder case).
- The extension host's parent is the **user's** main process, so a hard kill would
  take every window with it. Reboot therefore goes through
  `POST /reload-window` on the control plane.
- Two windows on the same workspace share one `workspaceState`: don't drive the
  agent in both at once (close the old window before continuing in the new one).

`--isolated` keeps the old behaviour: its own `--user-data-dir` and its own main
process. A hard kill is safe there, but the chat state is separate from the
user's.

## No-repo mode (no workspace folder)

A window opened with **no folder** is a first-class instance: `code -n` is spawned
with no path at all, the extension publishes an honest `workspace: null` in its
discovery file, and the daemon stores `workspace: null` in the record.

```powershell
# daemon that starts a bare window right away
powershell -ExecutionPolicy Bypass -File tools\hyper-vscode\serve.ps1 -NoWorkspace

# or against a running daemon
node tools\hyper-vscode\hvsc.mjs start --no-workspace
```

`hvsc status` prints `(no workspace)` for such an instance (never `null`).

**Matching:** an instance is matched to its control plane by instance id first,
then by *same workspace* + launch time. For no-repo instances "same workspace"
means *both sides are null* — that is what lets a record be re-adopted after an
extension-host restart (a new discovery file and port, same window), which is
also how `hvsc reboot` finds the endpoint again. So a no-repo window and an
older no-repo record are deliberately treated as the same workspace.

## Windows hvsc did not launch (adopted)

A reboot target does **not** have to be a window this daemon launched. A window
the user opened themselves (or that any other launcher started, or one from a
previous daemon run) is *adopted on first use*, which is what lets the supervisor
reload the very window a command runs inside:

```powershell
node tools\hyper-vscode\hvsc.mjs status                              # also lists unmanaged windows
node tools\hyper-vscode\hvsc.mjs reboot --current --continue "[reboot] 已重启"
node tools\hyper-vscode\hvsc.mjs reboot --workspace . --continue "…"
node tools\hyper-vscode\hvsc.mjs reboot pid-19940 --continue "…"     # instance id from `status`
node tools\hyper-vscode\hvsc.mjs adopt --current                     # register without rebooting
```

| Target | How it is resolved |
| --- | --- |
| `pid-19940` (or a record id, or a raw pid) | the live discovery file / the record that points at it |
| `--current` | the caller's **process ancestry**: harness terminals are descendants of the window's extension host, so one of the ancestors *is* that window's discovery pid. No record and no `SPINNEY_INSTANCE_ID` needed — in passthrough mode our env never reached that window |
| `--workspace <path>` | the one live window that has that folder open (`workspace: null` for a no-repo window) |
| `--all` | every record, managed or adopted |

Everything else is a hard failure that lists the live windows — a typo never
reloads the wrong window.

An **adopted record is reload-only** (`isolated: false`): hvsc never kills a window
it did not launch, because its main process is shared with every other window of
the user's profile. `rm --kill` refuses it for the same reason. An adopted record
is replayable like any other one, and is dropped on the next daemon start once its
window is gone (it is derived state — nothing of ours to supervise).

The window comes back with a **new** extension host: new pid, new port, new
discovery file, new instance id. The record keeps its own id and follows the
window by instance id first, then by *same workspace + a control plane that
appeared after we asked it to reload* (anything older is not a candidate — that is
how a second window on the same workspace is kept out of the picture, and why a
stale discovery file whose process is still shutting down cannot shadow its
replacement). `hvsc status` shows the pair: `pid-19940 -> pid-4908`.

## Quick start

```powershell
# 1) enable the control plane once (user settings.json)
#    "spinney.httpApi.enabled": true

# 2) start the daemon in a standalone terminal (it must outlive the window)
powershell -ExecutionPolicy Bypass -File tools\hyper-vscode\serve.ps1 -Port 7777 -Workspace .
#    ...or with a window that has no folder open at all: swap -Workspace . for -NoWorkspace

# 3) in another terminal
node tools\hyper-vscode\hvsc.mjs status          # records + windows hvsc did not launch
node tools\hyper-vscode\hvsc.mjs start --no-workspace   # extra bare window, no folder
node tools\hyper-vscode\hvsc.mjs reboot <id> --continue "[reboot] 已重启，继续验证" --wait
node tools\hyper-vscode\hvsc.mjs reboot --current --continue "…"  # the window you are in, launched by anyone
node tools\hyper-vscode\hvsc.mjs jobs <jobId>    # step-by-step log
```

`hvsc start` with no argument still falls back to the daemon's own cwd.

## Reboot sequence

```
hvsc → target resolution: record id | live instance id | --current (caller ancestry)
                           | --workspace <path> | --all      → adopt when unmanaged
     → harness  POST /wait-for-finish {scope:"all", timeoutMs}
                (waits for the turn to end and the last persist to flush)
     → adopted/shared profile: POST /reload-window  (the window reloads itself)
       isolated (we launched it): kill the instance's main process + relaunch
     → poll the discovery files + GET /health until a *fresh* control plane is up
       (same workspace, started after the reload; a lingering old file never wins)
     → POST /continue {sessionId, nodeId, message}   (message supplied by the caller)
```

`/continue` makes the agent run a caller-supplied instruction — treat the control
plane as a **local-trust boundary**: loopback only, bearer token, off by default,
and never log the token.

## Daemon API

```
GET  /health
GET  /instances             # { instances, discoveries } — the latter are live
                            #   windows no record points at yet
POST /instances             { workspace|null, noWorkspace?:true, args?, isolated? }
                            # workspace:null or noWorkspace:true → no-repo window (bare `code -n`)
POST /instances/adopt       { instanceId?|id?, workspace?, callerPids? }   # register a window we did not launch
POST /instances/:id/reboot  { reason?, continue?, timeoutMs?, scope?, wait?,
                              callerPids?, workspace? }
                            # :id may be a record id, a live instance id, a pid or
                            #   `current`; unknown targets are adopted, not rejected
GET  /jobs/:id
```

Bearer token: `tools/hyper-vscode/.state/daemon.json` (created at startup).

## Env / knobs

| Var | Effect |
| --- | --- |
| `HYPER_VSCODE_CODE` | launcher override (default: the real `Code.exe` next to `bin\code.cmd`) |
| `HYPER_VSCODE_GLOBAL_STORAGE` | replace the discovery root (a lab daemon never sees the user's real windows) |
| `HYPER_VSCODE_STATE_DIR` | replace `.state/` (lets a second daemon run beside the real one) |
| `HYPER_VSCODE_EXTENSIONS_DIR` | override `--extensions-dir` |
| `SPINNEY_INSTANCE_ID` | set by the daemon when it spawns `code` (isolated mode only) |
| `spinney.httpApi.enabled` / `.port` | control plane on/off, fixed or ephemeral port |
