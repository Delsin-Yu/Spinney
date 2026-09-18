# Testing convention

There is no unit-test suite: behaviour is verified against a **live** window. Two layers
exist — the manual F5 flow below, and `tools/harness-test.mjs`, a control-plane acceptance
harness (dev tooling, never shipped) that drives the running extension over HTTP and asserts
host behaviour: `node tools/harness-test.mjs <suite...|all>` (suites `health`, `sessions`,
`concurrency`, `navigation`, `background`, `signals`, `branch`, `selftest`; see
`multi-session.md` §5.1). Manual F5 checks still cover what the harness cannot see — the F5
flow exercises read/write/exec against a scratch file (keep it in `.spinney/`, which is
gitignored, so a leftover is harmless). Before a release, confirm `npm run compile` is clean and
`build-deploy.ps1` succeeds. CI (`.github/workflows/ci.yml`) runs the release gate itself —
`npm run vscode:prepublish` — on a push to `main`, on a `v*` tag, on a pull request and on
demand, so a red workflow and a red gate are the same thing instead of two lists that drift.

Eight build-time guards are the exception, all run by `vscode:prepublish` so a
regression fails *packaging* instead of the user's session:

- `npm run check:models` (`tools/check-models.js`) — the model configuration:
  `spinney.model.default` must be the fallback card, `spinney.providers` and
  `spinney.modelCards` must exist as object schemas, `spinney.model` must **not**
  carry an `enum` (the cards are the list), `src/**` and `media/**/*.js` may not name
  a model id, and README/docs may only name catalog ids. See
  `invariants/model-cards.md`.
- `npm run check:webview` (`tools/check-webview.js`) — the chat webview script:
  `media/main.js` is neither compiled nor linted, so it loads the script into an
  in-memory DOM (no browser, no VS Code), dispatches a sample per message shape in
  `TURN_MESSAGES` — a **superset** of the types `ChatViewProvider.post()` sends
  (it still replays the retired `background` shape alongside the live
  `backgrounds`) — and asserts that no handler throws *and* that the UI follows
  (effort dropdown, model list, image affordances, context readout). It exists
  because a stale identifier inside a message handler throws
  silently in the real webview — the UI just keeps its previous values, which is
  how the Thinking-effort dropdown once stuck on "none" after the chat-side model
  panel was deleted while the `config` handler still called into it. Its last step
  is **deferred** (a timer) and checks that the webview's perf probes still report:
  a traced repaint (`reset` carrying `traceId`) must come back as a `perfDiag`
  `paint` report, which is the only way to see a silently dead probe without a live
  host — see `invariants/streaming-perf.md`.
- `npm run check:modeltree` (`tools/check-modeltree.js`) — the Model Card Tree page:
  `media/modeltree.js` is neither compiled nor linted, so this loads it into an
  in-memory DOM (plus the vendored layout engine the HTML shell loads before it) and
  replays the frozen page protocol — the one `ready` at boot, the ids the script
  fetches checked against the ones the shell declares, a `modelTree` snapshot drawn as
  one card per provider/card with the engine's coordinates and one connector per model
  card, **the connector layer's viewport** (`#mt-canvas` and the `<svg>` carrying the
  same positive size, one `<path>` per card that has a provider, each one starting on
  its provider's bottom edge and ending on its card's top edge), **the selected card
  being the form** (every field, the read-only id and the request preview inside that
  card, none of them in an unselected one), a keystroke that flips Save on without
  moving or rebuilding anything while the posted payload carries the edit, an effort
  level that re-measures the card taller and back (the two-pass layout), a failed save
  that keeps the dirty draft and shows the host's reason, a full add-card → save round
  trip (a locally generated v4 UUID, trimmed fields, neither `hasKey` nor `isBuiltin`),
  an invalid draft blocked client-side, a card moved to another provider re-parenting
  (its connector follows it), **the gestures** (`zoomAt` keeping the point under the
  cursor fixed and stopping at the 0.4 / 1.5 bounds, a drag that pans without
  selecting, one automatic fit on the first snapshot and never again, the RMB
  autoscroll starting and stopping), and a fresh snapshot rebuilding the tree. It
  answers one question — "does the page still understand the host, and is anything it
  draws actually drawn?" — with no browser and no VS Code. `node tools/check-modeltree.js`
  runs it directly; an explicit path checks the checker itself. The protocol it pins
  lives in `src/chat/ModelPanel.ts`: if the host really changed, update
  `media/modeltree.js` and this checker together.
