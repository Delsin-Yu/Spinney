# `remote/android` — the Android remote controller (milestone M3)

A phone joins the same room as a Spinney window and gets the same two surfaces the desktop
replica has: a foldable **room tree** (room → device → instance → session) and a **replicated
session view**, plus the actions of the frozen contract. The token grants full control, including
creating sessions — accepted and decided in `docs/agents/plans/remote-control.md` §1 — so there is
no read-only tier, no approval step and no reminder anywhere in here.

The wire contract is `remote/PROTOCOL.md` and it is the authority. Where this tree and that page
disagree, that page wins. The user-facing contract is `docs/agents/plans/remote-control.md`.

---

## 1. The version matrix (measured on this machine, not chosen by taste)

| Piece | Version | Where it came from |
| --- | --- | --- |
| Gradle (wrapper) | **8.11.1** | already in `~/.gradle/wrapper/dists/gradle-8.11.1-bin/bpt9gzteqjrbo1mjrsomdt32c` — never downloaded |
| JDK | 17.0.20 (Microsoft) | machine default; `javax.crypto` PBKDF2-HMAC-SHA256 needs API 26, which is why `minSdk = 26` |
| Android Gradle Plugin | **8.7.3** | already cached (needs Gradle ≥ 8.9 → OK; supports `compileSdk 35`) |
| Kotlin (`android`, `plugin.compose`, `jvm`) | **2.0.21** | already cached |
| Compose BOM | **2024.12.01** (ui 1.7.6, material3 1.3.1) | already cached |
| `androidx.activity:activity-compose` | **1.9.3** | cached |
| `androidx.core:core-ktx` | **1.13.1** | cached |
| `org.jetbrains.kotlinx:kotlinx-coroutines-android` | **1.7.3** | cached |
| `androidx.webkit:webkit` | **1.12.1** | **downloaded** (network) |
| `androidx.security:security-crypto` | **1.1.0-alpha06** | **downloaded** |
| `com.squareup.okhttp3:okhttp` | **4.12.0** | **downloaded** |
| `com.google.zxing:core` | **3.5.3** | **downloaded** (Maven Central) — the QR *decoder* both pairing paths read a code with (§4d) |
| `androidx.camera:camera-core`, `camera-camera2`, `camera-lifecycle`, `camera-view` | **1.4.1** | **downloaded** (Google's Maven, `dl.google.com` — not Maven Central) — the live camera scan (§4d) |
| `:core` tests | **`org.junit.jupiter:junit-jupiter:5.11.4`** + `junit-platform-launcher` | **downloaded** |

`compileSdk = 35`, `targetSdk = 35`, `minSdk = 26`, Java/Kotlin target 17.

Everything except the downloaded artifacts was already in `~/.gradle/caches`, which is what
decided the AGP/Kotlin/Compose versions: a version that resolves offline beats a newer one that
does not. After the first online run, `./gradlew --offline :core:test :app:assembleDebug` works
(the sub-agent proved that with a full `--offline --no-build-cache clean` run, and the CameraX
change re-proved it with `--offline --rerun-tasks :app:assembleDebug`).

CameraX is the one dependency that does **not** come from Maven Central, so a mirror of Central
alone cannot resolve it; `camera-view` also drags in `androidx.appcompat` at runtime (its
`PreviewView` is a `FrameLayout` subclass), which is where the ~40 extra transitive modules in the
app's classpath come from. `camera-camera2` is the only backend: it is the one that exists on
API 26+ without Google Play Services.

## 2. Modules, and where a change belongs

| Path | What it is |
| --- | --- |
| `:core` → `core/src/main/kotlin/dev/spinney/remote/core/` | **Pure Kotlin/JVM, no Android dependency.** The whole protocol: `Derivation.kt` (§3), `Sealing.kt` (§4 nonce/AAD/AEAD, the `s` wire salt), `Connection.kt` (§5 frames + the sealing state of one connection), `Transport.kt` (§7 envelope, slices, reassembly), `ReplayWindow.kt` (§4, one window per sender salt), `Sse.kt` (§7 parser), `RelayRoutes.kt` (§7's routes, the `/v2` join and the mode it carries), `JoinRefusal.kt` (what a `/v2` join refusal means, and whether a retry could change it), `Room.kt` (the room tree's fold over `hello`/`instances`/`bye`), `MirrorPolicy.kt` (§6 tables), `LanguageTags.kt` (a reported tag → the canonical catalog tag), `Pairing.kt` (the strict `spinney-pair:1?…` parser, §4d), `QrScan.kt` (zxing: pixels → the payload, the one **area-averaging decode ladder** both pairing paths run, and the luma plane → ARGB ints the camera needs, §4d), `Backoff.kt`, `Json.kt`, `Bytes.kt`, `Protocol.kt` (every pinned number, in one place) |
| `:core` → `core/src/test/kotlin/…/VectorsTest.kt` | **The point of M3**: the Kotlin ↔ TypeScript byte-for-byte proof, read straight out of `remote/vectors/vectors.json` |
| `:core` → `…/ProtocolContractTest.kt` | The rules the vectors cannot pin: nonce freshness on reconnect, the per-salt replay window, the three distinguishable refusals, the frame's JSON, the SSE shape, the routes and the `/v2` join refusal taxonomy (a `room_unknown` body is terminal; a 404 with no `error` body is a relay older than the app), backoff, the room fold, the language-tag mapping, and the §6 tables |
| `:core` → `…/PairingTest.kt` | The pairing payload: the three shared vectors by literal, the `%20`/`+` parity trap (asserted against `URLDecoder` itself), every refusal as its own reason, and **a zxing decode of the committed `pairing-fixture.png`** — the one place an independent reader proves the desktop's encoder (§4d) |
| `:core` → `…/QrLadderTest.kt` | The two pieces both pairing paths share: the **measured asymmetry** — a synthetic screen photograph on which a nearest-neighbour downscale of the code finds nothing while `decodeLadder`'s area averaging finds it — and the luma-plane arithmetic (`rowStride`/`pixelStride`) the camera frames arrive with (§4d) |
| `:app` → `app/src/main/kotlin/dev/spinney/remote/app/` | The Android half: `RemoteClient.kt` (the connection), `SessionWebView.kt` (the shipped renderer in a WebView + the host bridge), `ShellAssets.kt` (the asset origin and the two injections), `RoomTreeScreen.kt` (Compose), `SessionScreen.kt` (the phone's own actions), `CameraScanScreen.kt` (CameraX: live preview → luma frames → the shared decoder → the payload, §4d), `PairingFromPhoto.kt` (picker → pixels → payload → the three sentences, §4d), `SecureTokenStore.kt`, `L10n.kt`, `RemoteController.kt`, `MainActivity.kt` |
| `app/src/main/assets/webview/**`, `…/assets/l10n/**` | **Generated copies.** Never edit one by hand — see §3 |
| `app/src/main/assets/shell/**` | Hand-written, Android-owned: `session.html`, `session-shim.js`, `session-boot.js` |
| `tools/gen-shell.js` | A one-off derivation of `assets/shell/session.html` from `ChatViewProvider.getHtml()`; kept so the next person can re-derive it instead of hand-copying |
| `core/src/main/kotlin/…/InteropMain.kt` | **A test harness, not a client.** A tiny JVM `main` that joins a room, prints one JSON line per event, optionally sends one frame (of any size) and optionally replays it or re-stamps its salt — it exists so `tools/remote-interop.mjs` can put this transport on a wire against the TypeScript one |

## 3. The renderer rule, and the two scripts that keep it

`remote/PROTOCOL.md` §5 and the plan's §5 say it in one line: **one renderer, three places.** The
replicated session view is not a second implementation of the chat tree — it is the repo's own
`media/main.js` (plus `tree.js`, the vendored layout engine, the vendored markdown-it and
`style.css`) running in an Android WebView, with a Kotlin shim that supplies the file's single
coupling point (`acquireVsCodeApi()` at `media/main.js:2`) and the host half of the message
protocol.

An APK cannot load a file out of `media/`, so the runtime is **copied** and committed:

```bash
node tools/sync-remote-assets.js          # copy media/** and l10n/** into assets/
node tools/check-remote-assets.js         # fail the build if any copy is missing, stale or extra
node tools/sync-remote-assets.js --clean  # remove every generated copy again
```

`remote/android/remote-assets.json` is the manifest both scripts read (one row per file, with
`from`, `to` and why). The guard compares **sha256**, not timestamps: `assets/webview/main.js` must
be byte-identical to `media/main.js`, or the phone is running a second, silently older renderer
and a rendering divergence would look like a transport defect forever.

Two things the guard also catches, on purpose:

- **an unmanaged file** in `assets/webview/` or `assets/l10n/` — that tree is generated; a
  hand-written file in it is the same drift by another route;
- **a catalog language mismatch**, by content and not by a list of names: a catalog with no
  manifest row is fine **only** when its bytes are a byte-for-byte copy of one that has a row —
  which is exactly what a generated reported-tag alias is (`tools/sync-l10n-aliases.js` only ever
  writes a copy of its canonical source, and refuses even to delete an edited one). Anything else
  is a **new authored language** and fails until it has a row. The converse is checked too: two
  rows with identical bytes mean one of them names an alias, which is the mistake this rule exists
  to prevent.

  This rule is content-based rather than a skip-list for one reason: the release gate runs
  `npm run sync:l10n` **before** this guard, so the two aliases are present inside the gate and
  absent after `build-deploy.ps1`'s `finally`. A list of alias names would rot the moment a
  language is added — and the app does not need those files at all (§4b).

English is the source language and has **no** catalog file: `l10n/` holds only `zh-Hans` and
`zh-Hant`, and every English string *is* the key, so a missing catalog is a fallback, not a
missing translation.

## 4. The shell, and the one unguarded pairing

`assets/shell/session.html` is the DOM `ChatViewProvider.getHtml()` renders, with three
differences (all of them deliberate, all of them commented in the file):

1. the asset URLs point at `/assets/…` instead of `vscode-webview://` URIs;
2. `window.__spinneyL10n` is injected by the Kotlin host at `<!--SPINNEY_L10N-->` instead of by a
   `vscode.l10n` call, and the shell's own chrome reads its strings out of the same dictionary
   through `data-l10n*` attributes (`assets/shell/session-boot.js`), because a WebView has no
   `vscode.l10n`;
3. the CSP carries a per-load nonce for that one inline script (`<!--SPINNEY_NONCE-->`, replaced
   per request in `ShellAssets.kt`) and pins `connect-src 'none'` — the session view talks to the
   publisher through the Kotlin host, never through a fetch of its own.

`assets/shell/session-shim.js` is the whole of the host invention: `acquireVsCodeApi()`,
`window.__spinneyHost.receive(json)` dispatching a real `MessageEvent` (which is what
`media/main.js` listens for), and two transports — `androidx.webkit`'s `addWebMessageListener`
(preferred: origin-checked, and it carries a ~10 MB photo inside one `userMessage` without the
legacy bridge's string mangling) with `addJavascriptInterface` as the fallback when the platform
WebView is too old for the listener.

**The shell's DOM is guarded too, by the same script.** It cannot be *copied* (three rewrites stand
between it and `getHtml()`), so `remote/android/remote-assets.json` declares the pairing in a
`shell` block — the shell file, the host template, the generator, and the copied webview files —
and `check-remote-assets.js` fails when:

- an element id in `getHtml()` is missing from the shell (the phone would miss an element the
  desktop renders);
- the shell has an id `getHtml()` does not render (the same divergence the other way);
- an id that `media/main.js` or `tree.js` looks up (`getElementById` / `querySelector('#…')`) is not
  in the shell — a webview that cannot find an element it addresses freezes on stale values, which
  is exactly how a webview defect hides.

The fix is always `node remote/android/tools/gen-shell.js`, then diff. A template that cannot be
located (a refactor of `getHtml()`) is *reported and skipped*, never a false red. The class
attributes are compared too, because `style.css` is shared: an element whose class drifted would
paint the phone differently and no id check would notice.

## 4a. The connection salt `s`, and why the receiver never invents one

§4 makes the nonce `be64(seq) || be32(salt)`, and a receiver has to build that nonce **before** it
can open anything — so the salt is not derivable from the sealed bytes and has to be readable. §7
therefore puts it in the transport envelope as `s`, 8 lowercase hex, in position 3:
`{"v":1,"seq":7,"s":"1a2b3c4d","fid":"…","idx":0,"last":true,"b":"…"}`.

What this implementation does with that, and what the tests pin:

- the envelope codec carries `s` in that position and validates it **strictly** through
  `Nonces.decodeSalt`: 8 characters, lowercase, hex. `1A2B3C4D`, `1a2b3c4`, a missing `s` or
  `zzzzzzzz` are refusals, never coercions — a coerced salt builds a *different* nonce than the
  sender used and surfaces a transport bug as "tampered", which is the wrong diagnosis.
- `SealedConnection.open` builds the nonce from **the salt the slices carried**
  (`ReassembledFrame.salt`, decoded from `s`), never from the connection's own salt: a frame from
  another peer was sealed under *that* peer's salt, and substituting our own would fail the tag on
  every frame in a room with more than one publisher. `openSealed` takes the salt as a parameter so
  the source is impossible to miss; `Nonces.saltOf` survives for tests and diagnostics only.
- every slice of one frame must agree about `v`, `seq` **and `s`**: a disagreement is
  `MIXED_FRAME`, and the assembly is abandoned. That is the case that matters most — two
  connections' slices spliced under one `fid` would hand the receiver a frame whose nonce it can
  only guess.
- the replay window is **per sender salt** (§4: "a 64-wide sliding window per connection salt").
  A single window keyed on `seq` alone would refuse the second publisher's very first frame as a
  replay of the first publisher's `seq` 1 — a room that renders one publisher and looks healthy.
  The map is bounded at the room's peer cap and can only grow with salts that authenticated a
  frame, which requires the token, so the relay cannot evict a peer's window.

`VectorsTest` asserts the whole thing against the regenerated `remote/vectors/vectors.json`: each
seal's `envelope.s` is the recorded connection salt, the nonce rebuilt **from `s`** is the recorded
`nonceHex`, the recorded `sealedHex` opens under that nonce and does *not* open under any other
salt, every slice part carries `s` and the parts of one set agree, the reassembled frame's salt is
the wire salt, and `seals[3]` — the same token and the same `seq` 1 under a second salt — pins the
fresh salt as the replay defence rather than the sequence number.

## 4b. The catalogs a phone's locale maps onto

A phone reports a locale, not a tag: `zh-CN`, `zh-Hans-CN`, `zh-TW`, `zh` or `en-US`. `L10n.kt`
canonicalises that to the repo's region-invariant catalog tag (`LanguageTags`, mirroring
`src/languageTags.ts`) **before it looks anything up**, so `zh-cn` reads
`assets/l10n/bundle.l10n.zh-Hans.json`. That is why the reported-tag aliases
(`l10n/bundle.l10n.zh-cn.json`, which `npm run sync:l10n` writes for `vsce` and
`build-deploy.ps1` deletes again in its `finally`) are neither shipped nor needed. The mapping is
pure `:core` code and is unit-tested.

## 4c. The token: one spelling, one room

The room id is derived from the token and nothing else (§3), so a wrong token is **a different
room**. What `/v2` changed is how the phone learns that: it joins in `join` mode (§7), so a token
that names no room on that relay is *refused* — `404 room_unknown` — instead of being answered with
a live empty room that looks exactly like "nobody is publishing yet". That refusal is the plan's §11
axiom ("a wrong token is not an error, it is an empty room") retired; it is also a fact about the
*room* and not about the character, so it says the token is wrong without saying which character and
where — and the same refusal is what a *correct* token gets before the desktop has created the room.

A stray character still routes to a different room id, which is why the layers below still stand, and
it was measured on a phone: the relay's log showed **four rooms out of four spellings of one token**
(as typed, plus a trailing space, plus a trailing newline — what a paste produces — and with the IME
capitalising the first letter). Those four rooms existed because the phone asked to *create*; today a
phone cannot, so the same four spellings are four fingerprints to compare instead of four rooms to
find.

Four layers, in the order a token meets them:

1. **the IME** (`TokenField.kt`): a **platform `EditText`** in an `AndroidView`, because the two
   signals that stop an IME from "helping" have no Compose `KeyboardOptions` parameter. Measured on
   API 28, a Compose password field reports `inputType=0x81`, `imeOptions=0x2000006` — a password
   *hint* that third-party IMEs are free to ignore, and no "do not learn this" flag at all. The
   platform field sets, explicitly:

   ```
   inputType  = TYPE_CLASS_TEXT | TYPE_TEXT_VARIATION_PASSWORD | TYPE_TEXT_FLAG_NO_SUGGESTIONS   = 0x80081
   imeOptions = IME_ACTION_DONE | IME_FLAG_NO_PERSONALIZED_LEARNING | IME_FLAG_NO_EXTRACT_UI    = 0x11000006
   ```

   The flags are stamped at creation **and on every focus gain** (an IME re-applies its own
   `EditorInfo` when a field regains focus), and the masking is applied *after* them, because
   `setInputType` re-derives a transformation method from the type. Masking is
   `PasswordTransformationMethod` (which is also what makes `uiautomator` report `password="true"`);
   the reveal toggle sets it to `null`. The bordered container, the label above it, the eye and the
   fingerprint line are Compose, so the screen still reads as one form. (`setHorizontallyScrolling`
   is used where the brief says `isHorizontallyScrollable`: that property has no setter in the
   android-35 stubs.)
2. **the reveal toggle**: a masked field plus no fingerprint is how the wrong room stayed invisible.
   The field can be shown, with a TalkBack label;
3. **the fingerprint**: `Room · a1b2c3d4…` under the field, updating as you type, and repeated for
   every saved room — the first 8 characters of `roomId`, so two devices can be compared *before*
   anything is saved. The full id is on the room screen. The derivation is 600000 PBKDF2 iterations
   by design, so the fingerprint is debounced (250 ms) and computed off the main thread;
4. **`TokenInput.normalize`** (`:core`, unit-tested): leading and trailing whitespace removed and
   **nothing else** — no lowercasing, no interior stripping. The set is the one
   `String.prototype.trim` removes, because the desktop is the other end of the comparison; Kotlin's
   `Char.isWhitespace()` disagrees with it in both directions (a BOM is trimmed by JS and not
   whitespace to Kotlin; the C0 separators are the reverse), which is why the set is written out.
   It runs in the connect path, on write to `EncryptedSharedPreferences`, **and on read** — a token
   stored with a newline by an older build is repaired instead of silently kept.

A token that is too short (< 16 code points) or too repetitive (< 8 distinct characters) is refused
*on the phone*, with the desktop's own sentence, instead of becoming an empty room on the other
side. The thresholds are the desktop's (`TokenInput.MIN_TOKEN_CHARS` / `MIN_DISTINCT_CHARS`, mirroring
`tokenIssue` in `src/remote/rooms.ts`) rather than new ones, and the three refusal sentences are the
extension's own catalog strings — reused, so a Chinese phone reads the same words the desktop shows
and no new catalog entry is needed.

