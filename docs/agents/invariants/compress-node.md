# The compression card (the handoff the window below starts from)

When a context window ends, the conversation continues in a new one. There are exactly two
deliveries, and the composer's window entry asks them as one question with two answers
(`context-rollover.md` §4):

- **Simple** — the **pointer** handover: the card carries a handoff that points at the previous
  window's transcript, and the window below reads the record itself. Zero extra requests
  (`context-rollover.md` §6).
- **Agentic** — a **compression turn**: a real turn reads the previous window and writes the
  handoff **onto the card**. One more turn, and the handoff is what the next agent actually
  knows.

Both answers end at a **compression card** C below the window P they compress, and neither
emits a turn once the compression is over: `Simple` creates C ready, with the harness-written
text; `Agentic` runs the one turn on C and stores its answer there. C is where the user
continues — a **send** below C is what opens the window, and one C may open several
(`context-rollover.md` §5).

This page is the Agentic half. It replaces the retired one-shot summariser (a `clients.complete`
request with a fixed eleven-section prompt): that shape spent a request on a window that
could not afford one, and it left the summary as a string nobody could check. A turn can
read the transcript, read the workspace, and be stopped, continued and deleted like any other
card.

## Why a brief, not a summary

From *You don't need long context* (arXiv:2611.05306v1, Appendix A): a compression is not a
record of what happened, it is the **brief for the work that still has to be done**. A
narrative of the past is worthless to the agent who reads it; a picked list of facts,
intentions, artifacts and next steps is what keeps the task alive. That is why the required
sections are `Objective` (the task quoted verbatim), `Standing instructions and preferences`,
`Established facts`, `Applied changes`, `Verification`, `Dead ends` and `Remaining plan`, and
why `Durable references` — how to retrieve what was left out — is asked for and not required.

## 1. The two entries, one behaviour

