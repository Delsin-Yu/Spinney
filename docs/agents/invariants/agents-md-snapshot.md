## AGENTS.md instructions (two files, read at use)

- `src/chat/agentsMd.ts` is the reader, and it reads **both** instruction files **at
  use** — behind a small cache keyed on the file's modification time and size, so the
  usual cost is one `statSync` per file per use and a `readFileSync` only when the file
  really moved:
  - the **systemwide** file `~/.spinney/AGENTS.md`, through `globalAgentsMdPath`
    (`os.homedir()`; the extension's global storage is the fallback for a host that
    reports no home directory);
  - the open workspace folder's `<workspaceRoot>/AGENTS.md`. With **no folder open**
    there is no workspace file to read: that half is `null` and the log line records the
    agent root (see `docs/agents/no-repo-mode.md`). The systemwide file is read all the
    same, which is the only instruction source no-repo mode has.
- `ChatViewProvider.agentsMdSources()` exposes that pair (it is
  `RuntimeHost.agentsMdSources()`, the seam the runtime uses), and **both** prompt paths
  go through it: `SessionRuntime.freezeEpoch` renders the prompt from these bytes **and**
  hashes them into `Epoch.agentsMdHash`, and `SessionRuntime.setupState` hashes them
  again to decide whether the harness drifted. One reader, so the rendered prompt and the
  hash that guards it can never disagree.
- `ChatViewProvider.loadAgentsMd()` (`Agent.setGlobalAgentsMd` / `Agent.setAgentsMd`)
  still takes a per-window **fallback** snapshot at activation and on every
  workspace-folder change — used only when a file exists but cannot be read, so a
  transient failure cannot silently drop the instructions. A file that is *gone* is
  really gone: no stale snapshot lingers. `resetAgentsMdCache()` runs on a
  workspace-folder change, because the workspace path is part of the cache key.
- Both sections are composed by `agentsMdSection(sources)` into the `{{agentsMd}}`
  value, the template's last section:
  - `## Global AGENTS.md (all workspaces)` (`GLOBAL_AGENTS_MD_HEADING`), first;
  - `## Workspace AGENTS.md (project instructions)` (`AGENTS_MD_HEADING`), second.
  The headings live in that builder, not in the template: the sections are optional
  and ordered, and one builder is what keeps a missing file from leaving a dangling
  heading behind. Both present adds exactly **one** precedence line to the global
  section — the workspace file wins a conflict, because it is the narrower
  instruction.
- With neither file the whole trailing section is dropped, so the prompt just
  ends at `## Style`; there is never an empty heading. A workspace-only render is
  byte-for-byte what it was before the systemwide file existed.
- **An edit is seen by the next check, never by a running prefix.** The next
  `freezeEpoch` renders the new bytes and the next `setupState` reports the drift, so
  the composer offers `Continue with new context`; a chain that is already frozen keeps
  the bytes it was rendered with (that is the whole point of the epoch), so an edit
  never rewrites a prompt behind the model's back and needs no window reload.
  `Spinney: Open Global AGENTS.md` (`ChatViewProvider.openGlobalAgentsMd`) creates the
  file when it is missing and opens it; it never re-renders anything itself.
- The freeze hashes the **rendered** sections (`agentsMdSection(liveAgentsMdSources(...))`,
  `Epoch.agentsMdHash`), not one file, so a single hash covers both sources — see
  `invariants/system-prompt.md`.
- Sub-agents get no AGENTS.md section (neither file): the lean sub-agent template
  has no `{{agentsMd}}` placeholder, and that is deliberate.
- The identity line (model + reasoning effort) is the leading system prompt and is
  rewritten in place when model/effort changes — see `refreshSystemIdentity`.
