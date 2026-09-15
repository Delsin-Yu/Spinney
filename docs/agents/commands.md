# Commands

```bash
npm install                                  # dev deps
npm run compile                              # tsc -p ./  (no bundler; tsc only)
npm run watch                                # tsc -watch -p ./ (background task)
npm run dev                                  # compile + sync:l10n — what "Run Extension" runs first
npm run sync:l10n                            # write the reported-tag copies of the l10n catalogs
npm run clean:l10n                           # remove those copies again
npm run package                              # compile + guards + package (.vsix)  — POSIX
powershell -File build-deploy.ps1            # compile + package + install         — Windows
powershell -File build-deploy.ps1 -NoInstall # compile + package only              — Windows
```

`npm run package` and `build-deploy.ps1` are the two side-by-side closing paths.
`npm run package` is the POSIX entry point: it packages the `.vsix`, runs the
`vscode:prepublish` gate (compile + the five guards, the added one being
`check:rollover`) on the way, and takes the generated l10n aliases off disk again
once it is done.
`build-deploy.ps1` is the Windows path, and it also installs the newest `.vsix`
with `code --install-extension --force`. Use one of them for quick iteration,
then reload the window. This is the **mandatory last step** of any code change —
see "Standard closing procedure" above.

`sync:l10n` / `clean:l10n` are not optional extras. VS Code looks the Chinese catalogs
up by the region tag *it* reports; the repo only authors the canonical ones; the copies
in between exist for exactly as long as `vsce` is reading the tree. Running the
extension from source needs them too, which is why `dev` exists — see
`docs/agents/invariants/i18n.md`.

Launch: F5 (`.vscode/launch.json` → "Run Extension", pre-task `npm: dev`).
`--allow-missing-repository` is required for a manual `vsce package` because the
repo has no git remote.
