## Chat Tree invariants
- Session titles are derived, never authoritative: `AgentSession.title` is shown in
  the sidebar / tab title only, and the automatic namer (`sessionTitles.ts`) may
  rewrite it after a turn. `titleLocked` (set by a manual rename or the
  `rename_session` tool) freezes it, and a rename must never touch `updatedAt`
  (the sidebar sorts by it). Renaming does not change history, branching or the
  prompt in any way.
- `TreeNode.messages` (non-empty) always starts with a `user` role message; no node
  ever stores a `system` message. The system prompt is **not** synthesized per
  activation any more: it is rendered once when a chain starts
  (`SessionRuntime.freezeEpoch`) and kept on the node that starts the epoch
  (`node.epoch.prompt`), outside `messages` — see `system-prompt.md`.
- **A session is a forest** (`AgentSession.rootIds: string[]`, replacing the old
  `rootId`): every tree root in creation order. A fork **appends** a root instead of
  rewriting the first (`forkTree`), so the tree the user leaves behind keeps the
  bytes — and the provider cache entry — it was built with, and the webview lays the
  roots out side by side. `attachNode` registers a new root when the node has no
  parent (and, for a node whose parent is gone, keeps it reachable under the first
  root); `computeRootIds()` re-derives the list as "every node nobody claims as a
  child, oldest first" and `pruneSession` re-picks it whenever the stored list no
  longer describes the tree, so a hand-edited or half-written `rootIds` heals.
- **A node can start an epoch.** `node.epoch` (`Epoch`) is only set on a node that
  starts a chain — a session's first turn, a rollover node, a fork's copied
  epoch-owning nodes, and a legacy chain adopted at load — and only there. It does
  **not** imply a `contextBaseId`: a rollover node carries both (it cuts the prefix),
  while a session's first turn or a fork's new root carries the epoch alone and
  inherits its base from the root. A request
  finds its prompt and its tool schemas through `epochForNode(session, nodeId)`
  (nearest ancestor-or-self wins, so a fork's new root overrides everything above
  it) and the node that owns the envelope is `epochNodeId(...)`. Nothing re-renders
  it, ever; a chain without one renders live
  (`SessionRuntime.systemPromptFor`).
- A branch's flat API history, precisely:
  `SessionRuntime.buildPath` = `sanitizeMessages([epoch.prompt, ...pathMessages(session, nodeId)])`,
  where `pathMessages` is `[messages from the node's **context base** down to the
  node]` — **not** `[...path nodes' messages]`, and that cut is the whole semantic
  delta. The base is `contextBase()`
  (`tree.ts`): the nearest ancestor-or-self whose `contextBaseId` equals its own id.
  `buildPath` is the only thing that computes a prefix: it prepends
  `epochForNode(...).prompt` (the live render `systemPromptFor` only for a chain with
  no envelope) and sanitizes the result.
  `pathIds`, the display path and the transcript meta's `pathIds` are deliberately **not**
  cut — the tree stays connected and the view keeps expanding the whole line — so the two
  must diverge: the display path is a reading aid (which cards to expand, what a card
  describes), the API prefix is what the provider will actually accept. See
  `context-rollover.md`. `buildPath` runs when a run starts on that node
  (`beginTurn` / `beginInjectedTurn`) and hands the array to `agent.setMessages`. `session.activeNodeId`
  is only the **view focus** (which branch the tab shows, where the composer docks): it names the
  path the *next* user turn branches from, not the node a live run is writing to. The history must
  go through `Agent.sanitizeMessages` (the sanitized copy is **never** written back into the nodes
  — `pathMessages` returns the nodes' own message objects by reference, so `sanitizeMessages` must
  not mutate them: the reasoning→content healing builds a `{ ...msg }` copy). `prefixLen` is
  measured on the sanitized path.
