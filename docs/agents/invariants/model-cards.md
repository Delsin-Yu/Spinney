## Model configuration: provider nodes and model cards

**Rule:** the unit of model configuration is a **model card**, and every card
branches off exactly one **provider node**. Nothing in the harness is configured by
a bare model id any more: a card is what the user picks in the chat, what a session
stores, what a transcript records, and what a request is built from. The settings are
`spinney.providers` (an object of provider id → `{ name, baseUrl, concurrency }`),
`spinney.modelCards` (an object of card id → card fields), and `spinney.model` (the
**card id** of the default card). The Model Card Tree page (`Spinney: Open Model Cards`)
is the editor of those three keys.

### The two shapes

A **provider node** is one OpenAI-compatible endpoint:

| Field | Meaning |
| --- | --- |
| id | The settings key. `default` is the built-in provider and is always present; the page generates a fresh id for anything else. |
| name | What the user sees — the dropdown's `optgroup` label, the balance/nudge text. A row that leaves it out is named after its URL's host (`providerNameFromUrl`: the host, except for the one endpoint this harness ships knowledge about — `api.deepseek.com` → `DeepSeek`). |
| baseUrl | The API root, e.g. `https://api.deepseek.com`. Every chat request is `POST <baseUrl>/chat/completions`, an image upload is `POST <baseUrl>/files`, and the wallet line is `GET <baseUrl>/user/balance`. |
| concurrency | Maximum requests in flight against that endpoint; `0` = unlimited. |

The API key is **not** in settings. SecretStorage holds one entry per provider —
`spinney.apiKey` for the built-in one, `spinney.apiKey.<providerId>` for every other
(`apiKeySecretName` in `src/chat/modelTree.ts`) — set from the page or by the
`spinney.setApiKey` command, which takes an optional provider id. The
`DEEPSEEK_API_KEY` environment variable is the fallback for the built-in provider
only. It lives in SecretStorage rather than a setting because a provider table is
user data and a key is a secret: the same split the single-key build made, now per
provider.

A **model card** is one selectable model:

| Field | Meaning |
| --- | --- |
| id | A GUID the page generates. It is the value every persisted surface holds — `session.model`, `spinney.model`, the `model` argument of `spawn_agents`, the model dropdown — and it **never changes**. |
| name | What the user calls it: the dropdown line, the system prompt's identity line, the transcript meta, the control plane's `modelName`. |
| providerId | The one provider this card routes to. A card branches off exactly one, and a card whose provider was deleted heals to the built-in provider. |
| oaiModel | The only thing that travels as `body.model`. |
| contextWindow | The card's own window, for the context-usage indicator. It is not the API's `max_tokens` output budget. |
| vision | `{ enabled, transport }` — see below. |
| efforts | A free-form list of thinking levels this card offers. |
| defaultEffort | The level a session starts on; it must be one of `efforts`. |
| concurrency | Maximum requests in flight for this card; `0` = unlimited. |

**Why an id (a GUID) separate from the name:** renaming a card, or renaming its
provider, must not invalidate anything already persisted. Every stored surface keeps
the id, so a rename is safe by construction; only the wire request reads `oaiModel`.
The one card the extension ships knowledge about — the built-in fallback,
`deepseek-flash` — is the one id that is not a GUID.

### Effort levels are the card's, and `none` is literal

`efforts` is free-form: a card may offer `['minimal', 'thorough']` or the historical
four. The old fixed enum (`none | low | medium | high`) and the
`spinney.thinkingEffort` setting are gone; each card declares its own levels and its
own default. A session pick that the current card does not offer is **clamped to
that card's default** (`normalizeEffort`), never sent raw — a provider must never
receive a level its model was not declared with.

