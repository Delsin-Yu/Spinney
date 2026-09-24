## Vision / images
- Image support is **data, not a guess**: `isVisionCard()` reads the active **model
  card** — the built-in `deepseek-flash`, or any card the user marked
  `vision.enabled` in `spinney.modelCards` (see `invariants/model-cards.md`). Image
  content blocks are **only allowed in `user` messages** (`system` / `assistant` /
  `tool` reject them).
- A model that is *not* image-capable does **not** return a 400: DeepSeek
  silently replaces the image with an `[Unsupported Image]` text part and answers
  anyway (measured on the vendored base URL — the reply even reasons about the
  placeholder). That is why the harness never lets an image block reach such a
  card: a newly attached image is refused at the composer boundary
  (`onUserMessage`, with a notice naming an image-capable card), `read_image`
  answers with its own friendly error (`tryReadImage`), and a **copied** history is
  materialised with a placeholder text part instead (the materialisation bullet
  below) — a
  silent placeholder invites the model to invent what it cannot see.
- **User-attached images** (file picker `pickImage` / clipboard paste) and
  **agent-read images** (`read_image`) both follow the card's `vision.transport`
  (`invariants/model-cards.md`). The `deepseek` dialect uploads to the Files API
  (`POST /files`, `purpose=user_data`) and references the returned `file-api-…` id
  via a `file` content block (`{ type: 'file', file_id }`); `openai` puts a `data:`
  URL in an `image_url` part instead (see `model-cards.md`). The `onUserMessage`
  path uploads each attachment (`SessionRuntime.onUserMessage` in
  `src/chat/runtime.ts`) before sending when the transport is `deepseek`;
  `read_image` does it in the Agent (`tryReadImage`). On the DeepSeek endpoint the
  API auto-resizes to ~800×800 and caps each image at **384 tokens**. That is the
  **token** budget — and it is a different budget from the one the request actually
  puts the image into: the request carries the *uploaded* file, the provider caps the
  total per request at **200 MB** (`MAX_REQUEST_IMAGE_BYTES`), and the inline
  transport caps its own body at **48 MiB** (`INLINE_REQUEST_BODY_BYTES`), neither of
  which any readout watches. Because the endpoint charges per image and not per
  pixel, the token budget can read `ok` while the bytes walk into that wall: the
  window here is `1_048_576` tokens, so a chain can hold on the order of a thousand
  images — the incident in `plans/image-budget.md` §1, where `contextState()` said
  `ok` at ~30 % and the request carried 203 MB.
- Images may be up to **64 MiB** (`MAX_IMAGE_BYTES`) — a **per-image** ceiling, in a
  different budget from the per-request one below. A `deepseek`-transport image is
  **not** subject to the 48 MiB request-body limit; an `openai` (inline) one is,
  because its base64 `data:` URL rides in the body. Supported formats: JPEG, PNG, GIF, WebP
  (detected from content, not the filename). The 64 MiB cap is enforced with a
  friendly error in the tool; the attach path reports per-image upload failures and
  omits them.
- **The bytes are cut before the upload, never after it.** `read_image` — and, per
  `plans/image-budget.md` P3, a composer attachment — crops to an optional `rect` and
  downscales to a longest side of `IMAGE_TARGET_MAX_SIDE` (`1024`) **before** the
  upload (`transformImage` in `src/agent/imageTransform.ts`), so the bytes that ever
  reach the request are the small ones. PNG and JPEG are transformed natively; GIF,
  WebP and an interlaced or 16-bit PNG pass through unchanged and stay covered by the
  budget brake below. The output is re-encoded as PNG. A `TransformOutcome` with
  `changed: false` means `bytes` is the input, verbatim — a small image, or an
  unreadable/unsupported one, which never throws.
