# Plan: the image budget (bytes, not tokens)

**Status: implementing (P0–P3 approved).** This page is the contract the four slices are
built against; §3 freezes the interfaces, §4 the file ownership.

## 1. Why: two budgets, and only one of them was tracked

On 2026-09-23 a session (`mudm9cdychisuc`, node `mue7omckg1vff4`) died on

```
API error 400: .messages[561]: Total image size exceeds the limit: max 200 MB per request, got 203 MB
```

Nothing was broken in the harness — it was **blind**. Reconstructed from the transcripts:
that chain is 11 nodes / ~542 messages, and it carried **36 `read_image` uploads ≈ 179 MiB**
(`uploaded.bytes` summed; the last node alone: 12 uploads, 94.9 MiB, in one 73-minute turn of
64 rounds), because every request re-sends the whole prefix from the node's context base down.

Two independent budgets meet here, and the harness only ever watched one:

| Budget | Measured behaviour | Tracked by |
| --- | --- | --- |
| **tokens** | the endpoint resizes an image to ~800×800 and charges ~384 tokens per image (`invariants/vision-images.md`) | `usage.prompt_tokens`, the card's `contextWindow`, `contextState()` |
| **bytes** | the request carries the *uploaded* files; the provider caps the total at **200 MB per request** (and the inline transport's body at 48 MiB) | **nothing** |

The window is `1_048_576` tokens, so that chain sat at ~30% and `contextState()` was `ok` —
while its images were 203 MB. A 1 M-token window can hold on the order of a thousand images:
the token budget can never protect this path, and `MAX_IMAGE_BYTES` (64 MiB) is a *per-image*
ceiling, not a per-request one.

Consequence used as the design's foundation: since the endpoint discards everything above
~800 px anyway, a client-side downscale **loses nothing the model would have seen** — today we
upload 10 MiB so that the server can keep 800 px of it. That is what makes the transform a fix
rather than an optimisation. The one way it could regress is an endpoint that *tiles* large
images; §6 has the 30-second measurement that settles it, and the target side is one constant.

## 2. The four mechanisms

1. **The transform (P1/P2)** — `read_image` (and, P3, a user attachment) crops to an optional
   `rect` and downscales to a longest side of `IMAGE_TARGET_MAX_SIDE`, **before** the upload, so
   the bytes that ever reach the request are the small ones. PNG and JPEG natively; GIF / WebP /
   interlaced or 16-bit PNG pass through unchanged (and stay covered by the brake below).
   Because the per-image token cost is flat, `rect` is also a *capability*: a 1/16 crop costs the
   same ~384 tokens and shows that region at full detail — a zoom, not just a saving.
2. **The budget brake (P0)** — before uploading, `read_image` asks how many image bytes the
   next request would already carry; if the new image would cross the limit it is **not
   attached** and the tool answers with an ordinary `Error:` line that says how much is in use
   and **what to do instead**: delegate the looking to a sub-agent (a sub-agent's history starts
   empty, so it can see images this chain can no longer carry, and it reports back in text).
   Nothing is rewritten, so no cached prefix is invalidated. Degrades by capability: a depth-2
   sub-agent (which cannot spawn) is told to report the failure instead; a non-vision card never
   sees `read_image` at all.
3. **A byte-full window is a full window (P0)** — the provider's refusal is the same *kind* of
   statement as "maximum context length …" (the only authoritative one; `model-capabilities.md`),
   so it must offer the same way out. `windowFullReason()` classifies both, `nodeContextFull()`
   accepts both, and the `⧉` rollover becomes available — which is exactly the right action,
   because a rollover's new window **does not carry attachments** (§6 of `context-rollover.md`).
   Today that card is a dead end: `contextState()` is `ok`, so no button is offered.
4. **Provenance records the transform (P1/P2)** — a node's `imageSources` entry for an upload
   gains `bytes` and the transform that produced it, so (a) the budget is computable exactly and
   (b) the copy of a chain can *in principle* rebuild the **same view** instead of inlining the
   raw source file (today a 10 MiB sheet exceeds `INLINE_IMAGE_LIMIT_BYTES` and a fork turns
   it into a placeholder).

   *(b) is deliberately half-landed:* `materialiseMessages` now **refuses** to re-inline the raw
   source of a transformed upload — it degrades to the existing placeholder rather than silently
   showing a copy a different image, and rather than re-inflating the bytes the transform exists
   to avoid (`runtime.ts`, the `source.transform` branch). The faithful replay needs the
   *derived* bytes, and re-running `transformImage` at fork time would decode every image of the
   copied tree inside a click handler (36 big PNGs in the chain that started this work — seconds,
   not milliseconds), so it belongs behind a derived-bytes cache (`Map` keyed by
   `srcPath` + `rect` + target side, filled where the bytes are in hand: `prepareAttachment` and
   the tool's own upload, under an LRU byte cap) and an async pre-pass in `forkTree`. Until then
   the copy keeps the placeholder, which is honest: the provenance still says where the bytes are.

## 3. Interfaces (frozen)

`src/agent/imageTransform.ts` — pure, `vscode`-free, `node:zlib` only:

```ts
export interface Rect { x: number; y: number; w: number; h: number }
/** Longest side an image is reduced to. Tune after the §6 measurement. */
export const IMAGE_TARGET_MAX_SIDE: number;          // 1024
/** `rect` accepted from the model, clamped to the image, or an error sentence. */
export function normalizeRect(raw: unknown, width: number, height: number):
  { rect?: Rect; error?: string };
export interface TransformOutcome {
  bytes: Uint8Array; mime: string;
  width: number; height: number;          // the result's own size
  sourceWidth: number; sourceHeight: number;
  rect?: Rect;                            // the part of the source that was kept
  scale: number;                          // ≤ 1; 1 = crop only, or untouched
  changed: boolean;                       // false ⇒ `bytes` is the input, verbatim
  reason?: string;                        // why not changed (unsupported variant …)
}
/** Never throws for a bad image: an unreadable/unsupported input is `changed: false`. */
export async function transformImage(input: {
  bytes: Uint8Array; mime: string; rect?: Rect;
}): Promise<TransformOutcome>;
```

Supporting pure modules (same rules): `src/agent/pngCodec.ts`
(`decodePng(bytes) → { width, height, data: Uint8Array /* RGBA */ } | { error }`,
`encodePng({ width, height, data }) → Uint8Array`, 8-bit non-interlaced, colour types 0/2/3/4/6,
filters 0–4, adaptive re-filtering), `src/agent/imageResample.ts`
(`cropResample(src, rect, targetMaxSide) → { width, height, data, scale }`, area-average on
downscale, no upscale), `src/agent/jpegDecode.ts`
(`decodeJpeg(bytes) → { width, height, data: Uint8Array /* RGBA */ } | { error }`, baseline
sequential only), split as `jpegEntropy.ts` (markers, huffman, coefficients) and
`jpegReconstruct.ts` (dequant, IDCT, chroma upsampling, colour) behind a frozen seam (§4).

`src/agent/agent.ts`:

```ts
/** What the runtime knows about the images a request would carry. */
export interface ImageAccounting {
  /** Bytes behind one image content part, or undefined when unknown. */
  bytesOf: (part: ContentPart) => number | undefined;
  /** The limit for this card's transport (200 MB referenced, 48 MiB inline). */
  limitBytes: number;
}
setImageAccounting(accounting: ImageAccounting | null): void;
/** `read_image` uploads, now with the bytes actually sent and the transform used. */
getImageUploads(): { fileId: string; providerId: string; path?: string; bytes: number;
                     transform?: ImageTransformRecord }[];
```

`src/chat/tree.ts` (persisted provenance — optional fields, no version bump; the record type
is `ImageTransformRecord` from `src/agent/imageTransform.ts`, imported like `ChatMessage` is
today):

```ts
export type ImageSource =
  | { kind: 'upload'; providerId: string; fileId: string; srcPath?: string;
      bytes?: number; transform?: ImageTransformRecord }
  | { kind: 'inline'; dataUrl: string; bytes?: number; transform?: ImageTransformRecord };
```

`src/agent/models.ts`:

```ts
/** The provider's per-request image ceiling (bytes), and the inline body's own cap. */
export const MAX_REQUEST_IMAGE_BYTES: number;    // 200 MB, less a safety margin at use sites
export const INLINE_REQUEST_BODY_BYTES: number;  // 48 MiB
/** `'tokens' | 'images' | undefined` — the refusal's kind, from its text alone. */
export function windowFullReason(text: string): 'tokens' | 'images' | undefined;
```

`imageTransform.ts` also exposes `readImageSize(bytes, mime)` — a synchronous header read
(PNG `IHDR`, JPEG `SOFn`), so the tool can validate a `rect` before decoding anything.

## 4. Slices and file ownership (one writer per file)

| Slice | Owns | Delivers |
| --- | --- | --- |
| **A1** codec | `src/agent/imageTransform.ts`, `pngCodec.ts`, `imageResample.ts`, `src/agent/types.ts` (export the existing CRC helper only), `tools/check-image.js` | P1+P2 bytes-in/bytes-out, `rect`, PNG fixtures |
| **A2** jpeg | `src/agent/jpegDecode.ts`, `jpegEntropy.ts`, `jpegReconstruct.ts`, `tools/check-jpeg.js` | P3's JPEG decode, PIL-oracle verified |
| **B1** state | `src/agent/models.ts`, `src/chat/tree.ts` | P0 parser + constants; provenance shape + normalization |
| **B2** runtime | `src/chat/runtime.ts` | budget accounting, `⧉` recognition, attach-path transform, fork re-materialisation |
| **C** tool | `src/agent/agent.ts`, `src/agent/tools/readImage.ts` | the brake, the `rect` argument, the transform call, the delegation hint |
| **D** docs | `docs/agents/**` (except `plans/image-budget.md`), `AGENTS.md`, `CHANGELOG.md`, `manual/**` | the invariant corrections |
| **E** (me) | `package.json`, integration | guard wiring, compile, package, reload |

No new user-visible string: every new sentence is model-facing English (tool result, rollover
note, log line) — the `MAX_IMAGE_BYTES` precedent — so no l10n catalog changes.

## 5. Phases

- **P0** — B1 parser/constants · C brake + delegation hint · B2 `nodeContextFull`/rollover reason.
  Landing: the failing card offers `⧉`, and `read_image` refuses instead of walking into the wall.
- **P1** — A1 PNG transform · C transform call + result text · B2 attach path + provenance bytes.
- **P2** — A1 `rect` + `normalizeRect` · C schema/argument · result text names the source size and
  how to zoom.
- **P3** — A2 JPEG decoder · B2 composer attachments through the same transform.

## 6. Open measurements and risks

- **The 800 px / 384-token rule is the premise.** Verify it in the UI in 30 seconds: read one
  4000 px image, then a pre-shrunk copy of the same image, and compare the `usage.prompt_tokens`
  delta. Identical ⇒ the server discards those pixels anyway. If it does *not* hold (tiling),
  the transform still cuts bytes but reduces what the model sees — lower `IMAGE_TARGET_MAX_SIDE`
  only after this measurement.
- **Host-thread cost.** The extension host is single-threaded and `session-persistence.md` counts
  a blocked second as a bug: 4000×3000 is 12 M pixels, so the decoder yields to the event loop
  every N rows instead of blocking. If a measured turn says otherwise, move the codec to a
  `worker_threads` worker.
- **The decoder must not certify itself.** A pure-JS encoder + decoder pair can share a bug, so
  `check:image` decodes fixtures produced by an **independent** tool and compares pixels, not just
  round-trips.
- **Two writers, one file**: a change under `src/**` needs `npm run compile` clean before it is
  finished (`AGENTS.md`, closing procedure).

## 7. Guards

`npm run check:png`, `check:resample`, `check:image` and `check:jpeg` (plain node, driving `out/`
like every other guard), with `check:image` as the aggregate; all four wired into
`vscode:prepublish` by slice E. The image fixtures and their expectations are checked in under
`tools/fixtures/`, and the two generators (`tools/gen-image-fixtures.py`, `tools/gen-jpeg-fixtures.py`)
reproduce them byte-for-byte with PIL — which is what makes the oracle independent rather than
self-certifying.

## 8. Landing record

Landed P0–P3. What is worth knowing when reading the diff:

- **A defect found by the work's own guard, and fixed.** A downscale-only transform could *grow*
  the upload — 5.03× on a flat 600×1500 PNG, **10.65× on a small lossy JPEG** (whose only
  re-encode path is PNG, since this build has a JPEG decoder and no encoder). `transformImage` now
  discards a re-encode that is not smaller than its input and sends the original instead
  (`changed: false`, reason named), *except* when a `rect` was asked for — a crop is a view the
  model requested and is always honoured, even when it is bigger. The guard asserts the reason
  string, and a mutation test on `out/` (clamp disabled → 6 failures) proves the case can fail.
- **Per-agent accounting, not a process global.** The brake's view was first written as a
  module-level "last call wins" singleton; branches, sessions and sub-agents run in parallel here,
  so it would have answered one chain's request with another chain's index. It is now an `Agent`
  field installed by its own provider (`SessionRuntime.workerFor` / `runSubAgent`).
- **The brake computes its numbers from the bytes actually sent**: the upload's own byte count
  (`uploaded.bytes`), the `data:` URL's length inline, and the transform runs *before* the check —
  so a huge source that shrinks is never refused for its size on disk.
- **Measured, on this machine**: crop+resample of 4000×3000 → 1024×768 ≈ **74 ms**; a 12 MP JPEG
  ≈ 87–90 ms entropy decode + ≈ 256 ms reconstruction. No `worker_threads` worker is needed at
  these numbers; the codec still yields to the event loop every 64 rows (`PNG_YIELD_ROWS`).
- **Deliberate bounds**: the JPEG decoder refuses a frame above `MAX_FRAME_BLOCKS` (1 << 20 ≈ 22 MP
  at 4:4:4) *before* allocating, rather than trusting a header that could ask for gigabytes; such a
  file passes through untransformed. Non-baseline JPEG, 16-bit / interlaced / 1–4-bit PNG, and
  animated GIF/WebP are all pass-through, which the brake then covers.
- **Open item — the fork replay (§2.4b).** `materialiseMessages` refuses to re-inline the raw
  source of a transformed upload (it degrades to the existing placeholder), so a copied chain never
  shows a different image than the original saw — but it also does not yet rebuild the *same* view.
  The faithful replay needs a derived-bytes cache plus an async pre-pass in `forkTree`, because
  decoding every image of the copied tree inside a click handler is seconds of frozen UI.
- **Open measurement (§6).** The ~800 px / 384-token behaviour of the endpoint is still the
  premise, taken from `invariants/vision-images.md`; the 30-second `usage.prompt_tokens`
  comparison described in §6 has not been run in this tree, and it is what would justify moving
  `IMAGE_TARGET_MAX_SIDE`.

## Related

- `invariants/vision-images.md` — the per-image rules this extends with a per-request one.
- `invariants/context-rollover.md` — a window can be full **by bytes**.
- `invariants/model-capabilities.md` — why the refusal text is the trigger, never a threshold.
- `invariants/sub-agents.md` — why "delegate it" is the escape hatch, and what depth-2 may not do.