The literal `none` is the one reserved value: it means *omit `reasoning_effort`
entirely* (the API's own default) and keep the effort sentence out of the system
prompt. It is the literal string, not the absence of a level, because a card that
offers no thinking at all still needs a level name to be the default. Every fresh
card starts on `BUILTIN_EFFORTS` (`none, low, medium, high`) with `DEFAULT_EFFORT`
(`medium`), so a hand-created card starts where the built-in one does.

### Vision is a per-card declaration with a transport

`vision.enabled` gates the whole image path: attach/paste in the composer, the
`read_image` tool, and thumbnail visibility. `vision.transport` picks **which vendor
dialect** the bytes travel in — the two names are what a user actually chooses
between, so they are named after the dialect rather than after the mechanism:

| Transport | Request |
| --- | --- |
| `deepseek` | Upload to `POST <baseUrl>/files`, then a `{ type: 'file', file_id }` part (the DeepSeek Files API). Up to 64 MiB, not subject to the request-body limit. |
| `openai` | A `data:` URL in an `image_url` part — the OpenAI-compatible shape, so it is what a local vLLM / llama.cpp / gateway expects. Same 64 MiB ceiling locally, but the bytes occupy the request body. |

`openai` is the **default**: it is the standard shape, so a new card starts there and
so does a row that leaves the field out. `deepseek` is opt-in — the Files API is one
provider's extension. The vendored card pins `deepseek` explicitly, because its job is
to keep doing what a DeepSeek profile has always done.

In the page the toggle and the transport share **one line**: accepting images is the
gate, so the dialect select sits next to the checkbox and is *disabled* (not hidden)
while the gate is off — the line keeps its size, which is what keeps the measured card
height stable when the toggle flips.

The two transport names are the only values the field holds, in the settings parser
(`parseVision` in `src/agent/models.ts`) and in the page alike. An unknown transport
is a rejected row.

Why both: the Files API is a DeepSeek extension; an OpenAI-compatible endpoint that
does not have it needs the inline form, and the user is the one who knows which
endpoint they pointed at. The declaration stays a declaration — it is never probed
(see `model-capabilities.md`).

### `spinney.model` is a card id

`spinney.model` holds a **card id** and carries no enum. The chat's dropdown is built
at runtime from `spinney.modelCards`, so a setting that listed the models would be a
second copy to drift; there is deliberately no `enum` on it (`tools/check-models.js`
fails the build if one reappears).

Those three keys are the **whole** model configuration, and they are all this build
reads: the pre-model-card settings were never released, so there is no migration path
to maintain — a profile that has no cards simply runs on the vendored fallback.

The page's saves are written back to `settings.json` at **Global** (user) scope — a
provider table with keys behind it belongs to the reader, and in no-folder mode there
is no workspace scope to write to.

### The Model Card Tree page

A second webview editor tab (`spinney.modelTree`, `src/chat/ModelPanel.ts` +
`src/chat/modelTree.ts` + `media/modeltree.js` + `media/modeltree.css`), opened by
`Spinney: Open Model Cards` (`spinney.openModelCards`) and by the gear beside the chat's
model dropdown. It draws providers as roots with their cards branching off them —
the chat tree's visual language and the same vendored layout engine — with:

- **no side panel and no docked inspector**: the *selected* node's card expands in
  place into its own form (every editable field, the read-only id, the API-key fields
  and, for a model card, the request preview), and `#mt-main` holds nothing but the
  tree. The other cards stay compact (title / subtitle / a badge saying how many model
  cards hang off a provider), and a click selects while a drag pans and never selects.
  The layout is two-pass — the DOM is built first and *measured*, and only the measured
  box goes to the engine — because the selected card's height depends on how many
  effort rows its form has. A keystroke is never a re-layout: only a change of *shape*
  (a selection, a node added or removed, a level added or removed, the vision transport
  or a card's provider) re-measures and re-lays out the tree,
- a **draft / save / revert** model: edits touch a local draft, and a save posts the
  **whole** desired state at once, so a deletion is simply an id that is absent and a
  failed save leaves the draft exactly as the user left it. A **new card** arrives
  prefilled from the fresh-row defaults the snapshot carries (a 1M context window, the
  four built-in levels with `medium` as the default, images off, no cap) and is still
  invalid in the one place nothing may invent: its **wire model name**. So validation
  refuses it until it is named, and every other field is already usable,
- a **reset button on every resettable property** (base URL, concurrency, context
  window, vision on/off, image transport, the level list, the default level). What it
  restores is **the row's own factory state**, and the page is told it rather than
  knowing it: the snapshot carries `defaults.builtin` / `defaults.fresh`
  (`FRESH_*` / `BUILTIN_*` in `src/agent/models.ts`, chosen per row by
  `defaultsForProvider` / `defaultsForCard`). So the built-in `deepseek-flash` resets
  to the values it really ships with (a `2500` concurrency, images on, `deepseek`
  transport) while a row the user created resets to what a fresh row carries. `id`,
  `name`, `oaiModel` and a card's `providerId` have **no** reset button — they are
  hand-authored, not defaulted. A button is disabled while its field already holds the
  default, and only the level list's reset is a *shape* change (it re-measures the
  tree); every other one is a plain edit,
- **built-in rows cannot be deleted**: the page disables the delete button of the
  built-in provider and of the vendored card, and the host refuses the payload anyway
  (`validateBuiltinsSurvive` — a deletion is implicit, so a crafted save could drop
  them). Editing and renaming them is fine; only their disappearance is refused,
- **client-side validation** mirrored by **host-side validation**
  (`validatePayload` in `src/chat/modelTree.ts`): the host is the authority, rejects a
  bad payload with the reasons, and writes **nothing** — never a half-applied catalog,
- per-provider **API-key fields** (write-only; a badge says whether a key exists),
  written to SecretStorage rather than the settings,
- the chat tree's **gesture set** (`media/main.js`) with one deliberate difference:
  **the wheel scales**, anchored on the pointer, with or without ctrl/cmd (the chat
  tree pans on a plain wheel and zooms on ctrl/cmd + wheel; this page is a handful of
  cards, so the wheel *is* its zoom). Also LMB/MMB drag pan, RMB-hold autoscroll
  towards the cursor, fit to view, and one automatic fit when the first snapshot
  arrives — the camera is the user's from then on. The one wheel that is left alone
  is the request preview's, which scrolls sideways for its long lines (and must not
  wrap: its fixed line count is what keeps the measured card height stable),
