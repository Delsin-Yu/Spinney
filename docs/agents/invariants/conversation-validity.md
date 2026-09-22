## Conversation validity / sanitizing
- Every assistant message with `tool_calls` must be immediately followed by a
  `tool` response for each `tool_call_id` or the API rejects the request (400).
- A `user` message **after** a complete `assistant(tool_calls) → tool(...)` block is
  valid and has **two** precedents: the `read_image` image block and the completion-signal
  injection. Both are pushed from inside `Agent.runTurn` (`agent.ts`, the block after
  `executeToolCall`), after the whole
  tool batch of one assistant round and before the next request:
  - completion signals (`agent.ts`, `for (const text of this.signalHandler?.() ?? [])`):
    the hook (set by `Agent.setSignalHandler`) returns the texts of finished background
    terminals / async sub-agent batches, pushed as `role:'user'` messages;
  - `read_image` uploads (`agent.ts`, the `pendingImages` block): the tool responses must
    come first, then the image content block (an image block is only valid in a `user`
    message).
- **Injection position rule:** the signals go after *all* tool responses of the batch — never
  between an `assistant(tool_calls)` and its `tool` messages. `Agent.sanitizeMessages`
  (`agent.ts:266`) walks that window (`agent.ts:300-321`), `break`s on the first non-matching
  message and then pops the assistant message together with its already-accepted tool
  responses when any `tool_call_id` is left unresolved — a foreign message inside the window
  therefore deletes the whole block on the next resume.
- `sanitizeMessages` drops dangling `tool_calls` and orphan `tool`
  messages. It is **not** applied by `loadSessions` (`ChatViewProvider.loadSessions` only
  hands the stored tree to `pruneSession`, which heals the nodes). The sanitized copy is
  produced where a request is assembled: `SessionRuntime.buildPath`
  (`src/chat/runtime.ts`, the `Agent.sanitizeMessages([system, ...pathMessages(...)])`
  call) prepends the branch's **epoch prompt** — the frozen one, or the live
  `systemPromptFor(node)` render for a chain with no envelope — and sanitizes the path
  messages, and a sub-agent resume does the same for its stored conversation
  (`src/chat/runtime.ts`, the `SubAgent` resume path). The sanitized copy is derived, never
  written back into the nodes (`src/chat/tree.ts` header comment).
- No system message is ever stored **in a node's `messages`**: `pruneSession`
  (`src/chat/tree.ts`, the `m.role !== 'system'` filter — its comment still says
  "synthesized per activation", the filter is the rule) deletes a stored
  one, and the leading `system` message of a request is built at request time from the
  branch's frozen envelope (`epochForNode(...).prompt`, `src/chat/tree.ts`) or, for a
  chain that has none, from a live render
  (`SessionRuntime.buildPath` / `SessionRuntime.systemPromptFor`,
  `src/chat/runtime.ts`). What *is* stored is the envelope itself — on the node that
  starts the epoch, **outside** `messages` (`node.epoch.prompt`,
  `docs/agents/invariants/system-prompt.md`), which is why "the system prompt is
  never stored in a node" (`docs/agents/invariants/chat-tree.md`) is about messages
  only.
- The one deliberate exception to "a built history is never mutated": a
  provider-rejected image is repaired **in the history** by
  `Agent.markRejectedImages` (`src/agent/agent.ts`), the offending block becoming its
  placeholder text part in the message the turn will store — written once and
  recorded, never re-applied on every later send (`vision-images.md`).