`tools/remote-interop.mjs` proves the agreement by running both implementations over ten spellings
(trailing space, trailing newline, leading newline, a copied multi-whitespace prefix, NBSP, BOM, the
capitalised first letter, a short token, a repeated one): same normalised characters, same strength
verdict, **same room id**, and — as the control — the untrimmed spelling really would have been a
different room.

## 4d. Pairing from a QR code — the answer to a silent failure

Everything above is a *defence* against a mistyped token, and a defence is not a fix. So the desktop
draws the room's token as a QR code (`Spinney: Show Room Pairing Code`, `src/remote/pairingCode.ts`)
and the phone reads it back **off a screen or out of a photograph** — live, with its own camera, or
from the system photo picker — which removes the typing instead of guarding it. The token still never
goes to the relay (§3), and it never goes through a keyboard either: the one channel is the screen and
the camera of the phone.

The payload is one line, `spinney-pair:1?relay=<r>&room=<n>&token=<t>`, percent-encoded per **RFC
3986** over UTF-8. `src/remote/pairing.ts` is the encoder, `:core`'s `Pairing.kt` is the parser, and
the three literals are asserted by both (`tools/check-remote.js` §9 and `PairingTest`):

```
relay https://relay.example.com:8787  room home + lab  token a b+c/d?
  → spinney-pair:1?relay=https%3A%2F%2Frelay.example.com%3A8787&room=home%20%2B%20lab&token=a%20b%2Bc%2Fd%3F
```