- a read-only **request preview** of what the selected card would send: the endpoint,
  the `model` field, the `reasoning_effort` line (absent for `none`) and how an image
  would travel. It lives in that card's form, so a provider card simply has none.

One page per window; the chat's gear opens it, and the tab survives a window reload
through the webview panel serializer (`ModelPanel.revive`, the `spinney.modelTree`
view type in `activationEvents`). The page writes the settings through
`configuration.update`, so a save lands exactly like a hand edit and takes the same
live path (see `config-keys.md`); the host never trusts the injected page in the
saving direction, only in the display direction.

### Concurrency: two gates per request, and what does *not* take a slot

`ClientRegistry` (`src/agent/clients.ts`) turns a card into a request and owns two
`RequestGate`s (`src/agent/requestGate.ts`) — one per provider, one per card. Both use
the same semantics: `0` = unlimited, FIFO, abort-aware (`acquire(signal)` rejects when
the signal aborts while queued, which is what makes Stop work on a request that is only
*waiting* for a slot). A limit that drops below the running count never kills a request
in flight; it only stops granting.

**Chat completions and image uploads take a slot.** **Session-title requests and the
wallet readout deliberately do not**: they are bookkeeping, and letting a batch of
auto-titles occupy every slot would starve the conversation. A request that had to
queue says so in the status line (`queueStatus` in `src/agent/agent.ts`), because a
queued request is otherwise indistinguishable from a slow model.

The gates are per **request**, never per turn. A parent waiting for a tool result has
already released its own slot by then, so holding a slot can never deadlock a turn —
that is the whole reason the design is two gates and not a lock around a turn. The
acquire order is fixed (provider first, then card) so two requests can never take them
in opposite orders and deadlock.

### Where the model flows

