# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The wallet readout is a **provider** property now instead of an assumption. A provider
  row carries `balance`, which is one of `none` (no wallet line at all — the default for
  a new row, and the right answer for a local vLLM/llama.cpp endpoint), `deepseek`
  (`GET /user/balance`), `openrouter` (`GET /credits`) or `moonshot`
  (`GET /users/me/balance`), and the Model Cards page's provider form has a select for
  it. A row that omits the field is read with the dialect this harness knows for that
  host — `api.deepseek.com` → `deepseek`, anything else → `none` — because it is
  declared, never probed: no request is spent finding out, and no endpoint is read as if
  it spoke DeepSeek's dialect. The built-in provider still reads DeepSeek's wallet.

### Changed

- The wallet number belongs to the provider that reported it, and no longer outlives it:
  a `none` provider shows no figure at all, and a refresh that fails now clears the
  number instead of leaving the previous provider's on screen. The readout is still
  never retried, and its tooltip names the provider the number belongs to.
- The API client, its error and its options are no longer named after DeepSeek:
  `src/agent/deepseek.ts` → `src/agent/apiClient.ts`, `DeepSeekClient` → `ApiClient`,
  `DeepSeekError` → `ApiError`, `DeepSeekOptions` → `ClientOptions`. Nothing in it was
  ever DeepSeek-specific — there is one instance per provider and every endpoint it
  talks to is OpenAI-compatible — and its error text no longer claims otherwise.
  Everything that really is DeepSeek keeps the name: the vendored `deepseek-flash`
  card, the built-in provider's base URL, `DEEPSEEK_API_KEY`, and the `deepseek` image
  transport.

## [0.0.2] - 2026-09-16

The first public release. No earlier build was ever shipped, so this entry covers
everything the extension contains — the baseline the project had reached at the
`v0.0.1` tag, and the work done on top of it.

### Added

- Branchable chat tree: click any turn to fork a new branch and keep the old chain.
- File and command tools: `read_file`, `write_file`, `replace_in_file`, `list_dir`,
  `exec_command`, `read_image`.
- Parallel sub-agents.
- Background terminals.
- Vision (image input).
- An optional local HTTP control plane.
- API key storage in VS Code SecretStorage.
- A state migration script for older builds; see the migration section of the README.
- `spinney.replyLanguage` (dropdown, default `auto` = follow the VS Code display
  language, plus the languages VS Code ships display translations for): the language
  the agent replies in, injected as the system prompt's `## Language` line. The
  options are ordered by use — `en`, `zh-Hans`, `zh-Hant` first, the rest after —
  and each is labelled with the exact name the prompt receives (`English`,
  `Simplified Chinese`, `Brazilian Portuguese`, …). Changing
  it mid-conversation warns that the next request may miss the prompt cache, like a
  model or thinking-effort change.
- UI localization: every user-visible string — the chat window (webview), dialogs,
  the sidebar, and the manifest (command titles, setting descriptions) — now
  follows the VS Code display language, and the extension ships Simplified Chinese
  (`zh-Hans`) and Traditional Chinese (`zh-Hant`). One catalog per language
  (`l10n/bundle.l10n.<locale>.json`, keyed by the English source string) serves the
  host and the webview; `package.nls.<locale>.json` serves `package.json`. The files
  are named by the region-invariant tag, while VS Code still looks a catalog up by
  the region tag it reports (`zh-cn` / `zh-tw` for the language packs), so those
  copies are generated at package time (`npm run sync:l10n`) and removed again once
  the `.vsix` is written. English needs no file — the source strings are the English
  catalog — and any other language falls back to it. A new packaging guard
  (`npm run check:l10n`) fails the build when a catalog and the code drift apart — a
  string with no translation, a stale entry, a mismatched `{0}` placeholder, or a
  generated copy that is missing or stale. The **Spinney** output channel prints an
  `[i18n]` line naming the display language it resolved, the catalog it read, and the
  copy VS Code reads for the host strings.
