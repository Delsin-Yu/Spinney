## Conversation validity / sanitizing
- Every assistant message with `tool_calls` must be immediately followed by a
  `tool` response for each `tool_call_id` or the API rejects the request (400).
- `Agent.sanitizeMessages` drops dangling `tool_calls` and orphan `tool`
  messages when a session is restored, and is applied in `loadSessions`.
- The leading system message's identity is refreshed to the current model/effort
  on load; the rest of the history is preserved.

