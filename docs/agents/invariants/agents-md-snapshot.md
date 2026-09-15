## AGENTS.md snapshot (this file)

- `ChatViewProvider.loadAgentsMd()` reads `./AGENTS.md` **once per extension-host
  activation** (in the provider's constructor), and again whenever
  `vscode.workspace.onDidChangeWorkspaceFolders` fires (a folder opened or closed
  in the same window → `ChatViewProvider.onWorkspaceFoldersChanged`), and calls
  `Agent.setAgentsMd(...)`. With **no folder open** there is no `AGENTS.md` to
  read: the snapshot is `null`, the log line records the agent root, and the
  whole trailing section is dropped (see `docs/agents/no-repo-mode.md`).
- The snapshot itself lives in `src/agent/prompt.ts` (module-level
  `agentsMdSnapshot`) and is injected into `{{agentsMd}}`, the template's last
  section, under the heading `## Workspace AGENTS.md (project instructions)`
  (`AGENTS_MD_HEADING`).
- With no snapshot the whole trailing section — heading included — is dropped, so
  the prompt just ends at `## Style`; there is never an empty heading.
- Later edits to `AGENTS.md` do **not** reach a running extension host: the
  snapshot is read once per activation, and the system prompt is re-synthesized
  from it on every activation/checkout (`buildPath`). So an edit takes effect
  after a **window reload** — starting a new session in the same window does *not*
  re-read the file.
- The identity line (model + reasoning effort) is the leading system prompt and is
  rewritten in place when model/effort changes — see `refreshSystemIdentity`.
