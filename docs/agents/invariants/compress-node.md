# The compression node (a handoff written by a turn)

When a context window ends, the conversation continues in a new one. There are exactly two
deliveries, and the composer's new-epoch entry asks them as one question with two answers
(`context-rollover.md` §4):

- **Simple** — the **pointer** rollover: the new window is pointed at the previous window's
  transcript and reads the record itself. Zero extra requests (`context-rollover.md` §6).
- **Agentic** — a **compression node**: a real turn reads the previous window, writes the
  handoff, and the new window starts from that handoff. One more turn, and the handoff is
  what the next agent actually knows.

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
| `#new-context-btn` (the composer's one new-epoch button) | `media/main.js` `newContextTurn` | when the host says a new epoch is available (`SessionRuntime.newEpochTrigger`) |
| **right-click on `#send-btn`** | `media/main.js`, a `contextmenu` listener that `preventDefault`s and posts `{ type: 'compressNow', text, attachments }` | always: the click *is* the request, so no trigger is consulted |

Both land in `ChatViewProvider.newContextEntry` (`opts.compress` marks the right-click), so
the two entries cannot drift apart. There is deliberately **no menu drawn** on the right
click: the modal is the menu, because the choice is one question with two answers, not a list
of commands.

`confirmCompression()` is that question:

| | |
| --- | --- |
| title | `Start a new context window?` |
| buttons | `Simple`, `Agentic` (VS Code adds Cancel) |
| detail | one sentence per answer: Simple costs no extra request and the new window reads the record itself; Agentic runs one more turn, so the handoff is more complete and one turn slower |

Dismissing it sends nothing, kills nothing and keeps the composer's text.

The entry's precondition is `SessionRuntime.canCompress(nodeId)` — a conversational node, not
streaming, with no conversational child — and it says **nothing about how full the window is**.
`canRollover` (the composer button's suggestion at 90 %) keeps that condition; a deliberate
entry may open a window from a window that still has room. The Simple answer is
`rolloverContext(nodeId, 'current', { text, force: true })`, where `force` is exactly that
relaxation: without it a not-yet-full chain would degrade to an in-place continue, which is not
what the user asked for.

## 2. The tree

```
P  (the window being compressed)
│   dotted edge
C  (compression node — CMP)      role:'compress', compressedFrom: P
│   dotted edge
R  (the window that continues)   role:'resume', handoff:'summary'
```

- Both C and R are ordinary turn nodes with their own context base (`contextBaseId === id`),
  so the dashed edge and the badge are the same self-equality test every rollover uses.
- C's card wears `CMP` instead of `CTX` (a compression node starts a window of its own, and
  the badge says which of the two it is). R keeps `CTX`.
- C carries ordinary turn state — `messages`, `displayItems`, `status`, `model`, `effort` — so
  a reload shows it, the transcript dump holds it, and the next compression can read it.

### C's turn

`beginTurn(…, { parentId: P, freshContext: true, epochFrom: null, role: 'compress',
compressedFrom: P })`.

- `epochFrom: null` means "freeze a fresh envelope from the live setup" — C is its own epoch,
  in its own template (`COMPRESS_SYSTEM_PROMPT_TEMPLATE`) and its own tool set.
- Its **first and only** user message is harness-written: the facts (`[Harness: compression
  turn]`, the size line, the transcript path, the changed files, the killed work), the
  window's bounded source (`extractCompactionSource`), and then `COMPRESS_INSTRUCTION`
  verbatim. A person never typed it, so it renders as a `HARNESS` block.
- It has **no composer**: `setComposerVisible(false)` while it is checked out (the same rule a
  sidecar card gets). Its card keeps its own ⏹ **Stop** while it runs, and ▶ Continue when it
  ended without a window — the card is the only surface it has.

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

## 4. Sealing: one C, one window

C is an ordinary node, so without a rule it could produce two windows:

- **While it has no window**, ▶ Continue runs it again with its own envelope and history, and
  a successful answer opens the window. That is the recovery path after a Stop or a failure.
- **Once R exists**, C is **sealed**: the webview draws no ▶ on the card
  (`syncContinueButton`), and `SessionRuntime.continueFrom(C)` refuses with one sentence —
  *"This compression has already been delivered to the window below it. To redo it, start
  again from the window above."* — without starting anything.

So a compression has exactly one outcome, and "redo it" means going back up to P and asking
again.

## 5. Deleting

- **R cannot be deleted on its own.** `branchDeletionBlocked` refuses it with a sentence that
  points at the compression node, and the webview never draws its 🗑 in the first place. A
  window whose handoff source is gone would be a branch nobody can explain.
- **C's 🗑 is normal**, and its branch *is* the chain: `branchIds(C)` contains R and
  everything below it. The delete confirmation says so in its own line
  (`Compression: this branch is a compression node, the window it produced, and everything
  below that window.`), so the click is not read as "one turn goes away".
- The two roles are validated **by value** at load (`TreeNode.role`, `TreeNode.compressedFrom`,
  `Epoch.kind`); an unknown role is dropped and a state stored before compression existed
  loads as an ordinary tree. No version bump.

## 6. The outcomes, all normal

`compressAndContinue` awaits the turn's **real** end (`TurnRun.settled`, resolved once by
`finishTurn` whatever the status — or by `dispose`), then decides:

| what happened | what it does |
| --- | --- |
| `status !== 'done'` (a Stop, a failure) | one notice on C's card; no window; C stays as the record and its ▶ is the way to retry |
| the answer is empty | one notice; **no window** — a window whose first message says nothing is worse than none |
| a required section is missing | one notice naming them and one `[compression] …` output line; **the window opens anyway** (the answer is still the only handoff that exists) |
| a usable handoff | R is opened from it |

One `[perf] compaction in=… out=… ms=… outcome=summary\|fallback:<reason>` line records every
compression (`compactionDiagLine`), so "a turn wrote the handoff" is verifiable in a real
window instead of invisible.

## 7. R, the window below

`beginTurn(Context window {n}, { parentId: C, freshContext: true, role: 'resume', epochFrom: P })`,
then:

- `handoff = 'summary'`, `handoffSummary = <the compression answer>` — stored on the node, so a
  reload renders the same block and a later feature can read the handoff as data;
- the first message is a `kind:'harness'` block that **starts with the answer** (under
  `COMPACTION_HARNESS_TITLE`, so the next compression recognises "this window already starts
  from a handoff" and carries its unresolved items forward), followed by the facts prose cannot
  be trusted with: the original task and the last request verbatim, the transcript pointer, the
  killed-work list, the changed files, and the size of the window that ended;
- then the composer's text as a **real user message** — the request that made the user cross
  the window belongs to the new turn, not to C's instruction.

The window numbers are the branch's own: a session's first window is 1, P is `n`, C is titled
`Compression of window {n}`, R is `Context window {n+1}`.

## 8. Files

| Piece | File |
| --- | --- |
| `TreeNode.role` / `TreeNode.compressedFrom`, `Epoch.kind`, `isCompressNode`, `resumeChildOf` | `src/chat/tree.ts` |
| `COMPRESS_SYSTEM_PROMPT_TEMPLATE`, `compressSystemPrompt` | `src/agent/prompt.ts` |
| the selection and its bound, `firstUserRequest`, `editedFilesFromItems`, `buildCompressInstruction`, `COMPRESS_INSTRUCTION`, `buildContextRolloverMessage`, `missingCompactionSections`, `classifyCompactionAnswer`, `compactionDiagLine` | `src/agent/compaction.ts` |
| `compressTools` / `compressToolSchemas`, `freezeEpoch` (compress template + kind), `setupState` (like-for-like), `beginTurn({ epochFrom, role, compressedFrom })`, `canCompress`, `compressAndContinue`, `deliverCompression`, `prepareHandoff`, `postNoticeTo`, `continueFrom` (the seal), `TurnRun.settled` | `src/chat/runtime.ts` |
| `newContextEntry` (both entries), `confirmCompression`, the resume-node delete refusal, the compress delete line | `src/chat/ChatViewProvider.ts` |
| `compressNow` / `contextmenu` on `#send-btn`, `syncCtxBadge` (`CMP`), `syncContinueButton` (the card's Stop, the seal), no 🗑 on a resume card, the composer rule | `media/main.js`, `media/style.css` |
| the checks | `npm run check:compaction`, `npm run check:webview`, `node tools/rollover-acceptance.js` |

## 9. i18n

Translated (both catalogs): `Start a new context window?`, `Simple`, `Agentic`, the modal's
detail, `Compression of window {0}`, `Compression stopped, so no new window was opened. …`,
`The compression returned no answer, so no new window was opened. …`, `The compression is
missing {0} required section(s): {1}. …`, `Could not open the new context window here — try
again.`, `This compression has already been delivered to the window below it. …`, `This window
is the result of a compression — delete the compression node above it instead, …`,
`Compression: this branch is a compression node, the window it produced, and everything below
that window.`, `This node compresses the window above it; the window below it starts from the
handoff it writes`, `Stop this compression turn`.

Deliberately English and untranslated: the compression **instruction** and the two handoff
texts (model-facing, shown verbatim in their blocks), the `CMP` / `CTX` dock tokens, and the
`[compression]` / `[perf] compaction` diagnostics.
