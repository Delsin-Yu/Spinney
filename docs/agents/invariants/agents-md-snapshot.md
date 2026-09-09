## AGENTS.md snapshot (this file)
- `ChatViewProvider.loadAgentsMd()` reads `./AGENTS.md` **once** at construction
  (session start) and calls `Agent.setAgentsMd(...)`.
- `Agent` stores it in a static `agentsMdSnapshot` and appends it to the system
  prompt under `## Workspace AGENTS.md (project instructions)`.
- Later edits to `AGENTS.md` do **not** propagate into an existing session.
- The identity line (model + reasoning effort) is the leading system prompt and
  is rewritten in place when model/effort changes — see `refreshSystemIdentity`.

