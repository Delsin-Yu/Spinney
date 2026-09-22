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
  API auto-resizes to ~800×800 and caps each image at **384 tokens**, so no
  client-side downscaling is needed.
- Images may be up to **64 MiB** (`MAX_IMAGE_BYTES`). A `deepseek`-transport image is
  **not** subject to the 48 MiB request-body limit; an `openai` (inline) one is,
  because its base64 `data:` URL rides in the body. Supported formats: JPEG, PNG, GIF, WebP
  (detected from content, not the filename). The 64 MiB cap is enforced with a
  friendly error in the tool; the attach path reports per-image upload failures and
  omits them.
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
  | `deepseek` → another provider | bytes are recovered (a `data:` URL is already inline, or a local `srcPath` is re-read up to `INLINE_IMAGE_LIMIT_BYTES`, 8 MiB) → an `image_url` part; otherwise the placeholder |
  | `openai` → anything | an inline `data:` URL is self-contained and is carried over as is |
  | anything → a non-image-capable card | the placeholder `[image hidden: the current model does not support images]`, with the provenance kept so a later epoch can bring it back |

  Provenance is what makes this possible, and it is **persisted beside the messages**
  (`TreeNode.imageSources`, addressed by `{ messageIndex, partIndex }`, never inside a
  content part): the attach path records `{ kind: 'inline', dataUrl }` (the composer's
  own data URL) or `{ kind: 'upload', providerId, fileId }`, and `read_image` uploads
  are recorded from `Agent.getImageUploads()` by `SessionRuntime.recordUploadSources`
  when the turn is stored (with the local source path when there was one). A fork
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

