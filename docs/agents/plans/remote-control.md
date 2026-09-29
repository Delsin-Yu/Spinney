# Remote control — the plan

> **Status: M0 landed; M1 onward is not started.** The wire contract lives in
> `remote/PROTOCOL.md` and the machine-checked crypto vectors live in
> `remote/vectors/vectors.json` — the vectors bind the two ends that hold a key, while
> the relay reads the transport half alone. §17 records exactly what M0 landed and what
> it could not verify; nothing on this page is "shipped" without checking that list.

## 0. The goal

The harness can connect **outbound** to a self-hosted relay at a web address, and
authenticates with a shared token. Every active VS Code window that has the same token
configured is then automatically and fully visible to the other room members — on
another PC and in an Android app. There is no **approval** step and nothing to accept: one
token, one room, and the visibility follows from it. Getting the token onto a phone is a
transfer and not an approval, and it is the one place a device-to-device channel exists:
the desktop shows the token as a QR code and the phone reads it out of a photo (§11).

## 1. Authorization: the token grants full control

The token grants **full control**, including creating sessions. Remote control of the
harness is equivalent to remote code execution on the machine that runs it, mediated
only by the model; the owner has explicitly accepted this.

So all of the following are deliberately absent, and are not "later options":

- no read-only tier
- no per-connection approval
- no per-session hiding
- no time-boxed sharing

Enabling the feature plus a matching token **automatically publishes** every session's
full content — reasoning, tool output, images — to the room.

## 2. Visibility and topology

One token is one room. Room members see each other **symmetrically**: there is no
owner/member asymmetry, no "host" role, and no window that is more visible than
another.

- Every VS Code window connects on its own: one outbound connection per window per
  room. Two windows on one machine are two connections and two entries.
- The UI groups members by `deviceId = sha256(vscode.env.machineId + roomId)`; the
  device label is the OS hostname.
- The harness **never listens on a port**. The existing loopback control plane
  (`src/http/controlServer.ts`, `spinney.httpApi.*`) is **not** modified and is never
  exposed; remote control is a second, outbound-only path and does not widen the
  existing one.

## 3. The 1:1 rule

A replicated session must be functionally identical to using it locally. The rule is one
split:

- Anything acting on the **session**, the **working directory** or **agent state** is
  executed by the window that publishes it — the **publisher**.
- Anything about **reading and interacting with your own device** — opening a link, the
  clipboard, zoom/pan, card resize, choosing a file to send — happens on the **surface
  you are operating**.

Links always open on the surface where they were clicked. There is deliberately **no
"open on the host" toggle**: the surface you clicked on is the surface that acts.

## 4. Image upload

You pick the image on the surface you are operating. The bytes travel to the publisher
and are injected there through the exact same local path the local picker already uses —
`UserAttachment { dataUrl, name }` in `src/chat/tree.ts`. No separate file-transfer
channel is needed for this main line.

## 5. Rendering: the wire protocol is the existing host-to-webview protocol

No second protocol is designed. The publisher mirrors **every host-to-webview message it
already posts** — the seam is `ChatPanel.post()`, `ChatViewProvider.postTo()` and
`rt.postAllState()` — and the replica is a webview that receives those exact messages.

Consequences:

- one renderer runs in three places: the local chat tab, a remote-session webview panel
  in the harness, and a WebView on Android;
- there is no second source of truth: a message that is not posted locally is not
  visible remotely, so a rendering divergence is always a transport defect, never a
  renderer difference.

### What a replica's card does not have, and the pair that asks for it

A replica renders the same messages, so what it *receives* decides what it can draw. Two of
the host's payloads carry a node's transcript, and only one of them reaches a replica whole:
a **regular** node's `items` ride in the `tree` and `path` payloads, while an **agent** node
ships only `itemCount` — its body is fetched on first expansion (`loadAgentItems` →
`agentItems`), exactly as a local card fetches it. The measured consequence, seen by hand on
a real phone: a replica that opened a session showed **three cards with no content and no way
to say it was waiting** — `work:0 ans:0`, no work log, no answer, only the preview text the
tree row carries, and **no loading state anywhere** in the renderer
(`grep loading|spinner|skeleton media/main.js` was zero hits). A card that was *waiting* and a
card that was *empty* were the same picture.

One message pair and one visible state answer that, and the §3 rule says which side answers:
this reads **session** state, so the publisher answers it. It is not about the surface the
user is touching.

