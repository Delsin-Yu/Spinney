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

Twenty build-time guards are the exception, all run by `vscode:prepublish` so a
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
- `npm run check:unicode` (`tools/check-unicode.js`) — text that stays **well-formed**, the
  one failure nothing local can see and the provider's reader rejects outright: `clipText` /
  `sliceText` must never return an unpaired UTF-16 surrogate for **any** cut position (a
  valid emoji pair straddling the boundary included) and never differ from a naive
  `s.slice(0, n) + '…'` except where that cut would have split a pair; `tailText`, the mirror
  cut at the **head** (a background terminal's output tail), has its own assertion group —
  a pair straddling that cut is dropped whole, so the kept text never begins on a low half;
  `wellFormed` turns a lone leading surrogate, a lone trailing one and a reversed pair into
  U+FFFD while a valid pair survives byte-for-byte; `wellFormedDeep` fixes a whole
  message-shaped tree (content parts and `tool_calls[].function.arguments`) without mutating
  its input; in that same group sits the regression that matters — `JSON.stringify` of a
  sanitised value carries **no** unpaired-surrogate escape, the exact shape serde_json
  rejects (`unexpected end of hex escape`) — an HTTP 400 that kills the whole request, the
  2026-09-24 incident, where one clipped `📎` in a `search_transcripts` hit turned every
  later request of that turn into a failure. Its **last** step is the source scan:
  `src/**/*.ts` for a reintroduced clip, in **four** shapes, each read with the ellipsis
  written either literally (`…`) or as the escape `\u2026` (both spellings are in the tree —
  `src/tools/webBackends.ts` writes the escape — and an escaped ellipsis splits a pair just
  as well): the two **head** shapes (`.slice(…) + '…'`, a `slice` interpolated into `…` —
  remedy `clipText` / `sliceText`) and the two **tail** shapes (`'…' + value.slice(-n)`,
  `` `…${value.slice(-n)}` ``, the same failure with the halves swapped, so the lone half is a
  **low** surrogate — remedy `tailText`). A hit fails the build with `file:line`, pointing at
  `src/text.ts`.
  Pure node against the compiled `out/text.js` — the helper, never the source — so like
  `check:signals` it needs `compile` first and runs after it in `vscode:prepublish`. What it
  can **not** see: a value that reaches the wire without one of these helpers; the clip is
  only half the contract, the `wellFormedDeep` call at the request boundary
  (`src/agent/apiClient.ts`) the other, and a missing call site leaves no `slice` behind for
  the source scan to find.
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
- `npm run check:cwd` (`tools/exec-cwd-acceptance.js`) — the **working directory and
  path base** (`docs/agents/tools.md`), and the first of the five acceptance drivers
  that make up the gate (with `check:shell` / `check:kill` / `check:timeout` /
  `check:budget` below, which drive the same compiled tools): the contract lives in the *compiled* tools, so
  it stubs `vscode` (a
  `Module._load` hook), drives `ToolRegistry.execute` against a real shell, and
  asserts that `resolvePath` maps the Git-Bash form `/d/Repos/x` onto `D:\Repos\x` on
  Windows while leaving it alone elsewhere (on POSIX `/d` is a directory, not a
  drive), that a command starts in the harness root and **names that directory in the
  first line** of its result, that a `cwd` it cannot use answers `does not exist` /
  `is not a directory` with the resolved path and the harness root instead of Node's
  `spawn <shell> ENOENT` — that message read as "the shell is missing" and is why the
  model took to prefixing every command with a defensive `cd <dir> && …` — and that
  `read_file` reaches the file the `/d/...` form means rather than `D:\d\…`. It also
  reads the `exec_command` schema, because the two rules stated there (use `cwd`,
  never background the command inside the shell) are the only copy a sub-agent ever
  sees. Portable by construction: every drive path is derived from the checkout and
  the Windows-only half is skipped elsewhere, so the linux CI runs the same gate.
- `npm run check:shell` (`tools/shell-argv-acceptance.js`) — the argv a **native**
  child actually receives under the shell we spawn. It exists because of one incident:
  the model ran `taskkill /PID 67188 /T /F` through `exec_command` (Git Bash on
  Windows), MSYS had rewritten `/PID` into `C:/Program Files/Git/PID`, taskkill
  answered `invalid argument/option`, and three stuck Godot processes were never
  killed. None of that is visible in the tool's own source — only the argv a native
  program sees shows it — so the script drives the *compiled* shell selection
  (`out/tools/shell.js`) the way `spawnShellCommand` does (`shell.file` +
  `shell.buildArgs(cmd)` + `env: shell.env`) and makes the child print its own argv as
  JSON. It asserts that no probe argument carries a Git/MSYS installation prefix, that
  `/PID` arrives verbatim (the exact regression), and that `MSYS_NO_PATHCONV` is `'1'`
  on Windows and absent off it (the switch means nothing to a POSIX bash, so it must
  not leak there); it also *prints* what `//F` and `//IM` arrive as, which is a
  measurement rather than an assertion, because those two spellings are the MSYS
  double-slash escape and their fate depends on a rule we do not own. Needs `out/`
  (`npm run compile` first), and the Windows half is skipped on POSIX, so the linux CI
  runs the same gate. Part of `vscode:prepublish`.
- `npm run check:kill` (`tools/exec-kill-acceptance.js`) — the **kill-confirmation
  contract**. A kill used to be fire-and-forget: the old shape returned as soon as the
  signal had been *sent* (or `taskkill` had run, which only says taskkill ran), so Stop,
  the terminal card and the tool result all claimed a clean ending while the process
  tree could still be alive — the user's "commands do not end properly". It stubs
  `vscode` and drives the compiled `out/tools/background.js` for real, pinning four
  facts that were previously unobservable: `handle.kill()` resolves `'exited'` for a
  long-running command **and does so comfortably before the child would have ended on
  its own** (an 8 s command killed in well under 2 s — the outcome is a measurement,
  not a restatement of the intent), a second kill on the same handle is safe, an
  already-finished command resolves `'exited'` too (the "already gone" path that keeps
  a Stop from hanging on the OS), and every observed outcome is a member of
  `{'exited','no-exit','no-pid'}` (the type is the contract, so a kill that answers
  anything else, or never answers, fails here — every await is bounded, because a kill
  that never answers is a failure and not a hang). It also holds
  `BackgroundRegistry.kill` to its **synchronous** transition (the task reads as
  finished immediately, so Stop and the card stay instant) with the confirmation fired
  detached: an unconfirmed kill sets `killUnconfirmed` and writes one
  `bg kill id=… pid=… outcome=… ms=…` diagnostics line, a confirmed one stays quiet.
  Needs `out/` and is portable — the POSIX and Windows halves exercise the same public
  API. Part of `vscode:prepublish`.
- `npm run check:timeout` (`tools/exec-timeout-acceptance.js`, **52 checks**) — the
  **foreground limit** `spinney.commandMaxForegroundDuration` (300 s) and the
  `exec_command` budget model it rules: `timeout` is the command's **total** budget —
  foreground plus background — with **no ceiling**, the limit caps only the
  **foreground slice** (`min(timeout, limit)`), and the default `timeout_behavior` is
  `stop_when_timeout` again. It pins, in order: (1) a fast command stays a plain foreground call
  (`[exit 0 in …]`, nothing registered anywhere); (2) a `timeout` at or below the
  limit, with no behavior or an explicit `"stop_when_timeout"`, is killed at that timeout even
  where a background terminal was available (the budget is spent, so promoting it
  would be "kill it immediately" in disguise); (3) **rule R2** — a `timeout` *above*
  the limit with no behavior, or with `"stop_when_timeout"`, is **refused before the spawn** by
  `timeoutTooLongError`, with the message naming both numbers and saying
  `Nothing was started.`, and with neither a process nor a background job created
  (a returned value would be a silent clamp); (4) `timeout` above the limit **with**
  `"background_when_timeout"` is promoted at the **limit**, not at `timeout`, and the job
  carries only the **remaining** budget `timeout − limit` — the message names both
  numbers, `hub.register` happens exactly once under the **owner of the turn** (a job
  registered under the wrong owner renders in the wrong branch and its notice reaches
  nobody), and a `timeout` that fits inside the limit is *not* promoted at all;
  (5) a **node-scoped** value with `timeout` omitted — `background_when_timeout` (case 7)
  and `start_in_background` (case 8b) alike — is **refused before the spawn** by the one
  refusal (`needsTimeoutError(behavior)`) that names the value that was asked for, the
  missing `timeout`, the reason (`locks this node`) and both ways out (pass a `timeout`,
  or use `start_detached`), and it returns at once with nothing registered
  (`hub.register` is never called — the shape that used to be promoted into a node job
  with **no deadline** is closed here);
  (6) there is **no ceiling** — `timeout: 99999` with `start_in_background` is
  accepted and the whole 99999 s travels to the background as that job's budget;
  (7) a session without background access — a bare `ToolRegistry`, exactly what
  `exec-cwd-acceptance.js` constructs — still kills at the timeout, reports
  `timed out`, registers nothing and never throws `Background terminals are not
  available`; and (8) the tool description keeps the two rules a sub-agent reads
  there (never background the command yourself, use `cwd` instead of a
  `cd <dir> && …` prefix), gains the limit sentence and the rule that **both**
  node-scoped values need a `timeout` while `start_detached` is the only value that may
  omit one, and no longer contains the
  deleted `spinney.commandTimeout` / `spinney.commandTimeoutMax` at all. The settings
  stub answers **keyed by name** (`commandMaxForegroundDuration` → 1), because the
  limit is only observable when the key can be wrong: a stub that answers every key
  with the same value would hide a leftover `commandTimeout` read, and 1 s keeps the
  whole matrix at a few seconds instead of five minutes. Needs `out/` (`npm run
  compile` first) and is portable by construction: the "slow" command is
  `process.execPath -e …`, so it needs no `sleep`, no shell builtin and no PATH
  lookup. Part of `vscode:prepublish`.
- `npm run check:budget` (`tools/bg-budget-acceptance.js`, **51 checks**) — the
  **background budget** contract, the half of "a turn may not be held forever" the
  foreground could not fix: once a job left the foreground it ran until the end of
  time, and `join_background` would block a turn for as long as it took. It stubs
  `vscode` and the settings **keyed by name**
  (`commandMaxForegroundDuration` → 1) and drives the compiled
  `out/tools/background.js` plus the real `join_background` tool over a fake hub. It
  pins: a job registered with a 500 ms budget is **killed at roughly its deadline**
  (not left to run its 8 s command), its `killReason` is `'timeout'`, it reads as
  `'finished'`, `onFinish` fires exactly once and `remainingBudgetMs(task)` is **0**
  afterwards; a job registered with **no** budget is left alone a second later with
  `remainingBudgetMs` **`null`** (no deadline, not "0 left"), and an outside kill is
  attributed to a non-`'timeout'` reason; `remainingBudgetMs` on a live budgeted job
  is positive and **counts down**; and `join_background`'s gate — a live job with
  more budget left than a turn may wait is **refused** (the result says
  `has <…> of its <…> budget left` and `this join was refused`, tells the agent to
  `End your turn`, names `kill_background(<id>)`, is an instruction rather than an
  `Error:` line, and comes back at once instead of waiting on the job it refused), a
  live job with **no deadline** is refused too (`has no deadline` — otherwise an
  unbudgeted job could hold a turn for hours, which is the whole bug; this guard
  registers such a job directly, since `exec_command` now only produces one for
  `start_detached`, whose refusal the detached check answers first), a live job
  with 800 ms left is **allowed** and the join resolves when the budget ends it, and
  an already-finished job keeps today's wording. Every await is bounded: a case that
  never settles fails the run instead of hanging it. Needs `out/` and is portable by
  construction (the "slow" command is `process.execPath -e …`). Part of
  `vscode:prepublish`.

All four of those need `out/` (`npm run compile` first), for the same reason
`check:signals` does — they drive compiled tools — and they are wired into
`vscode:prepublish` immediately **after `check:cwd`**, whose subject they continue
(`check:cwd` is the working directory and path base, `check:shell` the argv the shell
hands on, `check:kill` the end of a command, `check:timeout` what happens when it does
not end, `check:budget` what happens once the work has left the turn).
- `npm run check:remote` (`tools/check-remote.js`) — the remote-control mirror
  transport's pure core, and with it the **cross-language crypto contract**. That
  feature exists three times (the TypeScript host here, the C# relay under
  `remote/server/`, and the Kotlin app under `remote/android/`), and only the first
  lives in this repository, so what can rot silently is a **derivation** that drifts:
  three implementations of PBKDF2/HKDF/AES-GCM that all look right and disagree by one
  byte in a salt, an AAD or a nonce layout. It drives the compiled `out/remote/*.js`
  and pins: the derivation is deterministic and its room id is exactly **26 base32
  characters** (it is a URL path segment and the routing credential); a seal/open round
  trip returns the identical plaintext; a tampered AAD is rejected as *tampering*
  rather than as a generic failure (the three-way error taxonomy — too large /
  tampered / replayed — is the contract, and collapsing it hides a broken peer behind a
  disabled one); the replay window's edges (a duplicate sequence, one at the floor, one
  below it); an oversized frame is refused **before** it is sealed; slicing a large
  sealed frame and reassembling it gives back the byte-identical buffer, with an
  out-of-order slice and an over-cap reassembly both refused; and the two mirror tables
  are **deny-by-default** — an unknown type is refused, and the types that must never
  cross (`perfDiag`, `layoutDiagnostic`, `openExternal`, `pickImage`, `copyNodeId`,
  `setNodeSize`) are refused by name, which is also what keeps a replica from tripping
  the owner's own painting-recovery ladder. It then validates
  `remote/vectors/vectors.json` — the committed vectors the Android app will read from
  M3 on — against that same code, which is what turns "the two implementations agree"
  into a checked fact instead of a hope. The relay is deliberately not a consumer: it
  never parses a frame, so it never sees a key. Needs `out/`
  (`npm run compile` first). Pointing a comparison in the vectors section at a
  trivially-true value is how to prove it still bites.
