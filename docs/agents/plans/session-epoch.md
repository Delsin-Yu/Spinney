# Session context epochs — the plan

> **Status: mostly implemented; this file is still the plan.** The sections below
> describe the design; §13 records what actually landed and what did not, so nothing
> here has to be read as "shipped" without checking that list. The rules that came
> out of it live in `docs/agents/invariants/**` (see the phase table in §8).

## 0. The goal, and the one invariant it needs

The provider's prompt cache is a **prefix** cache: request *N+1* can only reuse the
cached tokens of request *N* if its token stream starts with them, byte for byte. So
there are exactly three ways to lose a large cached prefix, and only the first two are
expensive:

| Where the change lands | Cost |
| --- | --- |
| token 0 (system prompt, `tools`) | the whole context is re-billed |
| an **early** message (an image block, a clipped tool result) | everything after it is re-billed |
| the tail (rollback, interrupt checkpoint, an appended notice) | only the tail |

Today the harness rewrites already-sent material in four places (a changed system
prompt, a changed tool set, image blocks rewritten at send time, and the 64 KiB
storage clip across a reload). A rewrite is **irreversible**: once the bytes of a
branch differ, the old prefix can never be produced again, so its cache entry is gone
for good. This plan replaces every one of those rewrites with an explicit, visible,
**non-destructive** decision.

- **I1 — append-only inside an epoch.** For one node, `(system, tools, messages)` is
  append-only for the lifetime of its epoch, and is reproduced byte-for-byte after a
  reload or a restart.
- **I2 — an epoch change is explicit and non-destructive.** A setup change never
  rewrites anything: the old bytes stay producible (they live on in the node that
  froze them) and the new bytes are frozen in a **new node**.
- **I3 — no silent repair.** Anything that would rewrite already-sent bytes is a
  defect, not a feature. Where such a repair is genuinely needed (a provider refusing
  an image), the repair is written into the history **once**, deliberately, and
  recorded — never applied invisibly at send time.

What "guaranteed" cannot mean: a provider's cache entry expires after a period of no
use. The guarantee is "the prefix never changes, so the hit happens whenever the entry
is alive" — not "the entry is always alive" (§11).

## 1. Vocabulary

| Word | Meaning |
| --- | --- |
| **node** | the unit of continuation. Every continuation — a plain send, a context rollover, a setup change — produces a **new node**. There is no "window" as a separate concept; the node that starts a new context *is* the thing. |
| **epoch** | the frozen request envelope (prompt bytes, tool schemas, provider, model, effort, language, dialect). Stored on the node that starts it, inherited by its descendants until the next such node. |
| **setup** (user-facing) | the configuration an epoch froze. The two modal actions are always about the *setup*, never about the mechanism. |
| **tree** | a chain of nodes under one root. A session is a **forest** of trees. |
| **context base** | the nearest ancestor-or-self that starts a new message prefix (`contextBaseId`, unchanged from today). A node that carries an epoch is always also a context base. |

## 2. Data model

```ts
/** The frozen request envelope. Stored once, on the node that starts it. */
interface Epoch {
  id: string;
  /** The rendered system prompt, byte for byte. Never rendered again. */
  prompt: string;
  /** The tool schemas this epoch advertises, in order. Never re-derived. */
  tools: FrozenToolSchema[];
  providerId: string;
  baseUrl: string;
  wireModel: string;
  effort: ThinkingEffort;      // '' / 'none' means the parameter is omitted
  replyLanguage: string;
  visionTransport: 'deepseek' | 'openai';
  agentsMdHash: string;        // content hash of the AGENTS.md snapshot at freeze time
  templateHash: string;        // content hash of the prompt template
  toolsetHash: string;         // content hash of the tool schema set
  frozenAt: number;
  /** True when this epoch was adopted retroactively at load (§7). */
  legacy?: boolean;
}
```

