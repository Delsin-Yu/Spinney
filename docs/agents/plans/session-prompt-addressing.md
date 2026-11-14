# Plan: session addressing, the three-verb surface, and what it deletes

**Status: landed (P0–P4), shipped in 0.7.0.** §8 is the landing record: what was
built, what was measured, and what is still open. This page is a **replacement** for the
node-addressed delivery in `plans/session-message-channel.md` §2, not an extension of it: the
session prompt stops riding the completion-signal queue entirely, and the tools that existed to
make that reuse work go away with it.

**Version: no bump.** The slice shipped under `0.7.0`: everything landed under `[Unreleased]` in
`CHANGELOG.md` and moved into `## [0.7.0]` when the release was cut. `version` in `package.json` /
`package-lock.json` and the tag stayed the developer's call, and nothing in this plan wrote them.

## 1. Why: measured, on 0.7.0

Three runs, same day, this window: `mwfaeuyosnekf0` (caller opened it), `mwfagvckmhonb5` (the queue
test), `mwfavm23ud5lcv` (the union-kill test). What they showed:

| Check | Result |
| --- | --- |
| Idle target | `delivered`, `how: injected_turn`, 77 ms and 78 ms |
| Busy target (a 90 s `wait_for_command`) | `queued` at `waited_ms: 30008`, then delivered at the tool boundary |
| Per-node inbound cap (5 sends into one busy node) | `queued=4`; the first message was dropped |
| Union kill with a message in flight | `delivered`, `how: writeback`; the block landed on the card |

Two of those four exposed a defect, and both are the same kind of defect:

1. **The cap's drop is silent after the window.** `deliverSessionMessage` drops the oldest with
   `oldest.session?.cancel(...)` (`src/chat/runtime.ts:6174-6181`), but the caller already gave up
   on that promise when `send_session_prompt` returned `queued`
   (`src/chat/ChatViewProvider.ts:4858-4862`). The tool description says `queued` is "delivered
   later, never dropped". After 30 s that is false, and the sender is never told.
2. **A union-killed line can never be woken by a message again.** `stopNode` records the node in
   `stoppedLines` (`src/chat/runtime.ts:4355`); `pushSignal` short-circuits on `isStoppedLine`
   into `queueWriteback` before any turn logic (`src/chat/runtime.ts:6276-6278`). Exactly one
   path clears the flag for a continuing turn (`beginInjectedTurn`, `:3127`), and the
   short-circuit means it is never reached. Three sends after a Stop returned `delivered` with
   `how: writeback` in 1 ms each, rendered on the card as `会话消息` blocks, and the node stayed
   `Interrupted` until a human pressed 继续.

Both are consequences of one decision: **an external message and a completion notice share one
queue and one dispatch function.** The notice rules ("nothing continues on a stopped line") were
written for work a node itself started; an external prompt inheriting them is a category error
that no amount of patching makes clean. Two more costs showed up in the same runs:

- **Node ids rot.** A node id is per-turn, and my own node id changed under the target twice in
  the same session, so the address I handed it in its first prompt was already stale. Two rounds
  of the test were spent on corrections.
- **The sender cannot tell a real delivery from a writeback.** `delivered` covers "a turn is
  running" and "it landed in a history nothing will read".

## 2. The contract

**The address is the session.** A prompt is delivered the way a human's message is delivered: it
starts a turn. There is no queue, no safe point, no delivery mode.

**On the two kinds of id.** A session id answers "which conversation" and lives until the session
is deleted; a node id answers "which point in it" and lives until the next turn. The defect this
plan removes is not that node ids exist — it is that one was used as a **reply address that has to
survive a round trip through another agent**, and that is a job the second kind cannot do. The
rule that keeps them in their place: an id is fine when the caller reads it and uses it once in
the same turn (`list_nodes`, `spawn_agents` → `send_agent_message`, the control plane's
`/stop {nodeId}`); it is wrong when it has to be carried across turns or handed to a third party.
The prompt removes the second use. Where precise point addressing is genuinely needed, the id stays
and the tool says so in its name.