- `npm run check:signals` (`tools/check-signal-persist.js`) — the completion-signal
  persistence contract (the completion-signal plan, §0.1 / D1): a
  `kind:'bg'` background-terminal card must survive a restart with its `delivered`
  flag and terminal snapshot (`bgTaskId` / `bgExitCode` / `bgElapsedMs` /
  `bgOutputTail`), a card that was mid-flight when the host went away must stop
  claiming to run, and both sidecar kinds (`agent` / `bg`) must stay out of the API
  path (`pathMessages`) and the checkout chain (`leafOf`). It round-trips a fixture
  through `migrateState` — the exact load path `loadSessions` uses — so it needs
  `out/` and therefore runs after `compile` in `vscode:prepublish`.
- `npm run check:l10n` (`tools/check-l10n.js`) — the UI catalogs: it extracts every
  translatable key from the code (`vscode.l10n.t('<literal>'` in `src/**`,
  `tr('<literal>'` in `media/*.js`, `%key%` in `package.json`) and fails when a
  shipped catalog is missing one (the window would silently stay English), keeps a
  stale one (a reworded string), or disagrees on `{0}` placeholders; it also checks
  that `package.nls.<locale>.json` mirrors `package.nls.json` and that every
  `%key%` resolves. It depends on the extractor's shape, which is why a
  translatable message has to be a single literal — see
  `invariants/i18n.md`.
