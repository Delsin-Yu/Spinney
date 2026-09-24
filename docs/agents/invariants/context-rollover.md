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
same way out, and the `⧉` rollover is exactly it: a new window carries **no
attachments** (§6). Today such a card is a dead end — the window is `1_048_576`
tokens and a chain that hits the image wall sits at ~30 %, so `contextState()` is
`ok` and no button is offered while every retry walks into the same wall.

A node is **context-full** when

```
node.status === 'error' && windowFullReason(lastFailureText(node)) !== undefined
```

`nodeContextFull()` (runtime.ts) only asks whether the classifier returned
*anything* — the kind is not its business — so both kinds make a node context-full,
and both therefore make `contextState(node)` `full` and offer the `⧉` button. The
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
(`'ok' | 'near' | 'full'`, `contextPercent` for the tooltip) — never re-derived in
the webview:

- `full` — the provider refused the request, by tokens or by image bytes (the
  `nodeContextFull` predicate above);
- `near` — that chain's latest prompt usage is **≥ 90 %** of the card's window;
- `ok` — otherwise, including a node with no usage yet.

**`usage.prompt_tokens` is still never a *machine* trigger.** It stays a readout
(and `model-capabilities.md` records how it lied once already — header read
`ctx 65%` while the request carried ~1.28 M tokens); the 90 % entry does not start
anything on its own, it only makes the `⧉` button appear, and the user's click is
what opens the window (§4, §11).

The host computes the state once and ships it in the `tree` node payload and in
every `nodeUpdate` patch, so the webview never has to re-derive a model fact from
error text. `nodeStatePatch` still carries the older `contextFull: boolean`
alongside, but `media/main.js` reads `context` / `contextPct` only.

## 4. The button, and the two setups it offers

One button per card, one class (`node-continue`), one meaning at a time. The
rollover variants add `node-rollover` (`node-near` too for the suggestion) and
`data-action="rollover"`.

| node state | button |
| --- | --- |
| `error` + context `full` | `⧉ Continue in a new window` → posts `{ type: 'rolloverTurn', id }` |
| context `near` (≥ 90 %), any terminal status | the same `⧉`, as a **suggestion**: the `node-near` class softens it and the title carries the percentage (`Context is {0}% full - continue in a new window`) |
| `error` (any other failure) | `↻ Retry` (unchanged) |
| `interrupted` | `▶ Continue` (unchanged) |

Show rules: the existing ones — a tip of its branch (no conversational child), not
a sidecar, not currently running. The `near` variant is the one addition: because
it hangs off the context state and not off a failure, it also appears on a `done`
tip (exactly the long conversation that just finished above 90 %). The host
re-checks the same rules in `SessionRuntime.canRollover` (the gate the modal and
the turn start share: `contextState(node) !== 'ok'` plus the tip/sidecar/running
checks), so a replayed click cannot open a second window from one card. Retry is
*replaced* rather than offered beside the new button, because the retried request
is the same oversized one and is guaranteed to fail again.

`applyNodeUpdate` merges `context` and `contextPct` into `treeNodes[id]` before it
re-syncs the button — a turn that ends after the tree was drawn arrives as a
`nodeUpdate`, so both entry points must carry them, and the button is one element
whose class list and `dataset.action` are re-synced (a card that goes Retry →
rollover and back must read the action at click time). For the same reason the host
routes every `nodeUpdate` through one helper (`nodeStatePatch(node)`) instead of
hand-built payloads drifting apart.

Host entry point: `ChatViewProvider.handlePanelMessage` → `rolloverTurn` →
`SessionRuntime.canRollover(id)` (a node that turns out not to be near/full at all
still falls back to the in-place `continueFrom`) → `rolloverWithSetup(rt, id)`.

`rolloverWithSetup` asks **which setup** the new window should start with
(`askSetups('rollover')`: `Continue with current setup` is the default/Enter
action, `Continue with latest setup` the alternative), gates the kills when the
node still owns work (§7), and then calls
`SessionRuntime.rolloverContext(id, choice)`:

- `'current'` — the new node **inherits the parent's epoch**: same prompt bytes,
  same tool schemas, same provider facts. Nothing is re-rendered. (A chain with *no*
  envelope at all — a pre-epoch branch that `adoptLegacyEpoch` did not adopt, since
  that pass only covers the checked-out chain — freezes one from the node's own
  resolved card and level, which is the only case in which `'current'` renders
  anything.)
- `'latest'` — the new node **freezes the live setup** (`freshEpoch`), the same
  configuration a fork would freeze.

Both are free here — a new context has no cached prefix to lose — which is exactly
why the choice can be offered at this entry point at all. Dismissing the dialog
changes nothing.