**The trap, and why `URLDecoder` is banned in `Pairing.kt`.** A bare `+` in a query is a web-form
convention, not RFC 3986: Java's `URLEncoder` writes a space as `+` and `URLDecoder` reads `+` back
as a space, while the desktop's `encodeURIComponent`/`decodeURIComponent` write `%20` and treat `+`
literally. A form decoder would therefore turn a token containing `+` into one containing a space —
a different room, and an empty one, which is precisely the defect pairing by QR exists to remove.
`Pairing.percentDecode` is the matching strict decoder: `%XX` into **bytes**, the bytes only then
read as UTF-8, a bare `+` kept as a literal `+`, and a malformed escape refused rather than
repaired. `PairingTest` asserts that difference against the JDK's own `URLDecoder` rather than
describing it.

**It refuses, and it is pure.** An unknown prefix or version, a parameter that is missing or empty,
**any parameter it does not know** (unknown fields cannot be skipped: a future field means a new
version, or a version-1 parser would silently mis-read a version-2 payload), a malformed `%XX`
escape or non-UTF-8 bytes, and a relay that is not an `http`/`https` URL. Each is its own reason in
`Pairing.Refusal`. What the parser does **not** do is judge the token: it returns the three strings,
and the flow then runs `TokenInput.normalize` + `TokenInput.issue` (§4c), so "what is a usable
token" keeps one definition and the token sentences stay the extension's own catalog strings.

