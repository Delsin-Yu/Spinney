# Transient model-call failures: retries, and the ▶ Continue button

Two halves of one story — "a model call failed, what now?" — and neither may be
implemented anywhere else.

One rule binds the two halves, and it is the whole design: **a transient failure is
never silent to the user, and never narrated to the model.** The user sees every
attempt — the status line, the `perf()` channel, the card's ⟳ marker, and the ⚠️
item when the attempts run out. The model sees *nothing*: not the failure, not the
retry, not a word about either. What it continues from is the conversation it was
already having, so a failed call can never read to it as "your work was thrown away,
start over" — the report this design answers ("the agent always starts fresh").

## 1. Transparent retries (`src/agent/apiClient.ts`)

`ApiClient.stream` and `.complete` both POST through `postWithRetry`, which
retries a **transient** failure up to `MAX_ATTEMPTS = 10` total attempts
(the initial try + 9 retries) with `retryDelay` backoff: 1s, 2s, 4s, … capped at
`RETRY_MAX_DELAY_MS = 30s` (worst case ≈ 2.5 minutes).

- **Retriable**: a `fetch` rejection (network / DNS / TLS), HTTP `408`, `429`,
  `>= 500`, and a `200` with no body. **Not retriable**: every other 4xx — 400
  (bad request / provider-rejected image), 401/403 (key), 404, 422. Those cannot
  fix themselves, and retrying them would only hide the real error behind a
  two-minute wait. `isRetriableStatus` is the one spelling of that rule, and it is
  **exported**: the turn-level ladder in §1c calls it instead of copying it, because
  the two layers must agree on what "transient" means — otherwise a 400 would be
  re-sent from above after this client had already decided it was fatal.
- **Only while nothing was yielded.** A streaming request is retried only before
  the first chunk reaches the caller: the caller has already assembled output
  from anything it received, so re-sending would duplicate it. A mid-stream break
  after the first chunk is fatal here (`stream()` tracks `yielded`; the retry is
  `postWithRetry(…, attemptStart = attempt + 1)` so the count stays monotonic) —
  and it is precisely the failure the turn-level checkpoint of §1c exists for.
- **Stop wins.** `retryLater` refuses once `signal.aborted`, and `sleep` wakes on
  the abort event, so pressing Stop during a 30s backoff interrupts immediately —
  no retry, no waiting. An aborted request is never retried.
- **Loud to the user, silent to the model.** Every retry is reported through
  `CompletionRequest.onRetry` (the Agent turns it into a `status` event,
  `retryStatus` in `agent.ts`: "Model call failed (2/10); retrying in 2s…") and
  logged via `perf()` to the Spinney output channel with the clipped reason. When
  attempts run out, `withAttempts` appends `(after 10 attempts)` to the `ApiError`
  message, so the error bubble in the chat says why it gave up. The model is told
  none of it: this ladder never writes into the history, and the request it retries
  is rebuilt from the messages it already has (§1c).
- `uploadFile` is **not** retried: an image upload failure is reported in the tool
  result / a warning notice, and uploading a 64 MiB body ten times is not a favour.
  The wallet readout keeps that rule, but it is not this client's any more: it lives
  in `src/agent/balance.ts` (`fetchBalance`, one call per dialect — see
  `model-cards.md`), which sits outside this policy and is never retried either.
- The Agent's own image-rejection retry (`markRejectedImages`, see
  `vision-images.md`) still works because a 400 is not retriable here: it surfaces
  immediately from this client, and the Agent **repairs the history** — the offending
  image block becomes its placeholder text part in the message about to be stored —
  and re-asks (`< 8` times). That loop lives inside `requestAssistantMessage`, i.e.
  *below* the ladder of §1c, so a rejected image never spends a whole-request
  re-issue.

### 1b. The stall watchdogs (a request that produces nothing is not "thinking")