- **`loadNodeItems` `{ id }`** — replica → publisher, inside an `input` frame. "Send me this
  node's full items." It joins `ACCEPT_FROM_PEER` (`src/remote/allowlist.ts`) and the phone's
  own copy, `MirrorPolicy.ACCEPT_FROM_PEER` (`remote/android/core`).
- **`nodeItems` `{ id, items }`** — publisher → replica, inside a `mirror` frame. The answer,
  carrying the node's `items` **verbatim**: the same bytes the local webview would render, so
  the one renderer stays the one renderer. It joins `MIRROR_TO_PEER` in both tables.
- **The loading state** — while such a request is outstanding, the card carries `aria-busy`
  and one visible string in its waiting zone. The renderer clears the state when the reply
  arrives, when the request is refused, and after a bounded wait. It asks **once per card**,
  and it prefers whichever of its two content sources actually has items: the path node's
  `items`, else the tree row's.

`remote/PROTOCOL.md` §5 names both types and its §6 records them as **accepted**, not refused.
Both allow-list rows are in the two implementations — `ACCEPT_FROM_PEER` / `MIRROR_TO_PEER`
in `src/remote/allowlist.ts`, and `MirrorPolicy.kt` in `remote/android/core` — and the
renderer's waiting state is the other half of this change. §17 stays the record of what is
verified.

### The default half: the summary rides the tree, the log arrives on demand

The pair above makes a card *able* to ask. It does not give a card anything to show by
itself, and the measured symptom comes back one step further on for a card nobody has
expanded: a replica that attaches to a session is mirrored that session's `tree` and, until
something is checked out, no `path` at all — so every card of a finished turn started as the
same `work:0 ans:0` card with nothing but the tree row's `preview` in it, and the fix for
that was a fetch per card, asked one card at a time.

So the **default** now carries a summary, and the on-demand pair stays exactly what it was:

- A **finished** node's row — in `tree` **and** in `path` — carries `items` = a **summary**:
  the node's **first `user` item** and its **last assistant item that carries text** (the
  answer, judged the way the row's 120-char `preview` already judges it), each clipped by
  the one clipper, beside **`summary: true`** and the node's true `itemCount`. `itemCount`
  is no longer an agent node's field alone: every finished row carries it, whatever its
  `kind`.
- The flag rides **only when the summary is a proper subset** of the log. A log with
  nothing to summarise (no items, or neither half) leaves a row *without* the flag, because
  a flagged row means "this card has content" to a renderer and an empty one would stop
  that card from ever asking for the log it has not got — that is the measured `work:0 ans:0`
  symptom with a flag on it. A log that *is* the pair (a one- or two-item turn) leaves the
  flag off too: the row carries the same bytes either way, and nothing should be fetched
  again for a log already in hand. A `path` row that cannot be summarised keeps shipping its
  whole clipped log, and a `tree` row that cannot be summarised keeps its `itemCount` alone.
- A `kind: 'agent'` row is never summarised, whatever its status: its card's contract is
  `itemCount` plus `loadAgentItems` (the lazy sidecar rule), and a `summary: true` row would
  claim that transcript is already in hand. A `kind: 'bg'` card has no items at all, so it
  is an `itemCount: 0` row.
- A **running** node's row is **unchanged**. Its transcript is what the live
  `delta` / `thinkingDelta` / `toolCallDelta` stream appends to, so a two-item snapshot
  under it would be rebuilt by the next delta — a running card is filled by its stream, and
  the summary is for the cards that have no stream any more.
- `nodeItems` is **unaffected**: it remains the node's `items` **verbatim**. The summary is
  never the answer to a `loadNodeItems`.

