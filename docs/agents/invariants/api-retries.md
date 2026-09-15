# Transient model-call failures: retries, and the ▶ Continue button

Two halves of one story — "a model call failed, what now?" — and neither may be
implemented anywhere else.

## 1. Transparent retries (`src/agent/deepseek.ts`)

`DeepSeekClient.stream` and `.complete` both POST through `postWithRetry`, which
retries a **transient** failure up to `MAX_ATTEMPTS = 10` total attempts
(the initial try + 9 retries) with `retryDelay` backoff: 1s, 2s, 4s, … capped at
`RETRY_MAX_DELAY_MS = 30s` (worst case ≈ 2.5 minutes).

- **Retriable**: a `fetch` rejection (network / DNS / TLS), HTTP `408`, `429`,
  `>= 500`, and a `200` with no body. **Not retriable**: every other 4xx — 400
  (bad request / provider-rejected image), 401/403 (key), 404, 422. Those cannot
  fix themselves, and retrying them would only hide the real error behind a
  two-minute wait.
- **Only while nothing was yielded.** A streaming request is retried only before
  the first chunk reaches the caller: the caller has already assembled output
  from anything it received, so re-sending would duplicate it. A mid-stream break
  after the first chunk is fatal (`stream()` tracks `yielded`; the retry is
  `postWithRetry(…, attemptStart = attempt + 1)` so the count stays monotonic).
- **Stop wins.** `retryLater` refuses once `signal.aborted`, and `sleep` wakes on
  the abort event, so pressing Stop during a 30s backoff interrupts immediately —
  no retry, no waiting. An aborted request is never retried.
- **Never silent.** Every retry is reported through `CompletionRequest.onRetry`
  (the Agent turns it into a `status` event, `retryStatus` in `agent.ts`:
  "Model call failed (2/10); retrying in 2s…") and logged via `perf()` to the
  Spinney output channel with the clipped reason. When attempts run out,
  `withAttempts` appends `(after 10 attempts)` to the `DeepSeekError` message, so
  the error bubble in the chat says why it gave up.
- `uploadFile` and `getBalance` are **not** retried: an image upload failure is
  reported in the tool result / a warning notice, and a balance refresh is
  cosmetic. Uploading a 64 MiB body ten times is not a favour.
- The Agent's own image-rejection retry (`markRejectedImages`, see
  `vision-images.md`) still works because a 400 is not retriable here: it surfaces
  immediately and the Agent hides the offending image and re-asks.

### 1b. The stall watchdogs (a request that produces nothing is not "thinking")

The retry policy above only reacts to an **error**, and a connection that goes
quiet neither errors nor ends — so the only thing that used to end such a request
was the user pressing Stop. That was the "the first answer takes forever, and Stop
+ Continue makes it instant" report: after a long silence the client is most likely
handed a pooled keep-alive socket the provider already dropped, `fetch` never
resolves, the turn shows `Thinking…` with the tok/s meter pinned at 0, and the
`[perf]` channel stays empty (nothing is logged before the response headers
arrive). Three timers in `deepseek.ts` now bound it:

- `FIRST_BYTE_TIMEOUT_MS` (20 s) — no response headers. `FIRST_BYTE_TIMEOUT_AFTER_IDLE_MS`
  (12 s) is used instead when the previous attempt started ≥ `IDLE_GAP_MS` (60 s)
  ago: that is the request most likely to be holding a dead socket, and the abort
  is what tears it down, so the retry leaves on a connection known to be fresh.
  The budget is measured against a narrow healthy baseline — ~1000 logged requests
  land in 0.5–3.4 s to first byte (p99 ≈ 2.9 s).
- `FIRST_CHUNK_TIMEOUT_MS` (20 s) — headers arrived but no payload. Nothing has
  been yielded yet, so this stays **retriable**.
- `STREAM_IDLE_TIMEOUT_MS` (60 s) — silence *inside* an answer. Thoughts and tool
  args pulse every ~50 ms, so a full minute is unambiguous; after the first chunk
  the retry rule above applies unchanged (fatal, no duplicate output).

Each attempt runs on its own `AttemptWatch` signal, chained to the caller's: the
watchdogs abort only the attempt, so `opts.signal.aborted` keeps meaning "the user
pressed Stop — never retry". A watchdog abort is reported like any other transient
failure (`onRetry` → the "retrying (n/10)…" status) and the retry rides the same
backoff budget. Instrumentation for the next report: a
`request-headers pending <ms> attempt=N idle=…` line every 5 s while a request has
no first byte, `request-headers … idle= budget=ms`, `request-first-chunk <ms>`
(= the real TTFT), `request-timeout <headers|network>`, and `request-stall <reason>
yielded=<bool>` for a stream that went quiet. `complete()` (session titles) shares
the header watchdog but not the body one — its caller already bounds it.

## 2. The ▶ Continue / ↻ Retry button, and its ⧉ Continue in a new window variant (transparent continue)

A turn can end without an answer in two ways: the user pressed Stop
(`node.status = 'interrupted'`, partial output kept as the checkpoint) or the
call failed (`node.status = 'error'`, the turn rolled back). Either way the user
used to have to type "continue" themselves. Now the card offers a button — and in
the ordinary cases it resumes **that node in place**: no new card, no visible node
split. One button, one meaning at a time: the third button state is a failure the
provider caused by refusing the request as too big, and there the same slot offers
a rollover instead, whose whole point is a *new* card.

