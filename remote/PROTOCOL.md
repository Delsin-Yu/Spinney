# Spinney remote control — the wire contract

> **Status: frozen design, implementation in progress.** This file is the
> authority for the bytes on the wire. Three independent implementations read it
> — the extension host (TypeScript), the relay (C#), and the Android app
> (Kotlin) — but only the two that do crypto are bound by
> `remote/vectors/vectors.json`, the machine-checked proof that they derive and
> seal identical bytes. The relay reads this file for its transport half alone:
> it never touches a key, and it cannot. When this file and an implementation
> disagree, this file wins, and the vectors are regenerated with
> `node tools/gen-remote-vectors.mjs`.
>
> The user-facing contract (what a replicated session may do, and where each
> action runs) is `docs/agents/plans/remote-control.md`.

## 1. Roles

| Role | Who | Does |
| --- | --- | --- |
| **relay** | `remote/server/` (C# Minimal API, Native AOT) | routes opaque frames between the peers of one room. Never parses, decrypts, logs or stores a frame body |
| **publisher** | a VS Code extension host | publishes its own instances and mirrors the sessions a replica attached to |
| **replica** | another extension host, or the Android app | reads the published instances, attaches to a session, renders the mirrored protocol, and may submit input |

A peer is a publisher and a replica at the same time: every window announces
itself and can attach to any other window in the room. There is no
host/client asymmetry beyond who owns a given session.

## 2. Topology and identity

- One **token** is one **room**. Two machines meet in the same room purely
  because their tokens match; the room's *name* is a local label and never
  travels.
- One **outbound connection per window per room**. A window never listens on a
  port, and the existing loopback control plane (`spinney.httpApi.*`,
  `src/http/controlServer.ts`) is not involved and not modified.
- `deviceId = sha256hex(utf8(vscode.env.machineId + roomId))` — stable per
  machine per room, and deliberately different across rooms so a peer cannot
  correlate a device between two rooms. `deviceName` is the OS hostname.
- `instanceId` is the window's control-plane instance id (`pid-<pid>`, or
  `SPINNEY_INSTANCE_ID`). It is not stable across a restart, and nothing keys on
  it: the room tree groups by `deviceId`, and a session is addressed by its own
  `sessionId`.
- `peerId` (8 hex chars) is assigned by the relay on `join` and is **transient**
  — it changes on every reconnect. It is used for transport addressing and
  attribution only, never as an identity.

## 3. Crypto

The token is never sent to the relay, and the relay cannot derive it. All
parties derive the same three values from the token alone. Inputs are UTF-8
unless stated.

```
master  = PBKDF2-HMAC-SHA256(password = token, salt = "spinney-room-v1",
                             iterations = 600000, dkLen = 32)
roomIdB = HKDF-SHA256(ikm = master, salt = "spinney-hkdf-v1", info = "room", len = 16)
encKey  = HKDF-SHA256(ikm = master, salt = "spinney-hkdf-v1", info = "enc",  len = 32)
macKey  = HKDF-SHA256(ikm = master, salt = "spinney-hkdf-v1", info = "mac",  len = 32)
roomId  = base32(RFC 4648, "A-Z2-7", uppercase, no padding) of roomIdB   -> 26 chars
```

- `roomId` is the relay URL path segment and therefore the **routing
  credential**. A wrong token produces a different room, so a wrong token is not
  an error: it is an empty room.
- 600000 iterations is deliberate and slow (hundreds of milliseconds). It is
  paid **once per room per connection**, synchronously, and it is the reason the
  derivation is not called on any hot path. Do not lower it to make a test
  faster; freeze a derived value instead.
- **There is no separate challenge/HMAC handshake.** A frame that opens under
  `encKey` has already proven possession of the token, because the key is
  derived from it. A relay that mixes two rooms together is therefore caught by
  the AEAD itself: the frame fails to open and is dropped. Adding a second MAC
  exchange would add a round trip and prove the same fact twice.

## 4. Sealing

- AES-256-GCM, key `encKey`, 16-byte tag **appended** (`ciphertext || tag`) —
  the layout WebCrypto, .NET `AesGcm` and Java `AES/GCM/NoPadding` all produce.
- Nonce (12 bytes) = `uint64 big-endian frame seq` immediately followed by
  `uint32 big-endian connection salt`. `seq` starts at 1 per connection and is
  monotonic; the connection salt is random per connection, which is what makes a
  reconnect unable to reuse a nonce. **The salt is not derived from anything and not
  secret: it travels in the transport envelope as `s` (§7).** A receiver has to build
  the nonce *before* it can open a frame, so the salt must be readable — an
  implementation that hides it somewhere the receiver has to guess (inside `fid`, say)
  is incompatible with every other implementation by construction. This is not a
  theoretical point: an earlier draft of this contract left the salt implicit, and two
  implementations promptly invented two different conventions for it.
- AAD = UTF-8 of the canonical string

  ```
  v|seq|fid
  ```

  field order fixed, decimals unpadded — e.g. `1|7|0011223344556677`. **Only the
  three facts a receiver already has before it decrypts** are bound, because the
  receiver has to build the AAD *before* it can open the frame: the sealed bytes
  are reassembled first, then opened. Everything else about the frame lives
  inside the sealed plaintext (§5) and is therefore authenticated by the GCM tag
  itself. The connection salt is deliberately not bound either: it is already half
  the nonce, so a frame carrying a different `s` fails the tag anyway, and binding it
  twice would add nothing but a second place to keep in step.
- This is deliberate and was a bug in an earlier draft: an AAD naming `type`,
  `from` or `to` cannot be reconstructed by the receiver, because the transport
  envelope carries none of them (§7) and could not, or it would leak them. It
  would also have been redundant — a peer that re-labelled or retargeted a frame
  cannot produce a valid tag over the plaintext it would have to change.
- `idx` and `last` are deliberately **not** in the AAD either. They describe a
  *slice*, not the sealed frame (there is one nonce per logical frame, not per
  slice), so binding them would be ambiguous. A tampered `idx`/`last` cannot
  forge anything: it corrupts reassembly, and the reassembled bytes then fail the
  tag. The relay can therefore only drop, delay or corrupt — never fabricate.
- The plaintext is the UTF-8 of the logical frame JSON (§5).
- **Replay defence**: a 64-wide sliding window **per sender salt** — the salt the envelope
  names, not the receiver's own. Every sender numbers its own frames from `seq` 1, so one
  window shared by all of them would refuse the second sender's first frame and then
  silently mute every sender but the first; a room of three would look healthy while half
  of it was inaudible. A `seq` already seen, or at or below the window floor, is rejected
  as a replay.
- **Verify the tag before you advance the window.** The order is part of the contract, not
  an implementation detail: the salt is public, a window is keyed by it, and a receiver
  that advanced first could be made to burn a real sender's window with a garbage-tagged
  envelope that merely *claims* that sender's salt — after which a keyless relay could
  mute that peer by exhausting its sequence space. A `seq` below 1, or not an integer, is a
  *format* error rather than a replay: a malformed sequence is not a hostile peer.
- **The window map is bounded**, with the least-recently-used sender evicted once a room
  holds more senders than its peer cap. That bound is about memory and not about security:
  an entry exists only after a frame authenticated under `encKey`, so a relay cannot mint
  one, and the cost of an eviction is one re-delivered frame from a sender that has been
  quiet while sixteen others spoke — which the idempotency rule in §7 already tolerates.
- Failures must stay distinguishable to the caller: *too large*, *tampered*, and
  *replayed* are three different outcomes, never one string.

## 5. Frames

A logical frame is compact JSON with exactly this key order:

```json
{"v":1,"type":"<type>","id":"<frame id>","from":"<peerId>","to":"<peerId>|*","body":{ }}
```

Everything semantic — the type, who sent it, who it is for — is **inside** this
JSON and therefore sealed. The transport envelope (§7) carries none of it.

- `id` is a caller-chosen correlation id (16 hex chars); a `result` carries the
  `id` of the request it answers. It is **not** the transport's `fid`: `id` lives
  as long as a request/response pair, `fid` only as long as one frame's slices.
  They are independent, and a sender that makes them equal is making a choice,
  not following a rule.

Unknown `v` is refused with `error{code:"version"}`, in the transport envelope and
in the sealed frame alike: a receiver that does not understand a version does not
try to open it. That check must not be best-effort, and `v` must be present on
**every** line: the relay never looks at a version, so a room holding one old and one
new client looks perfectly healthy to it, and the receiver's refusal is the only thing
that turns that mismatch into a legible error instead of a garbled render. A real
transport change — a binary blob channel, WebSocket — belongs in a new route version
(`/v2/room/...`) that a client joins instead of `/v1`, not in a flag inside `v`.

| Type | Direction | Body |
| --- | --- | --- |
| `hello` | peer -> room | `{ deviceId, deviceName, instanceId, workspace, appVersion, proto }` — sent on join |
| `bye` | peer -> room | `{}` — a graceful leave |
| `instances` | publisher -> room | `{ instances: [ { instanceId, workspace, sessions: [ { id, title, running, lockedNodes, backgroundNodes, model, modelName, effort, nodes } ] } ] }` — the state the room tree draws, re-sent whenever it changes |
| `attach` | replica -> publisher | `{ sessionId }` — start mirroring that session to me |
| `detach` | replica -> publisher | `{ sessionId }` — stop |
| `mirror` | publisher -> replica | `{ sessionId, message }` — one verbatim host->webview message |
| `input` | replica -> publisher | `{ sessionId, message }` — one verbatim webview->host message, restricted by §6 |
| `cmd` | replica -> publisher | `{ command, args }` — one **control-plane** command, for the affordances that are not webview messages at all. `command` is one of `session/start`, `navigate`, `continue`, `stop`, and `args` is that route's own body (`docs/agents/control-plane.md`). Answered by a `result` carrying the same `id`. This exists because "create a session on that machine" has no webview message to ride: the composer cannot express it. The publisher answers with `error{code}` when it refuses (`unknown-session`, `readonly`, `busy`) |
| `result` | publisher -> replica | `{ ok, ... }` — the answer to a `cmd`, correlated by the frame `id`. A replica that reconnects and does not get its answer must not resend blindly: the publisher's dedupe cache answers the repeated `id` instead |
| `resync` | either | `{ sessionId? }` or `{}` — "I dropped frames, send fresh state" |
| `ping` / `pong` | either | `{}` — application liveness |
| `error` | either | `{ code, message, ref }` — codes: `version`, `unknown-type`, `denied`, `unknown-session`, `readonly`, `busy`, `too-large`, `unsupported` |

`mirror` and `input` wrap the **existing** host<->webview messages unchanged.
This is the whole point of the design: the replica is a webview receiving the
protocol the shipped `media/main.js` already speaks, so there is one renderer,
not two. Laziness also comes for free — a replica that needs a node's body sends
the same `loadAgentItems` the local webview sends, and the answer arrives as a
`mirror` frame carrying the same `node` message the publisher would have posted
locally.

A publisher mirrors only the sessions a replica attached to, plus its own
`instances` announcement. Nothing is mirrored for a session nobody is watching.

## 6. What may cross the mirror

Both directions are **deny-by-default**: a type that is not in the table is
refused, and a new host or webview message type must fail a build guard until
somebody decides which side it belongs to. The tables live in
`src/remote/allowlist.ts`.

Deliberately **never** forwarded, in either direction:

| Type | Why |
| --- | --- |
| `perfDiag`, `layoutDiagnostic` | they are the operating surface's own diagnostics; reaching the publisher they would trip its "panel stopped painting" recovery ladder (`ChatViewProvider.ts`) and can force a repaint or a reload of the owner's window |
| anything carrying a perf `traceId` | a replica must never run the owner's probes |
| `setNodeSize` | card geometry belongs to the surface you are looking at |
| `copyNodeId` | the clipboard belongs to the surface you are operating |
| `openExternal` | a link opens where it was clicked — there is deliberately no "open on the host" toggle |
| `pickImage` | the picker opens on the surface you are operating; the chosen image travels as an attachment inside `userMessage` |
| `openModelTree` | the model-config editor edits local settings and local secrets |
| `ready` | a webview boot handshake in one direction, not a command |

## 7. Transport: SSE down, POST up

Plain HTTP(S). The extension uses `fetch` plus `response.body.getReader()` — the
same shape `src/agent/apiClient.ts` already uses — so the extension keeps zero
runtime dependencies and does not depend on a global `WebSocket`.

Relay routes (the full contract is in `remote/server/README.md`):

| Route | Purpose |
| --- | --- |
| `GET /healthz` | liveness and counts |
| `POST /v1/room/{roomId}/join` | returns `{ peer }`; 404 on a malformed room id, 429 when the room is full |
| `GET /v1/room/{roomId}/down?peer=` | `text/event-stream`; one `data:` line per frame from another peer, plus a `: ping` comment every 15 s |
| `POST /v1/room/{roomId}/up?peer=` | one frame payload, forwarded verbatim to every other peer of the room |

A frame payload on the wire is one SSE-shaped line. It carries **only what a
receiver needs before it can decrypt** — the version, the sequence number and the
connection salt (which together are the nonce, so neither can be secret), the
framing id, the slice position, and the bytes:

```json
{"v":1,"seq":7,"s":"1a2b3c4d","fid":"0011223344556677","idx":0,"last":true,"b":"<base64 of a slice of the sealed frame>"}
```

Key order fixed. `v`, `seq` and `fid` are the AAD (§4); `s` is the other half of the
nonce, as 8 lowercase hex characters; `idx` and `last` are reassembly facts; `b` is
the payload. Note what is *absent*: the frame's type, its sender and its target are
all inside the sealed plaintext, so the relay learns the shape of the traffic but
never what any of it means.

- The relay **never parses** this. It enforces only: the room id in the path, a
  body with no CR or LF byte (which is what stops SSE injection), a body within
  `--max-frame-bytes`, a per-peer rate limit, and the room/peer caps. It then
  forwards the body **verbatim**.
- **Slicing**: a sealed frame is sealed **once** (one nonce) and then split into
  slices of at most 48000 base64 characters each. `fid` is shared by the slices
  of one frame, `idx` is 0-based, `last` marks the final slice, and every slice
  of one frame carries the same `v`, `seq`, `s` and `fid` (a mismatch is an error —
  and the `s` check is the one that would otherwise let two connections' slices be
  spliced into one frame).
  The receiver reassembles by `fid` and only then opens the frame. Reassembled
  sealed frames are hard-capped at 16777216 bytes; exceeding the cap is an
  error, never a truncation. Slices of one frame may arrive interleaved with
  other frames, and an out-of-order or duplicated `idx` is an error.
- **Slice boundaries are the sender's choice** and are deliberately not part of
  the contract: a receiver concatenates and never inspects where one slice ends.
  Two implementations may therefore slice the same frame differently and still
  interoperate — only `seal`/`open` and the AAD have to agree byte for byte. The
  vectors use 30000 raw bytes per slice as their reference chunking.
- **A receiver must check `s` per `fid` *before* it opens the frame.** The salt is
  deliberately not in the AAD, so nothing downstream catches a spliced slice set: the
  receiver would simply build the nonce from the wrong salt, and the GCM tag would then
  report *tampering* — blaming a hostile peer for what is a transport bug. The mismatch
  is a **framing** refusal, and it abandons the assembly, so the remaining slices of that
  `fid` arrive with no assembly to join and are refused one by one. A single stray salt
  in an *N*-slice frame therefore costs *N-1* framing refusals; that arithmetic is
  expected and is not a leak or a loop.
- **Backpressure** is the relay's job and must never reach the sender: a peer
  whose outbound queue would exceed its cap is dropped (its stream is closed and
  it is evicted). The dropped peer reconnects and asks for a `resync`.
- **Known limitation, to be decided in M1**: the contract has no leave route, so
  a peer that goes away politely still occupies a room slot until the idle
  eviction (90 s), or until its stream is closed and the next write to it fails.
  With 16 slots per room this is harmless today; if reconnect churn on a flaky
  mobile link ever makes it matter, the fix is a `leave` route, added
  deliberately together with the client that uses it.
- **Client liveness**: an application `ping` every 20 s, answered by `pong`. This
  is both the half-open connection detector and the reason the SSE stream is
  never idle — Node's `fetch` is undici, whose `bodyTimeout` defaults to 300 s
  and is measured between chunks, so a silent stream would be killed by the
  runtime after five minutes. 20 s is comfortably inside that, and the value is
  a constant, not a tunable.
- **Reconnect**: on any transport failure, drop everything, re-derive (the
  derivation is cached per process), `join` again for a new `peerId` and a new
  connection salt, `hello`, re-`attach` the sessions that were attached, and ask
  for `resync`. Backoff is exponential with jitter and a cap; a reconnect is
  never a reason to replay an `input` the peer already sent — the publisher
  answers a repeated `id` from a short-lived dedupe cache instead.
- **Never block the local UI**: an extension host's mirror queue is bounded,
  drops on overflow and asks for a `resync`. A slow replica must not be able to
  delay, block or fail the owner's own webview, the agent loop, or a tool call.
- **WebSocket is a later, additive option.** Because the relay only moves opaque
  bytes, adding a WS route later is an addition, not a rewrite. The first
  implementation stays on SSE.

## 8. Sizing

| Limit | Value | Where enforced |
| --- | --- | --- |
| transport slice | <= 48000 base64 chars | sender |
| relay POST body | <= 65536 bytes | relay |
| reassembled sealed frame | <= 16777216 bytes | receiver |
| slice count per frame | <= 467 packing maximally (<= 560 with the 30000-byte reference chunking) | sender |
| derivation | 600000 PBKDF2 iterations | every party |
| heartbeat / `ping` | 15 s (relay comment) / 20 s (client frame) | relay / client |
| peer queue before drop | 4194304 bytes | relay |
| peers per room | 16 | relay |
| rooms | 64 | relay |
| peer idle eviction | 90 s | relay |
| peer rate | 60/s, burst 120 | relay |

A phone photo is the sizing case that matters: ~8 MB of JPEG becomes ~10.7 MB of
base64 inside the attachment, which fits the cap once. The double encoding
(base64 inside JSON inside base64 slices) is accepted for the first
implementation; a binary blob channel that carries bytes once is the M4
optimisation if it ever hurts. Pushing that one frame costs about 356 slices,
which at the relay's default rate (60/s, burst 120) takes roughly five seconds —
acceptable for an image, and the reason the rate is a relay flag rather than a
hard-coded constant.

## 9. Threat model, in one paragraph

Any peer holding the token has full control of every publisher in the room,
including creating sessions, which makes this equivalent to remote code
execution on the machine running the publisher — accepted by the owner, and the
reason the feature is off by default, the reason the status bar always shows the
peer count, and the reason every remote command is written to the diagnostics
log. The relay is untrusted for confidentiality and integrity: it learns traffic
shape, room ids (which are token-derived credentials) and peer counts, and it
can drop, delay or reorder frames, but it cannot read a frame, forge one, or
move one between rooms. The token is the single trust root: it never goes to the
relay, never goes to a log, and lives only in VS Code SecretStorage.