What the renderer does with it: a flagged row's two items are rendered like a log, and the
card records that what it holds is *not* the whole log (the card's own pair of flags). It
asks with the same one-shot `loadNodeItems` — and the same waiting state — the pair above
introduced. The ask has exactly one trigger, the card's **first expansion**: a card that is
never expanded never asks (a collapsed card is its head and its one-line preview, exactly as
before), so a cold repaint pays only for what the reader actually opened. The `nodeItems`
answer then replaces the summary, and a real transcript beats a summary of the same node on a
repaint that holds both. The local tab runs the same code path as the replica, which is the
point: what a surface shows follows what it has, and what it needs it asks for once.

The reason it is also a size win: a `path` for a long session used to ship every transcript
of the chain it names, and a summarised node now costs that `path` **two items** instead. A
full log crosses the room only when somebody opens that card, so the traffic of a room
follows attention instead of the size of the session it mirrors. No frame type and no
allow-list row is added: the summary rides inside `tree` and `path`, which already cross, and
`remote/PROTOCOL.md` §5.1 is where the wire shape is written down.

**State of this half.** It landed while this section was written, and it is guarded rather
than measured: the row shape is built in one place (`SessionRuntime.nodeRowItems`, spread
into both `treeMessage` and `postPath`), and `npm run check:webview` now carries the
behaviour by name — *summarised cards: collapsed = no ask, expanded = 1 `loadNodeItems` +
the strip, the answer replaces the summary* (and 0 requests for the card that was already
filled, on the replica shape and on the local `path` shape alike). What is **not** verified
is the same thing §17 still lists for this feature: no run in this repository opens the
Android app, and the probes on a real phone measured the pair above rather than this summary
— so what a summary card looks like on a phone is verified nowhere yet. §17 stays the record.

## 6. Diagnostics stay local

`perfDiag` and `layoutDiagnostic` must **never** be forwarded to the publisher.
Reaching it trips the publisher's own "panel stopped painting" recovery ladder
(`ChatViewProvider.ts`, around lines 3200-3213), which can force a repaint or a reload
of the owner's own window — a remote peer must not be able to disturb the local tab that
way.

The mirror is **deny-by-default in both directions**: a message type crosses only if it
is on an allow-list, and the allow-list is the guarded artifact, not the denylist.

## 7. The mirror must never block the local UI

The mirror owns a bounded queue. On overflow it drops frames and issues a `resync`
request, which re-delivers the state a freshly opened webview would receive. A slow or
stalled remote peer must never delay or block the owner's own webview: the local path
does not wait for the mirror, and the mirror has no unbounded growth anywhere.

## 8. Transport

- SSE downstream plus POST upstream over plain HTTP(S), using `fetch` and
  `response.body.getReader()` — the same shape `src/agent/apiClient.ts` already uses.
- a 20 s heartbeat, which is also the defence against undici's default 300 s body
  timeout (a quiet room must not be killed by an idle-read timeout).
- exponential backoff reconnect.
- chunked frames: a transport slice is at most 48000 base64 characters, carrying a
  slice of the sealed frame, with a 16 MiB cap on the reassembled frame. Slice
  boundaries are the sender's choice and a receiver only concatenates.
- WebSocket is an **additive later option, not the first implementation**.

## 9. The relay

The relay is **self-hosted only**, shipped as source in `remote/server/`: a C# ASP.NET
Core Minimal API project, Native AOT, cross-compiled to linux-x64 with the
`StuDev.AotAnywhere` MSBuild SDK.

It is a **dumb byte pipe**: it routes by room id and never parses, decrypts, logs or
stores frame bodies. No hosted service is offered by this project.

## 10. Crypto

The token is **never** sent to the relay. The hierarchy:

```
PBKDF2-HMAC-SHA256(token, salt='spinney-room-v1', 600000 iterations, 32 bytes) = master
HKDF-SHA256(master, salt='spinney-hkdf-v1', info='room')  -> the room id
HKDF-SHA256(master, salt='spinney-hkdf-v1', info='enc')   -> the AEAD key
HKDF-SHA256(master, salt='spinney-hkdf-v1', info='mac')   -> the MAC key
```

- The room id in the URL path is the **base32** (RFC 4648, uppercase, unpadded) form of
  the 16-byte room id, i.e. exactly **26 characters**.
- Frames are **AES-256-GCM**, with the sequence number and a per-connection random salt
  in the nonce, and the version, sequence number and framing id bound as the AAD — so a
  replay fails. The frame's type, sender and target are **not** in the AAD, because the
  receiver cannot know them before it decrypts; they live inside the sealed plaintext,
  where the same GCM tag authenticates them, so a frame cannot be re-labelled or
  retargeted either.
- The room id is the routing credential, so the relay can neither read nor forge
  anything.
- Peers do **not** run a separate challenge/HMAC exchange: a frame that opens under the
  AEAD key has already proven possession of the token, because that key is derived from
  it. A relay that mixed two rooms together is caught by the AEAD itself, so a second
  MAC exchange would add a round trip and prove the same fact twice.

The exact byte-level vectors (KDF outputs, nonce construction, the AAD, a sealed frame)
live in `remote/vectors/vectors.json` and are machine-checked, so a second implementation
is verified against the same bytes as the TypeScript one. Only the two ends that do
crypto are bound by them: the relay never touches a key, because it never parses a frame.

## 11. Rooms, naming, and the two trees

Multiple named rooms are supported.

- The rooms themselves are an **object keyed by the room name**, not an array:
  `spinney.remote.rooms` = `{ "<name>": { relayUrl, autoConnect } }`. The name is the key
  because the name *is* the room's local identity (it labels the tree root, the status
  bar and the dialogs, and it names the SecretStorage entry), and because an object
  setting is what the repo already uses for `providers` / `modelCards`. The plan first
  said `[{ name, relayUrl, autoConnect }]`; the object form was chosen when the setting
  was written, and the semantics are unchanged — only the shape.
