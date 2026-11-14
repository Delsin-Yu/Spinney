# Plan: the session message channel (receipt, tool-boundary delivery, round budget)

**Status: superseded.** The channel landed and then was replaced by
`plans/session-prompt-addressing.md`: measuring it on 0.7.0 showed that an external message
inheriting the completion-notice rules produced two defects (a silent queue-cap drop after
`queued`, and a union-killed line that no message could ever wake again), and a reply address that
is a node id rots every turn. This page stays as the design record of what was tried and why; §8
is its landing record, and nothing here describes the current tool surface.

## 1. Why: what the tools do today, measured

`create_session` / `send_session_message` / `list_sessions` / `list_nodes` replaced the hop in
`c2a90c6`. An ordinary two-round chat between two sessions measured the channel's limits in
`mwf88abz2v4oee` (caller) and `mwf89byjnr8n2u` (child), 2026-11-14:

- **Refusal while the target runs, and no wait.** The child's answer was refused with
  `Error: node … is running a turn right now`; it then slept 20 s and retried. Those were the
  only two options a caller had, and the window they had to guess was the whole turn.
- **No inbox.** The child's answer never reaches the caller as a message. In the measurement the
  caller read it out of the JSONL transcript, by path, because nothing else carried it.
- **The reverse delivery is a whole turn.** A reply is a user message that starts a turn on the
  caller's node, so an exchange competes with the human typing on the same line, and there is no
  receipt for the message that was sent.
- **No provenance.** A delivered message carries only `prompt`. The receiver cannot tell which
  session and node sent it: in the run above the child cited a node one level off, and the caller
  could only verify it by reading the sender's transcript (`mwf8c11vjzgkbu`).

The fix is mostly assembly of what is already there: the completion-signal path
(`pushSignal` → `scheduleSignalDrain` → `takeSignalsFor` / an injected turn) is exactly the
delivery shape an inter-session message needs, the signal queue is already a queue, and
`isHeld()` already knows how to keep a reload waiting.

## 2. The contract

### 2.1 One call, one receipt, and delivery at the target's next safe point

`send_session_message(session_id, session_node_id, prompt, max_rounds)`

- It **blocks until the send is finished**: the message has been delivered into the named node,
  meaning its turn has started, or a running turn has taken it at its next tool boundary. It
  never waits for the answer, because an answer may come right after a tool call or in a later
  turn (developer, 2026-11-14).
- **Delivery is the completion-signal path**, not a new mechanism:

  | Target | Delivery |
  | --- | --- |
  | running a turn | `takeSignalsFor` hands the text to that turn at its **next assistant tool round**, injected as one `user` message (`Agent.setSignalHandler`); a long model round or a long tool call only delays it |
  | idle | `drainSignals` opens an **injected turn on the same node**, never a new node under it, never the view focus |
  | queued, no boundary yet | the message sits in that node's signal queue and is delivered by the next boundary or the next idle drain |

- The caller waits at most `spinney.sessionSendSeconds` (default **30**, the same shape as
  `execForegroundSeconds`: a slice, not a timeout). A round longer than the window returns
  `queued`, which is a complete answer, not a failure: the drain still delivers it.
