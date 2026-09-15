# Testing convention

There is no unit-test suite: behaviour is verified against a **live** window. Two layers
exist — the manual F5 flow below, and `tools/harness-test.mjs`, a control-plane acceptance
harness (dev tooling, never shipped) that drives the running extension over HTTP and asserts
host behaviour: `node tools/harness-test.mjs <suite...|all>` (suites `health`, `sessions`,
`concurrency`, `navigation`, `background`, `signals`, `branch`, `selftest`; see
`multi-session.md` §5.1). Manual F5 checks still cover what the harness cannot see — the F5
flow exercises read/write/exec against a scratch file (`_e2e.txt` is a leftover scratch
fixture, safe to ignore or delete). Before a release, confirm `npm run compile` is clean and
`build-deploy.ps1` succeeds.

Five build-time guards are the exception, all run by `vscode:prepublish` so a
regression fails *packaging* instead of the user's session:

- `npm run check:models` (`tools/check-models.js`) — model ids: the settings enum
  must equal the catalog, `src/**` and `media/*.js` may not name an id, and
  README/docs may only name catalog ids. See `invariants/model-capabilities.md`.
- `npm run check:webview` (`tools/check-webview.js`) — the chat webview script:
  `media/main.js` is neither compiled nor linted, so it loads the script into an
  in-memory DOM (no browser, no VS Code), dispatches one message per type
  `ChatViewProvider.post()` sends, and asserts that no handler throws *and* that
  the UI follows (effort dropdown, model list, image affordances, context
  readout). It exists because a stale identifier inside a message handler throws
  silently in the real webview — the UI just keeps its previous values, which is
  how the Thinking-effort dropdown once stuck on "none" after the chat-side model
  panel was deleted while the `config` handler still called into it. Its last step
  is **deferred** (a timer) and checks that the webview's perf probes still report:
  a traced repaint (`reset` carrying `traceId`) must come back as a `perfDiag`
  `paint` report, which is the only way to see a silently dead probe without a live
  host — see `invariants/streaming-perf.md`.
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

`tools/rollover-acceptance.js` is the one acceptance run that needs neither a window
nor a provider — dev-only, **not** in `vscode:prepublish`. The guards above can only
reach the pure modules, while the risky half of a context rollover lives in
`SessionRuntime`: it stubs the `vscode` module (a `Module._load` hook) plus an offline
client and drives `rolloverContext()` for real. What it pins: the new window's first
request is `[system, harness]` with no ancestor message in it, the old node's
background terminal is killed while another node's job is left alone, the kill notice
lands in that node's history *and* in its re-dumped transcript, the carried-over
request/answer plus the clip note and attachment count are in the message, the window
is numbered per branch, and a node that is not context-full falls back to the in-place
continue. `node tools/rollover-acceptance.js` after `npm run compile`; it reads a few
private fields, so a refactor may break the script while the product stays fine.

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
2. Edit `.vscode/settings.json` the way a user does in the Settings UI — point
   `spinney.baseUrl` at the mock — and set a marker key with **`Spinney: Set API
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