- `spinney.remote.enabled` (boolean, default **false**) is the master kill switch. The
  plan said "off by default" without naming the mechanism; this is it. It is separate
  from each room's `autoConnect` on purpose: turning the feature off must tear every
  room down at once, and a per-room flag cannot express that.
- Each room's token lives in VS Code SecretStorage:
  `spinney.remote.password.<roomName>`.
- A room name is a **LOCAL LABEL**: two machines meet in the same room purely because
  their tokens match, whatever each side calls it. Nothing about the name is negotiated
  or sent as an identity.
- The name is visible in three places: the root of the room tree, the status bar, and
  the connect/kick dialogs.

The main UI knows two trees:

- A **ROOM TREE** — a **native VS Code tree view** (`spinney.remote`, a
  `TreeDataProvider` in the existing Spinney activity-bar container, contributed with
  `when: config.spinney.remote.enabled` so it only exists once the feature is on),
  showing `room -> device -> instance (workspace folder, model, busy) -> session`.
  R4 in the round-three plan said this should be a *shared webview page*
  (`spinney.remoteTree` + `media/remote.js`) so the desktop and the phone could render
  one implementation. **That reasoning is dead**: the Android app grew its own native
  Compose room tree (a phone wants a native list, not a 30-element webview), so there
  is nothing left to share, and a native tree view is the idiomatic VS Code surface —
  it gets folding, keyboard navigation, theme and collapse-state persistence for free,
  where the webview page would have re-implemented all four badly. Only the
  **replicated session** keeps the shared-renderer idea, because there the renderer is
  the product itself.
- A **REPLICATED SESSION** panel — a webview panel per remote session, which renders the
  mirrored protocol with the shipped `media/main.js` (see §5).

### The reversal: a wrong token is a different, non-existent room

This section used to imply it, and `remote/PROTOCOL.md` §3 stated it as an axiom: *"a wrong token
is not an error: it is an empty room."* **That is reversed**, and the reversal is worth recording
because of what it cost to learn.

The relay created a room the moment anybody joined any well-formed room id, and destroyed it when
its last peer left. So every token "worked": a mistyped one derived a different room id, the relay
happily created *that* room, and the device sat in a live room with no peers in it. Two devices in
two different rooms therefore looked exactly like two devices in one room where nobody had
published yet — the same tree, the same `online`, the same `0 peers`, no error on either surface.
**The rule the whole design rests on is "two machines meet because their tokens match", and that is
the one rule whose violation had no witness**: not on the desktop, not on the phone, not in the UI.
It took the relay's aggregate `/healthz` counts — `rooms` at 2 where 1 was expected — to see it at
all. The trigger was a pasted token with a stray leading space, trailing newline, non-breaking
space or byte-order mark (§17, "A defect the owner found on his own phone"); the failure it exposed
was older than that defect.

What is now true:

- The relay keeps a **room record**: the id and the unix time it was last used by a join, and
  nothing else — no token (it has never seen one), no content, no peer, no room name. It lives in
  memory and in a file, and it **outlives the last peer**, so a replica can still enter a room whose
  publisher is asleep. It expires after a TTL (30 days by default) and is capped (1024 by default),
  which is what keeps the metadata from accumulating: the next desktop connect re-creates it.
- `POST /v2/room/{roomId}/join` carries **what the caller may do**: `{"mode":"create"}` records the
  room if it is new and answers `created`, `{"mode":"join"}` **refuses** a room the relay has no
  record of with `404 room_unknown`. The mode is required and has no default — a default would be
  the old silent behaviour wearing a new route's name — so a client that asks to enter a room that
  does not exist is told so, in a status code it can turn into a sentence.