- `TreeNode.epoch?: Epoch` — only on a context-starting node, and only there.
  `epochForNode(session, id)` walks the parent chain, nearest first (exactly the shape
  of `contextBase()` in `src/chat/tree.ts`), and is the **only** way a request finds
  its prompt or its tools.
- **Provenance lives outside `messages`.** A content part travels to the API, so no
  extra field may hide in it: `TreeNode.imageSources?: ImageSource[]`, addressed by
  `{ messageIndex, partIndex }`, where
  ```ts
  type ImageSource =
    | { kind: 'upload'; providerId: string; fileId: string; srcPath?: string }
    | { kind: 'inline'; dataUrl: string };
  ```
  It is what makes re-materialisation possible (§6).
- `AgentSession.rootIds: string[]` replaces `rootId: string | null` — a session is a
  forest (§3).
- `AgentSession.legacyEpoch?: true` — set once during migration (§7).
- Store layout: the session header gains `rootIds`; node files gain `epoch` and
  `imageSources`. A layout version bump, migrated like the v1→v2 pass.

## 3. What gets deleted

Every row is a **rewrite of already-sent bytes**; the right-hand column is what
replaces it.

| Mechanism | Where | Replaced by |
| --- | --- | --- |
| `messages[0]` rewritten on a card / effort / language change | `src/agent/agent.ts:472-476` + call sites `:381`, `:397`, `:403`; `src/chat/runtime.ts:1446-1468` (`applyReplyLanguage`), `:1327-1375` (`applyDefaultModel`) | the epoch: a setup change opens a **new node** (§4.2) |
| The per-node pending pick (`setModel` / `setThinkingEffort`) and the ancestry walk that resolves it | `src/chat/runtime.ts:1238-1312`, `:1391-1433`, `cardIdForNode` / `effortForNode` on the request path | "the live setup" (what a new node would freeze) vs "the node's epoch" (what a send actually uses) |
| Image blocks rewritten at send time (non-vision card, foreign provider, provider-rejected) | `src/agent/agent.ts:550-591` (`messagesForCurrentModel`) | materialisation at epoch creation (§6); a rejection is written into the history once (§4.5) |
| The system prompt re-synthesized per request | `src/chat/runtime.ts:1598-1607` (`buildPath`), `:1181-1183` (`systemPromptFor`) | `epochForNode(...).prompt` |
| The system prompt dropped from storage, as if it were never data | `src/chat/tree.ts:557-561` (`pruneSession`) | the epoch **is** stored data (once per epoch, not per node) |
| 64 KiB clip of every stored message | `src/chat/runtime.ts:357-364` (`clipMessageForStorage`), write path `src/chat/ChatViewProvider.ts:1620-1651` | verbatim persistence (§5) |
| The Memento **write** path (the full-state fallback of a window that cannot take the store lock) | `src/chat/ChatViewProvider.ts:1679-1710` and the `clipSession` branch beside it | one owner window; a second window is read-only (§5) |
| The three "the prompt cache may be missed" warnings | `src/chat/runtime.ts:1462`, `:1534`, `:1563` (and their catalog entries) | there is no silent miss left to warn about |

Two more things become dead but are worth stating, because they look load-bearing:

- `finishTurn`'s slice verification (`src/chat/runtime.ts:2236-2249`) stays — it is
  what keeps a mid-turn history swap from storing ancestor messages in a node.
- `Agent.sanitizeMessages` stays as the defensive pass it is (`docs/agents/invariants/conversation-validity.md`);
  it is not a source of drift in the normal flow.

## 4. Behaviour

### 4.1 A plain send

Uses **the node's epoch**, always: prompt bytes, tool schemas, provider, endpoint, wire
model, effort and dialect all come from the frozen envelope, never from the live
configuration. Nothing is re-rendered, nothing is rewritten, nothing is hidden. A
branch that has not been touched since it was frozen keeps producing identical bytes
forever, so it keeps hitting whenever its cache entry is alive.

