# Context rollover (continuing a conversation in a new context window)

When a conversation fills the model's context window, this harness does **not**
compress it. It opens a **new context window**: a node that continues the same
session with an empty history, a harness-written resume message, and a pointer to
the previous window's on-disk transcript. The tree stays connected — the new node
hangs **below** the previous one, joined by a **dashed** edge.

## Why not summarise

- **Compression has to fire early.** The summarising call is itself a request
  whose input is the history, so by the time the window is actually full you
  cannot even send it. A summary pipeline therefore has to run at ~80% and again
  and again as the history regrows. A pointer can fire late — including *after*
  the provider already refused the request.
- **A summary is a one-shot lossy transform; a pointer is reversible.** Every
  main-agent turn is already dumped to `<root>/<sessionId>/<nodeId>.jsonl` and
  `search_transcripts` / `read_file` can read it (see `transcripts.md`), so
  "look it up" is a real instruction here, not a gesture.
- **The cost is genuinely lower.** A summariser pays a full-history input plus a
  summary output on every rollover; the pointer pays nothing until the model
  actually needs a detail, and the carried-over tail (§5) is free text we already
  have in memory.

### …so a handoff is a *chosen* one, never a pipeline

The composer's window entry (`#compress-btn`) offers `Simple` beside `Agentic` (§4), and that does not undo
any of the above — it is the same rollover, with the handoff chosen by the user:

- **Simple** is the pointer above, unchanged and still free. It is the default answer, and
  nothing runs on its own.
- **Agentic** is a **compression node**: one real turn that reads the previous window and
  writes the brief the next window starts from (`compress-node.md`). It is triggered by the
  user's click **after** the window ended, never at a percentage; its input is the window's own
  messages, selected and capped at 60,000 chars (§6a), not the branch above it — so it fits
  even in the window that was just refused, and nothing runs "as the history regrows".
- The pointer is not lost either way: a compressed window still carries the transcript path,
  the original task, the last request verbatim, the killed-work list and the files the window
  changed, so the reversible half stays reversible.
- A compression that fails, runs out of sense or is stopped is a **notice and no window**; the
  compression card is still there to continue. The default stays free.

## 1. The one invariant this changes: display path vs API prefix

`pathIds()` (the **display** path: which cards the view expands, what `path`
describes, what the transcript meta records) is unchanged — the full parent
chain. The **API prefix** is where the cut happens:

```ts
// tree.ts
/** The context basis of a branch: the nearest ancestor-or-self that starts a window. */
export function contextBase(session: AgentSession, nodeId: string | null): string | undefined {
  const ids = pathIds(session, nodeId);          // root → node
  for (let i = ids.length - 1; i >= 0; i--) {    // nearest one wins
    const n = session.nodes[ids[i]];
    if (n && n.contextBaseId === n.id) return n.id;
  }
  return undefined;
}

export function pathMessages(session: AgentSession, nodeId: string | null): ChatMessage[] {
  const ids = pathIds(session, nodeId);
  const base = contextBase(session, nodeId);
  const out: ChatMessage[] = [];
  for (const id of ids.slice(base ? ids.indexOf(base) : 0)) {   // ← the only change
    const node = session.nodes[id];
    if (node && !isSidecar(node)) out.push(...node.messages);
  }
  return out;
}
```

