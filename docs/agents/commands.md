# Commands

```bash
npm install                                  # dev deps
npm run compile                              # tsc -p ./  (no bundler; tsc only)
npm run watch                                # tsc -watch -p ./ (background task)
node_modules/.bin/vsce package --allow-missing-repository   # build .vsix
powershell -File build-deploy.ps1            # compile + package + install
powershell -File build-deploy.ps1 -NoInstall # compile + package only
```

`build-deploy.ps1` compiles, packages, and `code --install-extension`s the
newest `.vsix`. Use it for quick iteration, then reload the window. This is the
**mandatory last step** of any code change — see "Standard closing procedure"
above.

Launch: F5 (`.vscode/launch.json` → "Run Extension", pre-task `npm: compile`).
`-allow-missing-repository` is required because the repo has no git remote.