- `/v1/room/{roomId}/join` is unchanged in meaning, because `PROTOCOL.md` §5 puts a changed
  contract in a new route rather than in a flag. It now also *records* the room it creates, so a new
  client can join a room an old one made — and a room that is live but unrecorded is still joinable,
  so the fix cannot become an outage.
- On the desktop, the room id's first eight characters are in the status bar and all 26 are in its
  tooltip, and a join that **created** the room is reported: the publisher's half of the same
  legible failure, said on the side that holds the token. A refusal a user can act on is shown
  localized (`room-unknown`, `relay-too-old`) instead of as the transport's English line.
- On the phone the join is `/v2`'s `mode=join` too, so a token that names no room is refused there
  as well, and the room tree replaced the axiom sentence with a state and an action: the refusal
  says the token names no room, prints the room fingerprint, and tells the reader to compare it
  with the other device. The two refusal sentences are the desktop's own, word for word, so a
  Chinese phone reads what a Chinese desktop reads.

**The trade, and the alternative that was rejected.** The relay now keeps metadata it did not keep
before: *which rooms exist*, on disk, until each ages out. That is the price of a legible failure,
and it is accepted deliberately. The alternative rejected was to answer the question with **liveness
alone** — refuse a join when no peer is in the room, keep no record and keep the relay stateless —
because it refuses the replica the moment the publisher is asleep, which is the case a self-hosted
room exists for, and because it would collapse "the desktop is asleep" and "the token is wrong" into
one answer again, which is this same defect wearing the other face. The record is the state that
separates those two facts. The other rejected alternative is the obvious one: teach the relay to
check the token, with a stored verifier or a challenge. §10 forbids it — the relay never sees the
token and cannot derive it — and it would be worse than forbidden: a relay that could check a token
is a relay worth brute-forcing.

**The risk that was not removed, only priced.** `404 room_unknown` is an answer a candidate token
can be tested against, so the join routes are an oracle. What keeps a dictionary walk expensive is
the derivation (600000 PBKDF2 iterations per candidate, paid by the asker) plus a per-source-address
brake on the join routes; a device that joins once when it opens never notices either. That is a
mitigation and not a removal, and it is written that way in `PROTOCOL.md` §7 and in the relay's
`README.md`. The honest summary: the relay can now tell a caller that a room does not exist, and
that is exactly the fact that makes a token testable — accepted, because the alternative was a
silent failure the user could not act on.

### Pairing: a QR code, and why it replaced typing

The reversal above is about a token that is *wrong*; what made it wrong was a **keyboard**. The
phone's connect form is a masked field, an IME and a pasted string, and the defect §17 records — a
trailing newline, a leading space, a non-breaking space, a byte-order mark — arrived through it.
Normalising the input and printing the room fingerprint made that failure legible *after* it
happened; showing the token as a picture removes the class of failure instead of witnessing it.

- `spinney.remotePairingCode` (`src/remote/pairing.ts`, `pairingCode.ts`, `qr.ts`) builds one
  payload — `spinney-pair:1?relay=<r>&room=<n>&token=<t>`, three values percent-encoded per
  **RFC 3986** — renders it as a QR code with this repo's own encoder (byte mode, level M,
  versions 1–10, no npm dependency added), and opens the PNG. The phone reads the payload out of a
  photo the user picked through the **system photo picker**, so the app needs no camera permission
  and no decoder library of ours. `remote/PROTOCOL.md` §10 is the contract; the shared test vector
  both sides assert is in `tools/check-remote.js`.
- **Why the QR replaced typing.** A typed secret has a second, lossy representation — the keyboard
  and the IME — and a photographed one does not: the payload crosses one visual channel byte for
  byte, and the phone's parser is **strict** (an unknown prefix or version, a missing or empty
  parameter, and *any* parameter it does not know are all refused). The token it carries is then
  judged by the same `tokenIssue` rules on both ends, so pairing cannot become a second, weaker
  definition of a usable token. That strictness is also why a new field means a **new version
  integer** and never an extra parameter: a version-1 parser that skipped one would mis-read a
  version-2 payload, which is this section's silent-wrong-room failure wearing a different coat.