- **The transform is a fix, not an optimisation — it loses nothing the model would
  have seen.** The endpoint discards everything above ~800 px anyway
  (`plans/image-budget.md` §1; the 30-second `usage.prompt_tokens` measurement in its
  §6 is what settles whether the server *tiles* instead of discarding): today we
  upload 10 MiB so that the server can keep 800 px of it. And because the per-image
  token cost is **flat**, `rect` is also a **capability**, not just a saving — a 1/16
  crop costs the same ~384 tokens and shows that region at full detail.
- **The budget brake: an image that would not fit is not attached, and the model is
  told what to do instead.** Before uploading, `read_image` asks how many image bytes
  the *next* request would already carry; if the new image would cross the limit it is
  **not attached**, and the tool answers with an ordinary `Error:` line that says how
  much is in use and **what to do instead** — delegate the looking to a sub-agent (its
  history starts empty, so it can see images this chain can no longer carry, and it
  reports back in text; `sub-agents.md`). Nothing is rewritten, so no cached prefix is
  invalidated. It degrades by capability: a depth-2 sub-agent (which cannot spawn) is
  told to report the failure instead, and a non-vision card never sees `read_image` at
  all. The same sentence names the `⧉` rollover as the other way forward, since a new
  window starts without the images too (`context-rollover.md`).
- **Four constants, two budgets — do not confuse them.** `MAX_REQUEST_IMAGE_BYTES` is
  the provider's **per-request** ceiling (200 MB, less a safety margin at the use
  site); `INLINE_REQUEST_BODY_BYTES` (48 MiB) is the inline transport's own body cap;
  `IMAGE_BUDGET_RATIO` (0.9) is the fraction of that ceiling at which the brake fires.
  The ratio has to sit **below** the wall, not at it: the next request carries what is
  already there, so a brake that fired exactly at the wall would arrive one image too
  late. `MAX_IMAGE_BYTES` (64 MiB) is a **per-image** ceiling and nothing more — the
  two are different budgets, which is why a per-image cap can never protect this path.
- `npm run check:image` and `npm run check:jpeg` are the guards over this path — the PNG
  codec, the resampler, the bytes-in/bytes-out transform and the JPEG decoder — with the
  fixtures verified against an independent tool (PIL) rather than against this repository's
  own encoder; see `testing.md`.
- PNG uploads get a structural check on top of magic-byte detection
  (`imageIntegrityError` in `types.ts`, called by `uploadFile`): every chunk CRC
  and the `IEND` terminator are verified, so a truncated/corrupt PNG is rejected
  locally with a reason (`bad CRC in the IDAT chunk`, …) instead of a provider
  400.
- When the active model is not image-capable, newly attached images are **dropped
  with a notice** at the composer boundary (`onUserMessage` refuses them before a
  request is built), and the webview hides thumbnails and refuses to queue a pending
  attachment. What no longer exists is the **send-time hiding of stored images**:
  `messagesForCurrentModel` is deleted, and with it the whole "hide, not remove"
  rule — a stored history is not rewritten on its way out, ever. An image block's
  wire form is decided **once**, not per request: at attach / `read_image` time for
  the live turn (see the transport bullet above), and by
  `SessionRuntime.materialiseMessages` when a chain is **copied** into a new epoch
  (the bullet below). What the node stores is what the API receives.
