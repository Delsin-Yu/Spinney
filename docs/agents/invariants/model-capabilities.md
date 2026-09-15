## Model capabilities: declared, never probed

**Rule:** the harness knows exactly one model's capabilities — the built-in
fallback card `deepseek-flash` in `src/agent/models.ts` — and takes every other from
the user's **model cards** (`spinney.modelCards`). There is no capability probe, no
self-learning from an error, and no second copy of the catalog outside
`src/agent/models.ts`. If a card's context window, image support or image transport is
wrong, the fix is one field on that card in the Model Card Tree page, not a network
round-trip. The declaration lives **on the card** now — `contextWindow`,
`vision.enabled`, `vision.transport` — where it sits next to the wire model name it
describes and travels with the session that picked it (see `model-cards.md`).

### Why not ask the API

Measured against `https://api.deepseek.com` (2026-09):

- `GET /models` (and `/v1/models`) returns `{id, object, owned_by}` only — the
  documented schema has no context length and no modalities. There is no
  per-model retrieve endpoint that adds anything (`GET /models/<id>` is the same
  three fields, and 404s for an id the listing omits **even when that id is
  callable** — the listing is not even an availability oracle). It therefore cannot
  fill in a card's `contextWindow` or `vision` even if the harness wanted it to.
- No tokenizer endpoint exists (`/tokenize`, `/tokens`, `/count_tokens` are 404),
  and no response header carries a limit, so there is nothing to read for free.
- The only authoritative runtime statement of a context window is the 400 text:
  `This model's maximum context length is 1048576 tokens. However, you requested
  …`. The max output is likewise announced by a rejected request
  (`Invalid max_tokens value, the valid range of max_tokens is [1, 393216]`).