- `npm run check:rollover` (`tools/check-context-rollover.js`) — the context-rollover
  contract (`invariants/context-rollover.md`): a window break cuts the **API** prefix and
  nothing else, so the sent history must start at the branch's context base
  (`contextBaseId` equal to the node's own id) while `pathIds` — the cards, the
  transcript meta — keeps the full chain, a descendant inherits the base, a marker naming
  a foreign or missing node must be a *provable* no-op (the self-equality read-time
  validation, which is why there is no repair pass), each window's own turn sends only
  its harness message, and `parseContextLengthError` must read the provider's 400 (the
  real sentence's two numbers, casing and whitespace tolerated, plus reworded fallbacks)
  while an ordinary failure never becomes a trigger. Both rules are invisible until a
  real window fills up — a wrong cut silently sends the entire dead history, or nothing
  at all — so they are pinned here. Like `check:signals` it is pure node against `out/`,
  and therefore also runs after `compile` in `vscode:prepublish`.
- `npm run check:grid` (`tools/check-tree-grid.js`) — the Chat Tree's sidecar lattice
  (`media/tree.js` plus the vendored tidy-tree engine into node with `vm`, no DOM and no
  VS Code): over ~18 topologies (flat 1..9, nesting two and three levels deep, a card
  taller than its own sub-grid, mixed `agent` / `bg`, plus the real session
  `mu2zn79jlv7b23` as a golden case) it asserts the per-column sums — each column its
  own stack, ending flush at the block's bottom line, the shorter column's free space
  spread evenly with the integer remainder to the topmost cells — the `stretch` map
  (covering every sidecar card, never a turn node, ≥ the card's measured height and
  filling its slot, the one documented exception aside), no overlapping card rectangles
  inside the parent's reserved block (≤ `agentMaxRows` cells per column,
  `col = floor(i / R)`), card-free `busX` / `chanX` / `corrY` corridors (measured from
  the card's *rendered* bottom), and a strict one-pass fixpoint for every reachable
  shape. It also pins `media/main.js`'s `relayout()` order — clear the previously
  applied stretch **before** measuring the cards, apply `result.stretch` after — the one
  way this layout could creep every frame. Drift in any of the four `media/tree.js`
  invariants just named — the per-column stacks, the even fill, the `stretch` map, the
  corridors — fails packaging here instead of shipping.
- `npm run check:docs` (`tools/check-docs.js`) — the **shipped user manual**
  (`manual/**`, one page per catalog language, English first) against the manifest: a
  language that ships a catalog but no page (the set comes from
  `l10n/bundle.l10n.<tag>.json`, minus the reported-tag aliases `sync:l10n` writes, and
  the tag pair is read from `out/languageTags.js`, so this one runs after `compile`),
  a heading level sequence that diverged across the translated pages, a command title
  or a `spinney.*` setting key missing from a page (the titles are the localized
  `package.nls*.json` values, which is what the palette shows), and a `.vscodeignore`
  pattern that would keep a page out of the `.vsix` — the ignore file is evaluated the
  way `vsce` reads it (last match wins, `!` re-includes, a slash-free pattern matches
  the base name). `node tools/check-docs.js <dir>` points it at another manual folder,
  which is how to prove it still catches what it is for. See
  `docs/agents/user-manual.md`.

`tools/rollover-acceptance.js` is the first of the four acceptance runs that need
neither a window nor a provider — dev-only, **not** in `vscode:prepublish`. The
guards above can only reach the pure modules, while the risky half of a context
rollover lives in `SessionRuntime`: it stubs the `vscode` module (a `Module._load`
hook) plus an offline client and drives `rolloverContext()` for real. What it pins:
the new window's first request is `[system, harness]` with no ancestor message in
it, the old node's background terminal is killed while another node's job is left
alone, the kill notice lands in that node's history *and* in its re-dumped
transcript, the harness message carries the user's last request and the last answer
verbatim **and** names and counts the killed background terminal, the window is
numbered per branch, and a node that is not context-full falls back to the in-place
continue. `node tools/rollover-acceptance.js` after `npm run compile`; it reads a few
private fields, so a refactor may break the script while the product stays fine.

`tools/modeltree-acceptance.js` is the second of the four, the same shape for the
Model Card Tree page's host half — dev-only, **not** in `vscode:prepublish`, no
window and no provider. It stubs the `vscode` module and drives
`ModelTreeController` for real: a `ready` produces exactly one snapshot, an
**invalid** save writes nothing at all and answers with the
reasons, a valid save writes the two settings at Global scope, stores or clears the
per-provider keys and calls back once, and the SecretStorage naming rule holds
(`spinney.apiKey` for the built-in provider, `spinney.apiKey.<id>` for the rest).
`node tools/modeltree-acceptance.js` after `npm run compile`; it reads a few private
fields, so a refactor may break the script while the product stays fine. It is the
complement of `check:modeltree` — that one is the page, this one is the host.

`tools/model-switch-acceptance.js` is the third windowless acceptance run, for the
**per-node model selection**. It stubs `vscode`, runs a real `SessionRuntime` against a
catalog of three cards (two dialects on two providers) and an offline client that records
every request, then asserts what would go on the wire: a follow-up from a node runs on
**that node's** card and the new node records it; a node with no card inherits the nearest
ancestor's; a dropdown pick is pending until its send, is consumed by it, and is forgotten
on a checkout; picking the card the node already uses emits **no** "Model changed" notice;
another branch is never retargeted by a pick made elsewhere; a level is clamped by the
node's own card; and a history's DeepSeek upload block is hidden behind a placeholder when
the request runs on a non-`deepseek` card while passing through untouched on a `deepseek`
one. `node tools/model-switch-acceptance.js` after `npm run compile`.

`tools/gate-acceptance.js` is the fourth windowless acceptance run, for the request
gate (`src/agent/requestGate.ts`) that `ClientRegistry` puts in front of every
provider and every card. Waiting code is the kind that looks right and deadlocks in
practice, so it drives the gate directly — FIFO order, `0 = unlimited`, an abort while
queued (Stop must end a request that is only *waiting* for a slot), an abort that
arrives before the slot is taken, a cap lowered below what is already in flight, and a
raised cap waking the queue — and then through `ClientRegistry.stream`: two streams
against a one-slot card never overlap, the card's **wire name** (not its id) is what
goes on the wire, a stream that is broken out of early still gives its slot back, and a
session-title completion answers while the only slot is busy. It also refuses to pass
quietly: a run that ends while an `await` is pending (i.e. a deadlock) exits non-zero.
`node tools/gate-acceptance.js` after `npm run compile`.

What `check:webview` can **not** tell you: anything visual (no CSS, no layout, no
theme) and anything about the provider's TypeScript side. Maintenance: adding a
provider message type means adding it to `TURN_MESSAGES` in the script (missing
one does not fail — it just is not covered), and a webview that starts using a DOM
API the stub lacks needs that API added to the stub. An explicit script path
(`node tools/check-webview.js <file>`) runs it against a mutated copy — that is
how to prove the guard still catches what it is for.

## Live settings check (recipe, not a tracked script)

Settings must reach the **running** extension host without a window reload (see
`invariants/config-keys.md`), and the F5 flow cannot show that — a reload hides
exactly the bug class. The method that does, with no real API key and no tokens:

1. Run a throwaway fake DeepSeek endpoint: node `http`, `127.0.0.1`, ephemeral
   port, logging every request's path + `Authorization` header. Answer
   `/user/balance` with valid JSON, and `/chat/completions` with a minimal SSE
   stream (`data: {…}` … `data: [DONE]`) for `stream: true` / plain JSON for
   `stream: false`.
2. Edit `.vscode/settings.json` the way a user does in the Settings UI — point a
   provider's `baseUrl` (`spinney.providers`) at the mock and declare its wallet
   dialect (`"balance": "deepseek"`: a row that leaves the field out is declared by
   host, and a loopback host is `none`, so the wallet request below would never be
   sent), with a `spinney.modelCards` card on it and `spinney.model` set to that
   card's id — and set a marker key with **`Spinney: Set API
   Key`** (the key lives in SecretStorage now, not in `settings.json`) —
   then assert what the running host sent: `GET /user/balance` with the new base
   URL (A), again after a second base-URL edit (B), and a real
   `POST /chat/completions` carrying the newest key, `stream: true` and the tool
   schemas (C).
3. Checks A/B need nothing but the edit; C needs a real request — drive it through
   the control plane: `POST /session/start {title, prompt}` creates and starts a
   fresh session **immediately**, even while this session is mid-turn (P1), so C no
   longer needs an idle host or a detached run; `POST /session/start {sessionId}`
   (no prompt) hands the UI back afterwards.

`tools/search-files-acceptance.js` is the **fifth** windowless acceptance run, for the
`search_files` tool (`src/tools/searchFiles.ts`). That tool used to walk the whole tree
in-process, on the extension host's only JS thread — 397 calls / 782.7 s in one customer
log, a hitless search costing as much as a hit-heavy one, and the host blocked for up to
10.3 s — and now runs in a **ripgrep child process** with the original walk kept as the
fallback for a machine where no `rg` can be found. Two execution paths that must keep
**one** contract is exactly the kind of thing that drifts silently, so the script stubs
`vscode` (a `Module._load` hook) and drives the compiled tool for real: `file:line: text`
with workspace-relative slash paths, `-` context separators, a single-file `path`, the
exact `maxResults` cut plus its `…[search stopped early: …]` note, `search.exclude` /
`files.exclude` pruning (a directory pattern, a directory glob and a file glob), no hit
inside a font-like binary in either path, `(no matches)` for a hitless search, the fresh
`search-files … via=rg|walk scope=` perf line, and the three `Error:` strings unchanged.
Its last section re-runs the whole script in a child process with `env.appRoot` absent
and `PATH` stripped — the "no ripgrep here" case — and asserts the walk produces the same
behaviour. `npx tsc -p ./ && node tools/search-files-acceptance.js` (an explicit out dir
checks the checker itself); it needs `out/`, so it runs after `compile` like
`check:signals`, but it is **not** in `vscode:prepublish`.

`tools/transcript-queue-acceptance.js` is the **sixth** windowless acceptance run, for the
transcript write queue (`src/chat/transcript.ts`). A dump used to be `mkdirSync` +
`writeFileSync` on the extension host's only JS thread — 700 KB–1 MB per turn, and a storm
of 15 sub-agents finishes dozens at once. The write is queued now, and a queue introduces
an ordering question synchronous code could not have: **a deletion has to win over a write
that is still pending**, or "the files are gone" is undone a moment later
(`invariants/session-persistence.md`). It drives the compiled module directly and pins:
the synchronous `{ file, lines, bytes }` answer while the bytes are still queued, the
untouched JSONL layout (meta on line 1, then one message per line, 0-based `index`),
`hasPendingTranscriptWrite()` counting a queued dump as present, `flushTranscripts()`
draining the queue, a later body for one path replacing the earlier pending one, a
deletion cancelling a queued dump (and reporting it as removed) and tombstoning an
in-flight one so the whole session folder is gone once the queue drains, a new write
clearing the tombstone, and a sub-agent dump taking the same path. Removing the
`cancelPendingWrites` call fails four of its checks — that is how to prove it still bites.
`npx tsc -p ./ && node tools/transcript-queue-acceptance.js` (an explicit out dir checks
the checker itself); it needs `out/`, so it runs after `compile`, but it is **not** in
`vscode:prepublish`.

`tools/session-store-acceptance.js` is the **seventh** windowless acceptance run, for the
file-backed session store (`src/chat/sessionStore.ts` + `src/chat/fileWriteQueue.ts`). The
store moves session content out of the single Memento row — the row is re-serialized in full
on every write, and it is keyed by the extension id, which is how a rename once made every
conversation undiscoverable. The module is deliberately **vscode-free** (the caller passes
the global-storage path and the workspace identity), so this script needs no stub and drives
it for real over a throwaway root under `.spinney/`. It pins the four properties that are
invisible until the day they matter: an id-independent root (`defaultDataRoot` never
contains the publisher identity; `workspaceKeyFor` is stable per uri and independent across
workspaces) · a write that cannot destroy the previous one (the synchronous answer, the
self-describing envelope, the `.bak` generation, a `.tmp`-only file ignored) · a loss that is
survivable (a missing `index.json` rebuilt from the files, one corrupt session skipped while
the rest load, a mismatched id refused) · a deletion that is recoverable and ordered (moved
to `.trash`, nothing unlinked, and it beats a write still in the queue) · one live lock per
workspace (refused while the holder is alive, taken over when the heartbeat is stale or the
pid is gone, a release by a former owner ignored) · and rename survival itself
(`adoptFrom` imports another root's sessions, discovery picks the newest root, the source is
untouched). Replacing the trash move with an unlink fails it.
`npx tsc -p ./ && node tools/session-store-acceptance.js` (an explicit out dir checks the
checker itself); it needs `out/`, so it runs after `compile`, but it is **not** in
`vscode:prepublish`.

`tools/sim/` is the **simulation harness** (dev-only, never shipped, never in CI): it
reproduces a customer's storm — a session whose main agent runs whole-tree searches and then
fans out 15 read-only sub-agents, each searching the same tree — with **no tokens**, and
prints a PASS/FAIL table against the agreed thresholds. It is the instrument every
performance fix in this repository is judged by, so its analyser is itself tested
(`--selftest` feeds it the customer's own lines and asserts each one FAILs with the right
value, a clean log passes, and an absent measurement is a WARN rather than a silent PASS).

- `node tools/sim/run.mjs --selftest` — fixture + mock + plan + analyser, offline.
- `node tools/sim/run.mjs` — the full run. It **launches its own throwaway window** with a
  private `--user-data-dir` and a private `--extensions-dir`, a fixed control-plane port and
  token, and the four `SPINNEY_HTTP*` bypass variables plus `SPINNEY_PERF_LOG` (the dev-only
  perf tee, because the output channel has no read-back API). The developer's window is never
  touched. Two traps it works around, both found the hard way: the extension declares only
  `onWebviewPanel:*`, so a companion `sim-activator` extension focuses the Spinney container to
  make it activate; and a fresh profile opening an untrusted folder runs in Restricted Mode,
  where an extension that does not declare `capabilities.untrustedWorkspaces` is not enabled
  at all.
- `node tools/sim/run.mjs --rename-test` — the rename-survival path alone (an empty store
  root adopting its sessions back from a sibling root another extension id left behind). It
  cannot be run in the developer's own window without taking that very conversation off screen
  if the adoption failed, so it runs in the throwaway one and is repeatable.
- `node tools/sim/run.mjs --analyse <log>` — re-analyse an existing perf log.

**Two readings for one metric.** `persist-queued` is what the host *pays* (a payload build —
3 ms since the store replaced the single Memento row); `persist-done` is the write *queue*'s
completion latency, so it is reported twice: the **median** against the agreed 300 ms (a rise
there means every write got slow — a regression) and the **storm tail** against 500 ms (one
long tail while fifteen sub-agents are writing is information: the queue was behind, not the
host blocked). The measured band is ~15–25 ms idle and 90–314 ms mid-storm.

`tools/diagnostics-log-acceptance.js` is the **eighth** windowless acceptance run, for the
diagnostics log (`src/chat/diagnosticsLog.ts`). Every build keeps one file per window in the
session data folder now, so "it cannot grow without end" and "it holds no conversation" are
promises the product makes — and both would fail silently (a folder filling over months; a line
of user text nobody noticed). It drives the compiled module and pins: the folder is created on
demand, the self-describing header names the build and how to turn the log off, rotation at the
limit keeps **one** `.prev` generation (and replaces an older one), a file below the limit is
left alone, **exactly** five windows survive (the number is restated in the guard on purpose —
reading it from the module under test once let a `KEEP = 50` mutation through), the newest file
is what the command finds (an empty or missing folder reports nothing), and two source-level
rules: a session title is written to the output channel rather than through the perf sink, and
the API-key line interpolates `set`/`missing` rather than the key. Nonsense bounds are the point
of a guard here: seeding `KEEP + 3` windows and asserting the survivors is how the retention
rule is visible. `npx tsc -p ./ && node tools/diagnostics-log-acceptance.js` (an explicit out dir
checks the checker itself); it needs `out/`, so it runs after `compile`, but it is **not** in
`vscode:prepublish`.

Rules learned the hard way: back up `.vscode/settings.json` byte-for-byte and
restore it in a `finally` (a failed run must never leave a mock base URL behind — the
file is `.gitignore`d, being per-developer state, so at least a botched run cannot be
committed);
space two edits more than a second apart (VS Code debounces external writes, and
a coalesced event looks like a missing feature); pass an explicit `timeout` on
the command that edits the file, or you end up measuring the tool's own default
instead of the setting under test. A build that reads the config once at
activation (and never re-reads or pushes it) fails A/B/C — that is what a regression
here looks like.

The implementation used while fixing this was deliberately thrown away
(`.spinney/live-config-test/`, gitignored scratch). If it is wanted as a tracked
tool it belongs in `tools/` — see `scratch-space.md`.