So a branch's flat API history is `[epoch.prompt, ...messages from the context base
down to the node]` — **not** `[...path nodes' messages]`. That is the
whole semantic delta; `chat-tree.md` states it too.

Everything downstream inherits it for free, because `SessionRuntime.buildPath()`
is `sanitizeMessages([epochForNode(...)?.prompt ?? systemPromptFor(node),
...pathMessages(...)])` — the frozen envelope first, a live render only for a chain
that has none (`system-prompt.md`) — and every run records its
basis from that same array inside the same block (`prefixLen` / `prefixTail` in
`beginTurn` / `beginInjectedTurn`). Nothing else may compute a history prefix.

Two side effects worth knowing (both wanted):

- The old `activeSessionHasImages()` probe is **gone** with the send-time image
  hiding: nothing asks "does the sent prefix carry images?" any more. An image is
  judged where it is created — the composer's `isVisionCard(sendCard)` guard and the
  card's `vision.transport` (`vision-images.md`).
- The `persist-queued … msgs=N` diagnostic (prefixed `[perf]`, *not* `[persist]`) now
  reports the sent prefix's size: `persistNow()` counts
  `pathMessages(session, session.activeNodeId).length`, not the active node's own
  `messages.length` (`src/chat/ChatViewProvider.ts`, the `counts` line in
  `persistNow`).

`contextBaseId` participates in `pathIds`, so it decides which nodes' messages are
*sent*; it never moves a card.

## 2. Data model

```ts
// tree.ts — TreeNode
/**
 * This branch's context basis: from this node on, the message prefix sent to the
 * API contains no ancestor message at all. Only ever equal to the node's own id,
 * which is validated at read time (`contextBase()`), so it cannot go stale: a
 * foreign or unreachable value simply has no effect and needs no migration.
 */
contextBaseId?: string;
```

- `normalizeTreeSession` keeps the field when it is a string (no version bump:
  optional fields load unchanged, exactly like the P4 per-session selection).
- A value that is not the node's own id is **ignored at read time** — that is the
  whole validation, and it is why no repair pass is needed.
- Ancestors of a rollover node keep their own history untouched: the old branch
  stays fully usable (`▶ Continue` there, or a plain send) until it overflows
  again.

## 3. Trigger: the provider's 400, or the user at 90%

```ts
// src/agent/models.ts — the module that owns every context-window fact
/** Read the window and the refused size out of a provider context-length error. */
export function parseContextLengthError(text: string): { window?: number; requested?: number } | undefined;
/** Which budget a refusal names — from its text alone. */
export function windowFullReason(text: string): 'tokens' | 'images' | undefined;
```

Primary match (the format the provider actually emits, see
`model-capabilities.md`): `maximum context length is <N> tokens. However, you
requested <M>`. Loose fallback so a reworded provider still rolls over:
`context_length_exceeded` / `context length` / `reduce the length`.

**A window can be full by bytes, not only by tokens.** `windowFullReason()`
classifies the refusal's *kind* and nothing else: `'tokens'` for the context-length
error above, `'images'` for the provider's **per-request** image-size refusal —
`Total image size exceeds the limit: max 200 MB per request, got … MB`, the budget
`vision-images.md` describes and the token window cannot see. Both are the same kind
of authoritative statement (the request cannot be sent), so both have to offer the
same way out, and the composer's rollover entry is exactly it: a new window carries **no
attachments** (§6). Without it such a card would be a dead end — the window is `1_048_576`
tokens and a chain that hits the image wall sits at ~30 %, so `contextState()` is
`ok` while every retry walks into the same wall (this was the state before the
composer's `Continue with new context` existed: `contextState()` is `full` for both
kinds, so the entry is offered).

A node is **context-full** when

```
node.status === 'error' && windowFullReason(lastFailureText(node)) !== undefined
```

`nodeContextFull()` (runtime.ts) only asks whether the classifier returned
*anything* — the kind is not its business — so both kinds make a node context-full,
and both therefore make `contextState(node)` `full` and offer the composer's
window entry (§4). The
harness note names which refusal it was: `rolloverReason()` (`runtime.ts`) returns
`'images'` for the byte refusal and `'full'` for the token one, because the two are
different statements and a model told the wrong one redoes the wrong thing (§6). The
message itself stays model-facing English. The rule itself is untouched by the second
kind: the refusal **text** is
still the only trigger — never a local threshold — and the numbers a refusal prints are
still read by nobody (`parseContextLengthError`'s `window` / `requested`, and the two
sizes the byte refusal names, §11). `lastFailureText()` (runtime.ts) reads the
`⚠️ …` item back off the node's own card, so the judgement survives a reload and the
model is told exactly what the user can read there.

`SessionRuntime.contextState(node)` combines that hard trigger with a second,
**user-initiated** entry: the newest `usage.prompt_tokens` *on that node's own
chain* (`chainPromptTokens`) reaching `NEAR_CONTEXT_RATIO` (0.9) of the window of
the card the chain sends with (`chainCard`: the chain's epoch card, else the live
resolution). It is the same three-valued answer the host ships to the webview
(`'ok' | 'near' | 'full'`, `contextPercent` for the readout) — never re-derived in
the webview:

- `full` — the provider refused the request, by tokens or by image bytes (the
  `nodeContextFull` predicate above);
- `near` — that chain's latest prompt usage is **≥ 90 %** of the card's window;
- `ok` — otherwise, including a node with no usage yet.

**`usage.prompt_tokens` is still never a *machine* trigger.** It stays a readout
(and `model-capabilities.md` records how it lied once already — header read
`ctx 65%` while the request carried ~1.28 M tokens); the 90 % entry does not start
anything on its own, it only makes the composer's window entry appear, and the
user's click is what opens the window (§4, §11).

The host computes the state once and ships it in the `tree` node payload and in
every `nodeUpdate` patch, so the webview never has to re-derive a model fact from
error text. `nodeStatePatch` still carries the older `contextFull: boolean`
alongside, but `media/main.js` reads `context` / `contextPct` only.

## 4. The composer's one entry point

There is exactly **one** entry for every new-epoch transition, and it lives in the
composer: `#compress-btn` (the window entry) and `#new-context-btn` (the drift-only setup entry), both in `#actions` left of `#send-btn`
(`src/chat/webviewShell.ts`). It replaces the three entries that used to disagree —
this feature's per-card `⧉ Continue in a new window` (`syncContinueButton`'s rollover
half, the `.node-continue` / `.node-window` pair), the composer's `#new-setup-btn` `⧉`
shown only for `drift === 'harness'`, and the `askSetups` modal a plain send raised when
the user changed model / effort / language. All three are gone from `src/` and `media/`;
`npm run check:continue` and `npm run check:webview` assert it.

| | what it is |
| --- | --- |
| label, with content | `Compress and send` |
| label, empty box | `Compress` |
| shown when | the host says a new epoch is available — setup drift (`config.setup.drift`), or the focused chain's `context` is `near` / `full` — **and** the box has content or the context is `near` / `full`: the empty-box form is the compaction entry, so a setup drift with an empty box hides the button |
| hidden when | the focused node is running or locked: Stop owns the row, and both other buttons hide with it. The window entry also hides on a **compression card**, which has nothing above it left to compress |
| disabled when | the window is read-only, or the focused node is a sub-agent branch (the tooltip says which). An **empty box does not disable it**: there it is the compaction entry, the one click a full window has left |
| click | posts `{ type: 'newContextTurn', text, attachments }` — the same content a Send would carry |

