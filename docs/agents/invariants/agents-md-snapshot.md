## AGENTS.md snapshots (there are two)

- `ChatViewProvider.loadAgentsMd()` reads **both** instruction files **once per
  extension-host activation** (in the provider's constructor), and again whenever
  `vscode.workspace.onDidChangeWorkspaceFolders` fires (a folder opened or closed
  in the same window → `ChatViewProvider.onWorkspaceFoldersChanged`):
  - the **systemwide** file `~/.spinney/AGENTS.md`, through
    `ChatViewProvider.globalAgentsMdPath` (`os.homedir()`; the extension's global
    storage is the fallback for a host that reports no home directory) →
    `Agent.setGlobalAgentsMd(...)`;
  - the open workspace folder's `<workspaceRoot>/AGENTS.md` →
    `Agent.setAgentsMd(...)`. With **no folder open** there is no workspace file to
    read: that snapshot is `null` and the log line records the agent root (see
    `docs/agents/no-repo-mode.md`). The systemwide file is read all the same, which
    is the only instruction source no-repo mode has.
- Both snapshots live in `src/agent/prompt.ts` (module-level `agentsMdSnapshot` and
  `globalAgentsMdSnapshot`) and are composed by `agentsMdSection(sources)` into the
  `{{agentsMd}}` value, the template's last section:
  - `## Global AGENTS.md (all workspaces)` (`GLOBAL_AGENTS_MD_HEADING`), first;
  - `## Workspace AGENTS.md (project instructions)` (`AGENTS_MD_HEADING`), second.
  The headings live in that builder, not in the template: the sections are optional
  and ordered, and one builder is what keeps a missing file from leaving a dangling
  heading behind. Both present adds exactly **one** precedence line to the global
  section — the workspace file wins a conflict, because it is the narrower
  instruction.
- With neither snapshot the whole trailing section is dropped, so the prompt just
  ends at `## Style`; there is never an empty heading. A workspace-only render is
  byte-for-byte what it was before the systemwide file existed.
- Later edits to either file do **not** reach a running extension host: the
  snapshots are read once per activation, and the system prompt is re-synthesized
  from them on every activation/checkout (`buildPath`). So an edit takes effect
  after a **window reload** — starting a new session in the same window does *not*
  re-read the files. `Spinney: Open Global AGENTS.md`
  (`ChatViewProvider.openGlobalAgentsMd`) creates the file when it is missing and
  opens it, and deliberately does not re-read anything afterwards.
- The freeze hashes the **rendered** sections (`prompt.currentAgentsMdSection()`,
  `Epoch.agentsMdHash`), not one file, so a single hash covers both sources — see
  `invariants/system-prompt.md`.
- Sub-agents get no AGENTS.md section (neither file): the lean sub-agent template
  has no `{{agentsMd}}` placeholder, and that is deliberate.
- The identity line (model + reasoning effort) is the leading system prompt and is
  rewritten in place when model/effort changes — see `refreshSystemIdentity`.
