## Conversation validity / sanitizing
- Every assistant message with `tool_calls` must be immediately followed by a
  `tool` response for each `tool_call_id` or the API rejects the request (400).
- A `user` message **after** a complete `assistant(tool_calls) → tool(...)` block is
  valid and has **two** precedents: the `read_image` image block and the completion-signal
  injection. Both are pushed from inside `Agent.runTurn`, after the whole tool batch of one
  assistant round and before the next request:
  - completion signals (`agent.ts:625-634`): the `signalHandler` hook (`agent.ts:261`,
    set by `Agent.setSignalHandler`, `agent.ts:344`) returns the texts of finished background
    terminals / async sub-agent batches, pushed as `role:'user'` messages;
  - `read_image` uploads (`agent.ts:635-651`): the tool responses must come first, then the
    image content block (an image block is only valid in a `user` message).
- **Injection position rule:** the signals go after *all* tool responses of the batch — never
  between an `assistant(tool_calls)` and its `tool` messages. `sanitizeMessages`
  (`agent.ts:169`) walks that window (`agent.ts:201-225`), `break`s on the first non-matching
  message and then pops the assistant message together with its already-accepted tool
  responses when any `tool_call_id` is left unresolved — a foreign message inside the window
  therefore deletes the whole block on the next resume.
- `sanitizeMessages` drops dangling `tool_calls` and orphan `tool`
  messages when a session is restored, and is applied in `loadSessions`.
- The leading system message's identity is refreshed to the current model/effort
  on load; the rest of the history is preserved.