**The button is the only entry, and it is the deliberate one.** Its click posts
`{ type: 'newContextTurn', mode: 'compression', text, attachments }` — the same content a Send
would carry — and `ChatViewProvider.newContextEntry` reads `mode: 'compression'` as a **forced**
trigger: it consults no `newEpochTrigger()`, because the click *is* the user's "move this
conversation now", so a window that still has room is a legitimate moment to move on.
`canCompress(nodeId)` is the structural precondition only (a conversational node whose own turn is
not streaming and whose windows are not still being written — a card that already has a
continuation below is *not* refused, because several attempts are how the two handoffs are
compared). `compress-node.md` §1 has the whole rule.

**Send** keeps its own rules and loses the drift mark: it is hidden while Stop shows,
and it is **disabled** when `!hasContent || context === 'full' || readOnly || isAgent`.
An empty box is now a disabled state instead of a silent no-op, and `Enter` goes through
the same button, so a disabled Send means Enter does nothing. `#composer-ident` (the
`Sending with:` / `New setup:` lines) stays exactly as it was — it states the two
setups; the button is the one way to act on the difference.

The host picks the **backend** from the trigger (`SessionRuntime.newEpochTrigger`), never
from a choice of the webview:

1. `context` (`contextState(node) !== 'ok'`) → a **compression card** below that node
   (`startPointerHandoff` for `Simple`, `compressHandoff` for `Agentic`, `compress-node.md`
   §1/§2). Its preconditions are `windowStartBlocker(nodeId) === null`: the node
   exists, is not a sidecar, is not running, and none of its windows is still being written.
   A child already below it does not block — another attempt is a sibling branch. A failure is
   a notice and nothing happens — nothing is started and nothing is killed.
2. `drift` only (`setupState().drift !== false`, either kind) → a **fork** under the live
   setup (`forkTree`). The old tree keeps the bytes — and the provider cache entry — it
   was built with. The composer's text is then sent into the new tree as an ordinary
   turn; an empty box forks only.

Then one modal, whose text depends on the backend (`confirmCompression` / `confirmEpochChange`):

| backend | title | body | buttons |
| --- | --- | --- | --- |
| context | `Start a new context window?` | `Simple costs no extra request: the new window is pointed at this window’s transcript and reads the record itself. Agentic runs one more turn — a compression node reads this window and writes the handoff the new window starts from, so the handoff is more complete, one turn slower, and costs that request.` | `Simple`, `Agentic` |
| drift | `Continue with the new workspace or model configuration?` | `The conversation history (about {0} tokens for the current model) will be sent to the provider under the new configuration. This request will miss the provider’s cache.` — `{0}` is `chainPromptTokensLive()` | `Continue` |

VS Code adds its own Cancel. Dismissing sends nothing, kills nothing and keeps the input
box. The setup question is **not** asked here: it belongs to the window, so it is asked at send
time, from the ready card (`sendFromHandoff` → `confirmHandoffSetup`, §5). The context answer is
re-validated after the question (`canCompress(nodeId)` again): a
turn may have started, or the node may have gone away, while the modal was open — and acting on
an answer given for another state is exactly the bug the check prevents; it posts a notice and
stops instead. The drift answer re-validates its own trigger (`newEpochTrigger() !== 'drift'`).

`Simple` maps to `startPointerHandoff(nodeId)` — the pointer shape of §6, written by the harness
into a card that runs **no turn at all**, so a `Simple` click costs nothing and is ready at
once. `Agentic` maps to `compressHandoff(nodeId)` — the compression turn of `compress-node.md`,
which runs **on the card** and stores the handoff there (`TreeNode.handoffNote`, plus
`handoffSummary`). Neither opens a window: that is a send below the card (§5).

`handoffSetup` is the answer to the setup question, and it is asked **at send time**, not here:
`sendFromHandoff` asks `confirmHandoffSetup` only when the live setup differs from the chain's
frozen one. `'current'` inherits the compressed window's frozen epoch — the question is about
the *window*, so a window that inherits keeps the bytes the conversation was already written in
(and the composer's new-epoch entry stays visible, still offering the other answer) — while
`'latest'` freezes the live model and level on the new window, at one cache miss. With no drift
the two answers are the same bytes, so no question is asked, and an inter-session prompt
(`send_session_prompt`) always takes `'latest'` without asking, because it cannot answer a
modal.

Killing running work is asked about **separately** and in both answers
(`confirmKillBackgrounds`, §7): a rollover stops a node's background terminals and sub-agents,
and that is a side effect the user did not ask for.

The host's `rolloverTurn` and `forkTurn` message cases and `rolloverWithSetup` /
`askSetups` / `forkAndSend` are deleted with the three old entries.


## 5. What the new node is

A window is **opened by a send**, from the compression card C the user pressed Compress into
(`compress-node.md` §1/§2). The click creates C; the send from C creates the window. That is the
whole difference from the old shape, and it is why a card can open several.

**Position:** a normal **child** of the compression card C (`parentId: C`; C is a child of the
overflowing node P), so the conversation reads continuously and the dashed edge marks the window
break. What changes is only the message prefix.

**Creation:** `onUserMessage(text, attachments, { basisNodeId: C, handoffSetup })` recognises the
basis as a `role:'compress'` card and takes its branch:
`beginTurn(title, { parentId: C, freshContext: true, role: 'resume', freshEpoch: handoffSetup ===
'latest', epochFrom })`. `epochFrom` is the compression chain's override — a node id
(`C.compressedFrom`, i.e. P) plants a **copy** of that node's frozen envelope on the new node,
`null` freezes a fresh one, absent keeps the ordinary rule (`compress-node.md` §3).
The `freshContext` option must set `node.contextBaseId = node.id` **after**
`createNode()` and **before** `buildPath()`, or the run's basis is still the full
chain. `freshEpoch` decides where the run's **epoch** comes from — the parent's
(inherited downward) or a new freeze of the live setup; a node with neither
inherits the parent's, which is the default. It also **resets** the parent's
pending interruption notice (`resetInterruptState()` instead of
`transferInterruptTo()`): that notice names a tool call in a context the new window
cannot see.

A send to a card that has **no handoff** is refused instead of creating a plain child
(*"This compression has not written its handoff yet. Continue it on its card, then send."*): a
window whose first message says nothing is worse than none.

**Title:** `vscode.l10n.t('Context window {0}', n)`, where `n` is the number of
windows on that branch: the session's first window is 1 and every window below it adds
one, so a session's first rollover is `Context window 2`. Each further send below the same card
adds a **sibling** window with the next number (§5b). The title is stored data, snapshotted in
the user's language like a session title. The card also carries a `CTX` badge (token-like,
deliberately untranslated, like `SUB` / `BG`), and the dashed edge and the badge are drawn only
when `contextBaseId === node.id` — the same self-equality test the host applies, so a stale
value cannot claim a window break the host does not perform.

