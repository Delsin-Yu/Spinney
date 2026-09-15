## Interrupt / abort / rollback
- `Agent.cancel()` aborts an `AbortController`; `exec_command` and the SSE stream
  both watch the signal. `apiClient.ts` re-checks the signal before every read and
  after every buffered SSE line.
- On interruption the partial output/reasoning streamed so far is preserved as a
  single "checkpoint" assistant message (no `tool_calls` — those are always
  incomplete) via `Agent.preservePartialTurn`. The rest of the turn (completed
  tool iterations, etc.) is rolled back. This lets the next turn see where the
  model cut off and self-correct.
- On a non-interrupt error the partial assistant/tool messages of the turn are
  rolled back (`messages.splice(turnStartIndex)`) so history stays valid.
- `requestAssistantMessage` normalizes a cancellation (whether from the harness
  `isStopped` checks or a network-level abort thrown by the stream generator)
  into an `InterruptedError` carrying the partial `content`/`reasoning`.
- `exec_command` on Windows uses `taskkill /T /F` to kill the whole process tree
  (a plain `child.kill()` only kills the shell and leaves grandchildren alive).
- If the previous turn was interrupted, a `user`-role interruption notice — the text
  `buildInterruptNotice()` composes from `INTERRUPT_NOTICE_GENERIC` /
  `INTERRUPT_NOTICE_TAIL` (`src/agent/agent.ts` ~:45-52 and ~:127-133), pushed at the
  top of `Agent.sendUserMessage` (~:642-646) — is injected before the user's next
  message. When the stop landed while a tool
  call was being streamed, the notice is prefixed with the exact tool that was in
  progress (e.g. `` `write_file` tool call that writes to `path` ``) via
  `buildInterruptNotice`, so the model knows what it was doing and can re-issue or
  correct it; otherwise it falls back to the generic text. It tells the model the
  partial output was discarded and leaves it to the model to decide whether the
  new message is a steering correction (continue) or a fresh request (restart) —
  it does **not** force a restart.
- `Agent.sanitizeMessages` is applied where a history is assembled, **not** on session
  restore: `SessionRuntime.buildPath` (`src/chat/runtime.ts` ~:1475) and a sub-agent
  resume in `runSubAgent` (~:3455). It treats an assistant
  message without `tool_calls` as valid, so a preserved checkpoint message
  followed by a `user` message is safe on resume.
- A turn that ended in `interrupted` (or `error`) also offers the ▶ Continue
  button on its card, which runs exactly the "continue" turn for the user — see
  `api-retries.md` (`SessionRuntime.continueFrom`).

