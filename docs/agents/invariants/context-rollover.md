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
new-epoch entry (§4). The
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
anything on its own, it only makes the composer's new-epoch button appear, and the
user's click is what opens the window (§4, §11).

The host computes the state once and ships it in the `tree` node payload and in
every `nodeUpdate` patch, so the webview never has to re-derive a model fact from
error text. `nodeStatePatch` still carries the older `contextFull: boolean`
alongside, but `media/main.js` reads `context` / `contextPct` only.

## 4. The composer's one entry point

There is exactly **one** entry for every new-epoch transition, and it lives in the
composer: `#new-context-btn`, immediately left of `#send-btn` inside `#actions`
(`src/chat/webviewShell.ts`). It replaces the three entries that used to disagree —
this feature's per-card `⧉ Continue in a new window` (`syncContinueButton`'s rollover
half, the `.node-continue` / `.node-window` pair), the composer's `#new-setup-btn` `⧉`
shown only for `drift === 'harness'`, and the `askSetups` modal a plain send raised when
the user changed model / effort / language. All three are gone from `src/` and `media/`;
`npm run check:continue` and `npm run check:webview` assert it.

| | what it is |
| --- | --- |
| label, with content | `Continue with new context` |
| label, empty box | `Compact and Continue` |
| shown when | the host says a new epoch is available — setup drift (`config.setup.drift`), or the focused chain's `context` is `near` / `full` |
| hidden when | the focused node is running or locked: Stop owns the row, and both other buttons hide with it |
| disabled when | the window is read-only, or the focused node is a sub-agent branch (the tooltip says which). An **empty box does not disable it**: there it is the compaction entry, the one click a full window has left |
| click | posts `{ type: 'newContextTurn', text, attachments }` — the same content a Send would carry |

**Send** keeps its own rules and loses the drift mark: it is hidden while Stop shows,
and it is **disabled** when `!hasContent || context === 'full' || readOnly || isAgent`.
An empty box is now a disabled state instead of a silent no-op, and `Enter` goes through
the same button, so a disabled Send means Enter does nothing. `#composer-ident` (the
`Sending with:` / `New setup:` lines) stays exactly as it was — it states the two
setups; the button is the one way to act on the difference.

The host picks the **backend** from the trigger (`SessionRuntime.newEpochTrigger`), never
from a choice of the webview:

1. `context` (`contextState(node) !== 'ok'`) → a **new context window**
   (`rolloverContext`). Its preconditions are `canRollover(nodeId)`: the node exists, is
   not a sidecar, is not running, and has no conversational child. A failure is a notice
   and nothing happens — nothing is started and nothing is killed.
2. `drift` only (`setupState().drift !== false`, either kind) → a **fork** under the live
   setup (`forkTree`). The old tree keeps the bytes — and the provider cache entry — it
   was built with. The composer's text is then sent into the new tree as an ordinary
   turn; an empty box forks only.

Then one modal, whose text depends on the backend (`confirmEpochChange`):

| backend | title | body | buttons |
| --- | --- | --- | --- |
| context | `Continue in a new context window?` | `The agent that takes over continues this conversation in a new window. It can either receive a handoff summary (one extra request) or be pointed at the previous branch and read the record itself.` | `Write a handoff summary`, `Just continue` |
| drift | `Continue with the new workspace or model configuration?` | `The conversation history (about {0} tokens for the current model) will be sent to the provider under the new configuration. This request will miss the provider’s cache.` — `{0}` is `chainPromptTokensLive()` | `Continue` |

VS Code adds its own Cancel. Dismissing sends nothing, kills nothing and keeps the input
box. After the answer the trigger is **re-validated** (`newEpochTrigger()` again): the
state may have moved while the modal was open (a turn finished, a dropdown moved, the
window filled), and acting on an answer given for a different state is exactly the bug
the check prevents — it posts a notice and stops instead.

The rollover's answer maps to `rolloverContext(nodeId, 'current', { text, handoff })`:
the new window **inherits** the parent's frozen epoch. The question this entry asks is
about the *window*, not about the setup, so a window that inherits keeps the bytes the
conversation was already written in; acting on a drift stays available afterwards, and
that is what the fork backend is for. **`handoff: 'summary'`** is recorded on the node
(`TreeNode.handoff`) and today behaves exactly like `'just continue'` — see §5a.

The host's `rolloverTurn` and `forkTurn` message cases and `rolloverWithSetup` /
`askSetups` / `forkAndSend` are deleted with the three old entries.


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

**History:** `[epoch.prompt, harness text]` plus — when the composer carried text — the
user's message as a **second, real `role:'user'` message after the harness one**
(`sendUserMessage(harness, text)`). That order is the point: the harness text is a fact
about the previous window, the typed text is this turn's request, and a model handed
only the harness text would be answering a quotation. `buildPath()` prepends the run's
**epoch prompt** — the frozen envelope of the node this rollover started (inherited, §4),
or a live render for a chain without one — so what the model receives is
`[epoch.prompt, harness, userText]` (or `[epoch.prompt, harness]` for an empty box). The
prompt itself is **not** in the node's `messages`, not put into the transcript dump and
not rendered in the card: it lives on the node that starts the epoch, once per epoch
(`docs/agents/invariants/system-prompt.md`).