- Vision is detectable by probe (send one synthetic image twice and compare
  `usage.prompt_tokens`: a text-only model's count barely moves, an image-capable
  model's jumps) — but a text-only model does **not** error on an image: the
  provider swaps it for an `[Unsupported Image]` text part and answers anyway.
  A probe would therefore have to be *interpreted*, and would run on every model
  switch; and it could not tell you which of the two **transports** the endpoint
  wants.

**Why declared instead:** a probe is a hidden request (cost, latency, and a
surprise the first time a model is selected), and its answer is only as stable as
the provider's alias mapping. That mapping provably drifts: DeepSeek's docs say the
legacy flash ids are still accepted but retired, *their requests are served by
V4.1-Flash* (which is image-capable), and the pro id is routed to V4.1-Flash on a
published date. A name cannot imply a capability — and a card's `oaiModel` is exactly
such a name — so the user declares it, as **structured data** on the card.

### The card is the declaration; the page is its editor

A card is `{ name, providerId, oaiModel, contextWindow, concurrency, vision: {
enabled, transport }, efforts, defaultEffort }` under `spinney.modelCards`, and its
provider is a row under `spinney.providers`. Both are **structured data** — an object
of id → fields — because that is what a hand-edited `settings.json` should contain:
the schema is the documentation, and the file is where a model list is read, diffed
and pasted. A field the user leaves out keeps a sane default (non-vision / the
built-in window), and a row that cannot be parsed is skipped and reported, so the
settings can never silently half-apply.

The editor is the **Model Card Tree page** (`Spinney: Open Model Cards`,
`invariants/model-cards.md`): it holds a draft, validates it client-side, and posts
the whole desired state to the host, which re-validates (`validatePayload`) and
writes `settings.json` through `configuration.update`. VS Code's Settings UI cannot
be that editor: it picks a setting's widget from the contributed JSON schema and
offers no way to add one, so a multi-column editable table is **impossible** there.
Verified in the shipped bundle's widget factory: `complex` → "Edit in
settings.json", `boolean`/`integer`/`number`/`string`/`enum`/`array` → one primitive
control each, `object` → a two-column key/value list, `boolean-object` → checkbox
rows, `complex-object` → read-only preview plus the JSON button. An array whose
`items.type` is `object` is classified `complex` (the classifier returns false for
non-primitive items), and a nested object value is pushed into the same "complex"
path unless every nested schema is primitive.

So the settings row deliberately stays **a read-only preview plus a link into
`settings.json`** (VS Code's `complex-object` rendering, handed over via **Edit in
settings.json**) — it is the fallback view, not the editor. The page is the editor.
The data *is* the UI on the page: there is nothing to keep in sync, and a save is
followed by the parsed truth being posted straight back, so a repaired field shows
up in the page instead of diverging from it.

### Where it lives

| Piece | File |
| --- | --- |
| Catalog (the built-in `VENDORED_MODEL` / `VENDORED_CARD`, `DEFAULT_MODEL`, `DEFAULT_CONTEXT_WINDOW`, `MAX_IMAGE_BYTES`) | `src/agent/models.ts` |
| `parseCatalog()` (`parseProviderRow` / `parseCardRow` / `parseVision`) — object shape, per-field defaults, error rows | `src/agent/models.ts` |
| `applyModelCards()` — read the two settings, install the catalog, log | `ChatViewProvider` (constructor + `onConfigurationChanged`) |
| `resolveModel()` — a card id (or a name, or a wire name) resolves; anything else falls back to the first usable card | `ChatViewProvider` |
| `getContextWindow()` — a card id's own window, else the default | `ChatViewProvider` → `contextWindowFor()` in `src/agent/models.ts` |
| The runtime gates: `isVisionCard()`, `contextWindowFor()`, `cards()` / `cardIds()`, `visionCards()`, `visionCardsLabel()` | `src/agent/models.ts` (consumers: `agent.ts`, `ChatViewProvider`, `runtime.ts`, `media/main.js` via the `config` message) |
| The declaration's editor (the page, its validation, the read-back) | `src/chat/ModelPanel.ts` · `src/chat/modelTree.ts` · `media/modeltree.js` |
| Settings (`model`, `providers`, `modelCards`) | `package.json` |
| The guard (`npm run check:models`): `spinney.model.default` == the fallback, the two catalog settings exist, no `enum` on `spinney.model`, no model id in `src/**/*.ts` / `media/*.js` (the catalog module and the vendored bundles excepted), and README/docs may name only ids the catalog has | `tools/check-models.js` |

Every mention of a model id in README/docs must be one the catalog has — today that is
only the built-in one (`tools/check-models.js` fails an id `MODEL_CATALOG` does not
carry) — and plugin text that reaches the model must call `visionCardsLabel()` /
`cardDisplayName()` instead of naming anything.

### The context indicator is API-driven

`postContext()` sends `{ type: 'context', used: <last request's usage.prompt_tokens>,
total: <window>, model: <card id> }`; the webview renders `used/total`. Nothing counts tokens locally
(`media/main.js`'s `estimateTokens` is the tok/s readout, unrelated). So
`remaining = total - used` is real but **lagging**: it is what the API reported
for the *previous* request, and the turn in progress can add messages on top of
it. The ground truth for "too big" stays the API's 400, whose message names both
the window and the size it refused.

That 400 text now has a **second consumer**: `parseContextLengthError()` in the
same catalog module reads the window and the refused size back out of it, and that
is what triggers a context rollover (`context-rollover.md`) — the provider's
refusal, never a local threshold, because a threshold would have to fire before
the window is full and would therefore have to summarise. `usage.prompt_tokens`
is **never a trigger, only a readout**: it is the *previous* request's number, and
it has already lied once — the header read `ctx 65%` while the request that failed
carried ~1.28 M tokens. When the window named in the 400 disagrees with
`contextWindowFor()`, nothing is compared and nothing is logged — only the fact of
the refusal is used — and the mismatch is never written back into the card's
`contextWindow`: the declared field is the
user's data, and a stale window is their one-field fix in the Model Card Tree page,
not something the harness corrects behind them.
