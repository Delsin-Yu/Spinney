## Agent-authoring notes

Where the text lives, the template/placeholder mechanics and the two hard rules
(no workspace facts, no model ids) are in
`docs/agents/invariants/system-prompt.md`. This file is about *what* to write.

- **One place.** All prompt text lives in `src/agent/prompt.ts`. Change wording
  there — not in `agent.ts`, and never inline in a tool description.
- **Default to Simplified Chinese (zh-Hans)** for replies — eager, not merely
  allowed — and keep code, paths, identifiers and command output in their original
  form. Do not add English-only output requirements to the model.
- **Ask instead of guessing**: one short clarifying question when a request is
  genuinely ambiguous (listing the most likely readings, so the user can answer in
  one line) instead of silently settling on a reading.
- There is deliberately **no tone/persona section** and no "correctness always
  wins" clause: an earlier version of this doc described both as living in the
  prompt, but they never did. Style lives in the template's `## 风格` bullets and
  accuracy is covered by the ask-first rule — do not reintroduce the other two.
- **The sub-agent prompt stays lean**: identity + environment + three behaviour
  lines (reply in Chinese, finish with a conclusion, do not overstep file changes),
  plus the read-only fan-out reminder for a read-only depth-1 sub-agent. Never give
  it the main template.
- **The prompt carries no tool list** (schemas go in the API `tools` field) and no
  capability inventory; where a capability is mentioned, it must derive from the
  same flags that build the tool list.
- The harness trusts the model to emit tool calls; there is no validation of text
  answers, only tool-argument parsing.