- A conversation that fills the model's context window now continues in a **new
  context window** instead of being compressed. When a turn fails because the provider
  refused the request as too big, that card offers **⧉ Continue in a new window**: the
  new node hangs under the same conversation (joined by a dashed edge, marked with a
  `CTX` badge, titled `Context window 2`), and its first request carries **no ancestor
  history at all** — a harness-written resume message points at the previous window's
  on-disk transcript (`read_file` / `search_transcripts`), quotes the user's last
  request and the last answer verbatim, and lists what was still running. Nothing is
  summarised, so nothing is lost and no extra model call is spent. The provider's
  refusal is the only trigger (the `ctx` readout is a lagging number, never a
  threshold), and a node that is not context-full keeps the ordinary in-place
  ▶ Continue / ↻ Retry. Because a full window can no longer receive results, a rollover
  first stops what that node still owned — its background terminals and its sub-agent
  subtree, behind one modal confirmation — writes the kill notices into that node's own
  history and re-dumps its transcript, which is what the new window is told to read.
- The Model Card Tree page (`Spinney: Open Model Cards`, `spinney.openModelCards`, and
  the gear beside the chat's model dropdown): a second editor tab that draws provider
  nodes as roots with their model cards branching off them — the chat tree's visual
  language, the same vendored layout engine and the same gesture set — with one
  deliberate difference: **the wheel scales**, anchored on the pointer, with or without
  ctrl/cmd (the chat tree pans on a plain wheel), plus drag pan, RMB autoscroll pan and
  fit to view. **The
  selected node's card is the editor**: it expands in place into its own form (no
  side panel), a draft/save/revert model posts the whole desired state at once,
  client-side validation is mirrored by host-side validation (a rejected save writes
  nothing), the per-provider API-key fields are write-only (with a badge saying
  whether a key exists), and the selected card carries a read-only preview of the
  request it would send. One page per window; the tab survives a window reload
  through the webview panel serializer.
- A provider's name is derived from its base URL when a row does not carry one — the
  host's name normally, but the one endpoint this harness ships knowledge about gets its
  product name (`api.deepseek.com` → `DeepSeek`). The name is editable either way.
- Providers (`spinney.providers`): one OpenAI-compatible endpoint each, with a name, a
  base URL and a concurrency cap (`0` = unlimited in flight). Every chat request is
  `POST <baseUrl>/chat/completions`, image uploads go to `POST /files`, and the wallet
  line reads `GET /user/balance`. The API key is not in settings: SecretStorage holds
  one entry per provider (`spinney.apiKey` for the built-in one,
  `spinney.apiKey.<providerId>` for the rest), set from the page or with
  `spinney.setApiKey`, which takes an optional provider id.
- Model cards (`spinney.modelCards`): a wire model name bound to exactly one provider,
  with its own context window, its own concurrency cap, a `vision` flag plus an image
  transport, a free-form list of thinking levels and the default one. A card's `id` is
  a GUID the page generates and never changes, so renaming a card or a provider never
  invalidates a stored session; `oaiModel` is the only field that travels as
  `body.model`.
- Per-card vision transport: `vision.transport` chooses the vendor dialect the image
  bytes travel in — `deepseek` (upload to `POST /files`, then a `{ type: 'file',
  file_id }` part) or `openai` (a `data:` URL in an `image_url` part).
- The **model and thinking level now belong to the node**, not to the session: a turn
  records the card it ran with on the node it creates, a follow-up resolves through the
  node's ancestry (own → nearest ancestor → the tab's seed), and the dropdown shows — and
  changes — that node's own card. Picking a card is a pending choice for the next send on
  the node in view (a checkout forgets it), so continuing an old branch no longer runs on
  whatever model the tab last used, and switching **back** to the card a node already uses
  is a no-op instead of a spurious "model changed, cache will miss" warning. A sub-agent
  inherits its parent node's card. The control plane's `sessions[].model`/`modelName`/
  `effort` report the checked-out node.
