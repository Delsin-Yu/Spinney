## Agent scratch space

Throwaway agent output goes in the workspace-local, gitignored `.agent-harness/`
(excluded from the `.vsix` too). It is disposable by design — nothing tracked may
point into it:

| Path | Contents |
| --- | --- |
| `.agent-harness/screenshots/` | `computer-use screenshot` output (pass `--path`) |
| `.agent-harness/tool-output/` | oversized `search_files`/`list_dir`/`exec_command`/background results (`limitInline`) |

Both folders are **created on demand** (and were wiped once already), so an empty
`.agent-harness/` is normal. `.agent-harness` is in the tools' `SKIP_DIRS`, so
`list_dir`/`search_files` walks skip it — grep a spilled file by its **exact path**
instead. Never write scratch files to `C:\Temp` or the repo root.

**Want the output to outlive the session?** It must not live here: this folder is
gitignored, so a `git clean`/fresh clone loses it while a tracked doc keeps
referring to it. Long-lived research/verification material belongs in
`tools/research/` (tracked, and excluded from the `.vsix` by `.vscodeignore` along
with the rest of `tools/**`) — that is where the vendored layout engine's audit
record and benchmark harness live.
