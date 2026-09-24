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
| `:core` tests | **`org.junit.jupiter:junit-jupiter:5.11.4`** + `junit-platform-launcher` | **downloaded** |

`compileSdk = 35`, `targetSdk = 35`, `minSdk = 26`, Java/Kotlin target 17.

Everything except the four downloaded artifacts was already in `~/.gradle/caches`, which is what
decided the AGP/Kotlin/Compose versions: a version that resolves offline beats a newer one that
does not. After the first online run, `./gradlew --offline :core:test :app:assembleDebug` works
(the sub-agent proved that with a full `--offline --no-build-cache clean` run).

## 2. Modules, and where a change belongs

| Path | What it is |
| --- | --- |
| `:core` → `core/src/main/kotlin/dev/spinney/remote/core/` | **Pure Kotlin/JVM, no Android dependency.** The whole protocol: `Derivation.kt` (§3), `Sealing.kt` (§4 nonce/AAD/AEAD, the `s` wire salt), `Connection.kt` (§5 frames + the sealing state of one connection), `Transport.kt` (§7 envelope, slices, reassembly), `ReplayWindow.kt` (§4, one window per sender salt), `Sse.kt` (§7 parser + routes), `Room.kt` (the room tree's fold over `hello`/`instances`/`bye`), `MirrorPolicy.kt` (§6 tables), `LanguageTags.kt` (a reported tag → the canonical catalog tag), `Backoff.kt`, `Json.kt`, `Bytes.kt`, `Protocol.kt` (every pinned number, in one place) |
| `:core` → `core/src/test/kotlin/…/VectorsTest.kt` | **The point of M3**: the Kotlin ↔ TypeScript byte-for-byte proof, read straight out of `remote/vectors/vectors.json` |
| `:core` → `…/ProtocolContractTest.kt` | The rules the vectors cannot pin: nonce freshness on reconnect, the per-salt replay window, the three distinguishable refusals, the frame's JSON, the SSE shape, backoff, the room fold, the language-tag mapping, and the §6 tables |
| `:app` → `app/src/main/kotlin/dev/spinney/remote/app/` | The Android half: `RemoteClient.kt` (the connection), `SessionWebView.kt` (the shipped renderer in a WebView + the host bridge), `ShellAssets.kt` (the asset origin and the two injections), `RoomTreeScreen.kt` (Compose), `SessionScreen.kt` (the phone's own actions), `SecureTokenStore.kt`, `L10n.kt`, `RemoteController.kt`, `MainActivity.kt` |
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

The room id is derived from the token and nothing else (§3), and a wrong token is **not an error —
it is an empty room** (the plan's §11). That is why a stray character is a silent defect rather than
a cosmetic one, and it was measured on a phone: the relay's log showed **four rooms out of four
spellings of one token** (as typed, plus a trailing space, plus a trailing newline — what a paste
produces — and with the IME capitalising the first letter).

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

- **SSE down / POST up** over plain HTTP(S) (`RelayRoutes` builds the three URLs in one place);
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
  asked of the owner's machine.

The phone announces itself with `hello` and publishes nothing: it is a replica-only peer, so it
never sends `instances`, and a peer that nevertheless asks it to `attach`/`input` gets
`error{code:"unsupported"}` instead of silence.

## 8. Build, test, install

```bash
cd remote/android
./gradlew :core:test              # 22 tests, including the vectors proof
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
  **neighbouring salt** does not open while the same bytes under the right salt do.

It is dev-only, it is not part of `vscode:prepublish` (it needs a .NET SDK and a JDK), and it
prints `PASS remote-interop: N/N checks` only when every check ran and passed.

## 9. What is verified, and what is not

Verified by **running**, on this machine:

- the vectors: all three derivations, all four seals (byte-identical `sealedHex`, opened with the
  nonce built **from `s`**), both slice sets (including each part's `s`, the splice refusal, and
  the reassembled frame's salt), the refusals, and that re-encoding each frame's plaintext
  reproduces the vectors' bytes exactly;
- `:core:test` green (22 tests) and `:app:assembleDebug` green, from a clean tree and with
  `--offline --rerun-tasks` (so the vector test genuinely re-reads `remote/vectors/vectors.json`);
- the APK contains `assets/webview/main.js`, both catalogs, the shell and the shim, and the token
  field's flags are verifiable *inside the artifact*: `dexdump -d` on the installed APK's
  `classes4.dex` shows `TokenField.applyImeFlags` computing `const v1, #00080081` before
  `setInputType` and `const v1, #11000006` before `setImeOptions` (the constants are inlined, so the
  values are what travels, not the field names);
- **`tools/remote-interop.mjs`: 35/35 checks** — a frame crossed between the Kotlin and TypeScript
  transports through the real relay, byte for byte, in both directions, multi-slice included, with
  each side opening the other's frame from the envelope's `s`, a replay refused in both
  directions, and a neighbouring salt refused (§8a);
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
- §3's grouping in the room tree is exercised against synthetic frames only.

The honest summary: the **crypto, the protocol and the wire are proved** — including across
implementations; the **UI is written and compiled, not run.**