### 2.1 `send_session_prompt(session_id, prompt, max_rounds)`

- **Target.** The session's **own active node** (`session.activeNodeId`, as `list_nodes` shows it),
  never a window's focus and never a node id the caller has to remember or track.
- **Effect.** One new turn, exactly as `onUserMessage` produces it: a new node branching off the
  active node, the session's active node moves to it, the same window-level gates apply
  (`isHeld()`, read-only, a full context window).
- **The prompt is a `user` message with one machine line first:**
  `[session prompt from <sessionId>/<nodeId>, rounds left <n>]`. Untranslated, as today,
  because the model has to tell an agent's instruction from the developer's, whatever language
  the reply is in. It travels in the bytes the provider sends only: the card shows the prompt
  itself and `list_nodes` shows `from=`, so a human never reads the line.
- **Provenance and budget ride on the node the prompt creates**: `lastFrom`, `roundsAllowance`,
  set through `onUserMessage`'s options so `beginTurn` stores them with the node. `list_nodes`
  keeps rendering `from=` and `rounds=`.
- **Refused while that node runs, or still owns unfinished work**, with one sentence naming the
  node, how long it has been busy, and the two ways out:

  ```
  Error: node mwf... in session mwf... is still busy (running a turn, 1m 12s); nothing was sent.
  Use wait_for_session_idle, or interrupt_session to stop it.
  ```

- **Receipt** (JSON):
  ```json
  { "state": "delivered", "target": { "session_id": "…", "node_id": "…" },
    "how": "turn", "rounds_left": 15 }
  ```
  `how` is a single value now. There is nothing else for it to say.

### 2.2 `wait_for_session_idle(session_id, seconds?)`

The wait that replaces the 30 s race, shaped exactly like `wait_for_command`
(`src/tools/backgroundTools.ts`): **a slice, not a timeout.**

- `seconds` default 30, clamped 1–300, read per call. It returns the moment the session's prompt
  target is free, and a normal result (never an `Error:`) when the window runs out.
- It waits on **the same predicate the composer uses**: no live run on the node a prompt would
  land on, **and** no unfinished work it still owns. "Idle" therefore means "the prompt will be
  accepted" and nothing else; a background terminal does block a prompt (the notice would be
  injected into the node the new turn branches from), so it is waited on, not merely reported.
- **The active node belongs to the prompt pair, and stops there.** A prompt has to land where a
  human's send would, so it reads the session's active node; the wait observes the same spot so the
  two agree. `interrupt_session` consults neither, because "which line is live here" and "where
  would a message go" are different questions.
- Result, one line: `idle` / `still busy after 30s: node mwf… running a turn for 1m 42s`. It says
  what is holding the line, because the sender's next decision is wait, interrupt, or report back.
- Respects Stop: the caller's own abort ends the wait at once.

### 2.3 `interrupt_session(session_id)`

The agent-facing twin of the composer's Stop, and deliberately **not** scoped by the active node:
it ends the live work in the session that an agent's prompt started, and nothing else. Same
`stopNode` (`src/chat/runtime.ts:4352`), so the kill itself is the union kill the button performs:
the node's turn, its background terminals, its running sub-agents, pending notices converted to
writebacks.

- **The scope is a filter over nodes, not a position in the tree.** A node qualifies when its
  `lastFrom` names the calling session and it is still live (a running turn, or work it still
  owns). Nobody has to compute "where a prompt would land", which is what made the earlier draft
  answer the wrong question.
- **A human's line is not in the set, ever, and that is a property of the data.** A prompt the
  human typed leaves `lastFrom` empty. There is no check to get wrong and no ordering to reason
  about: the kill cannot reach a human's turn even by accident.
- **A second agent's line is not in it either**, because ownership is by the **calling** session.
  Ending another agent's request is a different act with a different name; nobody has asked for it.