- **Materialisation happens in `forkTree`** (`SessionRuntime.materialiseMessages`,
  `src/chat/runtime.ts`), never per request. It is the only place an image block's
  wire form is decided for a copied chain, and it is **best effort**: an image whose
  bytes cannot be recovered becomes an ordinary placeholder text part
  (`[image hidden: …]`, the two `MATERIALISED_*` constants in `runtime.ts`) and the
  fork still succeeds — a chain is never left unsendable because of an image. The
  matrix it implements:

  | from → to | what happens |
  | --- | --- |
  | `deepseek` → the same provider account | the `file_id` is reused as is (the issuing account can still read its own handle) |
  | `deepseek` → another provider | bytes are recovered (a `data:` URL is already inline, or a local `srcPath` is re-read up to `INLINE_IMAGE_LIMIT_BYTES`, 8 MiB) → an `image_url` part; a **transformed** upload is *not* re-inlined from its source, so it degrades to the same placeholder as an unreachable or over-limit source |
  | `openai` → anything | an inline `data:` URL is self-contained and is carried over as is |
  | anything → a non-image-capable card | the placeholder `[image hidden: the current model does not support images]`, with the provenance kept so a later epoch can bring it back |

  Provenance is what makes this possible, and it is **persisted beside the messages**
  (`TreeNode.imageSources`, addressed by `{ messageIndex, partIndex }`, never inside a
  content part): the attach path records `{ kind: 'inline', dataUrl, bytes?, transform? }`
  (the composer's own data URL) or `{ kind: 'upload', providerId, fileId, bytes?, transform? }`,
  and `read_image` uploads
  are recorded from `Agent.getImageUploads()` by `SessionRuntime.recordUploadSources`
  when the turn is stored (with the local source path when there was one). `bytes` is
  the payload actually sent — not the size of the file behind it — and `transform` is
  the `ImageTransformRecord` that produced it, and the two exist for two reasons: (a)
  the per-request byte budget is then arithmetic over `imageSources` alone,
  computable **exactly** on the next request, and (b) the recorded transform is the
  **interface** a faithful copy needs — replaying it is what would rebuild the **same
  view** for a copied chain instead of inlining the raw source file. That replay is
  **not landed**: a `file` part whose source is an upload carrying a `transform` is
  deliberately not re-inlined from `srcPath`, and becomes the same
  `MATERIALISED_FOREIGN_UPLOAD` placeholder an unreachable or over-limit source
  already does — the chain that recorded the transform saw the cropped/downscaled
  view, so inlining the original would silently show the copy a *different* image, and
  it would re-inflate exactly the bytes the transform exists to avoid (a 10 MiB sheet
  becomes ~13 MiB of base64). A `rect` is why the raw source can never stand in for
  the derived bytes: the crop and the downscale are part of what the model saw.
  Re-running `transformImage` at fork time is rejected on purpose (it would decode
  every image of the copied tree inside a click handler), so the open item is a
  derived-bytes cache plus an async pre-pass in `forkTree`
  (`plans/image-budget.md` §2.4). A fork
  copies the provenance it did not have to change, so a placeholder in a copy can be
  turned back into an image by the next epoch that can read it.
- **A provider-rejected image is repaired in the history, once, deliberately.**
  A 400 matching `/unsupported image/i` that the local integrity check cannot catch
  is still the Agent's job to detect — `Agent.markRejectedImages` keeps finding *which*
  images to repair (only the message DeepSeek names in `.messages[<n>]`, otherwise
  every image in the history) — but its repair is now **persistent**: the offending
  block is replaced **in the stored message** by the placeholder text
  (`IMAGE_NEEDS_VISION` in `agent.ts`), so the request that is retried (up to 8 times,
  with a `status` event) carries the placeholder in the history itself. The
  provenance entry is kept, so a later epoch can materialise the image again; the
  retry costs nothing extra, because the refused request cached nothing past that
  block. `Agent.rejectedImageIds` and the old "hide it on every later request" set are
  gone with `messagesForCurrentModel`.
- Uploads are abortable: the attach path (`onUserMessage`) and `read_image`
  (`tryReadImage`) both pass an `AbortSignal` to `uploadFile`, so pressing Stop
  mid-upload rejects with `ApiError('Upload aborted.')` and is treated as an
  interruption rather than a failed upload.
- The webview hides image thumbnails (history and the composer preview) when the
  active model is not image-capable (`updateImageVisibility` in `media/main.js`
  toggles a `hide-images` class on `#tree-canvas` / `#attachments`), and refuses
  to queue a pending attachment with an inline hint. The conversation data is kept and the
  thumbnails reappear when an image-capable model is selected again. `media/main.js`
  has **no copy of the catalog**: the provider posts the whole `cards` list (each
  with its `vision` flag) and the active card's `efforts` in the `config` message,
  all derived from `src/agent/models.ts`.