## 5. What the new node is

**Position:** a normal **child** of the overflowing node P (`parentId: P`), so the
conversation reads continuously and the dashed edge marks the window break. What
changes is only the message prefix.

**Creation:** `beginTurn(title, { parentId: P, freshContext: true, freshEpoch: setup === 'latest' })`.
The `freshContext` option must set `node.contextBaseId = node.id` **after**
`createNode()` and **before** `buildPath()`, or the run's basis is still the full
chain. `freshEpoch` decides where the run's **epoch** comes from — the parent's
(inherited downward) or a new freeze of the live setup; a node with neither
inherits the parent's, which is the default. It also **resets** the parent's
pending interruption notice (`resetInterruptState()` instead of
`transferInterruptTo()`): that notice names a tool call in a context the new window
cannot see.

**Title:** `vscode.l10n.t('Context window {0}', n)`, where `n` is the number of
windows on that branch: the session's first window is 1 and every window below it adds
one, so a session's first rollover is `Context window 2`. The title is stored data, snapshotted in the user's language like a
session title. The card also carries a `CTX` badge (token-like, deliberately
untranslated, like `SUB` / `BG`), and the dashed edge and the badge are drawn only when
`contextBaseId === node.id` — the same self-equality test the host applies, so a stale
value cannot claim a window break the host does not perform.

**Before creating it, the node's leftover work is union-killed** — see §7.

**History:** exactly one stored message, the harness text below, as a `role:'user'`
message. `buildPath()` prepends the run's **epoch prompt** — the frozen envelope of
the node this rollover started (inherited or freshly frozen, §4), or a live render
for a chain without one — so what the model receives is `[epoch.prompt, harness
text]`. The prompt itself is **not** in the node's `messages`, not put into the
transcript dump and not rendered in the card: it lives on the node that starts the
epoch, once per epoch (`docs/agents/invariants/system-prompt.md`).

**Display:** a single `kind:'harness'` item (rendered as the badged block by the
existing `harnessNote` path), never a fabricated user bubble — the user did not
type it. Consequently the card has **no pinned prompt**; that is expected for a
node whose turn was opened by the harness.

## 6. The harness text

Built by `SessionRuntime` (model-facing, therefore **deliberately English**, like
`CONTINUE_MESSAGE` / `buildFailureContinue`, and never through `l10n.t`). Shape:

```
[Harness: context window reset]
The previous conversation could not be sent to the model any more (the provider refused
it: the context window was full), so this turn continues in a new, empty window of the
same session. Nothing above was carried over: do not claim to remember it.

Previous window: node <prevId> of session <sessionId>.
Its full transcript — every message, tool call and result — is on disk:
  <absolute path to <root>/<sessionId>/<prevId>.jsonl>
Read it when you need a detail: read_file on that path, or search_transcripts with
sessionId=<sessionId> (line 1 is the meta record). Earlier windows of this session have
their own files in the same folder.

Carried over verbatim:
- the user's last request: <clipped 2000 chars>
- the last answer you gave: <clipped 1000 chars>

Still running from the previous window: none — <N> background terminal(s) and <M>
sub-agent(s) were stopped when this window was opened, because their results could not
be delivered into a full window. They are recorded in the previous window's transcript,
including each job's command, final state and output tail; a sub-agent has its own file
(kind=subagent). Read those records before redoing any of that work.

Redo the user's last request here. If it depends on earlier work, fetch that from the
transcript first — do not guess.
```

Rules for building it:

- **The reason is named.** `buildContextRolloverMessage({ reason })` receives one of
  **three** values, read off the same refusal text `nodeContextFull()` reads
  (`rolloverReason()`, runtime.ts): `'full'` when the provider refused the request over
  its **tokens**, `'images'` when it refused it over its **bytes** (§3), and `'near'`
  when the user took the 90 % entry. The first paragraph says which: `… could not be
  sent to the model any more (the provider refused it: the context window was full)`;
  `… could not be sent to the model any more: the provider refused the request because
  of its images (the attachments it carried were over its per-request image size
  limit)`, which then says outright that none of those images came along and that
  attaching them again would cost the same bytes again — have them looked at by a
  sub-agent and report back in text; versus `… was stopped before the provider had to
  refuse it (the context window was nearly used up)`. Telling the model "it was
  refused" in the last case would be a lie, and naming the wrong refusal in the first
  two sends it after the wrong fix.
