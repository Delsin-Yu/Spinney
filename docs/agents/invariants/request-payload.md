## The request payload: one body constructor, one command that shows it

**Rule:** `buildChatRequestBody` (`src/agent/apiClient.ts`) is the only place a
chat-completions **body** is built. `ApiClient.stream()`, `ApiClient.complete()` and
`Spinney: Show Request Payload` all call it, so the JSON the command puts on screen is
the JSON the provider would receive — not a second rendering of the same request that
happens to agree today.

That is the whole reason the function exists. Before it, the body was inline in both
client methods; a command that "showed the payload" would have been a copy, and a copy
drifts exactly once and silently. `npm run check:payload` is the guard that keeps the
single constructor single (see §The guard).

### The command

`spinney.showRequestPayload` (`ChatViewProvider.showRequestPayload`) takes the
**active session's checked-out node**, asks its runtime for the payload
(`SessionRuntime.requestPayload()`), and opens
`JSON.stringify(body, null, 2)` in an **untitled** `json` document — the same shape as
`Spinney: Show System Prompt`. No temp file, no size branch: an inline image makes a
large document because a large document is what would be sent.

It also writes one line to the output channel, which is the machine-readable half:

```
[payload] session=<id> node=<id> card=<id> provider=<id> url=<baseUrl>/chat/completions messages=<n> images=<n> bytes=<n> [x-opencode-session=ses_<window>]
```

Sixty seconds later that line is the only record of what was on screen, so it names the
node, the card and the endpoint — the three things that decide whether a payload is the
one you meant. `bytes` is the UTF-8 size of the serialised body; `images` counts
`image_url` / `file` parts.

### What the body is built from

Everything is the same source `beginTurn` sends from, so a preview cannot differ from a
turn:

| Field | Source |
|---|---|
| `model` | `chainCard(node).oaiModel` — the card's wire name, never a literal (`src/agent/models.ts` is the only place an id may be written) |
| `messages` | `buildPath(session, node.id)` — the chain's frozen epoch prompt plus the window's messages (`contextBase()` down), sanitised by `Agent.sanitizeMessages` |
| `tools` | `epochForNode(session, node.id)?.tools`; a chain with no envelope (or a legacy envelope with no tool set) falls back to `liveToolSchemas(card, false)` |
| `thinkingEffort` | the chain epoch's level; with no envelope, `effortForNode(node)`, already clamped against that card |
| `stream` | `true` — the interactive request is a stream |
| `max_tokens` / `temperature` | **not set**: the interactive request sets neither (only the session-title request in `ChatViewProvider` does, and that is a different request) |

The built body is passed through `wellFormedDeep` before it is shown, which is exactly
what the wire copy gets (`JSON.stringify(wellFormedDeep(body))` in both client methods):
an unpaired surrogate becomes U+FFFD on the wire, so the document shows the repaired
structure rather than the inline copy that still carries the defect.

`undefined` — and therefore a localised information message instead of a tab — means
there is nothing to send from: an empty session (no node in view), or a **sidecar** node
(a sub-agent's conversation and a background card's are not this one's history).

### What it never shows

- **No credential.** The API key is an `Authorization: Bearer …` **header**; the body has
  no field for it, and no code on this path reads the key at all. `check:payload` asserts
  the body cannot grow one (`Bearer` / `Authorization` absent).
- **The conversation header is reported, not inlined.** For a provider whose row declares
  `sessionHeader: 'opencode'`, the request also carries `x-opencode-session: ses_<…>`
  (`SessionDialect`). A header is not part of the body, so it appears only as a meta field
  and in the `[payload]` line. The value is `windowStart(session, node.id)` — the context
  window the prefix belongs to — and it is opaque, not secret: it may be written to the
  diagnostics log.
- **One request, not a transcript.** The body is what the *next* request from that node
  would carry. A running turn's in-flight request is not re-read from the wire.

### The guard

`npm run check:payload` (`tools/check-payload.js`, in `vscode:prepublish`) drives the
compiled constructor and the compiled client methods — no window, no network:

- a streaming body always carries `stream: true` and `stream_options.include_usage`, and
  a non-streaming one carries neither key twice;
- `tools` appears only when the array is non-empty; `reasoning_effort` is absent for
  `none`; `max_tokens` (floored, positive only) and `temperature` (finite only, `0`
  included) appear only when given;
- **key order** is pinned for both shapes (`model, messages, stream, stream_options,
  tools, reasoning_effort, max_tokens, temperature`), because the order is part of the
  bytes and the bytes are what the provider's prefix cache keys on;
- the same input twice builds deeply equal bodies (the function is pure, and leaves its
  input alone);
- `ApiClient.prototype.stream` / `.complete` **really call** the constructor and build no
  body field of their own (read off the compiled methods, so the check follows the code
  when the source moves);
- `SessionRuntime.requestPayload()` builds its body that way, normalises it with
  `wellFormedDeep`, sends `card.oaiModel`, streams, and names no credential;
- neither file names a model id.

A second body constructor, or an inline body growing back beside the shared one, therefore
fails packaging instead of quietly making the command a lie.

### Where to change what

- A **new body field** (or a changed one): `buildChatRequestBody` only — then the guard's
  key-order and field assertions, which are its documentation.
- A **new meta fact**: `RequestPayloadMeta` and `requestPayload()`, plus the `[payload]`
  line in `ChatViewProvider.showRequestPayload`.
- A **new endpoint**: `chatCompletionsUrl` is the one spelling of
  `<baseUrl>/chat/completions`; the command reports it, so a second spelling would make
  the report wrong.
