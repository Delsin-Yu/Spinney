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
| control plane | the extension (`agentHarness.httpApi.enabled`) | `/health`, `/state`, `/wait-for-finish`, `/navigate`, `/continue`, `/reload-window` |
| discovery file | `<globalStorage>/http/<instanceId>.json` | port + bearer token the daemon reads (0600) |
| daemon state | `.state/daemon.json`, `.state/instances.json`, `.state/daemon.log` | token/port, launched instances (re-adopted after a daemon restart), append-only log |

## Profiles

`hvsc start` launches with **profile passthrough** by default (no
`--user-data-dir`), so the new window shares the user's profile and therefore the
same `workspaceState` — the chat session the supervisor wants to talk to.

Consequences:

- `code -n` attaches to the already-running main process, so the daemon's env
  vars (`AGENT_HARNESS_INSTANCE_ID`, `DEEPSEEK_API_KEY`, …) do **not** reach the
  new window. Enable the control plane in the user's settings instead:
  `"agentHarness.httpApi.enabled": true`. The instance id then becomes
  `pid-<extension-host pid>` and the daemon matches it by workspace + launch time.
- The extension host's parent is the **user's** main process, so a hard kill would
  take every window with it. Reboot therefore goes through
  `POST /reload-window` on the control plane.
- Two windows on the same workspace share one `workspaceState`: don't drive the
  agent in both at once (close the old window before continuing in the new one).

`--isolated` keeps the old behaviour: its own `--user-data-dir` and its own main
process. A hard kill is safe there, but the chat state is separate from the
user's.

## Quick start

```powershell
# 1) enable the control plane once (user settings.json)
#    "agentHarness.httpApi.enabled": true

# 2) start the daemon in a standalone terminal (it must outlive the window)
powershell -ExecutionPolicy Bypass -File tools\hyper-vscode\serve.ps1 -Port 7777 -Workspace .

# 3) in another terminal
node tools\hyper-vscode\hvsc.mjs status          # id / profile mode / harness port
node tools\hyper-vscode\hvsc.mjs reboot <id> --continue "[reboot] 已重启，继续验证" --wait
node tools\hyper-vscode\hvsc.mjs jobs <jobId>    # step-by-step log
```

## Reboot sequence

```
hvsc → harness  POST /wait-for-finish {scope:"all", timeoutMs}
                (waits for the turn to end and the last persist to flush)
     → passthrough: POST /reload-window  (the window reloads itself)
       isolated:    kill the instance's main process + relaunch the same argv
     → poll the discovery file + GET /health until the new instance is up
     → POST /continue {sessionId, nodeId, message}   (message supplied by the caller)
```

`/continue` makes the agent run a caller-supplied instruction — treat the control
plane as a **local-trust boundary**: loopback only, bearer token, off by default,
and never log the token.

## Daemon API

```
GET  /health
GET  /instances
POST /instances             { workspace, args?, isolated? }
POST /instances/:id/reboot  { reason?, continue?, timeoutMs?, scope?, wait? }
GET  /jobs/:id
```

Bearer token: `tools/hyper-vscode/.state/daemon.json` (created at startup).

## Env / knobs

| Var | Effect |
| --- | --- |
| `HYPER_VSCODE_CODE` | launcher override (default: the real `Code.exe` next to `bin\code.cmd`) |
| `HYPER_VSCODE_GLOBAL_STORAGE` | override the discovery root |
| `HYPER_VSCODE_EXTENSIONS_DIR` | override `--extensions-dir` |
| `AGENT_HARNESS_INSTANCE_ID` | set by the daemon when it spawns `code` (isolated mode only) |
| `agentHarness.httpApi.enabled` / `.port` | control plane on/off, fixed or ephemeral port |
