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
  Agent Harness output channel with the clipped reason. When attempts run out,
  `withAttempts` appends `(after 10 attempts)` to the `DeepSeekError` message, so
  the error bubble in the chat says why it gave up.
- `uploadFile` and `getBalance` are **not** retried: an image upload failure is
  reported in the tool result / a warning notice, and a balance refresh is
  cosmetic. Uploading a 64 MiB body ten times is not a favour.
- The Agent's own image-rejection retry (`markRejectedImages`, see
  `vision-images.md`) still works because a 400 is not retriable here: it surfaces
  immediately and the Agent hides the offending image and re-asks.

## 2. The ▶ Continue / ↻ Retry button (transparent continue)

A turn can end without an answer in two ways: the user pressed Stop
(`node.status = 'interrupted'`, partial output kept as the checkpoint) or the
call failed (`node.status = 'error'`, the turn rolled back). Either way the user
used to have to type "continue" themselves. Now the card offers a button — and it
resumes **that node in place**: no new card, no visible node split.

- **Webview → host**: `{ type: 'continueTurn', id: <nodeId> }`
  (`main.js` `syncContinueButton`). The host routes it straight into
  `SessionRuntime.continueFrom` (`ChatViewProvider.handlePanelMessage`), which is
  the *only* entry point — it keeps the reboot hold (`host.isHeld()`), the
  per-node refusal (`runs.has(nodeId)`) and the "which message does the model
  get" decision in one place.
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
    `INTERRUPT_NOTICE` (which names the interrupted tool), so `sendUserMessage`
    prepends it; the harness text is just `CONTINUE_MESSAGE`
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
  and not currently running. The label is `▶ Continue` for an interruption and
  `↻ Retry` for a failure. It is synced from both entry points of a status change
  (`renderTree` and `applyNodeUpdate`) — a turn that ends after the tree was drawn
  arrives as `nodeUpdate`, so both must call it.
- **Honest transcript**: the harness text is a `kind:'harness'` display item,
  pushed into the node's own items and rendered inline by `addHarnessNote` as a
  badged (`HARNESS`) block — never a fabricated user bubble, and never the pinned
  prompt (that still shows what the user actually asked for). It shows the exact
  text the model received. The live path is a node-scoped `harnessNote` message
  routed with `routeTo`, so continuing a node that is *not* the view focus still
  writes into the right card.
- **Don't break**: `continueFrom` must keep going through `beginInjectedTurn`
  (hold gate, per-node `runs` gate, `fresh: false` append) rather than `beginTurn`
  — a new node is exactly the visible split this feature exists to avoid. A
  `kind:'user'` item would also be wrong: the webview pins only the *first* user
  item of a node, so it would either be dropped on replay or overwrite the user's
  own prompt.

## Evidence

- `npm run compile`, `npm run check:webview` (the checker asserts the button's
  show rules, the label, that clicking posts `continueTurn`, and that a
  harness-authored message is badged).
- A throwaway node script against the compiled client (9 checks): network ×2 then
  success, pre-content stream break retried, post-content break *not* retried,
  503 exhausting 10 attempts with the "(after 10 attempts)" text, 401 not
  retried, abort during the failure not retried, `complete()` sharing the policy.
