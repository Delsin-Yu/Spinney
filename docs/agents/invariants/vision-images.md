## Vision / images
- Image support is **data, not a guess**: `isVisionCard()` reads the active **model
  card** — the built-in `deepseek-flash`, or any card the user marked
  `vision.enabled` in `spinney.modelCards` (see `invariants/model-cards.md`). Image
  content blocks are **only allowed in `user` messages** (`system` / `assistant` /
  `tool` reject them).
- A model that is *not* image-capable does **not** return a 400: DeepSeek
  silently replaces the image with an `[Unsupported Image]` text part and answers
  anyway (measured on the vendored base URL — the reply even reasons about the
  placeholder). That is why the harness hides image blocks itself instead of
  letting the provider do it — a silent placeholder invites the model to invent
  what it cannot see.
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
- When the active model is not image-capable, image blocks in the history are
  **hidden, not removed** (see `messagesForCurrentModel` in `agent.ts`): the
  stored `messages` keep the original image blocks, but the copy sent to the API
  replaces each `image_url`/`file` block with a `[image hidden: …]` text part so
  the request does not 400. Switching back to an image-capable model restores the
  image blocks automatically. `read_image` returns a similar friendly error, and
  the provider drops newly attached images with a notice.
- **An upload cannot cross providers.** A `{ type: 'file', file_id }` block is the
  *issuing* provider's private handle — another endpoint has never seen that id, so
  the same hiding rule applies when the card the request runs on is not `deepseek`
  (`vision.transport !== 'deepseek'`), with its own placeholder
  (`[image hidden: it was uploaded to a provider that this model cannot read
  from]`). An `image_url` block has no such problem: a `data:` URL is
  self-contained, so a history produced under the `openai` dialect is re-sendable
  anywhere. The harness does not keep the uploaded bytes, so it cannot convert one
  form into the other after the fact — the fix at the source is the card's
  `vision.transport`, and the runtime says so in its notice rather than letting the
  provider answer with a 400.
- A **provider-rejected image** (a 400 matching `/unsupported image/i`, e.g. a
  file the local integrity check cannot catch) follows the same hide-not-remove
  rule: `Agent.markRejectedImages` records the offending `file_id`/`image_url` in
  `Agent.rejectedImageIds` — only the message DeepSeek names in `.messages[<n>]`,
  otherwise every image in the history — and `messagesForCurrentModel` replaces
  it with `[image removed: …]` on every later request;
  `requestAssistantMessage` retries up to 8 times, emitting a `status` event.
  The stored history keeps the original block (never mutated), and the id set
  deliberately survives session switches: ids are unique per upload, so it only
  prevents repeating the same 400.
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