The retry policy above only reacts to an **error**, and a connection that goes
quiet neither errors nor ends — so the only thing that used to end such a request
was the user pressing Stop. That was the "the first answer takes forever, and Stop
+ Continue makes it instant" report: after a long silence the client is most likely
handed a pooled keep-alive socket the provider already dropped, `fetch` never
resolves, the turn shows `Thinking…` with the tok/s meter pinned at 0, and the
`[perf]` channel stays empty (nothing is logged before the response headers
arrive). Three timers in `apiClient.ts` now bound it:

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
  the retry rule above applies unchanged (fatal here, no duplicate output — and the
  turn-level ladder may still re-issue the whole request, §1c).

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

## 1c. The turn-level ladder: three whole-request re-issues (`src/agent/agent.ts`)

When the client's own ladder gives up, the failure is not necessarily final. A
turn may re-issue the **whole request** — the same one, built from the same
history — and only the model's conversation staying untouched makes that
acceptable: the model is asked the same question again, in the same words.

- **The bound is per turn.** `Agent.runTurn` opens the ladder's budget once
  (`const budget = { reissues: 0, deadline: Date.now() + TRANSPARENT_BUDGET_MS }`)
  and every assistant round of that turn shares it — at most
  `TRANSPARENT_ATTEMPTS = 3` re-issues inside a
  `TRANSPARENT_BUDGET_MS = 6 * 60_000` wall-clock deadline, counted across the
  whole turn rather than handed back by each request. Deliberately tiny: a turn that
  has already failed ten attempts three times over is a provider outage, and the
  user has to see it. Each re-issue still runs under the client's own ladder and
  watchdogs (§1/§1b), so one re-issue can itself be ten attempts long.
- **The decision is a pure function.** `shouldReissueTransparently(status,
  reissuesUsed, now, deadline)` is exported and reads no clock of its own — the
  caller owns the counter and the deadline it passes in — and it is
  `reissuesUsed < TRANSPARENT_ATTEMPTS && now < deadline && (status === undefined ||
  isRetriableStatus(status))`. The status is `ApiError.status`, i.e. the HTTP status
  of the failure, `undefined` when there was none:
  - **`undefined` is transient** — a `fetch` rejection (network / DNS / TLS), a
    stream that broke off mid-body, a `200` with no body. Nothing was refused, so
    re-issuing identical bytes on a fresh socket is the same question asked again.
  - **`isRetriableStatus` (408/429/5xx) is transient** — the provider answered
    "not now", not "no".
  - **Every other 4xx is a refusal** and surfaces immediately, spending no budget:
    401/403 (key), 404, 422, and the 400s the card has a *different* answer for —
    the provider's context-window and per-request image-size refusals, which offer
    `⧉ Continue in a new window` instead (`context-rollover.md`, and the `full`
    state in §2). Re-issuing a refusal repeats the same rejection.
- **Stop wins, before the decision.** A Stop is re-thrown unchanged by
  `Agent.requestRound` before `shouldReissueTransparently` is even consulted, so an
  interruption keeps its own path (the notice, the checkpoint, the `interrupted`
  event) and never becomes a silent re-issue.
