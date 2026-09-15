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
npm run package                              # compile + guards + package (.vsix)  — POSIX
powershell -File build-deploy.ps1            # compile + package + install         — Windows
powershell -File build-deploy.ps1 -NoInstall # compile + package only              — Windows
```

`npm run package` and `build-deploy.ps1` are the two side-by-side closing paths.
`npm run package` is the POSIX entry point: it packages the `.vsix`, runs the
`vscode:prepublish` gate (compile + `sync:l10n` + the **seven** guards — `check:models`,
`check:webview`, `check:modeltree`, `check:signals`, `check:l10n`, `check:rollover`,
`check:grid`) on the way, and takes the generated l10n aliases off disk again once it
is done.
`build-deploy.ps1` is the Windows path, and it also installs the newest `.vsix`
with `code --install-extension --force`. Use one of them for quick iteration,
then reload the window. This is the **mandatory last step** of any code change —
see the "Standard closing procedure" section in `AGENTS.md`.

`sync:l10n` / `clean:l10n` are not optional extras. VS Code looks the Chinese catalogs
up by the region tag *it* reports; the repo only authors the canonical ones; the copies
in between exist for exactly as long as `vsce` is reading the tree. Running the
extension from source needs them too, which is why `dev` exists — see
`docs/agents/invariants/i18n.md`.

Launch: F5 (`.vscode/launch.json` → "Run Extension", pre-task `npm: dev`).
`build-deploy.ps1` passes `--allow-missing-repository` to `vsce package`.
