# Stack & hard constraints

- **Language/build:** TypeScript (`strict: true`), CommonJS, target ES2022, `tsc`
  (`tsconfig.json`), source in `src/`, emitted to `out/`.
- **Runtime:** VS Code `^1.85.0` (`engines.vscode`, the only engine the manifest
  declares — there is no Node engine pin; `@types/node` is `^20.11.0` and CI
  builds on Node 20). Node's global `fetch` is used for HTTP — there is no
  `http`/`axios` dep.
- **Runtime deps:** **none.** `node_modules` is only devDependencies
  (`typescript`, `@types/node`, `@types/vscode`, `@vscode/vsce`).
- **Packaging:** `@vscode/vsce` produces a `.vsix`; `spinney-0.0.2.vsix` is a
  **local build artifact** (gitignored via `*.vsix`, never tracked).

