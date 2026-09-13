## Vision / images
- Image support is **data, not a guess**: `isVisionModel()` reads the catalog —
  the vendored `deepseek-flash` plus any `vision=true` row the user added in
  `spinney.modelTable`. Image content blocks are **only allowed in `user`
  messages** (`system` / `assistant` / `tool` reject them).
- A model that is *not* image-capable does **not** return a 400: DeepSeek
  silently replaces the image with an `[Unsupported Image]` text part and answers
  anyway (measured on the vendored base URL — the reply even reasons about the
  placeholder). That is why the harness hides image blocks itself instead of
  letting the provider do it — a silent placeholder invites the model to invent
  what it cannot see.
- **User-attached images** (file picker `pickImage` / clipboard paste) and
  **agent-read images** (`read_image`) are both uploaded to the DeepSeek Files
  API (`POST /files`, `purpose=user_data`) and referenced by the returned
  `file-api-…` id via a `file` content block
  (`{ type: 'file', file_id }`). The `onUserMessage` path uploads each
  attachment (`ChatViewProvider`) before sending; `read_image` uploads in the
  Agent (`tryReadImage`). The API auto-resizes to ~800×800 and caps each image
  at **384 tokens**, so no client-side downscaling is needed.
- Files-referenced images may be up to **64 MiB** and are **not** subject to the
  48 MiB request-body limit (inline base64 `image_url` is, but is no longer used
  for new images). Supported formats: JPEG, PNG, GIF, WebP (detected from
  content, not the filename). `content` size cap is enforced with a friendly
  error in the tool; the attach path reports per-image upload failures and omits
  them.
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
  mid-upload rejects with `DeepSeekError('Upload aborted.')` and is treated as an
  interruption rather than a failed upload.
- The webview hides image thumbnails (history and the composer preview) when the
  active model is not image-capable (`updateImageVisibility` in `main.js` toggles
  a `hide-images` class on `#messages` / `#attachments`), and refuses to queue a
  pending attachment with an inline hint. The conversation data is kept and the
  thumbnails reappear when an image-capable model is selected again. `main.js`
  has **no copy of the catalog**: the provider posts `models` + `visionModels`
  from `src/agent/models.ts` in the `config` message.