**The reader is zxing, and the dependency is deliberate.** `com.google.zxing:core:3.5.3` is pure
Java — no Google Play Services, which is a hard requirement rather than a preference, because the
test phone is a Huawei device without them — and it is what lets the *same* `QrScan.decode` read the
committed fixture on a plain JVM. `PairingTest` decodes `core/src/test/resources/pairing-fixture.png`
(written by `tools/gen-qr-fixture.mjs` from the desktop's own encoder, and held to it by
`tools/check-qr.js`'s X1) and gets shared vector 1 back field for field. **That decode is the only
independent evidence in this repository that the hand-written encoder emits a symbol a real reader
accepts**: no round trip through either implementation's own decoder could show it. Nothing in
`:core`'s main source set may import `java.awt` or `javax.imageio` — they do not exist on Android —
so the pixels cross that line as an `IntArray`; the *test* is the one place `ImageIO` loads the PNG.

**The ladder, and the measured fact it exists for.** A photograph of a *screen* is not a picture of
a code: it is a picture of a code and of the screen's own pixel grid, and the grid survives one kind
of downscale and not the other. Measured on the very photograph that asked for this feature
(3072x4096, a monitor shot with the phone's camera, read with this zxing): an **unfiltered**
(nearest-neighbour) downsample finds the code at 1/4 and nowhere else, while an **area-averaging**
one finds it at 1/2, 1/4 and 1/8. Android's `inSampleSize` does not filter, `Bitmap.createScaledBitmap`
with `filter = true` does — and a camera frame has no Bitmap at all, so the averaging is done on the
pixels. One implementation serves both paths, and it lives in `:core`:
`QrScan.decodeLadder(pixels, width, height)` tries **1/1, 1/2, 1/4**, each step a 2x2 channel-wise
area average of the previous one, and stops when the smaller side falls under 128 px — a version-6
symbol is 41 modules across, so below that nothing can be read. `QrLadderTest` builds the synthetic
screen photograph that pins the asymmetry: with the grid at period 3 and depth 30, a nearest-neighbour
read finds nothing at 1/1, 1/2 or 1/4 while the ladder reads the code at its 1/4 step. (The parameters
are measured, with room either side: at depth 10 the unfiltered reads succeed, at 20 the ladder reads
at 1/2, at 40 at 1/4, at 60 nothing reads it. A grid whose period divides the read's stride — the
obvious period 2 — does *not* reproduce it, which is why the test is a measurement and not an
illustration.)

**The camera is the primary action; the photo picker is the fallback.** "Scan the code with the
camera" opens `CameraScanScreen.kt`: a CameraX `PreviewView` in an `AndroidView` (the pattern
`MainActivity` already uses for the token field) bound to the screen's lifecycle, plus an
`ImageAnalysis` use case on a **single-thread executor** with `STRATEGY_KEEP_ONLY_LATEST` — one frame
at a time and no backlog, because a frame that arrived while the previous one was being decoded is
stale by definition. Each frame's **luma plane** is turned into the `IntArray` the ladder wants by
`QrScan.grayPixels(luma, width, height, rowStride, pixelStride)`: no Bitmap per frame, and the two
strides are parameters rather than assumptions, because a `YUV_420_888` plane is padded per row and
may be spaced per pixel — read as tightly packed bytes it shears the picture, a defect no preview can
show. The analysis is asked for 1280x720: the frame's pixel count is what the ladder's 1/1 step
allocates, and 720p still leaves about ten pixels per module when a 41-module symbol fills a third of
the frame. **The camera stops on the first payload** — the analyzer is cleared and the use cases are
unbound *before* the payload is handed over, so the camera (and its privacy indicator) is off while
the connect derives the key, and a second frame cannot race the first into the form. The payload then
takes the same path as a photograph's: `pairingFromPayload` in `PairingFromPhoto.kt` — strict parse,
`TokenInput`'s judgement, fill relay/room/token, `RemoteController.connect`.

**The permission.** `AndroidManifest.xml` declares `android.permission.CAMERA` (next to the login
`INTERNET`) and asks for it at runtime when the scan screen opens; `uses-feature camera` is
`required="false"`, because a phone without a camera still pairs through the picker. A refusal is a
sentence and a way back, not a dead end — the photo path needs no permission at all, so it cannot be
refused. Nothing about the camera is stored: frames are decoded in memory and dropped, and the token
never goes to the relay (§3).

**The flow on the connect screen** (`PairingFromPhoto.kt` + `MainActivity.kt`): "or from a photo"
opens `ActivityResultContracts.PickVisualMedia` — the system picker the app already opens for
attachments (`SessionScreen.pickImage`), so **no storage permission is added** and the picture arrives
from outside the app as one content URI. Then: decode a QR out of the pixels (`BitmapFactory`,
downsampled to keep a 108 MP photo an allocation instead of an OOM — the fixture's symbol is version
6, i.e. 41 modules across, so capping the longest side at 2560 px still leaves about six pixels per
module — and *then* the ladder, which is what actually decides legibility, since `inSampleSize` is an
unfiltered read), parse it, judge the token, fill relay/room/token, and take `RemoteController.connect`
— the same stored, normalised and derived path a typed token takes. Every failure is one sentence,
localised through `L10n.t`, and cleared as soon as the user edits the form: no QR code in the photo; a
payload this app cannot read; a code from a newer Spinney; a relay that is not an `http`/`https` URL —
plus §4c's token sentences, reused verbatim, and the picker's own "that image could not be read",
which `SessionScreen` already says.

**The English strings this change adds** (they live in Kotlin; `L10n.t` falls back to the literal, and
`l10n/*.json` is deliberately untouched — the catalog guard scans the extension, so an app-only key
there would be reported stale, which is a known, separate gap): the camera screen's title and its
button, `Scan the code with the camera`; the connect screen's secondary button, `or from a photo`;
`To scan the room code, this app needs the camera.`; `The camera was not allowed, so the code cannot be
scanned. A photo of the code still works.`; `Allow the camera`; `Cancel`; `Point the phone at the code
on the desktop's screen.` and `The camera could not be started.` The refusal and token sentences a scan
produces are the ones above, reused — a scanned code and a photographed code are judged by one code
path, so no new sentence was needed for that half.

## 5. The room tree is native Compose — why

The **session view** must be the shipped renderer (it has to be: that is the whole architecture).
The **room tree** does not, and it is a small list:

- the desktop's own room tree (`media/remote.js`, view type `spinney.remoteTree`) is an M2 artifact
  that does not exist in this tree yet, so "reuse the shared one" was not available;
- a tree row contains no chat pixels, so a native list cannot diverge visually from anything;
- the model behind it (`:core`'s `RoomModel`) is a pure fold over `hello`/`instances`/`bye`, which
  means what the phone draws is unit-tested on the JVM against synthetic frames — no emulator, no
  relay.

If `media/remote.js` lands, wrapping it in a WebView here would be a *smaller* diff than the
Compose screen is today (one `SessionWebView`-shaped host, a different shell), and this paragraph is
the argument for doing that rather than porting features into Compose.

**What the screen says when it is alone.** With no device row in the tree the phone prints a state
and an action, not an axiom: the peer count is in the header, the state is "no window in this room
has published a session yet", the action is the two ways that can happen (that device is not
publishing, or it holds a different token, which is a different room), and the value the action needs
is printed under it — `Room · LTKXZ4EW…`, the same 8 characters the connect screen shows, so two
people can compare by eye. When the join itself was refused the screen prints the refusal instead of
an empty room, because an empty room would be a lie: the room does not exist. Those two sentences —
`room_unknown` and a relay older than the app — are the extension's own catalog entries, verbatim, so
one wire answer is described one way on both surfaces and neither sentence is a new string. The
alone-state sentence is the one English literal this change adds, and §4b is why it is legible on an
English phone today: English is the source language, so an absent catalog entry *is* the string, and
a translated one is what makes it Chinese.

## 6. The token

`androidx.security` `EncryptedSharedPreferences`: an AES-256-GCM key in the Android Keystore, with
AES-256-SIV-encrypted key names, so not even a room *name* is readable from the file. The token is
written once per room and read on demand; it is never held in a field, never put in a log, and
`RemoteController.describe()` reports room names and whether a token is set — never its value, not
even a prefix or a length.

`deviceId` is `sha256hex(installationId + roomId)` (§2), where `installationId` is a per-install
random secret from the same encrypted store. It is a hash input, never an identity, so the same
phone is one device row per room and cannot be correlated between two rooms.

## 7. Transport

`RemoteClient` is §7 in Kotlin, on OkHttp:

- **SSE down / POST up** over plain HTTP(S) (`RelayRoutes` builds the URLs, and the `/v2` join's
  body with its own URL, in one place);
- **the join is `/v2/room/{roomId}/join` with `{"mode":"join"}`.** A phone is a replica: it may
  enter a room, it must not be able to bring one into being, which is what turns a token that names
  nothing into `404 room_unknown` instead of a live empty room (`JoinRefusal`). That is a
  client-mode *declaration*, not a privilege — the relay cannot tell a phone from a desktop, and
  whoever holds the token *is* the room — so it buys legibility and not security. Both 404 answers
  are terminal: `room_unknown` (a wrong token, or a publisher that has not created the room yet) and
  a 404 with no `error` body, which is a relay older than this app and the reason the contract puts a
  transport change in a new route version (§5). `429` and `5xx` stay retryable, as they were, because
  neither is a verdict on the token;
- a **20 s application `ping`** (`Protocol.CLIENT_PING_INTERVAL_MS` — a constant of the contract,
  not a tunable), with the relay's own 15 s `: ping` comment as a second liveness signal;
- a watchdog that cancels the stream after 40 s of silence, because a half-open socket must not be
  rendered as "connected";
- **exponential backoff with jitter and a cap** (`Backoff`);
- **a fresh 32-bit connection salt and `seq` back at 1 on every reconnect** — a reconnect is a new
  `SealedConnection`, and there is deliberately no path that resumes the old one. Reusing the salt
  would reuse every nonce, and GCM does not complain about that: it silently leaks the XOR of the
  two plaintexts and the authentication key. `VectorsTest` and `ProtocolContractTest` both assert
  the salt/sequence rule, and the vectors pin the nonce *layout*;
- §6's routing in both directions (`MirrorPolicy`), so the four messages that act on **this phone**
  — `openExternal`, `copyNodeId`, `pickImage`, `setNodeSize` — are handled here and can never be
  asked of the owner's machine, while the one lazy read a card does need (`loadNodeItems` up,
  `nodeItems` down) does cross: the items are the publisher's, so asking for them is a session
  question and only the publisher holds the answer.

