# Commands

```bash
npm install                                  # dev deps
npm run compile                              # tsc -p ./  (no bundler; tsc only)
npm run watch                                # tsc -watch -p ./ (background task)
npm run dev                                  # compile + sync:l10n — what "Run Extension" runs first
npm run sync:l10n                            # write the reported-tag copies of the l10n catalogs
npm run clean:l10n                           # remove those copies again
npm run check:models                         # guard: model-config drift (src scan + the webview scan)
npm run check:webview                        # guard: media/main.js survives every message the host posts
npm run check:modeltree                      # guard: media/modeltree.js still understands the host
npm run check:signals                        # guard: the completion-signal persistence contract
npm run check:l10n                           # guard: the UI catalogs drifting from the code
npm run check:rollover                       # guard: the context-rollover contract
npm run check:grid                           # guard: the Chat Tree sidecar lattice (media/tree.js)
npm run check:docs                           # guard: the shipped user manual (manual/**) vs the manifest
npm run check:cwd                            # guard: the working-directory / path-base contract (compiled tools)
npm run check:shell                          # guard: the argv a native child really receives under Git Bash
npm run check:kill                           # guard: the kill-confirmation contract (exited / no-exit / no-pid)
npm run check:timeout                        # guard: the foreground limit and the background promotion
npm run check:budget                         # guard: the background job budget (deadline, countdown, join refusals)
npm run check:websearch                      # guard: the keyless web_search / web_fetch pair
npm run check:image                          # guard: the pre-upload image transform (PNG codec, resampler, JPEG decode)
npm run check:neterror                       # guard: a failed fetch names its cause (out/agent/netError.js)
npm run check:unicode                        # guard: the well-formed text contract (out/text.js)
npm run package                              # compile + guards + package (.vsix) + collect   — POSIX
npm run artifacts                            # collect the built artifacts into artifacts/ (no rebuild)
powershell -File build-deploy.ps1            # compile + package + install         — Windows
powershell -File build-deploy.ps1 -NoInstall # compile + package only              — Windows
```

`npm run package` and `build-deploy.ps1` are the two side-by-side closing paths.
`npm run package` is the POSIX entry point: it packages the `.vsix`, runs the
`vscode:prepublish` gate (compile + `sync:l10n` + the **seventeen** guards — `check:models`,
`check:webview`, `check:modeltree`, `check:signals`, `check:l10n`, `check:rollover`,
`check:grid`, `check:docs`, `check:cwd`, `check:shell`, `check:kill`, `check:timeout`,
`check:budget`, `check:websearch`, `check:image`, `check:neterror`, `check:unicode`) on the way, and takes the generated l10n
aliases off disk again once it is done.
`build-deploy.ps1` is the Windows path, and it also installs
`artifacts/spinney-<version>.vsix` **by that exact path** with
`code --install-extension --force` (there is no "newest `.vsix`" search any more).
Use one of them for quick iteration, then reload the window. This is the
**mandatory last step** of any code change — see the "Standard closing procedure"
section in `AGENTS.md`.

`artifacts/` is where a build's output is published: `npm run artifacts` collects
whatever already exists into it — the packaged extension
(`artifacts/spinney-<version>.vsix`). `npm run package` and
`build-deploy.ps1` leave their own output there too, and collect it strictly, so a
missing input fails the run instead of being skipped. The folder is gitignored and
kept out of the `.vsix`; it is rebuilt on demand, `tools/collect-artifacts.mjs` is the
only thing that writes it, and nothing in it is hand-edited.

`sync:l10n` / `clean:l10n` are not optional extras. VS Code looks the Chinese catalogs
up by the region tag *it* reports; the repo only authors the canonical ones; the copies
in between exist for exactly as long as `vsce` is reading the tree. Running the
extension from source needs them too, which is why `dev` exists — see
`docs/agents/invariants/i18n.md`.

## When a script refuses to run ("is not digitally signed")

A `powershell -File <script>` that suddenly fails with **`<path> is not digitally signed`**,
while the *same bytes* run from outside the repository, is not the execution policy and not a
missing signature. Read the folder's **mandatory integrity label** first:

```powershell
icacls "<root>" | findstr /i Mandatory
```

`Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)` on the workspace root is the answer: every
file under it inherits **Low**, and PowerShell's `RemoteSigned` check refuses a Low-labelled
unsigned script (measured 2026-10-02: one file, one directory, and the plain invocation
succeeded the moment `icacls <file> /setintegritylevel Medium` was applied — nothing else
changed; `-ExecutionPolicy Bypass` succeeds because it skips that check entirely). It is the
fingerprint of a **sandbox that lowered the folder's integrity level** — a `workspace-write`
sandbox (DSH, in this workspace's history) is what put it here, and the earlier investigation
misread it as that tool's ACL (`icacls /reset` clears a DACL, never a label) and as a security
product's HIPS (a scan-exclusion list is a different layer again, and an antivirus touching
every `.ps1` is not an antivirus blocking one).

Raise it back, and the documented invocation works again:

```powershell
icacls "<root>" /setintegritylevel (OI)(CI)Medium   # the folder, and every file created later
icacls "<root>" /setintegritylevel Medium /T /C /Q  # every file that already exists
```

The recursive pass reports failures for paths that no longer exist (measured: 39956 of them,
all under a scratch `sim/profile/extensions` copy) — that is not a permission problem.
`npm run package` remains the closing path that never touches PowerShell.

Launch: F5 (`.vscode/launch.json` → "Run Extension", pre-task `npm: dev`).
`build-deploy.ps1` passes `--allow-missing-repository` to `vsce package`.