**Before the card is created, the node's leftover work is union-killed** — see §7.

**History:** `[epoch.prompt, C.handoffNote, userText]` — the card's **stored handoff** as a real
`kind:'harness'` message on R, then the user's message as a **second, real `role:'user'`
message after it** (`sendUserMessage(handoff, text)`). That order is the point: the handoff is a
fact about the previous window, the typed text is this turn's request, and a model handed only
the handoff would be answering a quotation. For an `Agentic` card the handoff text *starts* with
the summary (§6a) and C also stores it as `handoffSummary`; R gets that answer copied onto itself
(`TreeNode.handoffSummary`) when the card has one, so a reload, and any later feature, can read
the handoff as data beside the messages. A `Simple` card has no summary and its window claims
none. `buildPath()` prepends the run's **epoch prompt** — the frozen envelope of the node this
window inherited from (§4), or a live render for a chain without one — so what the model receives
is `[epoch.prompt, handoff, userText]`. The prompt itself is **not** in the node's `messages`,
not put into the transcript dump and not rendered in the card: it lives on the node that starts
the epoch, once per epoch (`docs/agents/invariants/system-prompt.md`).

**Display:** one `kind:'harness'` item (rendered as the badged block by the existing
`harnessNote` path), never a fabricated user bubble — the user did not type it — followed
by the ordinary `kind:'user'` item for the message that opened the window. The card's pinned
prompt is therefore the user's own message.

## 5a. The handoff: the pointer, or a compression turn

The new-context modal offers two answers, and both are implemented. **Both are stored on the
compression card C** (`TreeNode.handoffNote`), which is what makes the card ready and what a
send below it leads the new window with (`compress-node.md` §2/§7):

- `Simple` → the **pointer** shape of §6, which costs no request at all: the harness writes it
  into `handoffNote` the moment the card is created, and no turn ever runs.
  `TreeNode.handoffSummary` is left absent — no model wrote anything.
- `Agentic` → a **compression turn** on the card (`compress-node.md`): one real turn reads the
  previous window and writes the handoff, `finishHandoff` stores the full compressed handoff
  (pointer facts first, summary first in the text) in `handoffNote` and the answer itself in
  `handoffSummary`. The window opened later from that card starts from it and copies
  `handoffSummary` onto itself. Both fields are persisted with the node and validated by value
  at load, so an older build reads them as absent.

The retired shape — `Write a handoff summary`, one `clients.complete` request on the chain's
card with a fixed eleven-section prompt and a 30 s deadline — is **gone from `src/`**:
`writeHandoffSummary`, `buildCompactionRequest`, `buildCompactionRetryMessages` and
`COMPACTION_TIMEOUT_MS` were deleted with it, and `npm run check:compaction` asserts they stay
gone. The reason is the one this page opens with: a request whose input is the history has to
fire early, while a compression **turn** is a card the user can read, stop, continue and
delete.