The phone announces itself with `hello` and publishes nothing: it is a replica-only peer, so it
never sends `instances`, and a peer that nevertheless asks it to `attach`/`input` gets
`error{code:"unsupported"}` instead of silence.

## 8. Build, test, install

```bash
cd remote/android
./gradlew :core:test              # 39 tests, including the vectors proof, the QR fixture decode, the ladder's measured asymmetry
./gradlew :app:assembleDebug      # -> app/build/outputs/apk/debug/app-debug.apk
./gradlew --offline :core:test :app:assembleDebug    # after one online run
./gradlew --offline --no-daemon :core:interopJar     # the interop peer jar (dev-only)

# the cross-implementation wire proof (from the repo root; builds what it needs, kills what it starts)
node tools/remote-interop.mjs
```

`local.properties` holds `sdk.dir` and is gitignored by this directory's own `.gitignore` (the repo
root `.gitignore` is a VS Code-extension ignore list and covers none of `local.properties`,
`.gradle/`, `build/`, `*.apk`).

## 8a. The interop run — the only test with both implementations on a wire

`tools/remote-interop.mjs` stands up the **real relay** (`remote/server`), starts this module's
`InteropMain` as a **real Kotlin peer** on a plain JVM (the whole reason `RemoteClient` lives in
`:core` and imports no Android type), and joins the room itself with the **real compiled
TypeScript transport**. It then proves, from both sides, that

