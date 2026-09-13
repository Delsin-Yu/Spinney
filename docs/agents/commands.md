# Commands

```bash
npm install                                  # dev deps
npm run compile                              # tsc -p ./  (no bundler; tsc only)
npm run watch                                # tsc -watch -p ./ (background task)
npm run package                              # compile + guards + package (.vsix)  — POSIX
powershell -File build-deploy.ps1            # compile + package + install         — Windows
powershell -File build-deploy.ps1 -NoInstall # compile + package only              — Windows
```

`npm run package` and `build-deploy.ps1` are the two side-by-side closing paths.
`npm run package` is the POSIX entry point: it packages the `.vsix` and runs the
`vscode:prepublish` gate (compile + the three guards) on the way.
`build-deploy.ps1` is the Windows path, and it also installs the newest `.vsix`
with `code --install-extension --force`. Use one of them for quick iteration,
then reload the window. This is the **mandatory last step** of any code change —
see "Standard closing procedure" above.

Launch: F5 (`.vscode/launch.json` → "Run Extension", pre-task `npm: compile`).
`--allow-missing-repository` is required for a manual `vsce package` because the
repo has no git remote.