- **What the MODEL gets: nothing.** Nothing is pushed into `messages` except what
  the model itself had already streamed. If the failed request had streamed nothing,
  the history is re-sent exactly as it stands (the rebuilt body is identical, so the
  provider's cached prefix is reused too). If it had streamed a partial answer, that
  partial is pushed back as the model's **own assistant message** by
  `pushCheckpoint` — `content || reasoning` (reasoning mirrored into `content` when
  there was no text yet), `reasoning_content` kept whenever there was reasoning —
  including that mirrored case, because **thinking mode refuses a content-only
  assistant message** (`The reasoning_content in the thinking mode must be passed back
  to the API.`, a 400) — and never `tool_calls` (an unresolved `tool_calls` block is
  what the API rejects) —
  and the request is re-issued with **no** user message. There is no failure
  narrative on any resume path: `buildFailureContinue` and `CONTINUE_MESSAGE` are
  deleted (§2). Killing a half-written answer instead would both lose work and lie
  about what the first request saw.
- **What the USER gets.** The client's status line is unchanged and still reports
  every attempt; the ladder logs one `perf()` line per re-issue
  (`reissue 1/3 status=none checkpoint=0chars reason=…`, so the output channel says
  which attempt, whether a checkpoint was kept and how big it was, and the clipped
  reason); and the card gains **one** display-only marker, updated in place (§2).
- **When the ladder is exhausted** the last failure is thrown unchanged and surfaces
  exactly as it always did: an `error` event → the ⚠️ item, `node.status = 'error'`,
  and the ↻ Retry button. The turn's history is narrowed first — see
  `interrupt-rollback.md` for the rollback rule.

## 2. The ▶ Continue / ↻ Retry button, and its ⧉ Continue in a new window variant (transparent continue)

A turn can end without an answer in two ways: the user pressed Stop
(`node.status = 'interrupted'`, partial output kept as the checkpoint) or the
call failed (`node.status = 'error'`, the turn rolled back). Either way the user
used to have to type "continue" themselves. Now the card offers a button — and in
the ordinary cases it resumes **that node in place**: no new card, no visible node
split. One meaning per button, and at most two of them. Two further states are
about the *context*, not about the failure: a provider refusal that no retry can fix
(the request is too big) offers a rollover instead — whose whole point is a *new*
card — and a chain that is merely **near** full offers the same entry as a
suggestion. Only the *refusal* takes the repair's place; a failure at `near` shows
both (see the show rules below). What a rollover does is `context-rollover.md`.
A mid-answer stall (`request-stall`, §1b) is the case that asked for this: the turn
ends in `error`, and the card is the way back in.

- **Webview → host**: `{ type: 'continueTurn', id: <nodeId> }`
  (`main.js` `syncContinueButton`). The host routes it straight into
  `SessionRuntime.continueFrom` (`ChatViewProvider.handlePanelMessage`), which is
  the *only* entry point — it keeps the reboot hold (`host.isHeld()`), the
  per-node refusal (`runs.has(nodeId)`) in one place. The question that entry used
  to answer — "which message does the model get" — now has a one-word answer, and the
  engine makes it: **none**, unless a Stop stranded a tool call (§2, below). The run
  itself goes through `beginInjectedTurn`, so the two gates every turn start shares —
  the hold and a **read-only** window (`host.isReadOnly()`, another window owning
  this workspace's sessions) — apply here too. Unlike a typed prompt, this path never
  calls `sendUserMessage`: it starts the turn with `Agent.resumeTurn()`.
- **`Agent.resumeTurn(): string | undefined` — the one way back in.** Every resume
  path uses it. It puts **nothing** into the conversation on the model's behalf: no
  "continue from where you stopped", no failure note, no harness continue marker.
  The history the next request carries is exactly the history the turn died with,
  so a resume continues the model's own last message instead of being told to start
  over. The **one** exception is a tool call that was in flight when a Stop landed:
  a `tool_calls` block with no `tool` response is the only thing a history cannot
  express, so it is stated once as a pure fact
  (`buildStrandedToolFact`): `[Harness] Your previous <describeToolCall(…)> was cut
  off and did not finish; do not assume it completed.` (several calls joined with
  " and "). It states state, asks for nothing, and never describes the failure or
  the user. English literal, deliberately **not localized** — model-facing text,
  like the `INTERRUPT_NOTICE` literals, and the session's reply language must not
  change the fact the model reads. `resumeTurn` **returns** that line (the caller
  shows the user exactly what the model received) or `undefined` when nothing was
  pushed, which includes the refusal to resume: it is a no-op while a turn is
  already running.
- **The four resume combinations.** A resume adds at most one of two things to the
  history — the partial **content the model itself produced** (the checkpoint
  `pushCheckpoint` writes: never `tool_calls`), and/or **the fact line** of a
  stranded tool call — so what a resume actually re-sends is one of four shapes:
  1. **nothing at all** — a failure that had streamed nothing (the request is
     re-issued byte-identical, provider prefix cache included) or a Stop that
     stranded no named call. `resumeTurn` returns `undefined` and the card shows
     **no harness note**.
  2. **the checkpoint alone** — a failure that had already streamed part of an
     answer; the half-written answer stays as the model's own assistant message and
     the request is re-issued with no user message. Again no harness note.
  3. **the fact line alone** — a Stop during a tool call that had produced no
     answer text yet; the card shows that one line as a `HARNESS` block.
  4. **both** — a Stop during tool execution whose streamed message already carried
     text/reasoning: the checkpoint (kept by `preservePartialTurn`) plus the fact
     line.
- **Deleted with this change** (`src/chat/runtime.ts`): `CONTINUE_MESSAGE`
  ("Continue from where you stopped.") and `buildFailureContinue` (the
  `[Harness continue] …` note that quoted the failure and told the model to redo the
  last request). Both were written when the model had no other way to learn why it
  was being asked again; the point now is the opposite — a request that failed and
  was re-issued was *not* refused, so there is nothing to explain and explaining it
  is what made a resume read as a restart. `lastFailureText` **no longer builds any
  message for the model** either; it is still read off the node's own persisted
  `⚠️ …` item, and it is still the input to the window-full judgement (`full` in the
  context tri-state below, via `windowFullReason`) and to the `full` / `images` kind
  the rollover's own message states (`rolloverReason`), so both keep surviving a
  reload — it just never becomes text of the model's own. Note what has *not*
  changed: the `[Interruption notice]`
  path (`buildInterruptNotice`, the `INTERRUPT_NOTICE_GENERIC` /
  `INTERRUPT_NOTICE_TAIL` literals) is untouched, and still fires for a **typed new
  prompt** after a Stop — see the last bullet.
- **Who decides the context state**: the host, once, and it ships a tri-state —
  `context: 'ok' | 'near' | 'full'` plus `contextPct` (the rounded percentage, for
  the `near` variant's title) on the `tree` node payload and in every `nodeUpdate`
  patch. `full` is computed from the node's own persisted failure text
  (`node.status === 'error' && windowFullReason(lastFailureText(node)) !==
  undefined` — the token refusal *and* the provider's per-request image-size refusal,
  `windowFullReason()` in `src/agent/models.ts`), `near` from the newest prompt usage on
  that node's chain against the
  chain card's window, so a reload and a live turn agree. The webview therefore
  never parses an error string, and no second copy of the provider's wording exists
  in `main.js`. `nodeStatePatch` still carries the older `contextFull: boolean`
  beside them, but nothing in the webview reads it.
  The host entry point is `ChatViewProvider.handlePanelMessage` → `rolloverTurn` →
  `canRollover` → `rolloverWithSetup` → `SessionRuntime.rolloverContext(nodeId,
  setup)`.
- **In place, not a new node**: `continueFrom` uses `beginInjectedTurn(node)` —
  the same mechanism the background / sub-agent completion notices use. The run is
  bound to the existing node (`fresh: false`), its reply is appended to that
  node's history, and the view focus does not move. `node.status` is set to
  `running` for the duration (patched with a `nodeUpdate`) so the chip and the
  button follow it.
- **What the user reads about the silent retry**: one marker, and one only. The
  engine's `{ type: 'retry', attempt, max }` event (§1c) becomes a node-scoped
  `notice` whose text is `vscode.l10n.t('⟳ Silent retry {0}/{1}', attempt, max)`.
  It is strictly **display-only**: the host keeps it as the run's `marker`
  (`kind:'notice'`, `noticeKind:'info'`) in the run's `items`, i.e. in
  `node.displayItems`, and it is **never** in `messages` — the model's conversation
  must not contain a word the model was never told. It is *updated in place*, not
  pushed per attempt (one marker per run however many re-issues it takes): the live
  message carries `noticeId: 'retry-' + nodeId`, and the webview's `upsertNotice`
  rewrites the element with that `dataset.noticeId` rather than appending a second
  block. On replay the item renders through the ordinary `kind:'notice'` path, so a
  reload shows the same one marker. That marker is the whole of this design's new
  user-visible surface; the status line and the ⚠️ item are unchanged.
- **Show rules** (`syncContinueButton`, `media/main.js`): a terminal *tip* of a
  conversational branch — no turn child yet (a node that already has a
  conversational continuation is not offered again), not
  `kind:'agent'`/`'bg'` (sidecars have no conversation of their own in this path),
  and not currently running. The failure variants additionally need a terminal
  status: `▶ Continue` for an interruption, `↻ Retry` for any other failure, and
  `⧉ Continue in a new window` for `context === 'full'` (that variant also adds
  `node-rollover` and `data-action="rollover"`, and its click posts
  `{ type: 'rolloverTurn', id }` instead of `{ type: 'continueTurn', id }`). The
  **`near` entry is the one rule that hangs off the context state instead of a
  failure**: `context === 'near'` shows the same `⧉` (plus the softening `node-near`
  class and the percentage in the title) on a `done` tip too — the long
  conversation that just finished above 90 % is exactly its case. The two are
  **replaced only by a refusal, never by a size**: `full` means the provider refused
  *this* request, so `↻ Retry` would re-send the same refused bytes and the `⧉` takes
  the slot alone; a failure at `near` (a stall, a network error, a 4xx) keeps `↻
  Retry` **and** shows the `⧉` beside it, on its own `.node-window` element — nothing
  was rejected, the retry is a real repair, and the `⧉` entry has no other way in, so
  neither may hide the other. It is synced from both
  entry points of a status change (`renderTree` and `applyNodeUpdate`) — a turn
  that ends after the tree was drawn arrives as `nodeUpdate`, so both must call it
  (and `applyNodeUpdate` must merge `context` / `contextPct` into `treeNodes[id]`
  *before* it re-syncs, or that entry point would show the wrong variant). Each
  entry is one reused element (`.node-continue`, `.node-window`) whose text, class
  list and `dataset.action` are re-synced, and every click handler reads the action
  at click time.
- **Honest transcript**: the only resume text that exists is the fact line above,
  and it is a `kind:'harness'` display item, pushed into the node's own items and
  rendered inline by `addHarnessNote` as a badged (`HARNESS`) block — never a
  fabricated user bubble, and never the pinned prompt (that still shows what the
  user actually asked for). It shows the exact text the model received, which is why
  it is posted **only** when `resumeTurn` returned one: a resume that told the model
  nothing must not leave a note claiming otherwise. The live path is a node-scoped
  `harnessNote` message routed with `routeTo`, so continuing a node that is *not*
  the view focus still writes into the right card.
- **Stop then a TYPED new prompt is deliberately unchanged.** That is a real user
  interruption, so the old rules hold exactly as they did: the `user`-role
  `buildInterruptNotice` text (naming the stranded tool) is pushed at the top of
  `Agent.sendUserMessage`, the `INTERRUPT_NOTICE_*` literals are untouched, and the
  typed prompt **opens a new node** — the model is told the user stopped it and left
  to judge whether the new message steers the old task or starts a new one. Only the
  harness-authored resume became silent.
- **Don't break**: `continueFrom` must keep going through `beginInjectedTurn`
  (read-only gate, hold gate, per-node `runs` gate, `fresh: false` append) rather than `beginTurn`
  — for a continue/retry, a new node is exactly the visible split this feature
  exists to avoid. (The rollover is the one variant that *does* want a new card, so it
  goes through `rolloverContext` instead — which still falls back to `continueFrom`
  when the node turns out not to be near/full, see `context-rollover.md`.) It must
  also keep starting the turn with `resumeTurn` and not `sendUserMessage`: a
  `kind:'user'` item for a resume would both be a message the model never received
  and the wrong thing for the webview to pin (it pins only the *first* user item of a
  node, so a resume bubble would either be dropped on replay or overwrite the user's
  own prompt).

### 2b. The three "prompt cache may be missed" warnings are gone

A card / effort / reply-language pick or change used to rewrite `messages[0]` and
warn that the next request might miss the prompt cache ("Model changed to {0}…",
"Thinking effort changed to …", "Reply language changed to …"). All three notices
are deleted from `src/`, and with them the last reason for such a warning: a pick
now reaches the **next new node** only (the epoch freeze),
`SessionRuntime.applyReplyLanguage` merely records the name for later nodes, and a
chain that has an epoch sends with the epoch's bytes whatever the dropdowns say.

Nothing is silent about this either. The host computes the two setups —
`SessionRuntime.setupState()`: `node` (the checked-out chain's envelope) and `live`
(what a new node would freeze today) — and ships them in the `config` message as
`setup: { node, live, drift: false | 'user' | 'harness', reasons: string[] }`:

- `drift: 'user'` — the **user** just moved a dropdown (`model` / `effort` /
  `language`). `SessionRuntime.hasUserDrift()` is the gate: a plain send asks first
  (`ChatViewProvider.dispatchUserMessage` → `askSetups('user')`), the modal's default
  action is `Continue with current setup` (so Enter or Escape never changes a
  prefix), and `SessionRuntime.discardPendingSetup()` throws the pick away and puts
  the dropdown back on the frozen values before the send goes out. The composer shows
  both identities (`Sending with: …` / `New setup: …`) and marks Send while this is
  true.
- `drift: 'harness'` — the shipped prompt template, the workspace AGENTS.md, the tool
  schema set, the endpoint facts or the vision/setup shape changed under a frozen
  chain (`reasons` names which: `prompt` / `agents.md` / `tools` / `provider` /
  `images`). A plain send keeps the frozen setup **silently** — that is the point of
  freezing it — and the composer offers the extra `Continue with the latest setup`
  entry (`forkTurn`, §4.4 of the plan) for the user who wants to move on.

The comparison is made from **content hashes** (`Epoch.templateHash` /
`agentsMdHash` / `toolsetHash`, plus the live endpoint facts), never from a version
number, so an extension update that changes none of them is not a drift and changes
no prefix.

**Status:** the new keys (the modal's labels/header/details, `Sending with: {0}` /
`New setup: {0}`, the fork entry and the read-only notice) are in both shipped
catalogs — `npm run check:l10n` fails packaging when a source literal is missing
from one — and the five entries this change retired (the three "… the prompt cache
may be missed." notices and the two image-hiding notices) are gone from them.

## Evidence

- `npm run compile`, `npm run check:webview` (the checker asserts the button's
  show rules, the labels, that clicking posts `continueTurn` (and `rolloverTurn`
  for the context-full variant), that the state arriving by `nodeUpdate` switches
  the variant, and that a harness-authored message is badged).
- `npm run check:l10n` — `⟳ Silent retry {0}/{1}` is in both shipped catalogs (the
  guard fails packaging when a source literal is missing from one).
- `npm run check:rollover` — the pure-function guard for the window-starting flag,
  the prefix cut and the provider error-text parse (what it proves is listed in
  `context-rollover.md` §10).
- A throwaway node script against the compiled client (9 checks): network ×2 then
  success, pre-content stream break retried, post-content break *not* retried,
  503 exhausting 10 attempts with the "(after 10 attempts)" text, 401 not
  retried, abort during the failure not retried, `complete()` sharing the policy.
- **Not covered by a guard yet**: `shouldReissueTransparently` is exported and pure
  so that it *can* be tested directly, and the four resume shapes of §2 are read off
  `Agent.resumeTurn` / `Agent.requestRound` — neither has an automated check. Say so
  rather than implying one exists.