- **An empty set is a normal result, and it says what it did not touch**, so the sender knows
  whether to report back or retry:
  ```
  Nothing of yours to interrupt in session mwf...: 1 line is live, started by a human prompt.
  ```
- Report what it killed, one entry per line plus the totals, because an unreported kill is the same
  class of defect as §1's silent drop:
  ```
  Interrupted 2 lines in session mwf...: node mwfa (turn, 1m 12s, 1 background terminal),
  node mwfb (turn, 4s). 3 notice(s) kept for their next prompt. Nothing continues on its own.
  ```
- It is a kill, never a pause. The next prompt on that line is the resume (`beginTurn` clears
  `stoppedLines`), and that already works today.
- **Worked example, the case that looks dangerous.** An agent prompts node A, which creates B;
  `B.lastFrom` names the agent. The human later prompts A as well, creating C, whose `lastFrom`
  names nobody. `interrupt_session` targets **B and only B**: C is not in the set, and B stays
  reachable whether or not the checkout has followed C. The earlier draft, scoped by the active
  node with an ownership check on top, had to answer "neither" here and apologize for it.
- **Authority.** It is local (no external trace, no credential, nothing public), and the human's
  own Stop is unchanged and always available.

## 3. What this deletes

The session prompt stops using the signal queue, so the machinery that existed to make it use the
queue goes with it. This is a deletion, and it should land as one slice, not as an addition.

| Piece | Where | Fate |
| --- | --- | --- |
| `SignalKind`'s `'session'` member and its delivered block | `src/chat/runtime.ts:739` | deleted |
| `SessionDeliveryHow` (`tool_boundary` / `injected_turn` / `writeback`) | `:742` | deleted |
| `deliverSessionMessage` and the per-message `delivered` promise | `:6158` | deleted |
| `pushSignal`'s `isStoppedLine` short-circuit | `:6273-6279` | kept for notices, no session case |
| `SESSION_MESSAGE_QUEUE_CAP` and the drop | `:308`, `:6174-6181` | deleted |
| `pendingSessionMessageCounts`, `queued=` in `list_nodes` | `:6205` | deleted |
| `deliverToNode` and its 30 s `Promise.race` | `src/chat/ChatViewProvider.ts:4809-4866` | replaced by the prompt path |
| `spinney.sessionSendSeconds` (setting, default, doc, manual page) | `package.json`, `DEFAULT_SESSION_SEND_SEC` `:303`, `config-keys.md`, `manual/**` | **deleted**: nothing races a timeout any more |
| `sendSessionMessage.ts` | `src/agent/tools/` | replaced by `sendSessionPrompt.ts` + two new tools |
| `INTERCEPTED_TOOLS` entries | `src/agent/tools/index.ts` | three tools in place of one |

Kept, because they are now honest: `lastFrom`, `roundsAllowance`, the `from=` / `rounds=` lines in
`list_nodes`, the `[session prompt from …]` machine line, and `spinney.sessionMaxRounds`.

## 4. Interfaces (frozen once built)

| Piece | Where |
| --- | --- |
| tool schemas: `send_session_prompt` / `wait_for_session_idle` / `interrupt_session`, all `requires: 'sessions'` | `src/agent/tools/sendSessionPrompt.ts`, `waitForSessionIdle.ts`, `interruptSession.ts` |
| `onUserMessage` gains `{ from, rounds }` so the new node stores provenance and allowance | `src/chat/runtime.ts:3278` |
| the prompt entry: resolve the session's active node, apply the composer's gates, start the turn, return the receipt | `ChatViewProvider.deliverPrompt` (replacing `deliverToNode`) |
| the wait: resolve on the node's `finishTurn`, or on the window, whichever first | `ChatViewProvider.waitForSessionIdle` |
| the kill: `stopNode` once per qualifying node (`lastFrom` names the caller, node still live), summed into one receipt | `ChatViewProvider.interruptSession` |
| `create_session`'s result line: the report address is **the session id only** | `ChatViewProvider.handleCreateSession` |
| `POST /session/message`: the same prompt semantics — `409` while busy, never queued, no budget, no `from`; `deliverToNode` is deleted rather than kept alive for it | `ChatViewProvider.controlSessionMessage` |