### 4.2 A setup change — the two entry points

The composer shows **two identities**: the *sending* identity (the node's epoch) and
the *live* one (what a new node would freeze). They differ in two ways:

| Entry point | Trigger | Send button | Modal |
| --- | --- | --- | --- |
| **user drift** | the user changed the card / effort / language dropdown | **greyed** | `[No]` (default) · `[Continue with current setup]` |
| **harness drift** | the prompt template, the AGENTS.md snapshot, the tool schema set or the provider changed | not greyed; an extra hint entry appears | `[No]` (default) · `[Continue with Latest setup]` |

- Both entries open the **same** modal component; only the label of the
  non-default action differs, because only one of the two is what the user just asked
  for.
- **Enter goes through the same path as the button.** `media/main.js:4256` (`send()`)
  is already the single entry for both (`:4692` for the click, `:4731-4736` for
  Enter), so the gate lives inside `send()` and no second path can exist.
- `Continue with current setup` sends with the frozen epoch and **rolls the dropdown
  back** to it. The change the user made is **discarded** — it is not written to the
  session seed and not remembered for the next session.
- `Continue with Latest setup` **forks** (§4.4) and sends on the new tree.
- The rule is "default send always uses the old setup": silence, Escape, or an
  accidental Enter never changes a prefix.

Drift is computed from **content hashes**, never from a version number: the rendered
template text, the tool schema JSON, the AGENTS.md snapshot, and the provider /
endpoint / wire model / effort / language / dialect of the live setup
(`templateHash` / `toolsetHash` above). An extension version bump that changes none of
those is **not** a drift.

### 4.3 Context state, and the 90% entry

`contextFull: boolean` becomes `context: 'ok' | 'near' | 'full'`, computed by the host
(never by the webview) and shipped in the `tree` payload, in every `nodeUpdate` patch
and in `config`:

- `full` — the last turn died on the provider's context-length refusal
  (`parseContextLengthError(lastFailureText(node))`, unchanged);
- `near` — the latest `usage.prompt_tokens` on the node's chain is **≥ 90%** of the
  card's `contextWindow`;
- `ok` — otherwise (including a node with no usage yet).

The card's button slot, for a conversational tip that is not running:

| state | button |
| --- | --- |
| `full` | `⧉` (hard trigger — unchanged) |
| `near` | the same `⧉`, as a **suggestion** (the title carries the percentage) |
| otherwise | `▶ Continue` / `↻ Retry` (unchanged) |

`context-rollover.md` §11 currently says "no threshold pre-emption"; it is amended to
"**no automatic pre-emption** — a user-initiated entry exists from 90%". The reason
the old rule can be relaxed: the entry no longer costs anything, because the new node
starts an empty prefix anyway, so a fresh epoch there is free (§6).

### 4.4 Continue with Latest setup → a fork

1. The **current tree** is copied — nodes get new ids, and `parentId` / `children` /
   `contextBaseId` / `rootIds` are remapped. Not the whole forest (§12).
2. Every copied node is **materialised** for the target setup: images are transpiled
   (§6), text is copied verbatim. Materialisation is **best effort** — an image it
   cannot translate becomes a placeholder block plus one harness note; a fork never
   fails because of an image.
3. The new tree's root freezes the live setup as its epoch and is appended to
   `rootIds`. The view moves to it.
4. The user's send lands on the new tree's tip, as a new node.
5. The old tree is untouched. Its cache entry survives, so switching back — or
   comparing the two — is a hit, not a re-bill.

Visuals: the two trees sit **side by side** (chosen deliberately over a tab strip or a
vertical stack); a fork is a *sibling* tree, which is a different thing from a context
rollover, which is a **child node** with a dashed edge and a `CTX` badge (§4.5).

### 4.5 Context rollover (the hard trigger)

Mechanically the existing `rolloverContext` (`src/chat/runtime.ts:2533+`), with three
changes:

1. It offers the **same two setups**: `Continue with current setup` (the new node
   inherits the parent's epoch) or `Continue with Latest setup` (the new node freezes
   the live setup). Both are **free**: a new context has no cached prefix to lose.
2. It no longer re-renders the prompt through `buildPath`; the chosen epoch is written
   onto the new node before the path is built.
3. Its union kill / settle / flush / re-dump logic is unchanged
   (`docs/agents/invariants/context-rollover.md` §7).

A **provider-rejected image** is the one repair that is still allowed to touch a
history, and it is written down instead of hidden:

- the offending block becomes its placeholder **in the stored message**, with a
  harness note on the card and the `imageSources` entry kept (so a later epoch can
  materialise it again);
- the retry then sends the same chain with the placeholder — the failed request's
  prefix covered up to that block, and the failed request itself cached nothing, so
  the one-time cost is zero;
- `Agent.markRejectedImages` (`src/agent/agent.ts:1226-1250`) keeps its job of
  finding *which* images to repair, but its repairs are now persistent rather than
  send-time.

### 4.6 Delayed injections

Everything that can arrive **after** the turn that triggered it must be injected under
the **target node's epoch**, never a fresh render: the hop receipt
(`src/chat/ChatViewProvider.ts:2754-2789` → `controlStartSession` → a new child node),
the union-kill / background / sub-agent writebacks, and `continueFrom`. A hop may
return hours later; without this rule, an AGENTS.md edit or an extension update in
between would silently rewrite the prefix.

Sub-agents are frozen the same way, at spawn: the sub-agent's chain gets its own epoch
(its identity line and its card differ from the parent's), and `send_agent_message`
resumes it under that epoch. A sub-agent never shares the main chain's prefix, so it
cannot affect the main chain's cache.

## 5. Storage, and who owns a session

- **Messages are persisted verbatim.** `clipMessageForStorage` leaves the storage
  path entirely; the display caps on `displayItems` (8 / 32 / 64 KiB) are a different
  thing and stay.
- **Change detection must be exact for messages.** `persistDigest`'s
  length + head/tail probe (`src/chat/persistDigest.ts:37-66`) is a documented,
  guarded compromise for display fields; `messages` gets a real hash instead, because
  a missed change means a node file that is silently older than memory — and after a
  reload, a different prefix with no diagnostic.
- **One owner window per workspace.** The store lock is not a fallback trigger, it is
  the invariant: exactly one window reads and writes a workspace's session data.
  - The owner: read + write, as today.
  - Any other window on the same workspace folder: **read-only**. It loads the store
    and can browse trees, cards and history; every mutating action — send, continue,
    rollover, fork, delete, rename, clear, new session, `hop_session`, and the control
    plane's `/session/start` — is refused with one clear notice, and the Send button is
    disabled with a title saying why.
  - The Memento **write** path is deleted. The row keeps one role: a one-time
    migration source (`migrateToStore`) and nothing else.
  - Stale-lock reclamation stays: a dead pid or an expired heartbeat releases the
    lock, so a crashed window never locks the workspace out.
  - The current code decides the lock **optimistically** (`storeWritable` is set to a
    promise's optimistic value, `src/chat/ChatViewProvider.ts:440`); it must instead
    wait for the answer before the first load and the first turn.

## 6. Image materialisation (the transpile matrix)

Materialisation is the **only** place an image block's wire form is decided — once per
epoch, never per request. The source is local provenance when we have it, otherwise a
fetch by `file_id` from the provider that issued it, otherwise nothing:

| from → to | what happens |
| --- | --- |
| `deepseek` → `deepseek` (same provider) | the `file_id` is reused as is |
| `deepseek` → `openai` | bytes are recovered → an `image_url` part with a `data:` URL |
| `openai` → `deepseek` | bytes are uploaded → a new `file_id` |
| anything → a non-vision card | a placeholder text part (provenance kept, so a later epoch can bring it back) |
| bytes unrecoverable | placeholder + one harness note; the fork still succeeds |

Provenance is captured where the bytes exist: composer attachments (their `dataUrl` is
already stored on the display item and is never clipped) and `read_image` uploads
(`src/agent/agent.ts:1060-1062` — today the source path dies with the turn).

Because the wire form is decided once, the two send-time failure classes disappear
with `messagesForCurrentModel`: "this card cannot read that dialect" and "this card
has no vision". What remains is "the provider refused this image", handled in §4.5.

## 7. Migration

An existing history has **no** stored prompt (the old code re-rendered it every
activation), so its exact old bytes are unrecoverable. On first load after this lands:

- every session's **active chain** gets its current rendering frozen into it, marked
  `legacy: true`, and written immediately. One miss is unavoidable at that moment;
  from then on the chain is stable.
- messages that a previous `clipMessageForStorage` truncated stay truncated — the
  bytes are gone. Such a chain is reported once on the output channel
  (`[cache] lossy-history …`) so a surprising miss has an explanation instead of a
  mystery.
- `rootId` becomes `rootIds: [rootId]`; no other tree is invented.

## 8. Phases

Each phase compiles, ships and carries its own guard extension. No phase leaves the
tree in a state where two mechanisms write the same bytes.

| Phase | Content | Main files |
| --- | --- | --- |
| **P1 — persistence fidelity** | verbatim messages, exact digest for `messages`, one load path (`pruneSession` on both branches) | `src/chat/runtime.ts`, `src/chat/ChatViewProvider.ts`, `src/chat/persistDigest.ts`, `src/chat/sessionStore.ts` |
| **P2 — one owner window** | the lock gates load and write; read-only second window; the Memento write path deleted | `src/chat/ChatViewProvider.ts`, `src/chat/sessionStore.ts` |
| **P3 — forest** | `rootIds`, multi-root layout, tree-scoped delete/checkout/`list_nodes` | `src/chat/tree.ts`, `src/chat/runtime.ts`, `media/main.js`, `media/style.css`, `src/chat/transcript.ts` |
| **P4 — epoch freeze** | `Epoch` type, `epochForNode`, freeze at node creation, delete every rewrite (§3) | `src/chat/tree.ts`, `src/chat/runtime.ts`, `src/agent/agent.ts`, `src/agent/models.ts` |
| **P5 — provenance** | `imageSources` capture at attach and at `read_image` upload | `src/chat/runtime.ts`, `src/agent/agent.ts` |
| **P6 — fork & materialisation** | copy the tree, transpile the images, freeze the new epoch, append the root | `src/chat/runtime.ts`, `src/chat/ChatViewProvider.ts` |
| **P7 — drift & the composer** | content-hash drift, Send gate, Enter path, the modal component, the dropdown rollback | `src/chat/runtime.ts`, `media/main.js`, `media/style.css` |
| **P8 — context state** | `ok` / `near` / `full`, the 90 % entry, rollover merged into the node-epoch with the two setups | `src/chat/runtime.ts`, `media/main.js` |
| **P9 — migration & legacy** | the retroactive freeze, the `lossy-history` report | `src/chat/tree.ts`, `src/chat/ChatViewProvider.ts` |
| **P10 — docs, i18n, manual** | the invariant pages, the two catalogs, every `manual/**` page | see §10 |

## 9. Guards and acceptance

- `tools/check-epoch.js` (replacing `tools/check-context-rollover.js`): pure functions
  — the prefix is cut at the base, an epoch is inherited downward, a send never
  re-renders, `pathIds` is unchanged, the drift hashes ignore a version bump that
  changes no content, and the transpile matrix picks the right target for every
  (source, card) pair.
- `tools/check-webview.js`: the Send gate and the Enter path, the two modals and their
  default action, the dropdown rollback, the `ok` / `near` / `full` button variants,
  the forest layout, the dashed edge and the `CTX` badge.
- `tools/session-store-acceptance.js`: a **byte-exact** round trip of `messages`
  through the store, and the exact digest firing on a mid-string rewrite.
- A new acceptance driver (`tools/epoch-acceptance.js`, dev-only, `vscode` stubbed):
  fork → materialise (including an unrecoverable image) → the new tree's first request
  is `[epoch2.prompt, …copied messages…]`, the old tree's bytes are unchanged, and a
  legacy load freezes exactly once.
- A live check: send on a node, reload the window, send again, and read
  `cache_hit` / `cache_miss` (`src/chat/runtime.ts:2953-2960`) — the hit must cover
  the whole pre-reload prefix. A new `[cache] prefix-drift first-diff=#N reason=…`
  line (output channel and perf log only) turns any future regression into a
  one-line diagnosis.
- Definition of done for any phase that touches `src/`, `media/` or `package.json`:
  `npm run compile` → `powershell -File build-deploy.ps1` → ask the user to run
  `Developer: Reload Window` (`AGENTS.md`, "Standard closing procedure").

## 10. Documentation, i18n, manual

- New: `docs/agents/invariants/session-epoch.md` (the data model, the two mechanisms,
  the materialisation matrix, the ownership rule).
- Rewritten: `invariants/system-prompt.md` ("the prompt is never stored" is replaced
  by "stored once per epoch"), `invariants/chat-tree.md` (forest, node-epoch),
  `invariants/context-rollover.md` (the two setups, the 90 % entry),
  `invariants/session-persistence.md` (verbatim storage, the exact digest, the store
  really being wired, the deleted fallback), `invariants/api-retries.md` (the
  cache-miss warnings go away), `invariants/model-cards.md` and
  `invariants/conversation-validity.md` (the per-node pick becomes the epoch),
  `invariants/vision-images.md` (materialisation instead of hiding),
  `multi-session.md` (ownership), `file-map.md`, `where-to-change.md`.
- `AGENTS.md`: the hard-invariant list is rewritten **when the phases land**, not now
  — it describes the shipped code.
- `manual/**`: one page per catalog language gains the composer's two identities, the
  two modals, the side-by-side trees, and what the dashed edge and the `CTX` badge
  mean.
- `l10n/bundle.l10n.zh-Hans.json` / `…zh-Hant.json`: the new strings (buttons, modal
  titles, bodies and actions, the ownership notice, the context-percentage title), and
  the deletion of the three "prompt cache may be missed" entries.
  `npm run check:l10n` and `npm run check:docs` are the gates.

## 11. Deliberately not done

- **No cache keep-alive.** A provider entry expires after idle time; pinging it would
  spend real money to hold a cache. The guarantee is about the prefix, not the entry.
- **No summarisation, ever.** Unchanged from `context-rollover.md` §11.
- **No automatic rollover or automatic fork.** Every epoch change is a click.
- **No re-derivation of a frozen epoch.** Not on load, not on a version bump, not for
  a tool that no longer exists: an old tree keeps running its old prompt and its old
  tool schemas (§4.2's harness drift is how a user moves on).
- **No cross-provider `file_id` reuse.** A Files-API id belongs to the account that
  issued it; §6 transpiles instead.
- **No Memento write path, and no degraded mode.** One owner, one read-only second
  window, no third state.

## 12. Open items

1. **A lying dialect declaration.** `vision.transport` is a declaration and is never
   probed; when a card declares `deepseek` but its endpoint expects the object form of
   a `file` part, every request carrying that block fails permanently — and the text
   (`"messages[484].content[1].file" must be an object`) does not match the one
   existing repair path (`/unsupported image/i`). Fixing the upload path is out of
   scope here. Optional, cheap safety net: let an epoch **remember the dialect that
   actually worked**, so a later materialisation into the same epoch shape does not
   repeat a failure.
2. **What `Spinney: Show System Prompt` shows** for a node under an epoch: the frozen
   bytes (the truthful answer for that node), with the live render available as a
   second, clearly-labelled section.

## 13. What landed (and what did not)

Implemented, each with a guard or an acceptance driver behind it:

- **P1 — persistence fidelity.** `messages` are persisted verbatim (the 64 KiB storage
  cap is gone; the display caps on `displayItems` stay) and `persistDigest` folds
  everything inside `messages` by a real hash instead of the length + head/tail probe.
- **P2 — one owner window.** Reading a workspace's sessions never needs the lock;
  *writing* does. A window that loses the race loads the store read-only, refuses every
  turn (`RuntimeHost.isReadOnly`, checked in `beginTurn`/`beginInjectedTurn` and in the
  provider's send path, session CRUD and the control plane) and says so once. The
  Memento keeps one role: a migration source.
- **P3 — forest.** `AgentSession.rootIds`, tree-scoped deletion/checkout, `rootIds` in
  the tree payload, and the webview lays the roots out side by side with the composer
  docked on the focused tree.
- **P4 — epoch freeze.** `Epoch` on the node that starts a chain, inherited downward
  (`epochForNode`, validated by shape at read time); `buildPath` sends the frozen
  prompt; the frozen tool schemas are advertised instead of the live ones; a setup change
  is drift (`setupState`) rather than a rewrite; `refreshSystemIdentity`,
  `applyReplyLanguage`'s push, `applyDefaultModel`'s rewrite and the three cache-miss
  warnings are gone.
- **P5/P6 — provenance, materialisation, fork.** Composer attachments and `read_image`
  uploads record `imageSources`; `forkTree` copies the whole tree under the live setup,
  re-materialises its images (inline bytes when they are reachable, placeholder when they
  are not, reuse for the same account) and freezes a fresh envelope on each
  epoch-starting node.
- **P7 — drift and the composer.** Send is marked (never disabled) when the user's pick
  differs, the modal offers `Continue with current setup` / `Continue with latest setup`
  with the conservative one as the default and dismissal sending nothing, Enter goes
  through the same `send()`, the composer holds its text until the host confirms
  (`composerClear`), and a second entry offers the same question when the *harness* side
  moved.
- **P8 — context state.** `context: 'ok' | 'near' | 'full'` + `contextPct` are computed
  in one host place; `⧉` is offered from 90 % on any conversational tip (including a
  finished one) and on a provider refusal; the rollover offers the two setups and its
  harness text says which reason applied.
- **P9 — migration.** `adoptLegacyEpoch` freezes the checked-out chain's setup onto its
  base node when a session's runtime is built, marked `legacy`.
- **P10 — docs, catalogues and the manual** are updated in the same change (the
  invariant pages, both `l10n` catalogues, `manual/**` in all three languages).

Not done, and deliberately left for a follow-up:

- A sub-agent's own chain still renders its prompt per run; the epoch half of §4.6 is
  main-chain only.
- The read-only window is enforced everywhere it can be (turn starts, injected turns,
  session CRUD, the control plane, and the composer's disabled Send with the sentence as
  its title) but the *tab strip* still lets the user open a session to read it, which is
  the point.
- `P8`'s `near` entry is a suggestion on any tip; there is no age/decay rule for it.
- The plan's separate `tools/check-epoch.js` was not created: the pure epoch assertions
  live in `tools/check-context-rollover.js` (inheritance, the nearest epoch winning, a
  malformed envelope being ignored) and the end-to-end contract in
  `tools/model-switch-acceptance.js` (frozen card vs. pick, the fork, the placeholder).
- One known deviation from §4.2's table: the two composer identity lines are shown for a
  **user** drift only. A harness-side drift shows the new-setup entry instead, because the
  two lines would read identically there (they carry card · level · language, and the
  harness drift is none of those).
