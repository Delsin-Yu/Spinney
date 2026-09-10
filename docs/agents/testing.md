# Testing convention

There is no automated test suite. Verification is manual: run in the Extension
Development Host (F5) and exercise read/write/exec against a scratch file
(`_e2e.txt` is a leftover scratch fixture, safe to ignore or delete). Before a
release, confirm `npm run compile` is clean and `build-deploy.ps1` succeeds.

Two build-time guards are the exception, both run by `vscode:prepublish` so a
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
  panel was deleted while the `config` handler still called into it.

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
   `agentHarness.baseUrl` at the mock and set a marker `agentHarness.apiKey` —
   then assert what the running host sent: `GET /user/balance` with the new key
   and base URL (A), again after a second key-only edit (B), and a real
   `POST /chat/completions` carrying the newest key, `stream: true` and the tool
   schemas (C).
3. Checks A/B need nothing but the edit; C needs an idle host — drive it through
   the control plane (`POST /session/start` with a throwaway title, then
   `POST /session/start {sessionId}` to hand the UI back), and run the whole
   thing **detached** if the agent is mid-turn (a harness background terminal
   makes `/session/start` queue instead of run).

Rules learned the hard way: back up `.vscode/settings.json` byte-for-byte and
restore it in a `finally` (a failed run must never leave a mock base URL behind);
space two edits more than a second apart (VS Code debounces external writes, and
a coalesced event looks like a missing feature); pass an explicit `timeout` on
the command that edits the file, or you end up measuring the tool's own default
instead of the setting under test. A build that only reads config in
`buildAgent()` fails A/B/C — that is what a regression here looks like.

The implementation used while fixing this was deliberately thrown away
(`.agent-harness/live-config-test/`, gitignored scratch). If it is wanted as a
tracked tool it belongs in `tools/research/`, not `tools/` — see
`scratch-space.md`.