## 5. Slices

- **P0, the prompt.** `send_session_prompt`, the session-addressed entry, `from`/`rounds` on the
  created node, the receipt, the busy refusal. Tests first.
- **P1, the deletion.** Remove the session signal kind, the queue cap, the delivered promise,
  `queued=`, `spinney.sessionSendSeconds`. This slice is mostly `-` lines and it is where the two
  §1 defects disappear.
- **P2, `wait_for_session_idle`.** Shaped like `wait_for_command`, Stop-aware, one line of result.
- **P3, `interrupt_session`.** The provider-level `stopNode` entry and the counts.
- **P4, the surface.** `create_session`'s result line, `control-plane.md`, `config-keys.md`,
  `manual/**` for the three tools and the removed setting, catalogs, and the control plane itself:
  `POST /session/message` moves onto the prompt path (`409` while busy), and
  `tools/harness-test.mjs` carries the change — its `sessionMessage` suite becomes `sessionPrompt`
  / `sessionIdle` / `sessionInterrupt`, and the busy case asserts a `409` instead of a
  tool-boundary delivery.

## 6. Risks

- **Mid-turn steering is gone, deliberately.** A prompt either starts a turn or refuses. Two
  sessions talking now take turns, which is what a conversation is; the 22 ms / 2.4 s / 30 s
  spread measured today is the argument that the old behaviour was unpredictable anyway. If
  steering a running turn turns out to be genuinely needed, it becomes its own tool with one
  meaning, not a hidden mode of the prompt.
- **A full context window refuses a prompt.** The sender cannot roll the target over; it can only
  report that to its own user. That is the honest answer, and it should be in the refusal
  sentence.
- **The session's active node moves.** A prompt is a turn, and a turn moves the checkout, so a
  human looking at that session sees the view follow. This is what a human send does, and the
  alternative (keep the old basis) would grow siblings instead of a conversation.
- **Two agents can now stop each other's work.** Bounded by the report and by the round budget;
  the human keeps the same button.
- **The prompt must funnel through the same hold gate.** `POST /reload-window {idle:true}` is
  race-free only because `beginTurn` / `dispatchUserMessage` refuse under `isHeld()`; a prompt entry
  that skipped that gate would let a turn start after the deferred reload armed its hold, and the
  reload would fire mid-turn. The reload path itself needs no change: `tools/reload-window.mjs`
  posts exactly one endpoint, `POST /reload-window {idle:true, continue}`, and never touches the
  session routes. The caller that **does** change with this plan is `tools/harness-test.mjs`.
- **Removing `spinney.sessionSendSeconds` is a visible config change** for anyone who tuned it.

## 7. Guards and acceptance

The three runs in §1 are the acceptance scenario, replayed with the new surface:

1. **Five rounds, no sleeps.** Two sessions, five turns each way, answers arriving as turns. No
   transcript reading, no wrong node ids: the child is told one session id.
2. **Busy target.** Prompt refused with the node and its elapsed time; `wait_for_session_idle`
   returns the moment it ends; the retry lands.
3. **A stuck target.** `interrupt_session` kills the turn and its background job, reports the
   counts, and the next prompt lands with the writeback in its history.

Regressions, each with one assertion:

- **No silent drop exists any more**: there is no queue to overflow.
- **A stopped line takes a prompt**: `beginTurn` clears `stoppedLines`, and a test sends into a
  freshly interrupted node and expects a turn, not a writeback.
