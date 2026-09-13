# No-repo mode (no workspace folder open)

Plan + design for making the harness fully usable in a VS Code window with **no
folder open** ("no repo mode"). Status of each phase is tracked at the bottom.

## The problem

The harness activates, keeps sessions and chats fine in an empty window — the
`views`/`menus`/`activationEvents` in `package.json` are all workspace-agnostic.
What breaks is everything that needs a *base directory*:

| # | Break | Where |
| --- | --- | --- |
| 1 | `resolvePath()` funnels every relative path into `getWorkspaceRoot()`, which **throws** `No workspace folder is open.` → `read_file` / `write_file` / `replace_in_file` / `list_dir` (default `'.'`) / `search_files` (default root) all fail | `src/tools/index.ts` |
| 2 | `exec_command`'s default `cwd` is the workspace root → a command without `cwd` cannot even start | `src/tools/execCommand.ts` |
| 3 | Oversized results spilled to `os.tmpdir()` instead of an inspectable, persistent place | `spillDir()` in `src/tools/index.ts` |
| 4 | The model isn't told where "relative" points | `{{environment}}` in `src/agent/prompt.ts` |
| 5 | Sessions/config live in `context.workspaceState`; an empty window's bucket is not a stable home for a conversation (open a folder later and the list is "empty") | `src/extension.ts` |

## The design: one root seam

`getWorkspaceRoot()` keeps its throwing contract (it answers "which folder is the
workspace"). A second accessor answers "where do relative paths go":

```ts
agentRootInfo(): { root: string; kind: 'workspace' | 'scratch' }
getAgentRoot(): string   // = agentRootInfo().root
```

- folder open → `workspaceFolders[0].uri.fsPath`, `kind: 'workspace'`
- no folder → `<globalStorage>/no-workspace`, `kind: 'scratch'` (created on demand)

`resolvePath()` and every default `cwd`/default root go through it, so the tool
surface keeps working and the scratch root behaves like a brand-new empty folder.
The scratch root is deliberately **not** `$HOME`: `list_dir('.')` / a default
`search_files` would otherwise walk the whole home directory, and a stray
`write_file('x')` would land in it. Real files are reached by **absolute path** —
which is the honest rule when there is no repo to be relative to.

`setHarnessStorageDir(dir)` injects the global-storage path at activation (tool
modules have no `ExtensionContext`).

## Phases

- **P0 — tools** (`src/tools/index.ts`, `execCommand.ts`, `searchFiles.ts`,
  `readFile.ts`, `writeFile.ts`, `replaceInFile.ts`, `listDir.ts` + the
  `read_image` hardening in `src/agent/agent.ts`): the seam above, default roots
  through `getAgentRoot()`, spill dir under the agent root, descriptions reworded
  to be mode-neutral ("the harness root — the workspace folder, or the harness
  scratch folder when none is open").
- **P1 — prompt** (`src/agent/prompt.ts`): `EnvironmentFacts` carries the agent
  root; in no-repo mode `{{environment}}` renders two lines — the facts plus
  "relative paths and the default cwd are based on the harness root `<path>`; use
  absolute paths for real files and do not assume a repository layout". The
  template's path bullet stops claiming a workspace root.
- **P2 — session/config + workspace changes** (`src/extension.ts`,
  `src/chat/ChatViewProvider.ts`, `package.json`):
  - `storage = workspaceFolders?.length ? context.workspaceState : context.globalState`
    — no-repo sessions belong to the profile instead of an empty-window bucket
    that goes invisible the moment a folder is opened.
  - `setHarnessStorageDir(context.globalStorageUri.fsPath)` at activation.
  - `vscode.workspace.onDidChangeWorkspaceFolders` → re-snapshot AGENTS.md
    (previously read once per activation with no listener at all).
  - `transcriptRoot()` resolves a *relative* `spinney.subAgentTranscriptDir`
    against the agent root instead of silently falling back to global storage.
- **P3 — supervisor** (`tools/hyper-vscode/hvsc.mjs`, `serve.ps1`, its README):
  `workspace: null` becomes a first-class instance identity (`samePath` treats
  both-null as a match, `launchCode` can launch `code -n` with no folder,
  `hvsc start --no-workspace`). Needed to *develop* in no-repo mode; the
  extension side already publishes an honest `workspace: null` in its discovery
  file.
- **P4 — docs**: this file (indexed from `AGENTS.md`), `tools.md`,
  `scratch-space.md`, `invariants/system-prompt.md`, `invariants/config-keys.md`,
  `invariants/transcripts.md`, `control-plane.md`, `README.md`.

## Boundaries & risks

- The scratch root is shared by every no-folder window of the same profile (like
  `$HOME`), and so are the sessions/config in that mode — only one window drives
  a session at a time, so the risk is low, but it is documented, not accidental.
- `search_files` with no `path` searches the scratch root (usually empty) and
  prints **absolute** paths in no-repo mode. A default search is therefore not a
  way to find your files — pass an absolute path.
- The one-shot backfill markers are per-Memento, so moving to `globalState` makes
  each backfill run once in the no-repo bucket as well (idempotent by design).
- No `AGENTS.md` means the project-instructions section is dropped from the
  prompt (existing `stripAgentsMdSection` behavior). A *global* instructions file
  (`<globalStorage>/AGENTS.md`) is deliberately **not** part of this change.
- `read_image` and computer-use need absolute paths; `--path .spinney/screenshots`
  still works because the shell cwd is the agent root.

## Status

- [x] P0 — tools (`agentRootInfo`/`getAgentRoot`/`setHarnessStorageDir` in
      `src/tools/index.ts`; default roots + descriptions in `execCommand` /
      `searchFiles` / `readFile` / `writeFile` / `listDir`; `read_image` hardening)
- [x] P1 — prompt (`EnvironmentFacts.{root,rootKind}`, two-line `{{environment}}`)
- [x] P2 — session/config + workspace changes (`globalState` when no folder,
      `setHarnessStorageDir`, `onDidChangeWorkspaceFolders`, `transcriptRoot()`)
- [x] P3 — supervisor (`hvsc start --no-workspace`, `workspace: null` matching)
- [x] P4 — docs

Verified with a throwaway harness-mocked smoke test
(`.spinney/no-repo-smoke.js`, disposable): repo mode unchanged, no-repo
root created on demand, relative/absolute resolution, `getWorkspaceRoot()` still
throwing, and a real oversized-result spill landing under
`<scratch>/.spinney/tool-output/`.