- **The image is the token.** It reaches the phone over the screen and never over the relay — only
  the relay's one-way function of the token ever goes there (§3 of `PROTOCOL.md`) — so the command
  is explicit and never automatic, the PNG is written into the **extension's own storage** under
  one fixed name the next pairing overwrites (never the workspace, which a user commits and syncs;
  never the OS temp directory, which on a shared machine is other users' to read), and one warning
  sentence says that anyone who photographs the code can control the room.
- **What it changes here and what it does not.** It adds one contributed command and one documented
  surface; it adds **no relay route and no frame type**, so the transport half of this plan is
  untouched and a phone that pairs is just a device that now holds the token.

## 12. Repo layout

One top-level `remote/` folder:

| Path | Content |
| --- | --- |
| `remote/PROTOCOL.md` | the wire contract (frames, the crypto, the allow-lists, errors) |
| `remote/vectors/` | `vectors.json`, the machine-checked crypto vectors |
| `remote/server/` | the relay, C# (ASP.NET Core Minimal API, Native AOT) |
| `remote/android/` | the Android app, Kotlin/Compose |

`.vscodeignore` excludes `remote/**`, so nothing of it ships in the `.vsix`. The
extension keeps **zero runtime dependencies**; the C# and Android builds are separate
from `npm run vscode:prepublish` and are not part of the release gate.

## 13. Source marking

A remote-originated turn is marked in node metadata as
`node.origin = { peerId, deviceName, at }`. It is rendered as a badge on the card and
written into the transcript's line-1 meta record.

It is deliberately **not** written into the message text: the bytes sent to the provider
must not change, and the model is not told it is being driven remotely.

## 14. Residual protections

These stay in place regardless of the accepted risk:

- the feature is off by default;
- a permanent status-bar indicator;
- a peer list with a Kick action;
- every remote command is written to the diagnostics log;
- the token only ever lives in SecretStorage and never in the log (`src/redact.ts`
  extended). The one copy outside it is the pairing image (§11), and only while a user has asked
  for it — written on demand, into the extension's own storage, under one fixed name;
- a window that lost the workspace lock stays read-only and refuses remote mutations
  with the existing sentence.

## 15. Milestones

| Milestone | Content |
| --- | --- |
| **M0** | Relay skeleton; `dotnet publish -r linux-x64` validated; `remote/PROTOCOL.md`; the vectors. |
| **M1** | Publisher: settings, SecretStorage, the KDF, sealed and chunked frames, the SSE client with heartbeat/backoff/backpressure, the mirror seam and the allow-lists. |
| **M2** | The room-tree page and the replicated-session panel; remote image upload; copy-node-id; the deny-by-default wiring and its guard. |
| **M3** | The Android app. |
| **M4** | The large-file blob channel if needed; streaming polish; multi-room polish; manual, l10n and the acceptance driver. |

Every milestone that touches `src/`, `media/` or `package.json` ends the same way:
`npm run compile` -> `build-deploy.ps1` -> ask the user to run
`Developer: Reload Window` (`AGENTS.md`, "Standard closing procedure").

## 16. Documentation, i18n, manual

A user-visible change updates `manual/**` and every `l10n` catalog: the room tree, the
replicated panel, the connect/kick dialogs, the status-bar indicator, the origin badge and
the pairing code (section 20.8 of each page) all need a page per catalog language and the
new strings in every catalogue.
`npm run check:l10n` and `npm run check:docs` are the gates, exactly as for any other
shipped change.

## 17. What M0 landed

> Recorded so that nothing above has to be read as "shipped" without checking it. M1
> has not started.

| Landed | Where | Verified by |
| --- | --- | --- |
| the wire contract | `remote/PROTOCOL.md` | read against the two implementations that exist, and against the relay's route table |
| the crypto vectors | `remote/vectors/` + `tools/gen-remote-vectors.mjs` | re-running the generator reproduces the committed file **byte for byte** (same sha256), so it is generated and deterministic, not hand-edited |
| the transport core | `src/remote/rooms.ts` · `src/remote/frames.ts` · `src/remote/allowlist.ts` | `npm run check:remote` (`tools/check-remote.js`), wired into `vscode:prepublish` |
| the relay | `remote/server/` — ASP.NET Core Minimal API, Native AOT | its own `--selftest`: **18 cases, 18 passed** at this revision (12 when M0 landed), exit 0; `dotnet build -c Release` with 0 warnings |
| the cross-compile | `dotnet publish -r linux-x64 -c Release` from a Windows host | 12,909,792 bytes, `sha256 83847a11…`, `7f 45 4c 46` with `e_machine 0x3e` — a real x86-64 ELF |

**The one thing M0 did not verify: the cross-compiled Linux binary was never
executed.** This host has no WSL distribution and no container runtime, so the
artifact is *byte*-verified (ELF magic, class, endianness, `e_machine`, and no ICU
dependency) but not run. The same source passes its full in-process `--selftest` as a
JIT build, so the logic is covered; "the published ELF starts and serves on Linux" is
the first thing to confirm on a real Linux box or on the VPS, before M1 leans on it.

The contract itself changed twice inside M0 — both times because something was
*measured* rather than assumed, and both times before a line of transport code existed:

- the AAD named `type`, `from` and `to`, which a receiver cannot know before it
  decrypts: a chicken-and-egg that would have surfaced as a broken first connect. It
  is `v|seq|fid` now, and everything semantic moved inside the sealed plaintext.
- the relay minted a 16-hex-char `peerId` while the contract said 8. The contract won:
  nothing keys on a peer id and it carries no authority, so the narrower one is right.

### What M1–M3 landed

| Landed | Where | Verified by |
| --- | --- | --- |
| the publisher half (M1) | `src/remote/{roomsStore,remoteService,roomsCommand}.ts`, the seam in `ChatViewProvider`/`runtime`/`extension`, `spinney.remote.*` | `npm run check:remote` (275, pairing included — see the last row) and `npm run check:remote-surfaces` (74) — the latter drives the real `RemoteService` with a recorder in place of the transport: reconciliation, presence, the mirror, the `input` gate, the dedupe cache, the refusals |
| the transport | `src/remote/relayClient.ts` | `npm run check:relay` (134): a real relay stub on a loopback port drives the **compiled** transport through slicing, interleaved reassembly, replay/tamper/malformed refusals, a 429, pacing, backpressure, a refused join, and a reconnect with fresh key material |
| the two surfaces (M2) | `src/remote/{remoteTreeView,remoteSessionPanel,replicaRouting,origin}.ts`, `src/chat/{webviewShell,imagePick}.ts`, `media/main.js` | `npm run check:webview` (37 messages — the local panel still paints), `npm run check:remote-assets` (the shell DOM's 30 ids pair with the host template, both ways) |
| the Android app (M3) | `remote/android/` (a pure-JVM `:core` + the Compose/WebView `:app`), `tools/{sync-remote-assets,check-remote-assets}.js` | `./gradlew :core:test :app:assembleDebug` — 29 JVM tests, and `:core`'s vector test asserts every derivation, every seal and every slice against `remote/vectors/vectors.json` byte for byte; the APK builds |
| the shared salt, named | `remote/PROTOCOL.md` §4/§7, `frames.ts`, both implementations | `check:remote`, `check:relay` and the Kotlin vector test all pin `s` in position 3, one salt per connection, and a disagreement refused before any tag is checked |
| the pairing surface | `src/remote/{pairing,pairingCode,qr}.ts`, `spinney.remotePairingCode`, `remote/PROTOCOL.md` §10 | `npm run check:remote` (275): the payload's shared vectors, the strict `%XX` read-back of all three values, the refusals (an empty parameter, an unpaired surrogate). `npm run check:qr` (118): the format bits decode back to level M and the mask this encoder chose, the finder/separator/timing/alignment patterns and the 4-module quiet zone are where ISO/IEC 18004 §6 puts them, and every block's Reed-Solomon syndromes are zero in a second GF(256). **The decode is not proven here:** no decoder runs in this repository — the fixture `remote/android/core/src/test/resources/pairing-fixture.png` is what the Android half reads, and `check-qr` says so itself |

The release gate itself is green (`npm run vscode:prepublish`, 23 steps of which 21 are
`check:*` guards), including `check:docs` (3 manual pages, 30 commands, 22 settings) and
`check:l10n` (414 strings × 2 catalogs).

### What is still NOT verified

Two gaps the guards could never have closed have been closed deliberately, and one is
still open. It is not softened here.

**Closed: the two implementations have spoken to each other, and they agree.**
`npm run check:interop` (`tools/remote-interop.mjs`) runs the real relay, the real Kotlin
peer and the real compiled TypeScript transport in **one room** and asserts that frames
cross **byte for byte** (sha256 equal on both sides), including one large enough to need
four slices; that each side opens the other's frame with the salt it read **from the
envelope**; and that the `fid`-derived salt the TypeScript transport used to imply
provably *cannot* open it. That last assertion is the one that matters: it is the proof
that the hidden-salt convention two implementations had each invented differently would
have broken the room, and it is why the salt is now a named field. The run also verifies
it left nothing behind. It is dev-only — `dotnet`, a JVM and `out/` are not things a
packaging run may require — so it is not part of the release gate, and it says so in
`testing.md`.

**Closed: a real window has been in a room, and a second member drove it.**
`npm run check:remote-e2e` (`tools/remote-acceptance.mjs`) launches one throwaway VS Code
window on a profile of its own, attaches it to a room of the real relay, and joins that
room from Node on the real compiled transport. Everything it asserts is read back from the
window's **own control plane**, never from a mirror frame the run itself wrote — that is
what makes it evidence rather than a restatement: the window announces itself (`hello`
naming the device, the instance, the workspace and `deviceId = sha256(machineId + roomId)`);
`instances` carries its real sessions with their real titles and node counts; `attach`
yields a `mirror` frame holding that session's own `tree`; an `input` really starts a turn,
and a replayed frame id really does **not** start a second one (`result{ok:true,duplicated:true}`,
an unchanged node count); `cmd{session/start}` creates a session in the window and
`cmd{stop}` stops a turn; no mirrored payload carries a perf trace at any depth, with the
positive control that the local post is longer by exactly the stripped `traceId`; and
teardown leaves no window and no relay behind. It runs **three members in one room** — the
window, the Node member and a third sender — and asserts that the third member's broadcast
arrives carrying its own sender identity and leaving the receiver's refusal counters
unmoved, which is the assertion that would have caught the replay-window defect below on
its own. 48 checks, about 19 s, and it reports the window and the relay gone afterwards.
Dev-only: it needs a display, `dotnet` and `out/`, so it is not in the gate.

**A defect only a third member could find.** That run's first three executions found one:
`RelayTransport` kept a single replay window per receiving connection and applied it to
frames from **every** sender, while §4 specifies one window per connection *salt* and every
sender numbers its own frames from `seq` 1. In a room of three or more, the later senders'
frames were dropped as replays and never arrived — a half-mute room that renders perfectly.
Every two-peer test in this repository was green, including a 134-check transport driver
and the cross-implementation run, because a room of two never collides. The fix keys the
window by the sender salt the envelope names (LRU-bounded, so the map defends memory and
not the room), and it also reversed the order in which a receiver opens a frame and
advances that window: the salt is public, so advancing first let a keyless relay burn a
real sender's window with a garbage-tagged frame that merely *claimed* its salt, muting
that peer silently. Both rules are now in §4 and pinned twice: by case 7c of `check:relay` (stub level) and by
that run's own three-member assertion (a real room).

**A defect the owner found on his own phone.** A pasted token whose text carried a trailing
newline, a leading space, a non-breaking space or a byte-order mark derived a **different
room id** — so the phone and the desktop could each show a room called `home` and sit in two
different rooms, with nothing on either screen to say so. That is the one failure the whole
design rests on: "two machines meet in a room because their tokens match" is its only
membership rule. The desktop already trimmed; the phone did not, and neither surface could
*show* which room it was in. Both are fixed: the phone normalises on write, on read and on
paste (repairing a token an older build stored with a newline), it refuses a token the
desktop would refuse, and both surfaces now display the first eight characters of the
derived room id so two screens can be compared by eye. `check:interop` grew a section
comparing ten token spellings Kotlin-against-TypeScript — including the two places the
languages genuinely disagree about whitespace (a BOM is whitespace to JavaScript and not to
Kotlin; the C0 separators are the reverse) — and `:core`'s tests pin the premise, that the
four spellings really are four different rooms.

Still open:
- **Nothing in this repository has ever launched the Android app** — no emulator, no device,
  so no run here exercises its UI. It *has* been run by hand on a real phone (which is how
  the defect above was found), so what a person used is hand-verified. What remains
  compile-verified only is the rest of the UI — the reveal toggle, the IME hints, the
  fingerprint rendering, the repair-on-read path against a real `EncryptedSharedPreferences`
  file — and the image path (M2's picker → `userMessage` attachment → the publisher), which
  has still never carried a byte on a wire.
