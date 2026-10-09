## Interrupt / abort / rollback
- `Agent.cancel()` aborts an `AbortController`; `exec_command` and the SSE stream
  both watch the signal. `apiClient.ts` re-checks the signal before every read and
  after every buffered SSE line.
- **A rollback removes the INCOMPLETE TAIL, never the whole turn.** Both endings —
  a Stop and a non-interrupt error — narrow the history with the same rule,
  `Agent.sanitizeMessages` (`src/agent/agent.ts` ~:404), instead of splicing back to
  where the turn started. A turn's **completed** rounds (an assistant `tool_calls`
  message together with a `tool` response for every id) are finished work the model
  already paid for, and dropping them is what made a resume re-do work — the
  "the agent always starts fresh" report. What is still dropped is exactly what the
  API refuses: an assistant message whose `tool_calls` have no matching `tool`
  responses, and orphan `tool` messages.
  - **non-interrupt error** → `runTurn`'s catch sets
    `this.messages = Agent.sanitizeMessages(this.messages)` (~:1020) and then emits
    the `error` event.
  - **interrupted** → `preservePartialTurn` (~:1126) narrows with the same
    `sanitizeMessages`; an interrupted `tool_calls` block has no responses, so it is
    the thing that goes.
- **The checkpoint.** Partial output/reasoning streamed so far is preserved as a
  single assistant message — no `tool_calls` (those are always incomplete) — via
  `Agent.pushCheckpoint` (~:1104), the one rule the two keep-partial paths share: the
  Stop path (`preservePartialTurn`) and a re-issued request (§1c of `api-retries.md`,
  `requestRound` ~:1047). `content || reasoning` (reasoning is mirrored into
  `content` when no answer text had arrived yet, because the API rejects an assistant
  message carrying neither), and `reasoning_content` **stays** — the mirror may not
  consume it, in that case or any other: thinking mode refuses a content-only
  assistant message (`The reasoning_content in the thinking mode must be passed back
  to the API.`, a 400), which is what a checkpoint sent without it did to the whole
  conversation below the node. This lets the next turn see where the model cut off.
  `preservePartialTurn` reads that candidate out of the turn's tail **before**
  sanitizing, and pushes it **after**: the interrupted `assistant(tool_calls)`
  message is the only place a stop that landed during tool execution left the text it
  had already streamed, and it is exactly the message `sanitizeMessages` drops.
  The same rule binds `sanitizeMessages`' own heal (an assistant message with reasoning
  and no content is mirrored **and** keeps the reasoning), which is why a history stored
  by a build that dropped it is sendable again after one reload — no session surgery.
- `requestAssistantMessage` normalizes a cancellation (whether from the harness
  `isStopped` checks or a network-level abort thrown by the stream generator)
  into an `InterruptedError` carrying the partial `content`/`reasoning`.
- `exec_command` on Windows uses `taskkill /T /F` to kill the whole process tree
  (a plain `child.kill()` only kills the shell and leaves grandchildren alive).
- **The interruption notice belongs to a TYPED message, not to a resume.** If the
  previous turn was interrupted, a `user`-role notice — the text
  `buildInterruptNotice()` composes from `INTERRUPT_NOTICE_GENERIC` /
  `INTERRUPT_NOTICE_TAIL` (`src/agent/agent.ts` ~:137-163 and ~:232-239), pushed at
  the top of `Agent.sendUserMessage` — is injected before the user's next typed
  message. When the stop landed while a tool
  call was being streamed, the notice is prefixed with the exact tool that was in
  progress (e.g. `` `write_file` tool call that writes to `path` ``) via
  `buildInterruptNotice`, so the model knows what it was doing and can re-issue or
  correct it; otherwise it falls back to the generic text. It states where the
  model stopped — *what it had written so far is above, unchanged* — and leaves it
  to the model to decide whether the new message is a steering correction
  (continue) or a fresh request (restart); it does **not** force a restart. It must
  never say the partial output was discarded or is no longer in the conversation:
  the checkpoint is right there in the history the message is appended to, and
  claiming otherwise is what made a resume read as a restart.
- **The harness-authored resume says almost nothing, on purpose.**
  `SessionRuntime.continueFrom` starts the turn with `Agent.resumeTurn()` (~:886),
  not `sendUserMessage`, so nothing is pushed on the model's behalf — no failure
  narrative, no "continue from where you stopped" — and the request carries the
  history as it stands. The one exception is a tool call a Stop **stranded**: that is
  the only state a history cannot express (a `tool_calls` block with no `tool`
  response), so it is stated once as a pure fact —
  `[Harness] Your previous <describeToolCall(…)> was cut off and did not finish; do
  not assume it completed.` (`buildStrandedToolFact`, ~:260; several calls joined
  with " and ") — and `resumeTurn` returns that line so the card shows exactly what
  the model received (`undefined` → no harness note at all). The four shapes a resume
  can take are enumerated in `api-retries.md` §2.
- `Agent.sanitizeMessages` is applied where a history is assembled, **not** on session
  restore: `SessionRuntime.buildPath` (`src/chat/runtime.ts` ~:1937) and a sub-agent
  resume in `runSubAgent` (~:4672). It treats an assistant
  message without `tool_calls` as valid, so a preserved checkpoint message
  followed by a `user` message is safe on resume.
- A turn that ended in `interrupted` (or `error`) also offers the ▶ Continue / ↻
  Retry button on its card, which resumes that node in place through
  `SessionRuntime.continueFrom` → `Agent.resumeTurn()` — see `api-retries.md` §2.
  A Stop followed by a **typed** prompt is the other path: a new node opens, and the
  interruption notice above is what the model receives.