- **Webview → host**: `{ type: 'continueTurn', id: <nodeId> }`
  (`main.js` `syncContinueButton`). The host routes it straight into
  `SessionRuntime.continueFrom` (`ChatViewProvider.handlePanelMessage`), which is
  the *only* entry point — it keeps the reboot hold (`host.isHeld()`), the
  per-node refusal (`runs.has(nodeId)`) and the "which message does the model
  get" decision in one place.
- **Who decides it is a context-length failure**: the host, once, and it ships a
  boolean — `contextFull` on the `tree` node payload and in every `nodeUpdate`
  patch, computed from the node's own persisted failure text (`node.status ===
  'error' && parseContextLengthError(lastFailureText(node)) !== undefined`), so a
  reload and a live turn agree. The webview therefore never parses an error
  string, and no second copy of the provider's wording exists in `main.js`. The
  host entry point is `ChatViewProvider.handlePanelMessage` → `rolloverTurn` →
  `SessionRuntime.rolloverContext(nodeId)`; what that does is `context-rollover.md`.
- **In place, not a new node**: `continueFrom` uses `beginInjectedTurn(node)` —
  the same mechanism the background / sub-agent completion notices use. The run is
  bound to the existing node (`fresh: false`), its reply is appended to that
  node's history, and the view focus does not move. `node.status` is set to
  `running` for the duration (patched with a `nodeUpdate`) so the chip and the
  button follow it.
- **What the model gets** (`runtime.ts`) — the context where it stopped, nothing
  re-derived:
  - interrupted → the checkpoint `preservePartialTurn` stored is already in that
    node's history, and the node's own agent still holds the pending
    `buildInterruptNotice()`'s notice (which names the interrupted tool), so
    `sendUserMessage` prepends it; the harness text is just `CONTINUE_MESSAGE`
    ("Continue from where you stopped.").
  - failed → the history the rollback restored, i.e. right after the last
    completed tool call, plus `buildFailureContinue(error)`: a `[Harness continue] …`
    note quoting the error, which the model could not otherwise see. The error text
    is read back from the node's own card (`lastFailureText` → the persisted
    `⚠️ …` item), not from a side table, so it survives a reload and is exactly
    what the user can read there.
- **Show rules** (`syncContinueButton`, `media/main.js`): a terminal *tip* of a
  conversational branch — status `interrupted`/`error`, no turn child yet (a node
  that already has a conversational continuation is not offered again), not
  `kind:'agent'`/`'bg'` (sidecars have no conversation of their own in this path),
  and not currently running. Those rules are unchanged by the rollover variant —
  only the **label and the action** follow the failure. Three states: `▶ Continue`
  for an interruption, `↻ Retry` for any other failure, and `⧉ Continue in a new
  window` when `contextFull` is set — that variant also adds `node-rollover` and
  `data-action="rollover"`, and its click posts `{ type: 'rolloverTurn', id }`
  instead of `{ type: 'continueTurn', id }`. Retry is **replaced**, never offered
  beside it: the request it would re-send is the same oversized one, so it is
  guaranteed to fail again, and a second button for one failure would make the
  card claim two possible outcomes where there is one. It is synced from both
  entry points of a status change (`renderTree` and `applyNodeUpdate`) — a turn
  that ends after the tree was drawn arrives as `nodeUpdate`, so both must call it
  (and `applyNodeUpdate` must merge the flag into `treeNodes[id]` *before* it
  re-syncs, or that entry point would show the wrong variant).
- **Honest transcript**: the harness text is a `kind:'harness'` display item,
  pushed into the node's own items and rendered inline by `addHarnessNote` as a
  badged (`HARNESS`) block — never a fabricated user bubble, and never the pinned
  prompt (that still shows what the user actually asked for). It shows the exact
  text the model received. The live path is a node-scoped `harnessNote` message
  routed with `routeTo`, so continuing a node that is *not* the view focus still
  writes into the right card.
- **Don't break**: `continueFrom` must keep going through `beginInjectedTurn`
  (hold gate, per-node `runs` gate, `fresh: false` append) rather than `beginTurn`
  — for a continue/retry, a new node is exactly the visible split this feature
  exists to avoid. (The rollover is the one variant that *does* want a new card, so it
  goes through `rolloverContext` instead — which still falls back to `continueFrom`
  when the node turns out not to be context-full, see `context-rollover.md`.) A
  `kind:'user'` item would also be wrong: the webview pins only the *first* user
  item of a node, so it would either be dropped on replay or overwrite the user's
  own prompt.

## Evidence

- `npm run compile`, `npm run check:webview` (the checker asserts the button's
  show rules, the labels, that clicking posts `continueTurn` (and `rolloverTurn`
  for the context-full variant), that the flag arriving by `nodeUpdate` switches
  the variant, and that a harness-authored message is badged).
- `npm run check:rollover` — the pure-function guard for the window-starting flag,
  the prefix cut and the provider error-text parse (what it proves is listed in
  `context-rollover.md` §10).
- A throwaway node script against the compiled client (9 checks): network ×2 then
  success, pre-content stream break retried, post-content break *not* retried,
  503 exhausting 10 attempts with the "(after 10 attempts)" text, 401 not
  retried, abort during the failure not retried, `complete()` sharing the policy.
