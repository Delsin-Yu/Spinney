## Model capabilities: declared, never probed

**Rule:** the harness knows exactly one model's capabilities (the vendored
`deepseek-flash`) and takes every other model — including a per-model override of
the vendored one — from the user's `agentHarness.modelTable` setting. There is no
capability probe, no self-learning from an error, and no second copy of the
catalog outside `src/agent/models.ts`. If a model's context window or image
support is wrong, the fix is one line in the setting, not a network round-trip.

### Why not ask the API

Measured against `https://api.deepseek.com` (2026-09):

- `GET /models` (and `/v1/models`) returns `{id, object, owned_by}` only — the
  documented schema has no context length and no modalities. There is no
  per-model retrieve endpoint that adds anything (`GET /models/<id>` is the same
  three fields, and 404s for an id the listing omits **even when that id is
  callable** — the listing is not even an availability oracle).
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
  switch.

**Why declared instead:** a probe is a hidden request (cost, latency, and a
surprise the first time a model is selected), and its answer is only as stable as
the provider's alias mapping. That mapping provably drifts: DeepSeek's docs say
the legacy flash ids are still accepted but retired, *their requests are served by
V4.1-Flash* (which is image-capable), and the pro id is routed to V4.1-Flash on a
published date. A name cannot imply a capability, so the user declares it, as
**structured data** in `settings.json`:

```json model-table
"agentHarness.modelTable": {
  "deepseek-flash":  { "vision": true,  "max_tokens": 1048576 },
  "deepseek-v4-pro": { "vision": false, "max_tokens": 1048576 }
}
```

The setting stores data, not a mini-language: `vision` is a boolean, `max_tokens`
a number, and the key is the model id (`propertyNames.pattern` rejects spaces and
colons). A missing field keeps the vendored value for that id, or non-vision /
`DEFAULT_CONTEXT_WINDOW` for a new one. This shape is also what makes the setting
*self-explanatory in JSON* — the schema is the documentation, and the setting's
description links straight to it (see below).

### The setting is the only editor

VS Code picks a setting's widget from the contributed JSON schema and offers no
way to add one, so a three-column table (model id / vision / window) is
**impossible** there. Verified in the shipped bundle's widget factory: `complex`
→ "Edit in settings.json", `boolean`/`integer`/`number`/`string`/`enum`/`array`
→ one primitive control each, `object` → a two-column key/value list,
`boolean-object` → checkbox rows, `complex-object` → read-only preview plus the
JSON button. An array whose `items.type` is `object` is classified `complex`
(the classifier returns false for non-primitive items), and a nested object value
is pushed into the same "complex" path unless every nested schema is primitive.

So the schema deliberately stores **structured data** and accepts VS Code's
`complex-object` rendering: the settings row shows the entries read-only and hands
over to JSON through **Edit in settings.json**. Do not "fix" that with a
hand-rolled webview editor — one was tried (a chat-panel table with a column per
field, writing back through `workspace.getConfiguration().update`), and the JSON
view was judged better: the data *is* the UI, there is nothing to keep in sync,
and `settings.json` is where a model list is read, diffed and pasted.

The setting's description carries the same way in, as a markdown command link —
allowed, because the settings editor renders descriptions with
`openerService.open(href, { allowCommands: true })` and resolves `#setting.id` as
a jump to another setting:

    [settings.json](command:workbench.action.openSettingsJson?%7B%22revealSetting%22%3A%7B%22key%22%3A%22agentHarness.modelTable%22%2C%22edit%22%3Atrue%7D%7D)

That is the same call VS Code's own button makes (`openSettingsJson` with
`revealSetting: { key, edit }`), so it opens the file *on that key*, creating it if
needed.

### Where it lives

| Piece | File |
| --- | --- |
| Catalog (`VENDORED_MODEL`, `DEFAULT_MODEL`, `DEFAULT_CONTEXT_WINDOW`) | `src/agent/models.ts` |
| `parseModelTable()` — object shape, per-field defaults, error rows | `src/agent/models.ts` |
| `setModelOverrides()` + `modelSpecs()` (vendored + table, deduped by id) | `src/agent/models.ts` |
| `applyModelTable()` — read the setting, install, log | `ChatViewProvider` (constructor + `onConfigurationChanged`) |
| `resolveModel()` — an unknown id falls back to `DEFAULT_MODEL` | `ChatViewProvider` |
| `getContextWindow()` — precedence: table row → `contextWindow` → catalog → default | `ChatViewProvider` |
| The runtime gates: `isVisionModel()`, `contextWindowFor()`, `modelIds()`, `visionModelIds()` | `src/agent/models.ts` (consumers: `agent.ts`, `ChatViewProvider`, `main.js` via the `config` message) |
| The link into `settings.json` (in the setting's own description) | `package.json` `markdownDescription` → `openSettingsJson` with `revealSetting` |
| Settings (`model`, `modelTable`, `contextWindow`) | `package.json` |
| The guard: enum == catalog, no model id in `src/**` or `media/*.js`, copy names only catalog ids | `tools/check-models.js` |

A `model-table`-labelled fenced block is the one place a doc may show ids the
catalog does not have (the checker skips it) — every other mention of a model id
in README/docs must be `deepseek-flash`, and plugin text that reaches the model
must call `visionModelsLabel()` instead of naming anything.

### The context indicator is API-driven

`postContext()` sends `{used: <last request's usage.prompt_tokens>, total:
<window>}`; the webview renders `used/total`. Nothing counts tokens locally
(`media/main.js`'s `estimateTokens` is the tok/s readout, unrelated). So
`remaining = total - used` is real but **lagging**: it is what the API reported
for the *previous* request, and the turn in progress can add messages on top of
it. The ground truth for "too big" stays the API's 400, whose message names both
the window and the size it refused.
