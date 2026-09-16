## Conversation validity / sanitizing
- Every assistant message with `tool_calls` must be immediately followed by a
  `tool` response for each `tool_call_id` or the API rejects the request (400).
- A `user` message **after** a complete `assistant(tool_calls) → tool(...)` block is
  valid and has **two** precedents: the `read_image` image block and the completion-signal
  injection. Both are pushed from inside `Agent.runTurn` (`agent.ts:655`), after the whole
  tool batch of one assistant round and before the next request:
  - completion signals (`agent.ts:694-696`): the `signalHandler` hook (`agent.ts:312`,
    set by `Agent.setSignalHandler`, `agent.ts:402`) returns the texts of finished background
    terminals / async sub-agent batches, pushed as `role:'user'` messages;
  - `read_image` uploads (`agent.ts:702-715`): the tool responses must come first, then the
    image content block (an image block is only valid in a `user` message).
- **Injection position rule:** the signals go after *all* tool responses of the batch — never
  between an `assistant(tool_calls)` and its `tool` messages. `Agent.sanitizeMessages`
  (`agent.ts:217`) walks that window (`agent.ts:250-269`), `break`s on the first non-matching
  message and then pops the assistant message together with its already-accepted tool
  responses when any `tool_call_id` is left unresolved — a foreign message inside the window
  therefore deletes the whole block on the next resume.
- `sanitizeMessages` drops dangling `tool_calls` and orphan `tool`
  messages. It is **not** applied by `loadSessions` (`ChatViewProvider.loadSessions` only
  hands the stored tree to `pruneSession`, which heals the nodes). The sanitized copy is
  produced where a request is assembled: `SessionRuntime.buildPath`
  (`src/chat/runtime.ts:1484`) prepends the fresh system prompt and sanitizes the path
  messages, and a sub-agent resume does the same for its stored conversation
  (`src/chat/runtime.ts:3499`). The sanitized copy is derived, never written back into the
  nodes (`src/chat/tree.ts:17`).
- No system message is ever stored: `pruneSession` (`src/chat/tree.ts:531`) deletes a stored
  one (`src/chat/tree.ts:542`), and a fresh prompt is synthesized per run by
  `SessionRuntime.buildPath` / `SessionRuntime.systemPromptFor`
  (`src/chat/runtime.ts:1484`, `src/chat/runtime.ts:1067`).
  So there is no stored identity to refresh on load — the leading system message is built at
  request time, which is what `docs/agents/invariants/chat-tree.md` means by "the system
  prompt is never stored in a node".