Nothing else changes shape: the plumbing (`sendUserMessage`'s two messages) is the same, the
pointer's facts are the same, and a compression that fails or is stopped keeps its ▶ Continue
on the card: the retry makes the card ready and opens **no** window (`compress-node.md`
§4/§6).

## 5b. Several windows below one card

A compression card is a boundary, not a conversation, so it stays usable after the first send:
every send below it opens a new window, each a **sibling** `role:'resume'` node of the others,
numbered in order (`Context window 2`, `Context window 3`, …). They are separate branches the
user can keep side by side and compare, and the card itself is unchanged by them.

What is one-per-card is **▶**: once the card carries its handoff, ▶ is refused
(`This compression already wrote its handoff; send a message below it to continue in the new
window.`) and the webview draws none. ▶ is the recovery path of a card with **no** handoff —
after a Stop, a failure or an empty answer. The windows are not deletable on their own either:
delete the compression card and the whole chain goes (§8, `compress-node.md` §5).


## 6. The harness text

Built by `SessionRuntime` (model-facing, therefore **deliberately English**, like
the `[Harness]` fact line and the `INTERRUPT_NOTICE` literals, and never through
`l10n.t`). There are two shapes: the **pointer** (below, the `Simple` answer) and the
**compressed** one (the `Agentic` answer — the handoff comes first and the pointer facts follow
it; §6a and `compress-node.md` §7). Pointer shape:

```
[Harness: context window reset]
The previous conversation could not be sent to the model any more (the provider refused
it: the context window was full), so this turn continues in a new, empty window of the
same session. Nothing above was carried over: do not claim to remember it.

Previous window: node <prevId> of session <sessionId>.
The previous window used <used> of this model's <window>-token context (<pct>%), which
is at or past the limit this provider accepts for one request.
Its full transcript — every message, tool call and result — is on disk:
  <absolute path to <root>/<sessionId>/<prevId>.jsonl>
Read it when you need a detail: read_file on that path, or search_transcripts with
sessionId=<sessionId> (line 1 is the meta record). Earlier windows of this session have
their own files in the same folder.

Carried over verbatim:
- the user's first request in that window: <verbatim, clipped 2000 chars>
- the user's last request: <clipped 2000 chars>
- the last answer you gave: <clipped 1000 chars>

Files the previous window changed — re-read one before editing it, it may have moved on:
- <path>

Still running from the previous window: none — <N> background terminal(s) and <M>
sub-agent(s) were stopped when this window was opened, because their results could not
be delivered into a full window. They are recorded in the previous window's transcript,
including each job's command, final state and output tail; a sub-agent has its own file
(kind=subagent). Read those records before redoing any of that work.

Redo the user's last request here. If it depends on earlier work, fetch that from the
transcript first — do not guess.
```

Rules for building it:

- **The size is stated.** `buildContextRolloverMessage({ usage })` receives
  `{ used, window, pct }` (`rolloverUsage(node)`: the chain's newest `prompt_tokens`
  against the window of the card the chain sends with) and adds one factual line right
  after the `Previous window:` paragraph — `The previous window used <used> of this
  model's <window>-token context (<pct>%)` — whose tail depends on the reason: `… which
  is at or past the limit this provider accepts for one request.` (`'full'`), `… which is
  past the harness's 90% rollover threshold; nothing was refused yet.` (`'near'`), or `…
  the refusal was about the bytes of that request, not about these tokens.` (`'images'` —
  an image refusal happens at ~30 % of the token window, so the "at or past the limit"
  sentence would be false there, and a model told the wrong thing redoes the wrong
  thing). `usage` is `undefined` when either number is unknown, and the line is then
  omitted: a fact the harness cannot state is not stated.
- **The reason is named.** `buildContextRolloverMessage({ reason })` receives one of
  **four** values, read off the same refusal text `nodeContextFull()` reads
  (`rolloverReason()`, runtime.ts): `'full'` when the provider refused the request over
  its **tokens**, `'images'` when it refused it over its **bytes** (§3), `'near'`
  when the user took the 90 % entry, and `'compress'` for the compressed shape, where the
  size line claims no reason at all (`The previous window used … , the window was
  compressed to continue the conversation in a shorter one.`) — a compression may be asked
  for at any fill level, so neither "it was refused" nor "it was nearly full" is a fact. The first paragraph says which: `… could not be
  sent to the model any more (the provider refused it: the context window was full)`;
  `… could not be sent to the model any more: the provider refused the request because
  of its images (the attachments it carried were over its per-request image size
  limit)`, which then says outright that none of those images came along and that
  attaching them again would cost the same bytes again — have them looked at by a
  sub-agent and report back in text; versus `… was stopped before the provider had to
  refuse it (the context window was nearly used up)`. Telling the model "it was
  refused" in the last case would be a lie, and naming the wrong refusal in the first
  two sends it after the wrong fix.
- **The composer's text is not quoted here.** The pointer text stays about the
  *previous* window; the new request travels as its own user message (§5), so the
  "Redo the user's last request here" instruction only ever describes work the model
  can find in the transcript.
- **The pointer degrades.** If `spinney.saveSessionTranscripts` is off, or the
  file is missing (`rolloverTranscriptOnDisk(prevId)` →
  `fs.existsSync(path.join(host.transcriptDir(sessionId), prevId + '.jsonl'))`, the path
  builder being `rolloverTranscriptPath`; `src/chat/runtime.ts`, both next to
  `startPointerHandoff`),
  the pointer lines are replaced by: *"The previous window's transcript is not
  available on disk; rely on the carried-over text and ask the user when a detail
  is missing."*
- **Carrying the tail is deliberate** (0 extra API cost — both are messages we
  already have). It is what stops the pointer from being useless: a model that
  does not know what it does not know does not look anything up.
- **Clipping is announced**: if the request was longer than the cap, say
  `(truncated: <N> chars total, the full text is in the transcript)`.
- **Attachments cannot be carried** (a `file_id`'s validity across windows is not
  guaranteed): say *"the original request had <N> attachment(s)"* instead.
- The leftover list is composed from what was actually killed in §7.
- **The original task is quoted, not described.** The window's **first** real user message
  (the request the task started from) is carried verbatim beside the last one, because a
  handoff that loses it is a handoff of the wrong task. A window whose first request never
  came from the user (a pointer note) says nothing there.
- **The changed files are listed.** `editedFilesFromItems` reads the window's `kind:'tool'`
  display items for the three writing tools and names each path once, in the order it was
  touched, under "re-read one before editing it, it may have moved on".
- **There is no "the summary failed" sentence any more.** The pointer shape is the `Simple`
  answer, which never asked for a summary; a compression that failed or was stopped is a
  notice on **that card** and no window at all (`compress-node.md` §6).

## 6a. The compression's input, and its outcome

The input, the bounds, the prompt and the validators live in `src/agent/compaction.ts` (pure,
`vscode`-free, driven by `npm run check:compaction`). `SessionRuntime.compressHandoff` owns the
card and the turn, `finishHandoff` the settle wait and what the card then carries; the window
itself is a later send from the card (`§5`), and the outcome table and the one-window-one-▶ rule
are `compress-node.md` §4/§6.

**The input is one window, bounded, never the whole chain.** `extractCompactionSource` selects
from `pathMessages(session, P)` — the context base down to the overflowing node, i.e. exactly
the API prefix without the system prompt — and it does so **before** the union kill, because the
kill appends harness notices to P as `role:'user'` messages that the user never wrote. What it
keeps:

- the **first** user message **verbatim** (a handoff that loses the original request is a
  handoff of the wrong task);
- **every** user message, each clipped to **500 chars**, with the count stated in the header
  (`user messages: <N>`);
- the assistant texts of the **last 8** turns, each clipped to **1000 chars**;
- each tool call as `name -> brief -> first line of the result`, the arguments clipped to
  **120** chars and that first result line to **200**;
- a marking line when the window already starts from a handoff (`COMPACTION_HARNESS_TITLE`), so
  the second compression carries the first one's unresolved items forward instead of
  re-inventing them.

The whole source is capped at **60,000 chars**. Over that, the **middle** is dropped —
head+tail selection keeps the header, the first request and the newest blocks — and one marker
line says how much was left out and where to read it. The two anchor blocks survive even if
they have to be shortened themselves.

**The changed files are read out of the transcript items** (`editedFilesFromItems`): every
`kind:'tool'` item whose tool is `write_file` / `replace_in_file` / `append_file`, its `path`
argument, in the order it was touched and without duplicates. Both handoff shapes list them
under "re-read before editing", because the working tree may have moved on since.

**The answer is validated by heading** (`missingCompactionSections`): the seven required
sections of `COMPRESS_REQUIRED_SECTIONS` are matched tolerantly (any heading level, casing, or
a trailing colon/period), and `Durable references` — how to retrieve what was left out — is
asked for and not required. A missing required heading is **not** a failure: the handoff is
stored on the card anyway and the card is told which sections are missing (`compress-node.md`
§6).


## 7. Leaving no orphan work behind

A rollover happens on a node that is *not* streaming (the button needs a terminal
status), but it may still own running background terminals and sub-agents. They
must not keep running: their completion notices would target a line nobody
continues from, and their results would never reach the new window.

So the rollover begins with the **existing union kill** (`stopNode(nodeId)`, the
same code path as the composer's Stop): it kills the node's background terminals
(`notifyAgent: false`), its whole sub-agent subtree (including the terminals the
sub-agents own), and takes any notice already queued for the node, converting all
of them into **writebacks** — notices appended to P's own card and its
`node.messages` (`role:'user'`). That is exactly the "leave it in the transcript"
requirement: writebacks live in the history the transcript mirrors.

Three things the rollover must add on top of `stopNode`:

1. **Wait for the kills to settle before composing the message.** A killed
   sub-agent writes its own dump inside its `finish` handler
   (`writeSubAgentTranscript`) and only then does its transcript path exist, so
   the message's sub-agent list would otherwise be a guess. Each running
   sub-agent therefore carries a settle promise in `runningSubAgents`
   (`{ agent, abort, settled }`, resolved in `finish`), and the rollover awaits
   them with a bounded timeout (~2 s) so a stuck job cannot hang the button.
2. **Flush and re-dump P.** `flushWritebacks()` writes the kill notices into P's
   history but — unlike `finishTurn` — never dumps it, so the file on disk would
   still lack them. After the flush, the rollover calls
   `host.dumpSessionTranscript(P, session, P.status)` explicitly. A
   `kind:'bg'` card produces no dump of its own (it has no turn), so the kill
   record must **carry the job's command, final state and output tail** — that is
   the only durable copy of what the terminal produced.
3. **Confirm before killing.** A rollover is the user's click, but killing a
   ten-minute build is a side effect they did not ask for. When
   `lockedWorkCount(P) > 0` the host shows the same modal gate the
   delete/clear paths use (`confirmKillBackgrounds`, with the header `Work is
   still running in this window.`) and only proceeds when the user picks the
   destructive action. No running work → no dialog.

## 8. Files

| Piece | File |
| --- | --- |
| `contextBaseId`, `contextBase()`, `epochForNode()`, `pathMessages()` cut, `normalizeTreeSession`, `TreeNode.handoff` / `handoffSummary` / `handoffNote`, `hasHandoff()` | `src/chat/tree.ts` |
| `parseContextLengthError()`, `windowFullReason()` | `src/agent/models.ts` |
| `beginTurn({ freshContext, freshEpoch, epochFrom, role })`, `canRollover()` / `canCompress()`, `windowStartBlocker()`, `startPointerHandoff()` / `createHandoffCard()`, `compressHandoff()` / `finishHandoff()`, `handoffReady()`, `windowsOnPath()` / `producedWindowNumber()`, the send-from-a-card branch of `onUserMessage()` (`handoffSetup`), `newEpochTrigger()`, `contextState()` / `contextPercent()` / `contextStateLive()`, `chainPromptTokensLive()`, `freezeEpoch()`, the harness text, `rolloverUsage()`, `nodeStatePatch()`, the kill + settle + flush + re-dump (`prepareHandoff`) | `src/chat/runtime.ts` |
| `newContextTurn` routing, `newContextEntry()`, `confirmCompression()`, `sendFromHandoff()`, `confirmHandoffSetup()`, `confirmEpochChange()`, `forkEntry()`, `forkFor()`, the kill modal, the transcript meta field | `src/chat/ChatViewProvider.ts` |
| `sendUserMessage(content, followUp)` — the handoff message and the composer's text as two user messages | `src/agent/agent.ts` |
| AGENTS.md read-at-use (`liveAgentsMdSources`) | `src/chat/agentsMd.ts` |
| `#new-context-btn` in `#actions`, the composer's own show/disable rules, `syncContinueButton` (▶ / ↻ only, no ▶ on a ready compression card), `syncHandoffCard` (the green ready card), the `Compress` / `Compress and send` label pair, the `context`/`contextPct` merge in `applyNodeUpdate`, dashed edge, `CTX` badge | `src/chat/webviewShell.ts`, `media/main.js` |
| `#actions #new-context-btn` (and the removed `#new-setup-btn` / `.node-rollover` / `.node-near` rules), `.edge-context`, `.node-ctx-badge`, `.handoff-ready` | `media/style.css` |
| The handoff texts: the input selection and its 60k bound, the previous-handoff marking, `firstUserRequest`, `editedFilesFromItems`, the pointer text, the compression instruction, the heading validation, the diagnostics line | `src/agent/compaction.ts` |
| The compression card: `compressTools`, `compressHandoff` / `finishHandoff`, `startPointerHandoff` / `createHandoffCard`, `COMPRESS_SYSTEM_PROMPT_TEMPLATE` / `compressSystemPrompt` | `src/chat/runtime.ts`, `src/agent/prompt.ts` (`compress-node.md`) |
| `TreeNode.handoff` / `TreeNode.handoffSummary` and their load-time validation | `src/chat/tree.ts` |
| The strings of §9 | `l10n/bundle.l10n.zh-Hans.json`, `l10n/bundle.l10n.zh-Hant.json` |
| The pure-function guards | `tools/check-context-rollover.js` (`npm run check:rollover`), `tools/check-compaction.js` (`npm run check:compaction`) |
| The chain's own guards | `tools/check-webview.js` (`npm run check:webview`), `tools/rollover-acceptance.js` |

## 9. i18n

Translated (both catalogs, the source literals in the code):

| Where | English source |
| --- | --- |
| host | `Context window {0}` |
| host | `Work is still running in this window.` |
| host | `{0} piece(s) of work are still running here (background terminals and sub-agents). Continuing in a new window stops them; what they produced stays in the transcript.` |
| host | `Continue and stop them` |
| host | `Start a new context window?` |
| host | `Simple` / `Agentic` |
| host | `Simple costs no extra request: the new window is pointed at this window’s transcript and reads the record itself. Agentic runs one more turn — a compression node reads this window and writes the handoff the new window starts from, so the handoff is more complete, one turn slower, and costs that request.` |
| host | `Continue with the new workspace or model configuration?` |
| host | `The conversation history (about {0} tokens for the current model) will be sent to the provider under the new configuration. This request will miss the provider’s cache.` |
| host | `Continue` |
| host | `Nothing to do: this conversation is on its own setup, and its context window has room left.` |
| host | `Nothing was sent: the setup or the context window changed while the question was open. Try again.` |
| host | `This context window is full, so the request was not sent. Use “Continue with new context” to carry the conversation into a new window.` |
| host | `Could not continue in a new context here — wait for the running turn to finish and try again.` |
| webview | `Continue with new context` |
| webview | `Compress` / `Compress and send` |
| webview | `Compress this conversation and send this message into the new context window (the harness asks first)` |
| webview | `Type a message or attach an image to send` |
| webview | `The context window is full; continue in a new one first` |
| webview | `A sub-agent branch cannot start a new context window` |
| webview | `A sub-agent branch is read-only` |
| webview | `This node starts a new context window; the branch above it is not sent to the model any more` (the `CTX` badge's title) |

**Both catalogs carry these keys** (checked by `npm run check:l10n`, which fails
packaging when a source literal is missing from a shipped catalog), and the entries this
change retired are gone from them: the per-card rollover label and its two tooltips
(`⧉ Continue in a new window`, `Ask the harness to continue this turn in a new, empty
context window (the current one is full)`, `Context is {0}% full - continue in a new
window`), the harness-drift hint (`Continue with the latest setup (forks this tree and
sends there)`) and the setup modal (`Continue with current setup`, `Continue with latest
setup`, `Continue with a new setup?`, its two bodies, and `Send will ask before using the
old setup (the one this node froze)`). The compression-card change retired the button's old
pair as well (`Compact and Continue`, `Send this message in a new context window or under the
new setup (the harness asks first)`, `Compact this conversation and continue in a new context
window (the harness asks first)` and `Type a message or attach an image to continue in a new
context`) in favour of `Compress` / `Compress and send`.

The handoff choice is deliberately **setting-free**: it is one answer to the modal's
question (`Simple` / `Agentic`), it runs on the card the conversation already uses, and
there is no `spinney.*` key to enable it, no temperature or length to tune and no separate
card to pick. A user who wants the free handoff answers `Simple`. The compression's own
strings are listed in `compress-node.md` §9.

Deliberately untranslated (the existing rules, see `i18n.md`): the harness resume text (the
pointer shape **and** the compressed one, whose title line `[Harness: context window reset —
handoff summary]` is what the next compression reads) (model-facing and shown verbatim in its
block), the `CTX` / `CMP` badges (compact dock tokens), and the `[config]` / `[perf]` /
`[compression]` diagnostics.

## 10. Evidence

- `npm run compile`.
- `npm run check:rollover` — pure node: the prefix is cut at the base, the base is
  inherited by descendants, a `contextBaseId` naming another node has no effect, a
  rollover node's own path is only its own messages, `pathIds` is unchanged, an epoch
  is inherited from the nearest ancestor that carries one and a **malformed** envelope
  is ignored rather than repaired (so the live-render fallback is reached), and
  `parseContextLengthError` reads the real provider text (plus two reworded
  fallbacks and a non-matching error).
- `npm run check:webview` — the composer's two epoch entries (the window button and the drift-only setup button): their labels (with and
  without content), that it is hidden with no epoch available and while Stop shows, that
  it is disabled on an empty box, in a read-only window and on a sub-agent branch, that a
  click posts `newContextTurn` with the box's text and attachments and clears nothing,
  that no card carries a `.node-window` / `node-rollover` / `node-near` element any more,
  that `#new-context-btn` sits before `#send-btn` in the shell, that a `nodeUpdate`
  carrying `context: 'full'` disables Send and offers the entry, that the `edge-context`
  class lands on the child's connector only, that the `CTX` badge appears on the
  window-starting card and not on its descendants, that a compression card wears `CMP`
  instead, shows its own ⏹ Stop while its turn runs and has **no** input box then, that it
  turns **ready** (the green `.handoff-ready` card) and hosts the composer once it carries its
  handoff, and that a resume window carries no 🗑 of its own.
- `npm run check:compaction` — pure node, against the compiled `src/agent/compaction.ts`: the
  source is one window (harness notes are not user requests), the first user message is
  verbatim while every user message is clipped to 500 chars with the count, only the last 8
  assistant texts are kept, a tool call reads `name -> brief -> first line of the result`
  with a 200-char result, a window over 60,000 chars keeps its head and its tail and
  announces the clip, a window that starts from a handoff is marked as one, the eight
  sections and the seven required headings (tolerant matching, prose rejected), the decision
  (`empty` / `invalid` / usable), the compression instruction (the facts, then the fixed ask
  verbatim, the transcript pointer degrading instead of pointing at nothing), the pointer
  text (the original task and the changed files included, the size line claiming no refusal
  in the compressed shape), `editedFilesFromItems` (only the writing tools, in order, no
  duplicates), the `outcome=` spelling of the diagnostics line, and that the retired
  one-shot summariser's exports are **gone** from the module.
- `npm run check:continue` — the retired setup modal (`askSetups` /
  `discardPendingSetup` / `hasUserDrift`) is gone from `src/`.
- `node tools/rollover-acceptance.js` (dev only, after `npm run compile`) — drives
  `startPointerHandoff()` against the real runtime with the `vscode` module stubbed and an
  offline client: the card carries the pointer text, starts no turn, and a send below it opens
  a window whose first request is `[epoch.prompt, handoff, user]` and carries no ancestor
  message, the overflowing node's background terminal is killed while another
  node's job is left alone, the kill notice reaches that node's history *and* its
  re-dumped transcript, the handoff carries the pointer / clipped tail / attachment
  count. The
  **compression chain** is driven the same way, with a scripted assistant turn: C's first
  request is `[compression envelope, harness instruction]` with no ancestor or sibling
  message and carries exactly the four read-only tools, C freezes an envelope of `kind:
  compress`, and the card carries no handoff while its turn runs. A `Simple` press creates a
  ready card with the pointer text and no request at all. A send below a ready card opens R:
  a `resume` node whose system message is **P's** bytes (not C's), whose first message is C's
  handoff and is followed by the user's message, and which records the handoff's presence
  (`handoff` / `handoffSummary`). A second send below the same card opens a **sibling**
  window with the next number. A Stop on C leaves the card interrupted with **no handoff** and
  no window, an empty answer stores no handoff, a missing section stores the handoff anyway
  with a notice on the card, `continueFrom(C)` is refused once the handoff exists, and
  `branchDeletionBlocked` refuses the resume window while allowing the compression card.
  See `testing.md`.

## 11. Deliberately not done

- **No automatic pre-emption.** Amended when the epoch model landed: there is still
  no threshold that *starts* anything — nothing rolls over on its own, and nothing
  is written pre-emptively — but a **user-initiated entry exists from 90 %**: the
  composer's new-epoch button appears on a near-full chain
  (`SessionRuntime.contextState(node) === 'near'`), and the click is what opens the
  window. Nothing may relax it further: a near-full tip has no task to carry, so an
  *automatic* rollover there would either burn a request or fabricate a turn.
- **No automatic rollover.** It costs a request and kills work; it is always the
  user's click — including at 90 %, where the button is only a suggestion.
- **The new node does not adopt the old node's background jobs.** Ownership is
  `(session, node)` by design (`background-terminals.md`); the rollover kills them
  and records them instead.
- **The provider's window number never writes a card — and nothing compares it.**
  `windowFullReason(...)` is used only to **classify** (which budget did this failure
  name? — `'tokens'` or `'images'`), and `parseContextLengthError(...)` below it only
  as a **boolean** (does this failure text
  name a context-length error?); its `window` / `requested` fields are never read, so a
  mismatch between the 400's window and `contextWindowFor()` (the active card's
  `contextWindow`) is neither detected nor logged — not on `[config]`, not on `[perf]`.
  That is fine by design: the field is the user's, and a wrong window is their
  one-field fix on the card (`model-capabilities.md`, `model-cards.md`). The byte
  refusal gets the same treatment for the same reason: the two sizes it prints are a
  snapshot of one failed request, so they are read and knowingly dropped — nothing
  compares them against `MAX_REQUEST_IMAGE_BYTES` either (`vision-images.md`).