- A history's **uploads no longer break a provider switch**: a `{ type: 'file',
  file_id }` block belongs to the provider that issued it, so when the request runs
  on a card whose `vision.transport` is not `deepseek` it is hidden behind a
  placeholder (the same "hide, never remove" rule as a text-only model), and the
  runtime notice says why instead of letting the endpoint answer with a 400. A
  `data:` URL needs no such treatment.
- A **new model card arrives prefilled**: a 1M context window, the four built-in thinking
  levels with `medium` as the default, images off and no concurrency cap — everything
  except its wire model name, which stays the user's to type (so an unnamed card is still
  refused by validation rather than sent to a model nobody chose).
- A **reset button on every resettable property** of the Model Card Tree page (base URL,
  concurrency, context window, vision on/off, image transport, the level list and the
  default level). It restores **that row's factory state** — the built-in rows reset to
  the values they ship with, a row you created resets to a fresh row's — and the page is
  told those values by the host (`defaults` in the snapshot), so there is one copy of
  them. `id`, `name`, `oaiModel` and a card's provider are hand-authored and get no
  button; a button is greyed out while its field already holds the default.
- Built-in rows are **protected from deletion**: the delete button is disabled for the
  built-in provider and for the vendored `deepseek-flash` card, and the host refuses a
  save that drops either of them anyway (`validateBuiltinsSurvive`). Editing and
  renaming them stays allowed.
- Two concurrency gates (`RequestGate`): one per provider and one per card, both FIFO
  and abort-aware, both `0` = unlimited. Chat completions and image uploads take a
  slot; session-title requests and the wallet readout deliberately do not, so a batch
  of auto-titles cannot occupy every slot. A request that had to queue says so in the
  status line, and Stop works on a request that is only waiting for a slot.
- A packaging guard, `npm run check:modeltree` (`tools/check-modeltree.js`): it loads
  `media/modeltree.js` into a stub DOM and replays the page protocol — the `ready`
  handshake, a snapshot drawn as a tree, a failed save that keeps the draft, and an
  add-card → save round trip. It runs in `vscode:prepublish` alongside the others.
- Prompt snippets in the composer: a button beside the input box opens a menu of
  pre-written instruction texts, and choosing one inserts its text into the message —
  it becomes part of your own turn, editable before you send it, and the click itself
  sends nothing. The extension ships two (`Plan`, `Implement Parallel`); your own are
  `spinney.promptSections`, an object keyed by the name shown in the menu. A row whose
  name matches a shipped snippet replaces its text, any other name adds a row, and the
  shipped ones always stay available. Editing the setting repaints the menu in an open
  chat tab, with no reload.

### Changed

- The chat's model dropdown now lists **model cards** (grouped per provider) and the
  thinking-level dropdown is built from the active card's levels; switching a card
  switches its levels with it.
- `spinney.model` now holds a **card id** (the default card) and carries no enum.
- Thinking levels are per card and free-form: each card declares its own `efforts` and
  `defaultEffort`, and a session pick its card does not offer is clamped to that
  card's default. The literal `none` still means "send no `reasoning_effort`" and
  keeps the effort sentence out of the prompt.
- The API key is per provider in SecretStorage; `spinney.setApiKey` /
  `spinney.clearApiKey` take an optional provider id (the palette defaults to the
  built-in provider).
- Transcripts record the card's display name, and the control plane reports
  `sessions[].model` as a card id with a new sibling `modelName`.
- The pre-model-card settings were never released, so there is no migration path:
  this build reads `spinney.providers` + `spinney.modelCards` + `spinney.model` and
  nothing else, and a profile without cards runs on the vendored fallback card.
- `tools/check-models.js` no longer requires the old settings enum; it checks that
  `spinney.model.default` is the fallback card, that `spinney.providers` /
  `spinney.modelCards` exist as object schemas, and that no model id is hardcoded.
  `tools/check-webview.js` feeds the new `config` shape.
- The block that is live right now is always expanded, and it lets go on its own. A
  thinking block receiving deltas, and a tool call between its first delta and its
  result, are expanded whatever `spinney.foldThinking` / `spinney.foldToolCalls` say —
  those two settings describe a block **at rest** again — and they fold back the moment
  the answer's text takes over, the call reports its result, or the turn ends (an
  interrupted call used to stay open, marked `running`, forever). A click on a block's
  header is still the last word: a block you folded or opened by hand is never touched
  by the rule again, and a settings change no longer reaches the block that is live.
- A node that owns unfinished work now offers **Stop** instead of a greyed-out composer.
  While a background terminal or an async sub-agent batch started by that node is still
  running — or its completion notice is already queued for it — the composer's
  bottom-right button is Stop rather than Send (with a tooltip saying so; no banner, and
  the input stays usable exactly as while a turn streams). Pressing it is a **union
  kill**: that node's turn, every background terminal it spawned and every sub-agent it
  is still running are stopped, and **nothing continues the conversation** — each
  suppressed notice is written back into that node's own history (and shown in its card
  as the usual notification block), so it reaches the model with the user's next prompt
  or ▶ Continue. `POST /stop {nodeId}` and `GET /state → sessions[].lockedNodes` expose
  the same rule to the control plane; a card's ✕ still kills one job and *does* tell the
  model. The reason for the node-scoped lock is unchanged: the notice is injected into
  the node that owns the work while a user turn branches off the node it was sent from,
  so sending from there used to run two agents on one conversation line. Only the owner
  is covered — its existing descendant branches stay usable, so a long-lived job (a dev
  server) does not freeze the conversation below it.
- The composer (the checked-out node's input dock) no longer scales. Its controls and
  fonts used to follow the host card's width — `--cs` was `card width / 560`, clamped to
  0.8–1.6, so dragging a card's resize handle (or a wide/narrow window hosting the
  placeholder card) resized the input, buttons and metrics along with it. Every size in
  the pane is now a fixed px value, and the pane ignores the card and panel size
  entirely.
- The settings are grouped in the Settings UI: `contributes.configuration` is now one
  section per topic — **Model & API**, **Chat & Display**, **Tools & Execution**,
  **Sub-agents**, **Sessions & Transcripts**, **Control Plane** — in a logical order
  within each group. The existing keys and their defaults are unchanged; an entry that lived
  in the middle of the old flat list (say `spinney.autoSessionTitles`) simply moved next
  to its neighbours.
- A card's drag handle now sits **outside** the bottom-right corner instead of on top of
  it: a short wire (3px, round-capped, `r=13` bend, two equal 10px arms) 8px clear of
  the card, drawn as an SVG stroke masked over a plain background so the ends and the
  bend are round and the accent on hover is a colour change. It no longer covers the
  composer docked at the bottom of the active card, so the two paddings that existed
  only to keep the meter row clear of it are gone. Two consequences: `.node` no longer
  clips its children (`overflow: visible`), so the two children painting their own
  background round their own corners (`.node-head` at the top, `#composer` at the
  bottom); and the handle is painted below the card (`z-index: -1`), so the part of its
  box that reaches back over the card cannot swallow clicks meant for the Send button.