- **The kill ends agent-started work and nothing else**: two live lines in one session (one from a
  human prompt, one from the agent's), `interrupt_session` ends exactly the agent's and leaves the
  human's running; the result names the human's line as untouched, and the caller's own stuck line
  is still reachable after the checkout has followed the human's branch.

Then the standing gates: `npm run compile`, `check:l10n`, `check:docs`, `check:webview`,
`harness-test.mjs sessionPrompt` (the prompt path is the only one of the three reachable over the
control plane), and the closing `build-deploy.ps1` + reload for the tool rename, the removed
setting and the manual pages.

## 8. Landing record

### 8.1 What landed (0.7.0)

- `send_session_prompt` / `wait_for_session_idle` / `interrupt_session` replace
  `send_session_message` (`src/agent/tools/sendSessionPrompt.ts`, `waitForSessionIdle.ts`,
  `interruptSession.ts`; `INTERCEPTED_TOOLS` carries all three under `canSessions`).
- `SessionRuntime.promptBlocker(basis)` is the **one** gate: `onUserMessage` refuses on it, the
  wait polls it, and the busy sentence in the prompt's receipt is built from its fields. It is the
  same order the composer always had (missing, running, locked, held).
- `onUserMessage` takes `{from, rounds, quiet}` and returns an outcome
  (`{ok,nodeId}` / `{ok:false, code, nodeId, ranMs, locked}`), writes `lastFrom` and
  `roundsAllowance` onto the node the turn creates, and suppresses its localized notices for the
  agent path (`quiet`), which gets a sentence instead.
- `interruptLines(callerSessionId)` filters by `lastFrom` and liveness, then runs `stopNode` once
  per qualifying line; `TurnRun.startedAt` is what makes "busy for 1m 12s" quotable.
- **Deleted**: the `session` signal kind, `SessionDeliveryHow`, `deliverSessionMessage`,
  `pendingSessionMessageCounts`, `takePendingSessionMessages`, `noteUndeliveredSessionMessage`,
  the per-node queue cap (4) and its silent drop, `queued=` in `list_nodes`, `deliverToNode` and
  its 30 s `Promise.race`, `queuedMessagesIn`, and the `spinney.sessionSendSeconds` setting (in
  `package.json`, both `package.nls.*` families and the manual tables).
- `POST /session/message` runs the prompt path: `nodeId` is validated but does not address
  anything, and a session that cannot take a turn is a `409` naming the ways out.
- `create_session`'s result no longer hands out a node id for the report address, and the first
  turn it starts carries the calling session as `lastFrom`, so `interrupt_session` can end it.

### 8.2 Guards

| Check | Result |
| --- | --- |
| `npm run compile` | clean |
| `check:l10n` | ok (403 strings; 62 nls entries per language) |
| `check:docs` / `check:webview` / `check:signals` / `check:models` / `check:titles` | ok |
| `node tools/harness-test.mjs sessionPrompt` | **PASS** (8 checks, 39.9 s): busy → 409 naming the node and both ways out; idle → 200 `state: delivered`, `how: turn`, a **new** node (`got=mwfcfotlt3hnna old=mwfceu0u7svoge`); unknown session and unknown node → 409 |
| `build-deploy.ps1` | packaged and installed `0.7.0`, no version bump |

### 8.3 Measured

Live walk on 0.7.0, session `mwfc7u6kuejxn8` ("验收会话"), the same day the slice landed.

| Step | Result |
| --- | --- |
| `send_session_prompt` into a running session | **refused**, not queued: `Error: node mwfc7v7bddn3fy in session mwfc7u6kuejxn8 is running a turn (11s so far); nothing was sent. Use wait_for_session_idle, or interrupt_session to end work an agent started.` |
| `wait_for_session_idle` (10 s) | `still busy after 10s: node mwfc7v7bddn3fy is running a turn for 46s. Wait again, use interrupt_session (agent-started work only), or report back to your user.` |
| `wait_for_session_idle` (60 s) | `idle after 30s: session mwfc7u6kuejxn8 accepts a prompt now (node mwfc7v7bddn3fy).` — returned 30 s early, on the moment the turn ended |
| `send_session_prompt` into the idle session | `{"state":"delivered","target":{"session_id":"mwfc7u6kuejxn8","node_id":"mwfc9lypkt71j4"},"how":"turn","rounds_left":7}` — a **new** node, not the old one |
| `interrupt_session` on that line | `Interrupted 1 line(s) in session mwfc7u6kuejxn8: node mwfc9lypkt71j4 (turn, 13s, 1 background terminal(s)). Pending notices are kept for that node's next prompt; nothing continues on its own.` `list_nodes` then read `running: 0` and the job `[bg, delivered]` |
| the resume | the next prompt started a turn on a child of the interrupted node, and its transcript carries the interrupt (`[command wait was interrupted]`, plus the killed-job notice) |

**One defect found by the walk, and fixed.** `interrupt_session` on a freshly created session
answered `Nothing of yours to interrupt … (started by a human prompt)`: `create_session` starts
its first turn on the agent's behalf, but that path did not write `lastFrom`, so the agent could
never clean up a session it had created. `from` is now threaded through
`startFreshSession → dispatchUserMessage → onUserMessage`, and the first node of an agent-created
session carries the calling session as its owner.

**One wording defect, fixed.** A killed background job's notice read `was killed by the user
after 12s` even when the kill came from `interrupt_session`, which is a lie to the model reading
it. The verdict is now `was stopped after …`, which is true of the composer's Stop, the card's
kill, `kill_command` and the agent's interrupt alike.

**One design consequence the walk exposed, and made explicit.** A reply is a prompt back, so it is
refused while the asker is still running its own turn: the target tried to report and got
`node … is running a turn (49s so far)`, correctly did not loop, and reported the refusal instead.
That is the coherent result of "a prompt is a user message" — a human's answer also has to wait
until the session is free — but nothing said so, and the old tool's text promised the opposite
("the other session answers by calling this tool itself, possibly right after a tool call"). The
rule is now in the tool description and in every manual page: **after `send_session_prompt`, end
your turn; the answer arrives as a new turn on your node.**

**A fourth defect, found by reading the delivered reply.** The prompt arrived as a clean user
message with no provenance line at all: `[session prompt from …]` was in §2.1 and in the tool
description, and it was never written. That is not cosmetic — it is the only thing that tells the
model a message from a peer is not a message from the developer. The line is now prepended inside
`onUserMessage` (one place, so both the prompt path and `create_session`'s first turn get it), it
carries the sender and the remaining rounds, and it lives only in the bytes the provider sends: the
card shows the prompt itself and `list_nodes` shows `from=`.

**A fifth defect, and the worst of them.** Reading the node files after a reload showed `lastFrom`
gone: `normalizeTreeSession` rebuilds every node from a **field whitelist**, and neither
`lastFrom` nor `roundsAllowance` was on it. Provenance is not display here — `interrupt_session`
decides what an agent may stop by `lastFrom` — so a reload silently handed every old line back as
"started by a human prompt" and took away the agent's ability to end its own work. Both fields are
now read back, validated field by field (a malformed record is dropped, never repaired), and the
round budget stops resetting itself on every reload.

**Verified live, in this order.** The machine line: the target's own transcript shows its user
message beginning `[session prompt from mwfae5q69ae1hi/mwfcjwj74irvfg, rounds left 2]`. The
persistence: a node written to disk **before** the fix's reload came back after it as
`- mwfcjz401z5gmg  [turn, from=mwfae5q69ae1hi/mwfcjwj74irvfg, rounds=2]`. The nodes written before
the fix had already lost the field, and stay empty — history, not a live bug.

### 8.4 Open

- The live walk is the acceptance for `wait_for_session_idle` and `interrupt_session`: neither is a
  control-plane route, so `harness-test.mjs` cannot reach them. That is a gap in the driver, not
  in the tools, and it is the price of the two being agent-side verbs. The walk's own log was read
  out of the session's transcript for the last step, because the test prompt forgot to hand the
  target a session id to report back with — a defect in the walk, not in the tools.
- The per-node cap disappearing means an abuse case (one sender stacking messages) no longer
  exists either: there is no queue. Nothing replaces it, by design.

### 8.5 Decided (this planning round)

The wait keeps the session-level name (`wait_for_session_idle`); `POST /session/message` moves onto
the prompt path and `deliverToNode` is deleted rather than kept alive for the control plane;
`interrupt_session` is session-addressed and scoped **by provenance** (`lastFrom`), not by the
active node, so it may end several lines at once. No node argument.

**One consequence to keep an eye on.** A prompt moves the session's active node to the node it
creates, so a human and an agent working in the same session share one line and take turns on it.
Two branches only exist when someone moved the checkout on purpose (`/navigate`, clicking another
card), and in that state each branch can stream. The kill is unaffected either way, since it
filters by provenance rather than by position. If the shared prompt line ever turns out to be the
wrong default, the fix is a session-level "where should my prompt land" argument, not a node
argument folded into the prompt.

### 8.6 Two follow-ups, found by a live chat

Both came out of one real use: two sessions chatting across five rounds, this window and a
fresh one, on the landed surface. The tools behaved; what the walk found was one hole in the
budget and one card that said nothing.

**The hole: `create_session` handed out a fresh ceiling.** It threaded `from` and stopped there,
so the first node of an agent-created session never got a `roundsAllowance` field, and
`handleSendSessionPrompt`'s `inherited ?? cap` then read that absence as "take the ceiling".
An agent mid-exchange with 4 rounds left could open a session with 16 — the brake could be
refilled by creating sessions instead of continuing a line, which is the shape the allowance
exists to stop. The child noticed it first: its machine line read
`[session prompt from <id>/<node>]` with no `rounds left`, because `opts.rounds` was undefined.

Fixed by giving both agent-written prompts **one** arithmetic. `spendExchangeRound(node,
declared?)` resolves the effective number, charges the caller one round and answers what the
receiver inherits; `refundExchangeRound` gives it back when nothing was sent (a busy target, a
bad id, a torn-down window). `send_session_prompt` passes its declared `max_rounds`;
`create_session` declares nothing — it has no such argument — so the round comes off the
ceiling, exactly as a prompt on a human-started line does. Consequences, stated because they
are real: a line with **no** allowance left can no longer create a session either (it is the
same brake, and the refusal already says what to do), and every `create_session` now writes a
`roundsAllowance` onto the caller's node and a `rounds left n` machine line onto the child's
first turn. The multiplication this closes is the only refill there was: `min()` still never
raises, and a human message is still the one reset.

**The card said nothing.** The four session tools were mapped to the `note` kind, so a folded
row read `Prompted a session` with no target (nothing in `toolBrief` knew a session id was the
identifying argument), and opening it showed the raw receipt — `{"state":"delivered",…}` — to a
human. They now have a kind of their own (`session`), which states the target and the rounds
left in the head, shows the text the call **sent** in the body, and reads the receipt into
those facts instead of printing it. The rounds also became a chip on the folded row
(`syncSessionRounds`), because a budget the reader has to open a card to see is a budget nobody
watches. `check:webview` pins both shapes with real samples — a receipt and a sentence — so a
rewording of either result is a red guard rather than an empty card.

## Related

- `plans/session-message-channel.md` — the design this replaces for the agent-facing tools; the
  budget arithmetic and the provenance fields survive it, the delivery machinery does not.
- `control-plane.md` — the session tools' contract, and `POST /session/message`.
- `invariants/background-terminals.md` — "a slice, not a timeout", which `wait_for_session_idle`
  copies from `wait_for_command`.
- `invariants/sub-agents.md` — the notice path that keeps `pushSignal`, and why a stopped line's
  notices must not open a turn.
- `invariants/config-keys.md` — `spinney.sessionMaxRounds` stays, `spinney.sessionSendSeconds`
  goes.
- `versioning` — no bump; `[Unreleased]` until the release cut it into `[0.7.0]`.