| entry | what posts it | how it asks |
| --- | --- | --- |
| `#compress-btn` (the composer's window entry, left of Send) | `media/main.js` `newContextTurn('compression')` | always: the button is on screen while the composer is, and the host answers a stale click with a notice |
| `#new-context-btn` (the drift-only setup entry) | `media/main.js` `newContextTurn('fork')` | only when the live setup differs from the frozen one (`hasSetupDrift`), because with no drift the answer would be the same bytes |

Both land in `ChatViewProvider.newContextEntry` (`opts.mode` says which entry asked), so the
entries cannot drift apart. There is no second entry on the Send button: the composer's one
button is the only way in, which is why nothing else has to repeat its refusals.

Both compression entries **end at the card**. `newContextEntry` creates C below the checked-out
window and returns: `startPointerHandoff(nodeId)` for `Simple`, `compressHandoff(nodeId)` for
`Agentic`. No window is opened from the click, and no turn is emitted once the compression is
over. Everything that used to follow the click — the window, its first request, and the setup
question — belongs to the **send** that goes out below C (`sendFromHandoff` → `onUserMessage`,
§7).

`confirmCompression()` is that question:

| | |
| --- | --- |
| title | `Start a new context window?` |
| buttons | `Simple`, `Agentic` (VS Code adds Cancel) |
| detail | one sentence per answer: Simple costs no extra request and the new window reads the record itself; Agentic runs one more turn, so the handoff is more complete and one turn slower |

Dismissing it sends nothing, kills nothing and keeps the composer's text.

**The setup question is not asked here any more.** It belongs to the window, not to the
compression, so it is asked when the window is actually opened — at send time, in the send path
(`ChatViewProvider.sendFromHandoff` → `confirmHandoffSetup`) — and only when the live setup
differs from the chain's frozen one (`hasSetupDrift`): `Keep this window’s setup` inherits the
frozen envelope of the window the card continues (the provider has that prefix cached), `Use the
latest setup` freezes the live model and level on the new window (one cache miss). With no drift
the two answers are the same bytes, so the question is not asked. The answer reaches the runtime
as `handoffSetup: 'current' | 'latest'` on `onUserMessage`, which plants P's envelope
(`epochFrom: P`) or freezes fresh (`epochFrom: null, freshEpoch: true`) on R accordingly.
Keeping the old setup is what leaves the other entry's answer unasked: the composer's setup
entry stays visible, still offering it. An inter-session prompt (`send_session_prompt`) cannot
answer a modal, so it always continues on the latest setup, with no question.

The entry's precondition is `SessionRuntime.windowStartBlocker(nodeId)` — a conversational node
whose own turn is not streaming and none of whose windows is still being written — and it says
**nothing about how full the window is**, and **nothing about a child the card already has**:
several windows below one card are the point, each a sibling branch, and a card the user has
already continued from may be compressed again. A **compression card** is refused as an entry
(`This card is already a compression; send a message below it instead.`): its composer's entry
hides there too, because there is nothing above it left to compress.
`canCompress(nodeId)` is that predicate as a boolean (`null` = allowed).
`canRollover` (the composer button's suggestion at 90 %) keeps that condition; a deliberate
entry may start from a window that still has room. Neither answer sends anything by itself: the
composer's text travels through the send below the card (`sendFromHandoff`), which is the same
path a later typed message takes, and a compression that never becomes ready leaves the text in
the box.

## 2. The tree

```
P  (the window being compressed)
│   dotted edge
C  (compression card — CMP)      role:'compress', compressedFrom: P
│   dotted edge   (one per send below C)
R  (a window opened by a send)   role:'resume'
```

- Both C and R are ordinary turn nodes with their own context base (`contextBaseId === id`),
  so the dashed edge and the badge are the same self-equality test every rollover uses.
- C's card wears `CMP` instead of `CTX` (a compression card starts a window of its own, and
  the badge says which of the two it is). R keeps `CTX`.
- C carries ordinary turn state — `messages`, `displayItems`, `status`, `model`, `effort` — so
  a reload shows it, the transcript dump holds it, and the next compression can read it. A
  `Simple` card has no `messages` of its own: its turn never ran.
- **R is created by a send**, not by the compression: several windows can hang below one C, and
  each one is a sibling of the others (`Context window 2`, `Context window 3`, …).

### C's card and its three states

A card is **ready** when it carries its handoff: `handoffNote` is a non-empty string
(`hasHandoff`, `TreeNode.handoffNote`). Only the card changes state; nothing below it moves.

| state | how it is reached | what the card shows |
| --- | --- | --- |
| **ready** | `Simple`: created ready, with the harness's pointer text. `Agentic`: its turn ended `done` with a usable answer, and `finishHandoff` stored `handoffNote` (the full compressed handoff) and `handoffSummary` (the answer) on it | green border and a green `Context compression` badge (`handoff-ready`, `syncHandoffCard`), the **composer**, and no Compress entry |
| **running** | `Agentic` only, while the compression turn streams | no input box at all; the card's own ⏹ **Stop** |
| **ended without a handoff** | a Stop, a failure, or an empty answer | no input box; ▶ **Continue**, its only way back (§4) |

- The composer rule is one line in the webview: `compressing = role === 'compress' &&
  !handoffReady`, so a ready card hosts the composer like any other card and an unfinished one
  is not an input surface at all.
- `#compress-btn` hides on a compression card (`updateCompressButton`), and the host refuses the
  entry anyway (`This card is already a compression; send a message below it instead.`): there
  is nothing above a card left to compress.

### C's turn (Agentic only)

`beginTurn(…, { parentId: P, freshContext: true, epochFrom: null, role: 'compress',
compressedFrom: P })`.

- `epochFrom: null` means "freeze a fresh envelope from the live setup" — C is its own epoch,
  in its own template (`COMPRESS_SYSTEM_PROMPT_TEMPLATE`) and its own tool set.
- Its **first and only** user message is harness-written: the facts (`[Harness: compression
  turn]`, the size line, the transcript path, the changed files, the killed work), the
  window's bounded source (`extractCompactionSource`), and then `COMPRESS_INSTRUCTION`
  verbatim. A person never typed it, so it renders as a `HARNESS` block.
- It has **no composer while the turn runs**: `setComposerVisible(false)` while it is checked out
  (the same rule a sidecar card gets, and `compressing = role === 'compress' && !handoffReady`
  in the webview). Its card keeps its own ⏹ **Stop** while it runs, and ▶ Continue when it
  ended without a handoff — the card is the only surface it has.

The `Simple` answer runs **no turn at all**: `createHandoffCard(P, note)` writes the same kind
of node — `role:'compress'`, `compressedFrom: P`, its own `contextBaseId`, `status:'done'` —
with the pointer text already in `handoffNote` and one `HARNESS` item to show, and no agent, no
request and no `messages`. That is why a `Simple` card is ready the instant it appears.

### The tool surface is a capability, not a sentence

`SessionRuntime.compressTools()` builds the registry C's agent is constructed with:

- `read_file`, `list_dir`, `search_files`, `search_transcripts` — a `subset` of the full
  registry;
- `write_file`, `append_file`, `replace_in_file` and the four background tools are
  **blocked** on the registry the subset is taken from (`withBlocked`), so a hallucinated call
  lands on an explicit denial instead of an "unknown tool" answer;
- `canSpawn`, `canSpawnReadOnly` and `canSessions` are all off, and the spawn / session hooks
  are never installed on that worker — so no intercepted tool is advertised at all.

A compression turn therefore cannot change the workspace. That is a fact of the registry it
was built with, not a promise its prompt makes.

### The handoff says what it is

Both handoff shapes end their opening with `HANDOFF_IS_NOT_MEMORY` (`src/agent/compaction.ts`):
the message is a handoff, repeating one of its facts says so, and a command or a file is never
written as something this window ran or read unless it did.

That paragraph exists because of a measurement, not a worry. A fresh window whose entire history
was one compressed handoff and one question ("summarize our progress within your dialog history
only") answered with a `git status`, a `git worktree list` and a `git branch --merged` — three
commands it had not run, with numbers that happened to be right. `messages` held two entries: the
handoff and the assistant's answer, no tool call at all. A brief that is worth reading is a brief
a model will mistake for its own experience, so the text has to name the voice. The pointer shape
(no brief at all, only the transcript pointer) carries the same paragraph for the same reason: it
misreported a `git status` too.

## 3. The envelope inheritance (the one thing that must not be wrong)

`epochForNode` walks **up** the path and returns the nearest envelope. C is between P and R,
so R's nearest envelope is C's compression one — which would hand the continuing conversation
a prompt that says "you are the compression node, you are not answering the user".

`beginTurn` therefore takes `epochFrom`:

| value | meaning |
| --- | --- |
| absent | the ordinary rule: inherit the parent's envelope, freeze one if the chain has none |
| `null` | freeze a fresh envelope from the live setup (C) |
| a node id | **plant a copy** of that node's envelope on the new node (R copies P's) |

The copy is stored on R itself (`R.epoch = { ...P.epoch, id: newId() }`): same bytes, same
hashes, same `cardId` / `effort` / `language` — a new id, because the id names the run that
carries them. Storing it is what makes it a **boundary**: without it, R's own descendants would
walk up past R into C's envelope.

The guard asserts it (`tools/rollover-acceptance.js`): R's system message is byte-equal to
P's, its `kind` is not `compress`, and its tool-set hash is P's. The runtime also writes one
`[compression] P -> C -> R (window n, envelope main, inherited main from P)` line, so a log can
prove the same thing without a debugger.

### Drift must be compared like with like

`setupState()` compares a chain's live setup against its frozen envelope. For a compression
envelope that means `session-prompt`'s own template, **no** AGENTS.md section and the read-only
tool set — comparing it with the main ones would report drift on every check, and a
compression chain would spend its life claiming the harness changed under it. `Epoch.kind`
(`'main'` absent, `'compress'` set) is what both `freezeEpoch` and `setupState` read, and the
AGENTS.md hash of a compression envelope is the hash of the empty section.

## 4. One card, as many windows as the user sends

A card is a boundary, not a conversation, so both of its edges need one rule:

- **While it has no handoff**, the card cannot be sent from. `onUserMessage` refuses a basis that
  is a `role:'compress'` card without one —
  *"This compression has not written its handoff yet. Continue it on its card, then send."* —
  because a window whose first message says nothing is worse than no window. The composer is not
  there to try it (§2), so this closes the scripted and inter-session entries.
- **Once the handoff exists**, every send below the card opens **a window**: one per send, each
  a sibling `role:'resume'` node, numbered in order (`Context window 2`, then `Context window
  3`, …). The card is not consumed and never gets sealed by its first window.
- **▶ is refused once the handoff exists.** The webview draws no ▶ on a ready card
  (`syncContinueButton`, the same `handoffReady` the composer reads), and
  `SessionRuntime.continueFrom(C)` refuses with one sentence —
  *"This compression already wrote its handoff; send a message below it to continue in the new
  window."* — without starting anything. ▶ is the recovery path of a card that has **no**
  handoff: after a Stop, a failure or an empty answer, it runs the card again and, on a usable
  answer, makes it ready without sending anything.

So a card produces exactly as many windows as the user asks it to, and "redo it" means going
back up to P and compressing again — a new card, not a second window from this one.

## 5. Deleting

- **R cannot be deleted on its own.** `branchDeletionBlocked` refuses it with a sentence that
  points at the compression card, and the webview never draws its 🗑 in the first place. A
  window whose handoff source is gone would be a branch nobody can explain.
- **C's 🗑 is normal**, and its branch *is* the chain: `branchIds(C)` contains every window it
  opened and everything below them. The delete confirmation says so in its own line
  (`Compression: this branch is a compression node, the window it produced, and everything
  below that window.`), so the click is not read as "one turn goes away".
- The two roles are validated **by value** at load (`TreeNode.role`, `TreeNode.compressedFrom`,
  `Epoch.kind`); an unknown role is dropped and a state stored before compression existed
  loads as an ordinary tree. No version bump.

## 6. The outcomes, all normal

`finishHandoff` (the Agentic answer) awaits the turn's **real** end (`TurnRun.settled`, resolved
once by `finishTurn` whatever the status — or by `dispose`), then decides:

| what happened | what it does |
| --- | --- |
| `status !== 'done'` (a Stop, a failure) | one notice on C's card; **no handoff** — the card keeps its ▶ as the way to retry |
| the answer is empty | one notice; **no handoff** — a handoff that says nothing would open a window whose first message says nothing |
| a required section is missing | one notice naming them and one `[compression] …` output line; **the handoff is stored anyway** (the answer is still the only handoff that exists) |
| a usable handoff | `handoffNote` (and `handoffSummary`) are stored on C and the card becomes ready |

All four change **only the card**: none of them opens a window, sends a message or kills
anything else. The window is a send (§7), and a compression that was stopped never auto-sends —
the composer's text stays in its box and the ▶ retry makes the card ready without sending
anything. `Simple` has no outcomes at all: its card is written ready by the harness, so the
first three rows cannot happen to it.

One `[perf] compaction in=… out=… ms=… outcome=summary\|fallback:<reason>` line records every
compression (`compactionDiagLine`), so "a turn wrote the handoff" is verifiable in a real
window instead of invisible.

## 7. R, the window below

R is created by `onUserMessage` — a send from a ready C — never by the compression:

`beginTurn(Context window {n}, { parentId: C, freshContext: true, role: 'resume', epochFrom: P })`,
then:

- the first message is **C's stored handoff block**, pushed before the user's message. For an
  `Agentic` card that text **starts with the answer** (under `COMPACTION_HARNESS_TITLE`, so the
  next compression recognises "this window already starts from a handoff" and carries its
  unresolved items forward), followed by the facts prose cannot be trusted with: the original
  task and the last request verbatim, the transcript pointer, the killed-work list, the changed
  files, and the size of the window that ended. For a `Simple` card it is the pointer text the
  harness wrote. Either way it is one `kind:'harness'` block;