- `npm run check:remote-surfaces` (`tools/remote-surfaces-acceptance.js`) — the
  remote-control **surfaces** of M2, which the pure guard above cannot reach because they
  are behaviour rather than tables. It stubs `vscode` and replaces
  `RelayTransport.prototype` with a recorder, so the *real* `RemoteService` runs its own
  reconciliation, key derivation, frame routing, de-dupe cache and blocklist with no
  window and no socket, and pins what cannot fail loudly: the room tree's
  `room → device → instance → session` hierarchy and the items it draws (a phase, a
  device name, a workspace folder and model, a session title and state); the
  **`cmd`/`result` pair**, including that a repeated frame id is answered from the shared
  idempotency cache and therefore creates **no second session** (the failure this exists
  for is a duplicated session on somebody else's machine); the four refusals
  (`unknown-session` / `readonly` / `busy` / `unsupported`) answered as `error{code}`
  carrying the request's own id; **`kick`** as a local blocklist keyed by
  `deviceId`+`instanceId` — mirroring stops, the peer's `input`/`cmd` frames are dropped
  *unanswered*, a `bye` goes out, the peer stays listed so **Unblock** is reachable, and
  nothing about it revokes anything; the replica surface's
  `attach`/`mirror`/`input`/`cmd`/`detach` across a reconnect; and the frozen 1:1 routing
  table of `src/remote/replicaRouting.ts` (the never-forwarded types stay local, the
  control allow-list is forwarded, the two sets do not overlap, anything unclassified is
  refused). Needs `out/` (`npm run compile` first).
- `npm run check:relay` (`tools/relay-acceptance.js`, **103 checks**) — the
  remote-control **transport**, which is the one layer where a mistake is silent: a
  dropped frame, a reused nonce, or a blocked extension-host thread all look like
  nothing at all. It stands up a **real relay** on an ephemeral loopback port
  (`node:http`, no dependency) and drives the **compiled** `out/remote/relayClient.js`
  with the real `rooms.ts` / `frames.ts` on both ends, pinning: a clean join and the
  documented status shape; the app-level `ping` arriving within a heartbeat while the
  room is quiet; an outbound frame decoded by the stub with the same key, one slice for
  a small frame and a dozen for a large one; a frame that needs several slices
  reassembled byte for byte, including **two frames interleaved by `fid`**; the wire
  line's seven keys in order with `s` in position 3 and genuinely the nonce's last four
  bytes; one salt per connection read from the envelope, and a frame that does **not**
  open under a neighbouring salt; a slice whose `s` disagrees with its frame refused as
  a *framing* error (never mixed in, and never misreported as tampering); a replay, a
  tampered byte and a malformed line each refused and counted **without taking the
  connection down**; a `429` retried rather than dropped; **pacing** (ninety frames
  spread over the time the rate requires, nothing dropped); **backpressure** (a stalled
  peer fills the queue, `send` still returns in milliseconds, the drops are counted, the
  event loop stays responsive); a **reconnect** after the stream ends — `backoff` with a
  `retryAt`, then a new peer id **and a fresh connection salt**, with nothing replayed
  and a frame dropped while offline never sent later; the silent-stream watchdog firing
  in 2 × heartbeat rather than waiting out undici's five minutes; a non-2xx join reported
  as a status and never thrown into the caller; and `stop()` releasing every timer and
  socket, with `start()` after it joining again. Needs `out/` (`npm run compile` first).
- `npm run check:remote-assets` (`tools/check-remote-assets.js`, **7 assets**) — the
  **Android renderer copies**. The phone renders the same `media/main.js` the desktop
  does, so a drifted copy means the phone runs a second, older renderer and nobody finds
  out until something is drawn wrong on a device. It pins: every generated asset under
  `remote/android/app/src/main/assets/**` byte-identical to its `media/**` or `l10n/**`
  source (sha256, and the failure names both hashes, both byte lengths and the fix
  command); **no unmanaged file** in those folders at all — a hand-added asset is exactly
  the second renderer this exists to prevent; and the shell's DOM pairing the host
  template **both ways** (30 element ids and 7 class attributes, plus every id the
  shipped `main.js` and `tree.js` look up). It also has to survive the release gate's own
  ordering: `vscode:prepublish` runs `sync:l10n` *before* this guard, so the four
  generated reported-tag aliases are on disk when it runs. The rule is a **content** rule
  and not a list of names — a catalog with no manifest row is fine iff its bytes are a
  byte-for-byte copy of a catalog that *has* one (which is exactly what a generated alias
  is, and `sync-l10n-aliases.js` refuses to delete an edited one), anything else is a new
  authored language and fails until it has a row. Needs no `out/`.
- `npm run check:websearch` (`tools/websearch-acceptance.js`) — the keyless
  web-search backends, replayed from the committed response bodies under
  `tools/fixtures/web-backends/`, so a backend that changes its markup or its
  captcha wall fails packaging instead of quietly returning nothing to the user.
  See `docs/agents/web-search.md`.
- `npm run check:png` (`tools/check-png.js`) — the PNG codec (`src/agent/pngCodec.ts`):
  a decode → encode **round trip**, colour types 0 / 2 / 3 / 4 / 6, filters 0–4, and
  adaptive re-filtering on encode (RGBA in, RGBA out). Needs `out/` (`npm run compile`
  first), like the three beside it.
- `npm run check:resample` (`tools/check-resample.js`) — `cropResample`
  (`src/agent/imageResample.ts`): an **area-average** downscale (nearest-neighbour
  thinning is the bug this pins — it invents aliasing the model then reports as image
  content), **no** upscale (a crop already inside the target comes back as it is), the
  crop `rect` itself, and the `scale` it reports. Needs `out/` (`npm run compile` first).
- `npm run check:image` (`tools/check-image.js`, and `check:png` + `check:resample` +
  `check:jpeg` run with it — `check:image` is the aggregate `npm run` entry, `check:jpeg`
  the JPEG half alone) — the transform itself (`src/agent/imageTransform.ts`):
  bytes-in / bytes-out, `changed: false` for an unsupported variant (GIF, WebP, an
  interlaced or 16-bit PNG, a damaged file), `rect` clamping through `normalizeRect`,
  `readImageSize` — and the **PIL-oracle rule**: its fixtures are produced by an
  **independent** tool (Python PIL) and the guard compares **pixels** against that tool's
  committed expectation, it does not merely round-trip, because a pure-JS encoder and
  decoder pair can share a bug and certify itself — exactly what
  `docs/agents/plans/image-budget.md` §6 says this must not do. It needs `out/`
  (`npm run compile` first), because it drives the compiled modules, and `check:image` is
  the one wired into `vscode:prepublish` by the integration slice.
- `npm run check:jpeg` (`tools/check-jpeg.js`) — the JPEG decoder (`src/agent/jpegDecode.ts`,
  with `jpegEntropy.ts` / `jpegReconstruct.ts` behind its seam) against the **same PIL
  oracle** (baseline sequential only): the expected pixels are committed beside each
  fixture, so PIL is not needed at guard time. Needs `out/` (`npm run compile` first).

`tools/exec-cwd-acceptance.js` and the four scripts listed after it above
(`shell-argv-acceptance.js` / `exec-kill-acceptance.js` / `exec-timeout-acceptance.js` /
`bg-budget-acceptance.js`) are the five windowless acceptance runs that *are* guards.
The rest — `tools/rollover-acceptance.js` first — need neither a window nor a provider and are
dev-only, **not** in `vscode:prepublish`. The guards that only
reach pure modules cannot see the risky half of a context rollover, which lives in
`SessionRuntime`: it stubs the `vscode` module (a `Module._load`
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

`tools/remote-interop.mjs` (`npm run check:interop`) is the **cross-implementation
acceptance** for remote control, and it is the only thing in this repository that has
ever made two independent implementations talk to each other. Dev-only, deliberately
**not** a build guard: it needs `out/` compiled, the C# relay built with `dotnet`, and a
JVM — three toolchains a packaging run must not require. It starts the **real relay**
(the JIT dll under `remote/server`), the **real Kotlin peer** (built as a jar by
`:core:interopJar`, run through `java -cp`), and the **real compiled TypeScript
transport**, then asserts what nothing else can: both peers join one room; a frame from
either side arrives at the other **byte for byte** (sha256 equal on both sides), including
one large enough to need four slices; each side opens the other's frame with the salt it
read **from the envelope**, while the `fid`-derived salt the transport used to imply
provably *cannot* open it (this is the proof that the hidden-salt convention, which two
implementations had each invented differently, would have broken the room); a replay is
refused on both sides; and a frame re-stamped with a neighbouring salt fails its tag. It
kills every child it starts (`taskkill /F /T` on Windows, a second reap pass) and never
calls `process.exit(0)`, so a leaked process would keep the run alive — that is the check
that nothing was left behind. Two things it taught, both worth remembering: Node refuses
to `spawn` a `.bat`/`.cmd` without `shell: true`, and the two implementations diagnose a
bad-salt frame differently (Kotlin verifies the tag first and says `TAMPERED`; the
TypeScript transport consults the replay window first and says `replay`) — with a *fresh*
sequence both report `auth`, which is the only version of that assertion that proves
anything.

What `check:webview` can **not** tell you: anything visual (no CSS, no layout, no
theme) and anything about the provider's TypeScript side. Maintenance: adding a
provider message type means adding it to `TURN_MESSAGES` in the script (missing
one does not fail — it just is not covered), and a webview that starts using a DOM
API the stub lacks needs that API added to the stub. An explicit script path
(`node tools/check-webview.js <file>`) runs it against a mutated copy — that is
how to prove the guard still catches what it is for.

**Open issue — a panel that stops painting, on evidence that is still missing.** The guard
exists because a reference to a deleted identifier inside a webview callback is *that* kind
of failure: a **silent** one — the handler throws, nothing reports it, and the UI keeps
whatever it had (that is how the Thinking-effort dropdown once stuck on "none"). A
customer's screenshot shows the same silence at the level of a whole tab: a panel whose
conversation stopped updating while its turn ran on. The reading this section used to carry
— that the customer log *proves* a panel "painted once and then never repainted" — does
**not** hold, and for three reasons that live in our own code rather than in that file:

- `post-tree` / `post-path` are written by `opPayload` only while an op is open
  (`src/perf.ts`), and no op is open around a streaming turn; the log holds 14 of them in
  21642 lines, all inside op blocks, so their absence after a switch proves nothing about
  whether the host posted (it posts deltas there, not trees).
- A routed message for a node with no card is dropped **without a word** (`routeTo`,
  `if (!itemsEl) return;`, `media/main.js`), so "the deltas arrived while nothing was
  painted" cannot be told apart from "the deltas were thrown away" on either side.
- The hours-long `webview-frames worst=` / `stream-flush window=` values in that file are
  **suspend / hidden artifacts**, not freezes: the host's own lag watch beside them reports
  `lag blocked 342ms`, and the frame watch has to name the whole gap because it evaluates
  the hidden check when its callback finally runs, i.e. after the page is visible again.

The open question itself stands — a tab **can** stop painting, and that screenshot is what
keeps it real — but it now waits on evidence a log of that shape cannot carry, which is
exactly what the frame sampler, the probe and the one-nudge ladder in
`invariants/streaming-perf.md` were added for; a re-report is read against those lines, and
the ` | at=` stamp on each one is what puts the two sides on one clock.

The guard takes those probes up with it: `check:webview.js` now asserts that they
**answer** — the probe reply to a request, the frame that follows it, the nudge frame, and
a drop for a message routed to a node that does not exist — so a silently dead probe fails
packaging instead of shipping, exactly as a dead paint report already does. See the same
issue, and the ladder, in `invariants/streaming-perf.md`.

## Windowed checks (the bounded wait, and what no guard can see)

`tools/remote-acceptance.mjs` (`npm run check:remote-e2e`) is the third kind of run:
**windowed acceptance**, dev-only, never in the gate. It launches one throwaway VS Code
window on a profile of its own (`--user-data-dir` / `--extensions-dir` inside
`.spinney/`, the developer's profile never touched, the extension under test linked in as
the repo), attaches it to a room of the **real relay** with the `SPINNEY_REMOTE*` bypass
variables, and joins the same room from Node on the real compiled transport. It is the
only run in this repository that proves the feature works in a live window, and everything
it asserts is read back from the window's **own control plane** rather than from a mirror
frame the run itself wrote: the window announces itself (`hello` naming the device, the
instance, the workspace and `deviceId = sha256(machineId + roomId)`), `instances` carries
its real sessions with their real titles and node counts, `attach` yields a `mirror` frame
holding that session's own `tree`, an `input` really starts a turn, a replayed frame id
really does **not** start a second one (`result{ok:true,duplicated:true}` and an unchanged
node count), `cmd{session/start}` creates a session in the window and `cmd{stop}` stops a
turn, no mirrored payload carries a perf trace at any depth — with the positive control
that the local post is longer by exactly the stripped `traceId` — and teardown leaves no
window and no relay behind, checked by filtering the process list. 44 checks, and it takes
about 19 s.

Its licence to exist is the defect it found on its first three runs: `RelayTransport` kept
**one** replay window per receiving connection and applied it to frames from **every**
sender, while §4 specifies one window per connection *salt* and each sender starts its own
`seq` at 1 — so in a room of three or more members the later senders' frames were dropped
as replays and never arrived. (Fixed: `relayClient.ts` now keys the window by the sender
salt the envelope names, LRU-bounded, and opens a frame **before** advancing its window —
the salt is public, so advancing first let a keyless relay burn a real sender's window.
Case 7c of `check:relay` pins all of it, including that a genuine same-sender replay is
still refused.) Every two-peer test in the repo was green, including a
103-check transport driver and a cross-implementation run; only a third member could see
it. That is the argument for this file: a room is not two peers, and a stub is not a
window.

The windowless runs above cannot see a **bounded wait** — and one of those waits has no
windowless coverage at all: `spawn_agents` / `send_agent_message` in `sync` mode
escape at `spinney.commandMaxForegroundDuration` through a `Promise.race` in
`SessionRuntime`, and the batch is then delivered by the *async* notice path
(`deliverBatchWhenSettled` / `deliverResumeAsync`) — a live window is the only place
that path exists. How to verify it, with the diagnostics log on:

1. Set a small limit (`spinney.commandMaxForegroundDuration` a few seconds, say 10)
   and drive `POST /session/start {title, prompt}` through the control plane with a
   prompt that spawns **one slow sub-agent** in `sync` mode (an `instruction` whose
   work outlives the limit — a slow build, or an `exec_command` with a long
   `timeout`).
2. Read that tool's result. It must be the **escape** shape, not the summaries:
   `escaped: true`, `waitedMs` equal to the limit, `ids` (the spawned node) and
   `done` / `running` split at the escape, and the `note` that says the batch is still
   running. A result that carries summaries means the wait was not bounded; a hang
   means the race never happened. (`send_agent_message`'s resume is the same contract
   with `id` instead of `ids`.)
3. Then wait for the batch. The summary must arrive **later, as one batch notice** —
   the notice, not the tool result, is the only delivery on that path (the
   "delivered exactly once" invariant), so a notice that never lands is a lost
   summary. Each finished sub-agent must still carry its `stats` and `transcript`, and
   its sidecar card must settle in the UI.

What only the window can add: no guard drives a node worker, a webview, or the
control plane, so this one is repeated by hand when the bounded-wait code changes.

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
