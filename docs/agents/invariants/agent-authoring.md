## Agent-authoring notes

Where the text lives, the template/placeholder mechanics and the two hard rules
(no workspace facts, no model ids) are in
`docs/agents/invariants/system-prompt.md`. This file is about *what* to write.

- **One place.** All prompt text lives in `src/agent/prompt.ts`. Change wording
  there — not in `agent.ts`, and never inline in a tool description.
- **Syntax is not prompt text.** The line above is about behavioural text. A tool's
  *contract* (argument shape, tolerances, error semantics) belongs in its
  `description`, because the prompt carries no tool list and the API `tools` field
  is the only channel the model reads it from. The verbatim-frame shape is the
  worked example: the prompt once restated it, that restatement was dropped with
  the tool list, and the description that remained ("set frame:true, put a short
  JSON header…") was vague enough that agents wrapped the RAW markers inside the
  JSON string ~2% of the time and wrote them into files. The description now spells
  out the correct and the wrong shape, and `embeddedFrameError` rejects the wrong
  one. When you remove a guide from the prompt, check the description left behind
  can stand alone.
- **Default to Simplified Chinese (zh-Hans)** for replies — eager, not merely
  allowed — and keep code, paths, identifiers and command output in their original
  form. Do not add English-only output requirements to the model.
- **Ask instead of guessing**: one short clarifying question when a request is
  genuinely ambiguous (listing the most likely readings, so the user can answer in
  one line) instead of silently settling on a reading.
- **The approval gate is the first behavioural section** (`## Approval before
  work`): the agent discusses a topic and waits for an explicit go-ahead before
  any state-changing work; it auto-starts only when the user said so in the
  instruction itself ("just do it"). Two boundaries are load-bearing: the gate
  covers *state-changing* work only, so read-only investigation while discussing
  is untouched, and it is **main-agent only** — a sub-agent has no user to ask and
  would either stall or invent the approval. The gate also owns the "don't re-ask
  per file once the topic is approved" half, which is why the old "when the intent
  is clear, just do it" clause is gone from `## Ask when it matters`: with the gate
  in place a clear request still waits. Do not reintroduce it.
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
