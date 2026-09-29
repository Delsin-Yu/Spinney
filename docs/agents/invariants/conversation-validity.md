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
- **The outbound wire shape:** every string in a request sent to the provider must be
  well-formed UTF-16 — no unpaired surrogate — because `JSON.stringify` writes an unpaired
  half as a legal-looking escape (`"\ud83d"`) and the provider's *validating* reader rejects
  it (`messages[62].content: unexpected end of hex escape`): a 400 that kills the **whole**
  request, not just that message. The half comes from a **clip that cut a surrogate pair**
  (an emoji is two code units), so every clip that can end a *sent* string goes through
  `src/text.ts` — `clipText` / `sliceText` / `tailText`, never `slice`. Family by family: the
  transcript renderer's `clip` (`src/chat/transcript.ts`, and with it the hit line and its
  label, `clip(rendered[i], 200)` / `clip(label, 100)`, and the session-header titles,
  `clip(t, 60)`); `truncate` (`src/tools/index.ts`, the shared tool-result cap); in
  `src/chat/runtime.ts` `clipForUi` (the webview's own copy, not the wire),
  `buildFailureContinue`, `SessionRuntime.truncateField`, the rollover carry-over
  (`sliceText(input.request, ROLLOVER_REQUEST_CAP)`, and its answer) and the killed job's
  `command` (`clipText(task.command, 80)`); `truncateField` (`src/agent/agent.ts`); the tool
  results that *are* a rendered line — the five 160-unit line cuts in
  `src/tools/searchFiles.ts`, `tidy` and the `http-error` detail in
  `src/tools/webBackends.ts` (the tree's `\u2026`, the escape the guard's source scan reads as
  an ellipsis too), and `describeFetchError` in `src/tools/webFetch.ts`; and the titles —
  `src/chat/sessionTitles.ts` (`clipLine`, the digest summary, the auto title),
  `titleFromPrompt` (`src/chat/tree.ts`), the provisional session / sub-agent titles in
  `src/chat/runtime.ts`, and `src/chat/ChatViewProvider.ts` (`summaryPreview`, the
  `hop_session` title, the hop receipt's 8000-unit answer). The one cut at the **head** is a
  background terminal's output tail — `tailText` (`src/chat/runtime.ts`, the `BackgroundInfo`
  tail and `node.bgOutputTail`) — where the danger is the same half on the other side: text
  that begins on a low surrogate. Log-only, on a string that leaves through a log line:
  `ApiClient.clipReason` (`src/agent/apiClient.ts`), `src/redact.ts` and `src/perf.ts`.
  The belt-and-braces boundary is
  `ApiClient.stream` / `ApiClient.complete` (`src/agent/apiClient.ts`), which put the **whole
  request body** of *every* `/chat/completions` request through `wellFormedDeep`
  (`JSON.stringify(wellFormedDeep(body))` — the messages, the card-supplied `model` /
  `reasoning_effort` and the tool schemas alike; unpaired half → U+FFFD, containers copied):
  a half that arrived by another route — a tool result, a paste, a stored message from an
  old node — is caught there, and only the wire copy is normalised, the caller's in-memory
  messages stay as they are. Measured 2026-09-24 (the incident
  `src/text.ts` names): one `search_transcripts` hit, its rendered `replace_in_file`
  arguments clipped at 200, cut the `📎` (U+1F4CE = D83D DCCE) exactly between its halves —
  the tail it returned in the tool result read `**` + U+D83D + `…`, and the very next
  request of that turn died with 400
  `… messages[62].content: unexpected end of hex escape` (line 1 column 321596).
  The gate is `tools/check-unicode.js` (`npm run check:unicode`, wired into
  `vscode:prepublish`): it drives the compiled `out/text.js` and fails when a helper returns
  an unpaired surrogate, when `JSON.stringify` of a sanitised value carries a
  lone-surrogate escape, or when a `slice`-then-`…` clip reappears anywhere in
  `src/**/*.ts` (four shapes — the head clip and the **tail** one, whose lone half is the
  *low* one and whose remedy is `tailText` — with the ellipsis read as `…` or as `\u2026`).