- then the user's own message — text and attachments, exactly like a normal send. The request
  that made the user cross the window belongs to the new turn, not to C's instruction or its
  handoff;
- `handoff` is set on R (it was opened from a handoff), and `handoffSummary` holds C's written
  answer when C has one — an `Agentic` card does, a `Simple` card does not, and a pointer
  window must not claim a summary nobody wrote.

The window numbers are the branch's own: a session's first window is 1, P is `n`, C is titled
`Compression of window {n}`, and the windows a card opens are `Context window {n+1}`,
`{n+2}`, … in the order they are sent (`windowsOnPath` skips the card, `producedWindowNumber`
counts the resume children it already has).

## 8. Files

| Piece | File |
| --- | --- |
| `TreeNode.role` / `TreeNode.compressedFrom` / `TreeNode.handoffNote` / `TreeNode.handoffSummary`, `Epoch.kind`, `isCompressNode`, `hasHandoff`, `resumeChildOf` | `src/chat/tree.ts` |
| `COMPRESS_SYSTEM_PROMPT_TEMPLATE`, `compressSystemPrompt` | `src/agent/prompt.ts` |
| the selection and its bound, `firstUserRequest`, `editedFilesFromItems`, `buildCompressInstruction`, `COMPRESS_INSTRUCTION`, `buildContextRolloverMessage`, `missingCompactionSections`, `classifyCompactionAnswer`, `compactionDiagLine` | `src/agent/compaction.ts` |
| `compressTools` / `compressToolSchemas`, `freezeEpoch` (compress template + kind), `setupState` (like-for-like), `beginTurn({ epochFrom, role, compressedFrom })`, `canCompress`, `windowStartBlocker`, `startPointerHandoff` / `createHandoffCard` (Simple, no turn), `compressHandoff` / `finishHandoff` (Agentic, the card only), `handoffReady`, `prepareHandoff`, `postNoticeTo`, `windowsOnPath` / `producedWindowNumber`, the send-from-a-card branch of `onUserMessage` and `handoffSetup`, `continueFrom` (▶ refused once the handoff exists), `TurnRun.settled` | `src/chat/runtime.ts` |
| `newContextEntry` (both entries, the compression-card refusal), `confirmCompression`, `sendFromHandoff` / `confirmHandoffSetup` (the setup question at send time), the resume-node delete refusal, the compress delete line | `src/chat/ChatViewProvider.ts` |
| `syncCtxBadge` (`CMP`), `syncHandoffCard` (`handoff-ready`: the green border and badge), `syncContinueButton` (the card's Stop, no ▶ once ready), the composer rule (`!handoffReady`), no 🗑 on a resume card, `Compress` / `Compress and send` and their tooltips | `media/main.js`, `media/style.css` |
| the checks | `npm run check:compaction`, `npm run check:webview`, `node tools/rollover-acceptance.js` |

## 9. i18n

Translated (both catalogs): `Start a new context window?`, `Simple`, `Agentic`, the modal's
detail, `Compression of window {0}`, `Compress and send`, `Compress this conversation and send
this message into the new context window (the harness asks first)`,
`Compression stopped, so no handoff was written. …`, `The compression returned no answer, so
there is no handoff. …`, `The compression is missing {0} required section(s): {1}. The handoff
was stored anyway.`, `This compression has not written its handoff yet. Continue it on its card,
then send.`, `This compression already wrote its handoff; send a message below it to continue in
the new window.`, `This card is already a compression; send a message below it instead.`,
`Could not open the new context window here — try again.`, `This window is the result of a
compression — delete the compression node above it instead, …`, `Compression: this branch is a
compression node, the window it produced, and everything below that window.`, `This node
compresses the window above it; the window below it starts from the handoff it writes`, `Stop
this compression turn`.

Deliberately English and untranslated: the compression **instruction** and the two handoff
texts (model-facing, shown verbatim in their blocks), the `CMP` / `CTX` dock tokens, and the
`[compression]` / `[perf] compaction` diagnostics.