| Piece | Value |
| --- | --- |
| `Agent.setCard(card)` (it replaced `setModel(modelId)`) | The whole card — provider, wire name, vision, levels. |
| `TreeNode.model` / `TreeNode.effort` | The card **id** and level the turn that created that node ran with. A node's card is its own, else the **nearest ancestor's**, else the session seed — so a follow-up on an old node runs on the model that produced it, never on whatever the tab last used. `TreeNode.agentModel` stays the sub-agent node's own card. |
| `SessionRuntime.cardIdForNode` / `effortForNode` (private) + `effectiveCardId` / `effectiveEffort` (public) | The resolution above, plus a **pending** pick on the node in view. `SessionRuntime.model` / `thinkingEffort` / `contextWindow` are getters over these, so every reader (the `config` message, the control plane, the ctx indicator) reports the **checked-out** node. |
| `session.model`, `spinney.runtimeConfig.model` | Card ids — the **seed** for a session with no node history, and the default for sessions created later. An explicit dropdown pick still writes them (`persistRuntimeConfig`). |
| The dropdown pick | A **pending** choice for the next send on the node in view: it is consumed by that turn (which records it on the new node) and **forgotten on a checkout**, so the dropdown follows the node you click. Picking the card the node already uses is a **no-op** — no "Model changed" notice, no persist. |
| `spawn_agents`' `model` argument | A card id, a card name, or a wire model name — `resolveCard` accepts all three, case-insensitively for the two spellings. |
| The `config` message (`SessionRuntime.postConfig`) | `{ model: <card id>, cards: [{ id, name, providerId, providerName, vision, efforts, defaultEffort }], efforts, thinkingEffort, foldToolCalls, foldThinking, snippets }` — a card's `vision` is the boolean `vision.enabled`, and `snippets` is the composer's prompt-snippet list (`cfg.promptSnippets`), so the webview keeps no copy of either. |
| Control plane `sessions[]` | `model` (card id) and `modelName` (the display form). |
| Transcript meta | The card's display name (`cardDisplayName`). |

The chat's model dropdown is **grouped per provider** (an `optgroup` per provider
name, so two cards with the same wire model on different endpoints stay tellable
apart), and the thinking-level dropdown is built from the **active card's** `efforts`.

### Where it lives

| Piece | File |
| --- | --- |
| `ProviderSpec` / `ModelCard` / `VisionTransport`, the built-in provider and card, `DEFAULT_MODEL`, `DEFAULT_PROVIDER_ID`, `BUILTIN_EFFORTS`, `DEFAULT_EFFORT`, `NO_EFFORT`, `MAX_IMAGE_BYTES` | `src/agent/models.ts` |
| `parseCatalog()` (`parseProviderRow` / `parseCardRow` / `parseVision`) — object shape, per-field defaults, error rows | `src/agent/models.ts` |
| `setCatalog()` + accessors: `providerSpecs` / `providerById` / `cards` / `cardById` / `resolveCard` / `defaultCard` / `contextWindowFor` / `isVisionCard` / `visionCardsLabel` / `cardDisplayName` / `effortsFor` / `normalizeEffort` / `newId` / `providerNameFromUrl` | `src/agent/models.ts` |
| `applyModelCards()` / `onModelCardsSaved()` / `refreshKeys()` / `resolveModel()` — read the settings, install the catalog, push to live owners | `ChatViewProvider` (`src/chat/ChatViewProvider.ts`) |
| `ClientRegistry` — one client per provider, per-provider keys, the two gates, the routing (`body.model` from the card) | `src/agent/clients.ts` |
| `RequestGate` — the FIFO, abort-aware slot gate | `src/agent/requestGate.ts` |
| The page shell + its serializer lifecycle (`MODEL_VIEW_TYPE`, `ModelPanel.create` / `revive`, the `ready` hold) | `src/chat/ModelPanel.ts` |
| The page controller: the message protocol, `validatePayload` (host authority), `apiKeySecretName` | `src/chat/modelTree.ts` |
| The page itself (tree, the selected card's form, draft/save/revert, key fields, request preview) | `media/modeltree.js` · `media/modeltree.css` |
| The command (`spinney.openModelCards`) and the gear the webview asks for (`openModelTree`) | `src/extension.ts` · `media/main.js` |
| The chat's dropdowns (`postConfig`) | `src/chat/runtime.ts` |
| Settings (`model`, `providers`, `modelCards`) | `package.json` |
| Guards (`npm run check:models` / `check:modeltree`): `spinney.model.default` == the fallback, the two catalog settings exist, no `enum` on `spinney.model`, no model id in `src/**/*.ts` (the catalog module excepted) or `media/*.js` (the vendored bundles excepted), README/docs name only ids the catalog has; the page protocol replay | `tools/check-models.js` · `tools/check-modeltree.js` |

Every mention of a model id in README/docs must be one the catalog has — today that is
only the built-in one (`tools/check-models.js` fails an id `MODEL_CATALOG` does not
carry) — and plugin text that reaches the model must call `visionCardsLabel()` /
`cardDisplayName()` instead of naming anything.
