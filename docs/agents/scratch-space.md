## Agent scratch space

Throwaway agent output goes in the workspace-local, gitignored `.spinney/`
(excluded from the `.vsix` too). It is disposable by design — nothing tracked may
**depend** on it: a tracked doc may *name* a scratch path in passing (this one does,
and so does `no-repo-mode.md`), but no tracked file needs the folder or its contents
to exist:

| Path | Contents |
| --- | --- |
| `.spinney/screenshots/` | screenshots written by a screenshot tool (it passes `--path`) |
| `.spinney/tool-output/` | oversized `search_files`/`list_dir`/`exec_command`/background results (`limitInline`) |

Both folders are **created on demand** (and were wiped once already), so an empty
`.spinney/` is normal. `.spinney` is in the tools' `SKIP_DIRS`, so
`list_dir`/`search_files` walks skip it — grep a spilled file by its **exact path**
instead. Never write scratch files to `C:\Temp` or the repo root.

**No folder open (no-repo mode).** There is no workspace-local folder, so scratch
output goes under the harness scratch root instead:
`<globalStorage>/no-workspace/.spinney/` (screenshots and `tool-output/` as
above, created on demand). The same rule applies — this location replaces the
`.spinney/` that a folder would provide, and scratch files still never go to
`C:\Temp` or the system temp dir. See `docs/agents/no-repo-mode.md`.

**Want the output to outlive the session?** It must not live here: this folder is
gitignored, so a `git clean`/fresh clone loses it while a tracked doc keeps
referring to it. Long-lived research or verification material belongs in a tracked
location — `docs/agents/` for prose, `tools/` for a runnable guard
(`tools/**` is excluded from the `.vsix` by `.vscodeignore`).