- a frame crosses **intact, byte for byte** — small and multi-slice, in *both* directions, with the
  payload compared whole and by sha256;
- each side opens the other's frame with the salt **read from the envelope's `s`**, and the
  `fid`-derived salt the pre-`s` convention would have inferred **cannot** open it — the assertion
  that would have failed under the old hidden-salt convention;
- a **replay** is refused by the receiver in both directions, and a frame whose envelope claims a
  **neighbouring salt** does not open while the same bytes under the right salt do;
- the Kotlin peer reached the room through §7's **`/v2` join in `join` mode** — the TypeScript peer
  is the one that ran `create`, so the replica really did enter a room instead of being handed one.

It is dev-only, it is not part of `vscode:prepublish` (it needs a .NET SDK and a JDK), and it
prints `PASS remote-interop: N/N checks` only when every check ran and passed.

## 9. What is verified, and what is not

Verified by **running**, on this machine:

- the vectors: all three derivations, all four seals (byte-identical `sealedHex`, opened with the
  nonce built **from `s`**), both slice sets (including each part's `s`, the splice refusal, and
  the reassembled frame's salt), the refusals, and that re-encoding each frame's plaintext
  reproduces the vectors' bytes exactly;
- `:core:test` green (**39 tests**) and `:app:assembleDebug` green, from a clean tree and with
  `--offline --rerun-tasks` (so the vector test genuinely re-reads `remote/vectors/vectors.json`);
  the count went from 36 to 39 when the camera landed (the three in `QrLadderTest`);
- **the QR fixture decodes with zxing** (§4d): `PairingTest` reads
  `core/src/test/resources/pairing-fixture.png` back to shared vector 1 field for field, which is an
  *independent* reader accepting the desktop's own encoder — the three payload literals, the
  `%20`/`+` parity trap (asserted against `URLDecoder`), and all eight refusal reasons are green in
  the same run;
- **the ladder's measured asymmetry** (§4d): `QrLadderTest` builds a synthetic screen photograph
  (nearest-neighbour upscale of the fixture + a period-3 pixel grid at depth 30), asserts that a
  nearest-neighbour read finds nothing at 1/1, 1/2 **and** 1/4, and that `decodeLadder` reads the
  payload at its 1/4 step — so the averaging really is what reads the code, and a future "just scale
  it down" would fail the test rather than the phone. The same file pins `grayPixels` on a padded,
  spaced luma plane with sentinel bytes, and decodes the fixture through a camera-shaped plane;
- the CameraX change **resolves and compiles from the two mirrors and then from the Gradle cache**:
  `:app:dependencies --configuration debugRuntimeClasspath` with no `FAILED` entries,
  `:app:assembleDebug` green, and `--offline --rerun-tasks :app:assembleDebug` green again after the
  artifacts were cached (this is what "the dependency set is complete" means here, and it is a
  statement about resolution, not about a camera);
- the APK contains `assets/webview/main.js`, both catalogs, the shell and the shim; the merged
  manifest carries `android.permission.CAMERA` next to `INTERNET` and a
  `uses-feature camera required="false"`; and the camera code is inside the artifact (`classes.dex`
  carries `CameraScanScreen` and the CameraX classes), and the token
  field's flags are verifiable *inside the artifact*: `dexdump -d` on the installed APK's
  `classes4.dex` shows `TokenField.applyImeFlags` computing `const v1, #00080081` before
  `setInputType` and `const v1, #11000006` before `setImeOptions` (the constants are inlined, so the
  values are what travels, not the field names);
- **`tools/remote-interop.mjs`: 72/72 checks** — a frame crossed between the Kotlin and TypeScript
  transports through the real relay, byte for byte, in both directions, multi-slice included, with
  each side opening the other's frame from the envelope's `s`, a replay refused in both
  directions, and a neighbouring salt refused (§8a). The Kotlin peer joins that room with §7's
  `{"mode":"join"}` against the real `/v2` route (the TypeScript publisher is the side that ran
  `create`), which is the one place the phone's join is exercised on a wire;
- `tools/sync-remote-assets.js` / `tools/check-remote-assets.js` in all its modes (write, no-op,
  drift, missing, unmanaged file, `--clean`), and `check-remote-assets.js` green **both** with the
  l10n aliases present (after `npm run sync:l10n`, i.e. inside the release gate) and with them
  absent (after `npm run clean:l10n`), while still failing for a genuinely new authored catalog.

**Not verified — no emulator, no device was run in this milestone:**

- the app has never been **launched**. Nothing about the WebView — the asset origin, the injected
  dictionary, the message bridge, the layout of the shipped `main.js` on a phone viewport — has been
  observed on a screen;
- the **Android app's own connection** has never been driven against a live room: what
  `tools/remote-interop.mjs` proves is that the *transport this app uses* talks to the TypeScript
  host correctly (that transport is `:core`'s `RemoteClient`, the same class the app constructs).
  The app adds the Compose screens, the WebView host and `EncryptedSharedPreferences` on top, and
  none of those have run;
- the image path (photo picker → `dataUrl` → `imagePicked` → the composer's attachment → the
  publisher) is written but has never carried a byte;
- **the pairing flow has never been run end to end.** Its two halves are proved separately and on
  different machines: zxing reads the committed fixture in a JVM test (§4d, the decoder and the
  desktop's encoder), and the parser's vectors, refusals and purity are unit-tested — but the app's
  own path (photo picker → `BitmapFactory` → the downsample cap → form fill → connect) has not run
  on a phone, so the picker's photo has never become a room through this code;
- **nothing about the live camera has run on a real camera.** No frame from a sensor has ever been
  analysed: that `ImageAnalysis` hands over a `YUV_420_888` luma plane whose `rowStride`/`pixelStride`
  are what `grayPixels` assumes, that the 1280x720 resolution request is honoured, that the preview
  and the analysis bind together on the back camera, that a desktop's code at typical viewing
  distance is legible at that size, that the camera really stops on the first decode, and that the
  runtime permission dialog appears where the screen expects it — all of that is written and compiled,
  and the pixel arithmetic underneath it is unit-tested, but the camera itself is the one part no JVM
  test can stand in for. The synthetic screen photograph in `QrLadderTest` is a *model* of the measured
  moiré, not a substitute for a phone held at a monitor;
- §3's grouping in the room tree is exercised against synthetic frames only;
- **the room screen's refusal branch has never been on a screen.** The join itself *has* been on a
  wire (§8a: this same `RemoteClient` reaches the room with `{"mode":"join"}` against the real `/v2`
  route), and this side's reading of the four answers is unit-tested (`joinRefusalTaxonomy`) — but no
  phone has been *refused* by a live relay through the app, so the two refusal sentences and the
  fingerprint line under them are compiled, not seen.

The honest summary: the **crypto, the protocol, the wire and the QR decode are proved** — the last
of those by an independent reader (zxing) accepting the desktop's own encoder, and now also by a
measured synthetic screen photograph proving that the decode *ladder* handles the moiré a screen
leaves behind; the **UI, including the camera, is written and compiled, not run.**