- **The pointer degrades.** If `spinney.saveSessionTranscripts` is off, or the
  file is missing (`rolloverTranscriptOnDisk(prevId)` →
  `fs.existsSync(path.join(host.transcriptDir(sessionId), prevId + '.jsonl'))`, the path
  builder being `rolloverTranscriptPath`; `src/chat/runtime.ts`, both next to
  `rolloverContext`),
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
| `contextBaseId`, `contextBase()`, `epochForNode()`, the `pathMessages()` cut, `normalizeTreeSession` | `src/chat/tree.ts` |
| `parseContextLengthError()`, `windowFullReason()` | `src/agent/models.ts` |
| `beginTurn({ freshContext, freshEpoch })`, `rolloverContext()`, `canRollover()`, `contextState()` / `contextPercent()`, `freezeEpoch()`, the harness text, `nodeStatePatch()`, the kill + settle + flush + re-dump | `src/chat/runtime.ts` |
| `rolloverTurn` routing, `askSetups()`, `rolloverWithSetup()`, the kill modal, the transcript meta field | `src/chat/ChatViewProvider.ts` |
| `SessionTranscriptInput` / meta `contextBaseId` | `src/chat/transcript.ts` |
| Button variant, `applyNodeUpdate` state merge, dashed edge, `CTX` badge | `media/main.js` |
| `.edge-context`, `.node-rollover`, `.node-near`, `.node-ctx-badge` | `media/style.css` |
| The strings of §9 | `l10n/bundle.l10n.zh-Hans.json`, `l10n/bundle.l10n.zh-Hant.json` |
| The pure-function guard | `tools/check-context-rollover.js` (`npm run check:rollover`) |

## 9. i18n

Translated (both catalogs, the source literals in the code):

| Where | English source |
| --- | --- |
| host | `Context window {0}` |
| host | `Work is still running in this window.` |
| host | `{0} piece(s) of work are still running here (background terminals and sub-agents). Continuing in a new window stops them; what they produced stays in the transcript.` |
| host | `Continue and stop them` |
| host | `Continue with current setup` |
| host | `Continue with latest setup` |
| host | `Continue with a new setup?` |
| host | `A new context window starts empty, so the latest setup costs nothing here. Continuing with the current setup keeps this conversation on the setup it was frozen with.` |
| host | `Could not continue in a new context here — wait for the running turn to finish and try again.` |
| webview | `⧉ Continue in a new window` |
| webview | `Ask the harness to continue this turn in a new, empty context window (the current one is full)` |
| webview | `Context is {0}% full - continue in a new window` (the `near` variant's title) |
| webview | `This node starts a new context window; the branch above it is not sent to the model any more` |

**Both catalogs carry these keys** (checked by `npm run check:l10n`, which fails
packaging when a source literal is missing from a shipped catalog), and the five
entries the epoch change retired — the three "… the prompt cache may be missed."
notices and the two image-hiding notices — are deleted with them.

Deliberately untranslated (the existing rules, see `i18n.md`): the harness resume
text (model-facing and shown verbatim in its block), the `CTX` badge (compact dock
token), and the `[config]` / `[perf]` diagnostics.

## 10. Evidence

- `npm run compile`.
- `npm run check:rollover` — pure node: the prefix is cut at the base, the base is
  inherited by descendants, a `contextBaseId` naming another node has no effect, a
  rollover node's own path is only its own messages, `pathIds` is unchanged, an epoch
  is inherited from the nearest ancestor that carries one and a **malformed** envelope
  is ignored rather than repaired (so the live-render fallback is reached), and
  `parseContextLengthError` reads the real provider text (plus two reworded
  fallbacks and a non-matching error).
- `npm run check:webview` — the rollover button's label and its `rolloverTurn`
  click, that a non-overflow failure still shows `↻ Retry`, that the state arriving
  by `nodeUpdate` switches the button, that the `edge-context` class lands on the
  child's connector only, and that the `CTX` badge appears on the window-starting
  card and not on its descendants.
- `node tools/rollover-acceptance.js` (dev only, after `npm run compile`) — drives
  `rolloverContext()` against the real runtime with the `vscode` module stubbed and an
  offline client: the new window's first request is `[epoch.prompt, harness]` and carries
  no ancestor message, the overflowing node's background terminal is killed while another
  node's job is left alone, the kill notice reaches that node's history *and* its
  re-dumped transcript, the message carries the pointer / clipped tail / attachment
  count, and a node that is not context-full falls back to the in-place continue. See
  `testing.md`.

## 11. Deliberately not done

- **No automatic pre-emption.** Amended when the epoch model landed: there is still
  no threshold that *starts* anything — nothing rolls over on its own, and nothing
  is written pre-emptively — but a **user-initiated entry exists from 90 %**: the
  same `⧉` button appears as a suggestion on a near-full tip
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
