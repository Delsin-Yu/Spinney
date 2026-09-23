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
another PC and in an Android app. There is no pairing step and nothing to accept: one
token, one room, and the visibility follows from it.

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
  extended);
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
replicated panel, the connect/kick dialogs, the status-bar indicator and the origin badge
all need a page per catalog language and the new strings in every catalogue.
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
| the relay | `remote/server/` — ASP.NET Core Minimal API, Native AOT | its own `--selftest`: **12 cases, 12 passed**, exit 0; `dotnet build -c Release` with 0 warnings |
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
| the publisher half (M1) | `src/remote/{roomsStore,remoteService,roomsCommand}.ts`, the seam in `ChatViewProvider`/`runtime`/`extension`, `spinney.remote.*` | `npm run check:remote` (258) and `npm run check:remote-surfaces` (74) — the latter drives the real `RemoteService` with a recorder in place of the transport: reconciliation, presence, the mirror, the `input` gate, the dedupe cache, the refusals |
| the transport | `src/remote/relayClient.ts` | `npm run check:relay` (103): a real relay stub on a loopback port drives the **compiled** transport through slicing, interleaved reassembly, replay/tamper/malformed refusals, a 429, pacing, backpressure, a refused join, and a reconnect with fresh key material |
| the two surfaces (M2) | `src/remote/{remoteTreeView,remoteSessionPanel,replicaRouting,origin}.ts`, `src/chat/{webviewShell,imagePick}.ts`, `media/main.js` | `npm run check:webview` (37 messages — the local panel still paints), `npm run check:remote-assets` (the shell DOM's 30 ids pair with the host template, both ways) |
| the Android app (M3) | `remote/android/` (a pure-JVM `:core` + the Compose/WebView `:app`), `tools/{sync-remote-assets,check-remote-assets}.js` | `./gradlew :core:test :app:assembleDebug` — 22 JVM tests, and `:core`'s vector test asserts every derivation, every seal and every slice against `remote/vectors/vectors.json` byte for byte; the APK builds |
| the shared salt, named | `remote/PROTOCOL.md` §4/§7, `frames.ts`, both implementations | `check:remote`, `check:relay` and the Kotlin vector test all pin `s` in position 3, one salt per connection, and a disagreement refused before any tag is checked |

The release gate itself is green (`npm run vscode:prepublish`, 18 guards), including
`check:docs` (3 manual pages, 29 commands, 22 settings) and `check:l10n` (404 strings ×
2 catalogs).

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
Every two-peer test in this repository was green, including a 103-check transport driver
and the cross-implementation run, because a room of two never collides. The fix keys the
window by the sender salt the envelope names (LRU-bounded, so the map defends memory and
not the room), and it also reversed the order in which a receiver opens a frame and
advances that window: the salt is public, so advancing first let a keyless relay burn a
real sender's window with a garbage-tagged frame that merely *claimed* its salt, muting
that peer silently. Both rules are now in §4 and pinned twice: by case 7c of `check:relay` (stub level) and by
that run's own three-member assertion (a real room).

Still open:
- **The Android app has never been launched** — no emulator, no device. The interop run
  proves the transport *the app constructs* is correct on a wire; the Compose screens,
  the WebView host, the `acquireVsCodeApi()` bridge, the injected dictionary and the
  Keystore-backed token have never run. The image path (M2's picker → `userMessage`
  attachment → the publisher) has never carried a byte on a wire either.
