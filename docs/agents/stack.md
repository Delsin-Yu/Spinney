# Stack & hard constraints

- **Language/build:** TypeScript (`strict: true`), CommonJS, target ES2022, `tsc`
  (`tsconfig.json`), source in `src/`, emitted to `out/`.
- **Runtime:** VS Code `^1.85.0` and Node 18+ (the VS Code extension host).
  Node's global `fetch` is used for HTTP — there is no `http`/`axios` dep.
- **Runtime deps:** **none.** `node_modules` is only devDependencies
  (`typescript`, `@types/node`, `@types/vscode`, `@vscode/vsce`).
- **Packaging:** `@vscode/vsce` produces a `.vsix`. There is a checked-in
  `minimal-agent-harness-0.0.1.vsix` (gitignored via `*.vsix`).

