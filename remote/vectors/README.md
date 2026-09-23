# Remote crypto vectors

`vectors.json` is the machine-checked crypto contract for remote control. The wire
contract itself is `remote/PROTOCOL.md`: where this file and that page disagree, that
page wins, and this file is regenerated.

Two implementations are checked against it, bit for bit -- the two ends that hold a
key:

- the **TypeScript host** in the VS Code extension (`src/remote/`), today, by
  `npm run check:remote`;
- the **Android app**, Kotlin (`remote/android/`), from M3 on.

The relay (`remote/server/`) is deliberately **not** on that list. It is a dumb byte
pipe: it never parses a frame, never decrypts anything and never sees a key, so it has
nothing to verify here. It reads `remote/PROTOCOL.md` for its transport half only.

It pins PBKDF2 and HKDF key derivation, the 26-character base32 room id, the
AES-256-GCM nonce and AAD, the `ciphertext||tag` layout, the transport envelope and
the transport slices.

## Regenerate

```
node tools/gen-remote-vectors.mjs
```

The generator uses Node built-ins only, is plain ESM with no build step, and is
**deterministic**: the tokens, the connection salts and the plaintexts are fixed
literals, so a second run must write a byte-identical file. Confirm the content with
the `note` field, do not edit `vectors.json` by hand.

## What a mismatch means

A mismatch between a language's output and this file means **one implementation
drifted**. Fix that implementation; never edit the vectors to match it. Run the
generator, and if the file changes, treat the change as a protocol change that every
implementation holding a key must be updated for.

## Fields that are not obvious

- `tokenUtf8Hex` repeats the token as its UTF-8 bytes, so the encoding a vector
  assumes is explicit (one token is deliberately non-ASCII, including a
  supplementary-plane character).
- `aad` is the canonical `v|seq|fid` -- only the three facts a receiver already has
  from the transport envelope before it decrypts. `type`, `from` and `to` are inside
  the sealed plaintext, and `idx`/`last` describe a slice, so none of them is bound.
- `envelope` is the transport envelope of the logical frame, key order fixed:
  `{"v":1,"seq":7,"s":"1a2b3c4d","fid":"0011223344556677","idx":0,"last":true}`, and a
  part in `slices[].parts` is that object plus its own `b`. `s` is the connection salt
  in 8 lowercase hex characters, and it is on the wire **because a receiver must build
  the nonce before it can decrypt**: the nonce is `be64(seq) || be32(s)`, so the salt is
  not derivable from the sealed bytes. An earlier draft left it implicit inside the
  first bytes of `fid`, and two implementations then disagreed about where to find it;
  `s` is stated instead.
- `s` is **per connection**, not per token or per frame, and `seq` restarts at 1 on each
  connection. `seals[3]` is a second connection of `seals[0]`'s token with the same
  `seq` 1 and a different `s`, so the two frames carry different nonces: that pair is
  what pins the fresh salt as the replay defence, not the sequence number alone.
- `params.sliceChunkBytes` is the **reference** chunking (30000 raw bytes = 40000
  base64 characters per slice), recorded rather than required: slice boundaries are
  the sender's choice and a receiver only concatenates. Every `b` stays under 48000
  base64 characters.
- `id` (the request/response correlation id, inside the sealed plaintext) and `fid`
  (one frame's transport framing id) are **independent**. `seals[0]` makes them equal
  because a sender may; `seals[1]`, `seals[2]`, `seals[3]` and `slices[1]` keep them
  apart. Nothing is derived from `fid`: it is opaque, and the contract deliberately
  gives a framing id no structure.
- The `slices[]` entries re-use the sealed frames of `seals[0]` and `seals[2]`, so the
  slice count of the large frame can be read straight out of the file, and every part
  of one `fid` carries the same `s`.
