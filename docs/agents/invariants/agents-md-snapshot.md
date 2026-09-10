## AGENTS.md snapshot (this file)

- `ChatViewProvider.loadAgentsMd()` reads `./AGENTS.md` **once per extension-host
  activation** (in the provider's constructor) and calls `Agent.setAgentsMd(...)`.
- The snapshot itself lives in `src/agent/prompt.ts` (module-level
  `agentsMdSnapshot`) and is injected into `{{agentsMd}}`, the template's last
  section, under the heading `## 工作区 AGENTS.md（项目说明）`.
- With no snapshot the whole trailing section — heading included — is dropped, so
  the prompt just ends at `## 风格`; there is never an empty heading.
- Later edits to `AGENTS.md` do **not** reach a running extension host: the
  snapshot is read once per activation, and the system prompt is re-synthesized
  from it on every activation/checkout (`buildPath`). So an edit takes effect
  after a **window reload** — starting a new session in the same window does *not*
  re-read the file.
- The identity line (model + reasoning effort) is the leading system prompt and is
  rewritten in place when model/effort changes — see `refreshSystemIdentity`.