- A turn's message slice is written **once**, in `finishTurn`, and the basis is recorded where the
  history is swapped: `beginTurn` (a fresh node, based on the parent's path — `opts.parentId`
  overrides it for an injected notice) and `beginInjectedTurn` (a sub-agent / background-notice
  turn, based on the node it continues) each call `worker.agent.setMessages(buildPath(...))` and
  record `run.prefixLen` / `run.prefixTail` from the result in the same block, so the basis and the
  array cannot drift apart. `prefixLen` is always an index into **`agent.getMessages()`** (which
  includes the leading system message — the frozen epoch prompt, or a live render for a chain with
  no envelope). `checkoutNode` no longer swaps any history at all — it only
  moves the **view** (each node has its own worker; see the one-agent-per-node bullet) — but a
  node's worker can still be re-based by a *later* run, so an untouched numeric basis would slice
  from the wrong offset and store ancestor history inside the turn's node. That is how one session
  reached `1,283,056` tokens — a single node had inherited ~1,100 duplicated messages, so the next
  request sent the whole conversation twice while the header still read `ctx 65%` (the *previous*
  turn's `usage.prompt_tokens`). `finishTurn` therefore verifies the basis by **identity**
  (`prefixLen > 0 && messages[prefixLen - 1] === prefixTail`) and, when the history was swapped
  mid-turn, writes nothing and logs `[slice]` instead. A queued notice whose node is **not** in the
  session is dropped, so a batch finishing after a session switch never injects a turn into another
  session's agent. Using a node's own `messages.length` as the basis re-includes ancestor history in
  that node.
- **One agent per node** (`SessionRuntime.workerFor`): every node that has ever run a turn owns a
  worker — its own `Agent` (history = `buildPath(session, nodeId)`, and its sub-agent / hop /
  rename / event hooks all close over that node) plus its own `ToolRegistry` (whose
  `BackgroundAccess.currentOwner()` is that node). A run is `runs.set(nodeId, run)`
  (`runs: Map<nodeId, TurnRun>`), so a new turn is refused when **that node** already has a
  live run — `beginTurn` checks `runs.has(parentId)`, `beginInjectedTurn` checks `runs.has(node.id)`
  — which is one half of the composer's Stop-not-Send rule in the UI. Two further
  refusals: `SessionRuntime.onUserMessage` also refuses while the **basis node still owns
  unfinished work** (`lockedWorkCount(basis) > 0` — a running background terminal, a
  running sub-agent batch, or a completion notice already queued for that node; the same set
  `lockedNodes()` exposes in `state`, which is why the composer shows Stop for such a node, and
  pressing Stop is the union kill `stopNode` that takes that node's turn, its background
  terminals and its whole sub-agent subtree), and **every** turn start is additionally gated by two
  window-level checks: `host.isHeld()` (`beginTurn` / `beginInjectedTurn` return `null` while an
  external controller
  holds the window for a reload; the callers re-queue) and `host.isReadOnly()` (`null` while
  another window owns this workspace's session data, so a send, a fork, a rollover, ▶ Continue
  and every injected notice turn are refused alike — `session-persistence.md`). Two *different*
  nodes of one session may
  stream at once. `isRunning()` = `busy || runs.size > 0`; `runningNodes()` = `runs.keys()`.
- Who owns the node: `beginTurn` creates a fresh node, so its run **assigns**
  (`node.messages = added`, `run.fresh = true`). `beginInjectedTurn` continues a node that already
  holds the turn that spawned it, so its run **appends** (`node.messages = [...node.messages,
  ...added]`, `run.fresh = false`) — assigning there would replace the spawning turn's messages
  with the notice's.
- Branching: every user message creates a new node under the checked-out node;
  sending on a node that already has children makes a sibling (a new branch).
  A branch switch costs only a prefix cache miss — the shared prefix stays cached.
- **Editing a prompt is branching from its parent.** The pencil on a card's pinned ask
  (`editUserMessage`) rewrites nothing: it takes the edited node's own first `kind:'user'`
  display item's attachments (so editing the words keeps the images) and sends the edited
  text through the ordinary user-message path with an **explicit** basis —
  `onUserMessage(…, { basisNodeId: node.parentId })` — which creates a new turn under that
  parent and leaves the edited node exactly where it was, an ordinary sibling branch
  holding the old wording. For a **root** node the basis is the explicit `null`, and
  `onUserMessage` honours it (a `'basisNodeId' in opts` presence test, never a truthiness
  read), so the replacement starts a **second forest root** instead of silently branching
  off the current checkout. The old node's `messages`, `displayItems` and prompt stay
  untouched — a rewrite would change the history the provider's prefix cache and the
  model's answer were built from — and the new node is focused by the ordinary `beginTurn`
  / `attachNode` path, with no focus code of its own. A sidecar, an unknown node and an empty
  text are each refused with one sentence. **A node whose turn is running is not refused**,
  and neither is one that still owns unfinished work: the edit is a branch under the edited
  node's parent, so the streaming node's `messages`, `displayItems` and prompt are touched by
  nothing, and `beginTurn` refuses only a second run on the **basis** node — two branches of
  one session may run at once. The pencil is therefore offered on every turn card that has a
  prompt (a sidecar has none), whatever its status. It sits **inside the ask's message bubble**
  (`div.msg.user.prompt`) and floats over that bubble's top-right corner, revealed by the
  bubble's hover: the ask reserves no gutter for it, so the message keeps the pin strip's full
  width and the chip overlaps the tail of the first line instead.
- `attachNode` repairs a missing parent by attaching the node to the **root**
  instead of leaving it unreachable (an orphan would still become the checkout
  point and silently blank the history); `leafOf` skips both sidecar kinds via
  `isSidecar` (`kind:'agent'` sub-agents and `kind:'bg'` background cards), so a
  restored checkout point can never land on a sidecar.
- Interrupt bookkeeping is **per node** (`interruptedNodes: Map<nodeId, Agent>`): an interrupted
  run records its worker (`interruptedNodes.set(run.nodeId, run.agent)`), whose `Agent` already
  captured the aborted tool call via `Agent.markInterrupted`. When a new run starts on
  a child, `beginTurn` looks up the parent (`interruptedNodes.get(parentId)`) and either transfers
  the pending notice with `Agent.transferInterruptTo(source)` (which hands it to the new worker and
  resets the source) or, if the parent is not the interrupted one, clears the new worker's stale
  notice with `Agent.resetInterruptState()`. Keyed by node, so two branches of one session cannot
  clobber each other's notice — this replaced the session-wide `lastInterruptedNodeId`.
- **Deleting a branch** (`branchIds` / `detachBranch` in `tree.ts`) removes a node
  *and its whole subtree* — sub-agent sidecars included — from `session.nodes`,
  unlinks it from the parent's `children`, and moves `activeNodeId` to the parent
  when the checkout was inside the removed subtree (to `null` when the root went,
  which leaves a valid empty session: `rootIds` empty, `activeNodeId` null,
  `orphanItems` kept). It is pure data — `ChatViewProvider.deleteBranch` owns the rest: the matching
  transcript dumps (see transcripts.md), and `SessionRuntime.afterBranchDetach(ids)`
  drops the removed nodes' workers + pending interruption notices + queued child
  notices, kills the background jobs they owned (`hub.removeNode(..., { kill: true })`),
  re-checks out the survivor and repaints (`tree` / `path`). It is always gated by a modal confirmation
  (`deleteBranchInteractive`) and refuses while a turn, an image upload or a sub-agent *inside the
  branch* is running (a live turn must never lose its node). The scope is the branch and never the
  session: another branch of the same session may stream meanwhile, so an idle branch stays
  deletable while its sibling runs (`branchDeletionBlocked`). `session.updatedAt`
  is bumped, so the sidebar reorders — a deletion is a content change, unlike a
  rename.
- `node.customSize` (optional `{w,h}`) persists a user-resized card; it survives
  migration via `normalizeTreeSession` and is sent in the `tree` message as `size`.
- `node.contextBaseId` (optional) is the other persisted per-node field: a **window-starting**
  node carries it and it is only ever the node's own id, set by `beginTurn(…, { freshContext:
  true })` right after the node is created and **before** `buildPath()`, or the run's basis
  would still be the full chain. It is validated at read time (`contextBase()`), so a
  foreign or unreachable value is simply ignored — a stale one has no effect and needs no
  migration or repair pass. It never moves a card; it only decides which ancestors'
  messages are sent. See `context-rollover.md`. The marker is **not** the epoch
  flag: only a node whose prefix must really be **cut** carries it (`freshContext`,
  i.e. a rollover, and a fork copies it onto the copied rollover nodes). A
  session's first turn and a fork's new root freeze an epoch and carry **no**
  marker at all — the base is then the root, exactly as if the field were absent.
- `node.epoch` / `node.imageSources` are the other two persisted per-node fields,
  both written once and never rewritten: the frozen request envelope
  (see the epoch bullet above and `system-prompt.md`) and the image provenance
  addressed by `{ messageIndex, partIndex }` (see `vision-images.md`). Both survive
  a load through `normalizeEpoch` / `normalizeImageSources` — a malformed value is
  dropped, not repaired.
- **Stream routing (the load-bearing rule):** every streaming message carries an explicit `nodeId`
  — `delta` / `thinkingDelta` / `usage` / `toolCallDelta` / `toolStart` / `toolEnd` / `done` /
  `interrupted` / `error` — and the webview routes each one to *that* node's card. It must
  **never** infer the stream target from the view. `tree.viewId` = `session.activeNodeId` (the view
  focus); `tree.activeId` = `activeStreamNodeId()` (the view run's node, else any live run, else
  `null`) and is only a routing hint. The webview expands/docks on `viewId ?? activeId`. A
  streaming node that is not on the view path still has a card in the DOM (every node gets one) and
  its deltas land in that card while it is collapsed.
- Chat render: the webview lays out the **view path** expanded and all other nodes collapsed;
  `path` describes the **view** (`pathIds(session, session.activeNodeId)`) while `tree` carries
  structure. Checkout re-sends `path` + `panTo` (no `reset`/`tree`) so the tree never tears down,
  and already-rendered nodes are skipped (`_itemsRendered`) to avoid re-running markdown.
- Migrating v1 `{messages, displayItems}` splits at each `user` message; items are
  re-attached by walking both lists (best effort) and the original state is backed
  up to `spinney.state.v1backup`.

- **The checked-out card's ring shows its prompt-cache hit rate.** The only coloured surface
  a card has is the 2 px `outline` of `.node.active`, and its colour comes from the
  `--cache-color` custom property `syncCacheColor` writes (`media/main.js`); the rule in
  `media/style.css` is `outline-color: var(--cache-color, var(--accent))`, so a card with no
  rate keeps the theme accent. The number is **the card's own requests combined**:
  `nodeCacheRate(node)` (`tree.ts`) sums `prompt_cache_hit_tokens` and
  `prompt_cache_miss_tokens` over every `usage` the turn attached — a tool loop makes several
  requests and all of them are that card's — and divides hit by `hit + miss`. It divides by
  those two, never by `prompt_tokens`: the total includes tokens the provider was never given
  a choice about. `nodeCacheRate` returns `undefined` when **no** request reported the two
  fields (another endpoint's `prompt_tokens_details.cached_tokens` is a key this build does
  not read, a turn that never completed has no usage, a `kind:'bg'` card has none at all),
  and that `undefined` is shipped as `cachePct: null`, never as 0: a real 0 % (a request that
  reported `hit = 0` beside a full miss) is a known number and reads red, while an unknown
  rate must not be drawn as a bad one. The host computes it at payload build time
  (`treeMessage` and `nodeStatePatch`) and stores nothing, so there is no percentage that
  could go stale, and the rate travels with the same patch that ends the turn. The webview
  maps it to a colour in `cacheColor`: `t = clamp(pct / 100, 0, 1)`, a red → purple → blue
  two-stop ramp (`#fc4d5f` at 0 %, `#f14dfc` at 50 %, `#4daafc` at 100 %), because a direct
  red → blue lerp passes through grey in the middle and a grey ring says nothing. Only `.node.active` reads the property, so switching the checkout moves the ring
  to the new card's own rate; a focused sub-agent card shows its own too. **The same number sits
  in the card's docked usage bar**: `.node-usage` (which also carries `.usage-line`'s type) is
  pinned between the log and the composer, so the token line never scrolls away with the log
  and one place per card holds it instead of one per open fold. It shows the card's **totals**,
  not its last request: `tree` and every `nodeUpdate` ship `usage: nodeUsageTotal(node)` (every
  `usage` item summed, the cache fields only from the items that reported them), the live
  `usage` message carries those running totals **and** the rate after that request
  (`cachePct`, `appendUsage` → `setCardUsage`), so the bar moves with the turn instead of only
  when it ends — and that live rate also repaints the card's colour (`paintCacheColor`, the one
  property the ring and the segment both read), so both are the right colour while the turn
  runs. **A running card that has not been counted yet still shows the bar**, every number `~`
  (`showUsagePlaceholder`), because "nothing yet" must not look like "nothing to show": the dock
  is there from the first thinking row and the first usage replaces the placeholders. The bar
  itself is `Prompt: {0} / Completion: {1}, Cache Hit: {2} / Miss: {3}` — no brackets, the card's
  totals — followed by a `.usage-rate` segment `Cache Hit Rate: {0}%` when the card has a rate,
  coloured with the card's `--cache-color`, so the number and the outline tell one story. A card
  whose provider reports no cache fields keeps the counts and no segment at all. A collapsed
  card is its head and its preview, so the bar is hidden there.
