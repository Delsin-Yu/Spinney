## Agent scratch space

All agent-produced artifacts live in the workspace-local, gitignored
`.agent-harness/` (excluded from the `.vsix` too) and are safe to delete:

| Path | Contents |
| --- | --- |
| `.agent-harness/screenshots/` | `computer-use screenshot` output (pass `--path`) |
| `.agent-harness/tool-output/` | oversized `search_files`/`list_dir`/`exec_command`/background results (`limitInline`) |

`.agent-harness` is in the tools' `SKIP_DIRS`, so `list_dir`/`search_files` walks
skip it — grep a spilled file by its **exact path** instead. Never write scratch
files to `C:\Temp` or the repo root; if a new kind of artifact appears, give it a
subfolder here.