- **A running node is no longer a refusal.** The old gate guarded a *turn start* ("a second agent
  on one conversation line", `deliverToNode`'s `runningNodes` / `lockedNodes` check). Appending a
  user message at a tool boundary starts nothing, so the gate no longer applies to a message. The
  human's own composer keeps its Stop-not-Send rule, and that asymmetry is deliberate: a session
  may steer a running turn, a human may not.
- A pending reload hold (`isHeld()`) stops injection for its duration, exactly as it does for
  notices (`takeSignalsFor` returns empty), and the message stays queued.
- Still refused, unchanged: unknown or deleted session, unknown node, a sidecar node (sub-agent
  window or `kind:'bg'` card), a read-only window, a disposed provider, and a missing or invalid
  `max_rounds`.

Receipt (JSON in the tool result):

```json
{ "state": "delivered" | "queued", "message_id": "…",
  "target": { "session_id": "…", "node_id": "…" },
  "how": "tool_boundary" | "injected_turn" | "writeback" | null,
  "waited_ms": 0, "rounds_left": 15 }
```

### 2.2 Provenance and budget ride with the message

- The delivered text is one block per message, prefixed with a **stable, untranslated** machine
  line: `[session message from <sessionId>/<nodeId>, rounds left <n>]`. It must not be localized:
  the model has to recognize the shape whatever language the reply is in. The card renders its
  own localized line from the same record.
- The node records each delivery (`node.delivered[] = { index, from, rounds, how }`) so the card,
  the transcript and `list_nodes` can show who asked. It never enters the epoch prompt, and it does
  not change the shape of a human turn.
- The round budget is charged **once per send, at send time**: `rounds_left = min(declared,
  inherited, cap) - 1`, returned in the receipt. The target merges it into its own allowance as
  `min(current ?? cap, incoming)`, so a batch of messages arriving together can never raise it.
- Every delivery lands on an **existing** node: the signal path injects a turn on the target
  node (or the running turn takes it at its next boundary), so no child node is created. The
  record is `node.lastFrom`, the allowance is `node.roundsAllowance`, and both are rendered by
  `list_nodes` (`from=`, `rounds=`). A mid-turn delivery has no card of its own either; the
  notice block on that node's card is the visible mark.

### 2.3 The queue is observable

- `list_nodes` labels a node whose queue holds undelivered messages with `queued=N`.
- A node that received one shows `from=<sessionId>/<nodeId>` and `rounds=<n>` on its line, and
  the delivered block on its card carries the same two fields.
- `message_id` is the sender's handle for a later look. Nothing polls.
- A node's inbound queue is capped (suggest **4**). Beyond the cap the oldest entry is dropped and
  reported to its sender, so one runaway sender cannot stack unbounded turns.

### 2.4 Delivery revalidates, and Stop does not lose a message

- At the drain, not only at the call: the target node still exists, it is still not a sidecar, the
  session still exists, and the window is still not read-only. A failed revalidation drops the
  message and reports it to the sender if the sender's node still exists.
- A **union kill** on the target node keeps its live-state rule: `onStop` converts pending signals
  to writebacks (`takePendingSignals` → `queueWriteback`), so a message waiting there stops opening
  a turn but is still appended to the node's history for its next prompt. Nothing is silently lost,
  and nothing fires after Stop.
- Deleting a node drops its own still-queued outbound messages, matching `confirmKillBackgrounds`
  ("deleting a branch or session kills what it still owns"). A reply aimed at a deleted node cannot
  land, and neither can a queued message aimed at it.

### 2.5 In memory, and a notice on the way out

The queue does not survive a reload, deliberately: a pending message is a live act of two live
sessions.

- The provider's pending-send bookkeeping is written back into the sender's node history before the
  window reloads or closes: one notice naming the target, the `message_id` and that it was not
  delivered. The write happens during disposal after `flushPersist()`, so it lands on disk.
- A hard crash cannot notify anyone. The plan states that; it does not pretend otherwise.

## 3. The round budget

### 3.1 The rule

- `max_rounds` is **mandatory**: an integer ≥ 1, clamped to `spinney.sessionMaxRounds` (default
  **16**). A missing or non-positive value is an ordinary `Error:` line that asks for the number
  again, so the model has to state its intent.
- The allowance travels with the delivery (§2.2) and is charged at send time.
- A send from a node that has an inherited allowance uses `min(declared, inherited, cap)`. The
  receiver can lower it, never raise it: once the exchange is running nobody can buy more rounds.
- `inherited == 0` at send time: refused with one sentence naming how many rounds this line has
  used since the last human message, and telling the sender to report back rather than re-send from
  another node.
- A **human-authored** node has no allowance (it never received a delivery), so the next send
  there declares fresh, still clamped. There is no "renewal" action: a human word creates a new
  node and the unattended stretch simply starts over.

### 3.2 What the number is, and is not

It is **legibility, not a brake**. A model under pressure declares the ceiling, so the brake is
`spinney.sessionMaxRounds` and the refusal is where a runaway stops. 16 is well above any real
multi-round exchange and well below an unbounded mirror loop; it is a setting because the
developer, not the agent, decides how much unattended work to allow.

### 3.3 Deliberately not

- **No `sync` mode that waits for the answer** (developer, 2026-11-14).
- **No wait tool, no polling tool.** The reply arrives as a message and starts or steers a turn.
- **No cross-window bus.** `POST /session/message` stays the same door, for the window that owns
  the sessions.
- **A pending reply does not lock the caller's node.** It is not unfinished work the node owns.

## 4. Interfaces (frozen)

| Piece | Where |
| --- | --- |
| tool schema: `max_rounds` (required, integer, min 1) and the rewritten description | `src/agent/tools/sendSessionMessage.ts` |
| one new signal kind (`session-message`) carrying `{ from, rounds, message_id }` | the signal record `src/chat/runtime.ts` already drains (`pushSignal`, `takeSignalsFor`, `drainSignals`) |
| a `delivered` promise per message, resolved where the signal is taken (tool boundary or injected turn) | the same signal record; the tool races it against `sessionSendSeconds` |
| provenance (`delivered[]`, `from`, `rounds`) | the node shape; read by the renderer, never by the request builder |
| `queued=`, `from=`, `rounds=` | `list_nodes` renderer (`SessionRuntime.handleListNodes`) |
| the unload notice | one RuntimeHost hook that queues a writeback for a sender node |
| `spinney.sessionSendSeconds` (default 30, min 1, max 3600) and `spinney.sessionMaxRounds` (default 16, min 1, max 64) | the "Tools & Execution" group, both read per call, both `scope: "window"` |

The old live-state gates in `deliverToNode` (`runningNodes` / `lockedNodes`) stop applying to a
message and stay where they are for `POST /session/start` and `/continue`.

## 5. Slices

- **P0, the channel.** The `session-message` signal kind, delivery at the tool boundary or as an
  injected turn, the `delivered` promise and the receipt, `sessionSendSeconds`, replacement of the
  running-node refusal. Tests first.
- **P1, observability and safety.** `queued=`, `from=`, `rounds=` in `list_nodes`, the per-node cap,
  revalidation at the drain, delete drops, the unload notice, the union-kill writeback.
- **P2, the budget.** Mandatory `max_rounds`, the clamp and the arithmetic, `sessionMaxRounds`, the
  refusal text, the stable machine line in the delivered block.
- **P3, the surface.** Catalog strings, `check:l10n`, `manual/**` pages for the two settings,
  `invariants/config-keys.md`, `control-plane.md`. A user-visible change updates every manual page,
  so this slice carries the full build-deploy reload.

## 6. Risks

- **A message can now land in the middle of a running turn and redirect it.** That is the same
  exposure background and sub-agent notices already have, and the human keeps the Stop button. It
  is also the only way a genuine back-and-forth can happen inside one turn, which is the point.
- **One shape, and it is not a bubble**: a delivered message is an injected turn (or a mid-turn
  injection) on the node it was sent to, so it appears as a notice block inside that node's
  card, never as a new card of its own. That is what makes it work mid-turn, and it means the
  tree does not grow a card per message. `from=` and `rounds=` on the node keep it legible, and
  a delivered message is written back (not dropped) on a union kill.
- **Coalescing**: several pending signals become one `user` message (`combineSignalText`). Session
  messages must stay one block each inside that text, and the budget is charged per send, not per
  batch, so coalescing cannot buy rounds.
- **The declared number is weak** (§3.2). The ceiling is the guard; do not sell it as a brake.
- **The unload notice is best effort by nature.** A crash loses it.
- **A long `sessionSendSeconds` blocks the caller's turn.** 30 s is the default for that reason, and
  `queued` is always a valid answer.

## 7. Guards and acceptance

- `tools/harness-test.mjs` `sessionMessage`: the current 409 case becomes "busy → tool-boundary
  delivery", plus idle injected turn, timeout → `queued` → later delivery, mandatory `max_rounds`,
  clamp to the cap, inherited-allowance refusal, delete-target drops, delete-sender drops its queue,
  read-only window, and union kill → writeback instead of a turn.
- The manual walk from 2026-11-14 as the acceptance scenario: two sessions, two rounds each way, no
  sleep and no transcript reading; each answer arrives in the other session's running turn, and the
  card says which node asked.
- `npm run check:l10n`, `npm run check:docs` (the two settings' manual pages). `check:models` is
  unaffected.

## 8. Landing record

Landed 2026-11-14, shipped in 0.7.0. This section records what was built, what was measured, and what
is still open.

### 8.1 What landed

- `send_session_message` takes a required `max_rounds`, blocks until the message is **delivered**
  (`spinney.sessionSendSeconds`, default 30), and returns the §2.1 receipt. A running node is no
  longer a refusal.
- One new signal kind (`session`) rides the existing queue (`pushSignal` → `takeSignalsFor` /
  `drainSignals`), so delivery is a tool-boundary injection or an injected turn on the same node.
  The delivered block is `[session message from <session>/<node>, rounds left <n>]` (the budget
  part is omitted for an external controller).
- `node.lastFrom` / `node.roundsAllowance` carry the provenance and the allowance; `list_nodes`
  renders `queued=`, `from=`, `rounds=`. A node's inbound queue is capped at **4**, and the
  oldest session message gives way (its sender is told).
- The budget is charged at send time — on the sender's own node too — and restored when the send
  fails; the receiver merges it as a minimum. `spinney.sessionMaxRounds` (16) is the ceiling.
- On disposal every still-queued message is appended to the sender's node history as one notice
  (a direct append, not the deferred writeback: the sender's own turn is being torn down).
- The control plane's `POST /session/message` shares the delivery, carries no budget and no
  `from`, and answers `state` / `how` / `messageId` / `waitedMs`.
- The webview knows a third producer (`Session message`) and renders its body as plain text.

### 8.2 Measured

| Check | Result |
| --- | --- |
| `node tools/harness-test.mjs sessionMessage` | **PASS**: a send into a live node → 200 `delivered` at `tool_boundary` after 17.2 s; into an idle node → 200 `delivered` at `injected_turn` after 78 ms; unknown session / node → 409 |
| A send into a running turn (the child was running `sleep 8`) | 200 `delivered`, `how: tool_boundary`, `waited_ms: 6902`, `rounds_left: 3`. The child's own `list_nodes` read `from=mwf88abz2v4oee/mwf9glj61ok05q, rounds=3`, and it confirmed the block arrived between the tool result and its reply |
| The reverse direction | the child's send returned `delivered`, `how: tool_boundary`, `waited_ms: 11174`, `rounds_left: 1`. The caller's node then read `from=mwf9iaf7gtaow0/mwf9iaok5l5lii, rounds=1`, and the block arrived **inside the caller's running turn** as `[session message from …, rounds left 1]` |
| Missing the window | a message into a 45 s tool call returned `queued`, `waited_ms: 30006`; the transcript shows it delivered right after the tool result |
| Observability while queued | during a 60 s tool call the target node read `[turn, running, busy, queued=1, from=…, rounds=0]` |
| Budget exhaustion | after the exchange the receiver's allowance reached 0 and its next send was refused with the allowance sentence. That sentence was **reworded after the run**: it says the allowance is used up and names 16 as the ceiling, instead of claiming 16 rounds were used |

Guards run clean: `compile`, `check:l10n` (401 strings), `check:webview` (44 messages),
`check:signals`, `check:docs` (22 settings), `check:models`.

### 8.3 Open

- **The reload notice is not automated and was not exercised** in this pass: it needs a message
  still queued at the moment the window goes down.
- The harness cannot force `queued` (it needs a turn that holds one tool call past the window,
  §7); the live walk covered that instead.
- Coalescing a session message with a completion notice in one batch, and the per-node cap of 4,
  are implemented but not exercised.
- The budget lives on the **node**, so a reply that arrives on another node of the same session
  (a human branch) starts a fresh allowance by design (§3.1).

## Related

- `control-plane.md` — the session tools' current contract, and `POST /session/message`.
- `invariants/sub-agents.md` — the receipt-with-escape prior art, and `settleSignals`' delivery
  rules.
- `invariants/background-terminals.md` — the completion-signal path this plan reuses, and "a slice,
  not a timeout".
- `invariants/config-keys.md` — the two new keys.
- `invariants/session-persistence.md` — why the queue is in memory, and the unload write.
- `multi-session.md` — the frozen P1–P4 concurrency contract the drain must not weaken.