**Display:** one `kind:'harness'` item (rendered as the badged block by the existing
`harnessNote` path), never a fabricated user bubble — the user did not type it — followed
by the ordinary `kind:'user'` item when the composer had text. The card's pinned prompt is
therefore the user's own message, or nothing at all when the box was empty.

## 5a. The handoff answer, and the pending summary

The context modal offers two answers, and only one of them is implemented:

- `Just continue` (and every entry that does not ask, such as a rollover started from a
  script) → the pointer shape of §6.
- `Write a handoff summary` → `handoff: 'summary'`, which `rolloverContext` **records on
  the new node** (`TreeNode.handoff`, persisted with the node, validated by value at load
  so an older build reads it as absent) and then treats exactly like `'just continue'`.
  The code carries the marker:
  `// TODO(compaction): a 'summary' handoff must spend one extra request to write a
  summary of the previous window and hand *that* to this node instead of the pointer.`

What the follow-up feature inherits: the user's *intent* is stored, the request plumbing
(`sendUserMessage`'s two user messages) is in place, and nothing else has to change shape.
Until then the modal's first button is honest about being a plan: both answers open the
same window, and neither costs an extra request.

## 6. The harness text

Built by `SessionRuntime` (model-facing, therefore **deliberately English**, like
the `[Harness]` fact line and the `INTERRUPT_NOTICE` literals, and never through
`l10n.t`). Shape:

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
- **The composer's text is not quoted here.** The pointer text stays about the
  *previous* window; the new request travels as its own user message (§5), so the
  "Redo the user's last request here" instruction only ever describes work the model
  can find in the transcript.
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
| `contextBaseId`, `contextBase()`, `epochForNode()`, `pathMessages()` cut, `normalizeTreeSession`, `TreeNode.handoff` | `src/chat/tree.ts` |
| `parseContextLengthError()`, `windowFullReason()` | `src/agent/models.ts` |
| `beginTurn({ freshContext, freshEpoch })`, `rolloverContext()`, `canRollover()`, `newEpochTrigger()`, `contextState()` / `contextPercent()` / `contextStateLive()`, `chainPromptTokensLive()`, `freezeEpoch()`, the harness text + `rolloverUsage()`, `nodeStatePatch()`, the kill + settle + flush + re-dump | `src/chat/runtime.ts` |
| `newContextTurn` routing, `newContextEntry()`, `confirmEpochChange()`, `forkEntry()`, `forkFor()`, the kill modal, the transcript meta field | `src/chat/ChatViewProvider.ts` |
| `sendUserMessage(content, followUp)` — the harness message and the composer's text as two user messages | `src/agent/agent.ts` |
| AGENTS.md read-at-use (`liveAgentsMdSources`) | `src/chat/agentsMd.ts` |
| `#new-context-btn` in `#actions`, the composer's own show/disable rules, `syncContinueButton` (▶ / ↻ only), the `context`/`contextPct` merge in `applyNodeUpdate`, dashed edge, `CTX` badge | `src/chat/webviewShell.ts`, `media/main.js` |
| `#actions #new-context-btn` (and the removed `#new-setup-btn` / `.node-rollover` / `.node-near` rules), `.edge-context`, `.node-ctx-badge` | `media/style.css` |
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
| host | `Continue in a new context window?` |
| host | `The agent that takes over continues this conversation in a new window. It can either receive a handoff summary (one extra request) or be pointed at the previous branch and read the record itself.` |
| host | `Write a handoff summary` |
| host | `Just continue` |
| host | `Continue with the new workspace or model configuration?` |
| host | `The conversation history (about {0} tokens for the current model) will be sent to the provider under the new configuration. This request will miss the provider’s cache.` |
| host | `Continue` |
| host | `Nothing to do: this conversation is on its own setup, and its context window has room left.` |
| host | `Nothing was sent: the setup or the context window changed while the question was open. Try again.` |
| host | `This context window is full, so the request was not sent. Use “Continue with new context” to carry the conversation into a new window.` |
| host | `Could not continue in a new context here — wait for the running turn to finish and try again.` |
| webview | `Continue with new context` |
| webview | `Compact and Continue` |
| webview | `Send this message in a new context window or under the new setup (the harness asks first)` |
| webview | `Compact this conversation and continue in a new context window (the harness asks first)` |
| webview | `Type a message or attach an image to continue in a new context` |
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
old setup (the one this node froze)`).

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
- `npm run check:webview` — the composer's one new-epoch entry: its labels (with and
  without content), that it is hidden with no epoch available and while Stop shows, that
  it is disabled on an empty box, in a read-only window and on a sub-agent branch, that a
  click posts `newContextTurn` with the box's text and attachments and clears nothing,
  that no card carries a `.node-window` / `node-rollover` / `node-near` element any more,
  that `#new-context-btn` sits before `#send-btn` in the shell, that a `nodeUpdate`
  carrying `context: 'full'` disables Send and offers the entry, that the `edge-context`
  class lands on the child's connector only, and that the `CTX` badge appears on the
  window-starting card and not on its descendants.
- `npm run check:continue` — the retired setup modal (`askSetups` /
  `discardPendingSetup` / `hasUserDrift`) is gone from `src/`.
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