- The green auto-scroll light (`.scroll-lock-dot`) is a 16px target instead of an 8px
  one: an invisible `::before` pad sits 4px past the dot on every side, so the click
  that toggles follow — and the hover glow that advertises it — reaches twice as far
  while the light itself looks unchanged. The pad belongs to the dot, so the click
  handler, the title and the `locked` state are untouched, and it grows inward, inside
  the 20px strip the scroll container reserves below itself, clear of the scrollbar and
  of the content above it.
- Sub-agent windows and background job cards now fill their grid cell. The sidecar grid
  no longer shares row lines across columns: each column is its own stack, a shorter
  column's free space is spread evenly over its own cards, and every card is stretched
  to its cell — so a sub-agent that spawned sub-agents ends flush with its own sub-grid
  instead of stopping early beside it, and a deep branch costs only its own column
  instead of leaving a dead gap under the cards of a shallower one.

### Removed

- `spinney.thinkingEffort`: each model card declares its own levels and its own
  default.
- The fixed four-level effort enum (`none|low|medium|high`) as a harness-wide
  concept.
- `spinney.model.enum`: the dropdown is built from `spinney.modelCards`.

### Fixed

- A model request that produces no traffic can no longer hang a turn. The client
  only ever retried on an *error*, and a connection that goes quiet neither errors
  nor ends, so the only thing that used to end it was pressing Stop — the "first
  answer takes forever, Stop + Continue makes it instant" report, which shows up as
  `Thinking…` with the tok/s meter pinned at 0 (typically on the first request after
  the window sat idle, when the pooled keep-alive socket is already half-open). Each
  attempt now runs under three watchdogs: 20 s to the response headers (12 s for the
  first request after a ≥60 s idle gap), 20 s to the first chunk, 60 s of silence
  inside an answer. An abort by a watchdog retries transparently through the existing
  backoff (the abort is what tears the dead socket down, so the retry leaves on a
  fresh connection); after the first chunk a stall stays fatal, so no output is
  duplicated. Stop keeps its meaning: a user abort is never retried. The output
  channel also gained `request-headers pending/slow`, `request-first-chunk`,
  `request-timeout` and `request-stall` lines, so a request that has not produced
  its first byte is now visible *while* it waits.
