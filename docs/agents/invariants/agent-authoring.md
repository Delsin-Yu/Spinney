## Agent-authoring notes
- The agent is instructed to **default to Simplified Chinese (zh-Hans)** for
  replies (eager, not just allowed) and to keep code, paths, identifiers, and
  command output in their original form (see `CORE_PROMPT`'s `## Language`).
  Do not add English-only output requirements to the model.
- `CORE_PROMPT` also carries an **"Ask instead of guessing"** rule (ask one short
  clarifying question when a request is genuinely ambiguous rather than silently
  settling on a reading) and a light **"Tone"** section inviting playful, concise,
  friendly replies (borrowed from the community DeepSeek persona), gated by a
  **"Correctness always wins"** rule that keeps the tone from ever compromising
  accuracy — and drops it entirely in serious/high-stakes contexts.
- The harness trusts the model to emit tool calls; there is no validation of text
  answers, only tool-argument parsing.
- **Plugin text vs workspace facts (hard rule).** Text that ships with the
  extension and reaches the model — `CORE_PROMPT`, every tool `description`, the
  `ADVANCED_TOPIC_DOCS` bodies in `src/tools/advancedDocs.ts`, and
  `Agent.subAgentSystemPrompt` — must contain **no workspace-specific facts**
  (paths such as `docs/agents/…`, script names such as `npm run compile`, repo
  layout, file names). Other users install this extension into unrelated
  workspaces, where such a fact is simply wrong. Workspace facts belong in the
  workspace's own `AGENTS.md` snapshot (and the docs it points at); plugin text
  may only carry plugin facts — tool names/args, model ids, and the `AGENTS.md`
  convention name itself.

