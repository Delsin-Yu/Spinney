/**
 * The model catalog — the **single** place that knows which providers this
 * harness can talk to and which model cards it recognizes.
 *
 * The model of the world (see `docs/agents/invariants/model-cards.md`):
 *
 *   provider node  → `{ id, name, baseUrl, balance, concurrency }` — an
 *                    OpenAI-compatible endpoint, the dialect its wallet line is read
 *                    in, and how many requests may be in flight against it.
 *   model card     → `{ id, name, providerId, oaiModel, contextWindow, vision,
 *                    efforts, defaultEffort, concurrency }` — branches off exactly
 *                    one provider and carries everything a request to it needs:
 *                    the wire name, the window, the image dialect, the levels.
 *
 * A card's `id` is a GUID the Model Card Tree page generates (the one exception
 * is the built-in fallback card below). It is the value every persisted surface
 * holds — `session.model`, `spinney.model`, the model dropdown, the `model`
 * argument of `spawn_agents`, the transcripts — while `oaiModel` is what travels
 * on the wire as `body.model`. Renaming either field therefore never invalidates
 * a stored session, which is the whole point of the indirection.
 *
 * The user's data lives in `spinney.providers` / `spinney.modelCards` (structured
 * data, `settings.json`, edited by the Model Card Tree page). A profile that has
 * neither — a fresh install, or one that never opened the page — gets the vendored
 * fallback below: a single `deepseek-flash` card on the built-in `default` provider.
 *
 * Everything derives from here, so changing the vendored fallback is a one-line
 * edit:
 *   - the chat's two dropdowns are built at runtime from {@link cards()},
 *   - user-facing copy (README, settings description) may name the vendored
 *     model, but only that one — `tools/check-models.js` fails the build
 *     otherwise,
 *   - plugin text that reaches the model (the system prompt, tool descriptions,
 *     tool error messages) must **never** hardcode a model id: it asks for
 *     {@link visionCardsLabel()} / {@link cardDisplayName()} instead.
 */

import { randomUUID } from 'crypto';
import { BalanceDialect, BALANCE_DIALECTS, isBalanceDialect } from './balance';

/**
 * How a card's images reach the provider. Two mechanisms, named after the vendor
 * whose dialect they belong to — that is what a user picks between:
 *
 *   `deepseek` — the Files API extension: upload the bytes to `POST /files`, then
 *                reference the returned id with a `{ type: 'file', file_id }` part.
 *                It is **not** part of the OpenAI-compatible schema; DeepSeek is the
 *                provider this harness ships knowledge about that has it, and it is
 *                the only way to send an image that does not occupy the request body
 *                (the Files API allows 64 MiB per image; an inline body does not).
 *   `openai`   — the OpenAI-compatible way: an `image_url` part whose `url` is a
 *                `data:` URL carrying the bytes. Every OpenAI-compatible endpoint
 *                understands the shape, so it is what a local vLLM / llama.cpp /
 *                gateway expects; the bytes do travel inside the request.
 *
 * `openai` is the **default**: it is the standard shape, so a new card — and a row
 * that leaves the field out — starts there. `deepseek` is opt-in, because the Files
 * API is one provider's extension. The vendored card pins it explicitly: that card
 * points at the DeepSeek endpoint, so it keeps using the upload path.
 */
export type VisionTransport = 'deepseek' | 'openai';

export interface VisionSpec {
  /** True if the card accepts image input (attach/paste, `read_image`). */
  enabled: boolean;
  transport: VisionTransport;
}

/** One OpenAI-compatible endpoint (`POST <baseUrl>/chat/completions`). */
export interface ProviderSpec {
  id: string;
  name: string;
  /** Where the API root sits, e.g. `https://api.deepseek.com` (no trailing slash needed). */
  baseUrl: string;
  /**
   * How this endpoint's wallet line is read (`balance.ts`) — a **declaration**, like a
   * card's image transport, never a probe. `none` says the endpoint has no wallet at
   * all, which is the honest answer for a local server and for any vendor this build
   * has no parser for.
   */
  balance: BalanceDialect;
  /** Maximum requests in flight against this provider; `0` = unlimited. */
  concurrency: number;
}

/** One selectable model: a wire model name bound to a provider and its limits. */
export interface ModelCard {
  /** Stable id (a GUID, or the vendored fallback's id). Never edited after creation. */
  id: string;
  /** What the user calls it (shown in the dropdown, the prompt and the transcripts). */
  name: string;
  providerId: string;
  /** The value sent as `body.model`. */
  oaiModel: string;
  /** Context window in tokens, for the usage indicator. */
  contextWindow: number;
  vision: VisionSpec;
  /** The thinking levels this card offers (free-form strings; `none` is special). */
  efforts: string[];
  /** Which of {@link efforts} a session starts on. Must be one of them. */
  defaultEffort: string;
  /** Maximum requests in flight for this card; `0` = unlimited. */
  concurrency: number;
}

/** The vendored model's spec: its id, its window and whether it takes images. */
export interface ModelSpec {
  id: string;
  contextWindow: number;
  vision: boolean;
}

/** The one model the extension ships knowledge about. */
export const VENDORED_MODEL: ModelSpec = {
  id: 'deepseek-flash',
  // The API enforces 2^20 = 1,048,576 for this model (its 400 says so verbatim);
  // the docs round that to "1M".
  contextWindow: 1_048_576,
  vision: true,
};

export const MODEL_CATALOG: readonly ModelSpec[] = [VENDORED_MODEL];

/** The card used when nothing is configured (also its id). */
export const DEFAULT_MODEL = VENDORED_MODEL.id;

/** The provider used when nothing is configured (also its id). */
export const DEFAULT_PROVIDER_ID = 'default';

/** Used when a card is unknown and nothing else applies. */
export const DEFAULT_CONTEXT_WINDOW = VENDORED_MODEL.contextWindow;

/** The levels every fresh card starts with. Free-form: a user may add or drop any. */
export const BUILTIN_EFFORTS: readonly string[] = ['none', 'low', 'medium', 'high'];

/** The level a fresh card starts on. */
export const DEFAULT_EFFORT = 'medium';

/**
 * The level that means "send no `reasoning_effort` at all". Deliberately the
 * literal `none`: it is what the API's own default is, and the system prompt
 * leaves the effort sentence out for it (see `prompt.ts`).
 */
export const NO_EFFORT = 'none';

/**
 * The image size ceiling. The Files API allows 64 MiB per image; the inline
 * transport has to fit the same bytes into the request body, so it uses the same
 * ceiling.
 */
export const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

/** The vendored provider — the endpoint the built-in `default` provider points at. */
export const VENDORED_PROVIDER: ProviderSpec = {
  id: DEFAULT_PROVIDER_ID,
  name: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com',
  balance: 'deepseek',
  concurrency: 0,
};

/**
 * The vendored card, derived from {@link VENDORED_MODEL}. Its transport is pinned to
 * `deepseek`: this card points at the DeepSeek endpoint, the upload path is what this
 * harness has always run there, and it keeps the request body free of image bytes.
 */
export const VENDORED_CARD: ModelCard = {
  id: VENDORED_MODEL.id,
  name: VENDORED_MODEL.id,
  providerId: VENDORED_PROVIDER.id,
  oaiModel: VENDORED_MODEL.id,
  contextWindow: VENDORED_MODEL.contextWindow,
  vision: { enabled: VENDORED_MODEL.vision, transport: 'deepseek' },
  efforts: [...BUILTIN_EFFORTS],
  defaultEffort: DEFAULT_EFFORT,
  // The built-in card documents the endpoint's real tolerance instead of claiming
  // "unlimited": the DeepSeek API takes this many requests in flight. It is a
  // ceiling, not a target — the harness never opens more than its sessions do.
  concurrency: 2500,
};

/** What the provider form's reset buttons restore. */
export interface ProviderDefaults {
  baseUrl: string;
  balance: BalanceDialect;
  concurrency: number;
}

/** What the model-card form's reset buttons restore. */
export interface CardDefaults {
  contextWindow: number;
  concurrency: number;
  vision: VisionSpec;
  efforts: string[];
  defaultEffort: string;
}

/**
 * The values a **brand-new row** gets — what a reset button restores on a row the
 * user created. It is deliberately *not* what `addCard()` seeds (a new card is
 * invalid on purpose, so its owner has to fill it in); this is the same field set
 * with values that are usable as they stand.
 */
export const FRESH_PROVIDER_DEFAULTS: ProviderDefaults = {
  baseUrl: VENDORED_PROVIDER.baseUrl,
  // A brand-new row declares no wallet line: this build ships a parser for exactly one
  // endpoint's dialect, and a row the user just typed is not it until they say so.
  balance: 'none',
  concurrency: 0,
};

export const FRESH_CARD_DEFAULTS: CardDefaults = {
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  concurrency: 0,
  vision: { enabled: false, transport: 'openai' },
  efforts: [...BUILTIN_EFFORTS],
  defaultEffort: DEFAULT_EFFORT,
};

/** The **built-in** rows' factory state — the vendored provider and card themselves. */
export const BUILTIN_PROVIDER_DEFAULTS: ProviderDefaults = {
  baseUrl: VENDORED_PROVIDER.baseUrl,
  balance: VENDORED_PROVIDER.balance,
  concurrency: VENDORED_PROVIDER.concurrency,
};

export const BUILTIN_CARD_DEFAULTS: CardDefaults = {
  contextWindow: VENDORED_CARD.contextWindow,
  concurrency: VENDORED_CARD.concurrency,
  vision: { ...VENDORED_CARD.vision },
  efforts: [...VENDORED_CARD.efforts],
  defaultEffort: VENDORED_CARD.defaultEffort,
};

/**
 * The reset target of every row: **its own factory state**. The built-in provider and
 * the vendored card reset to the constants above (`deepseek-flash` really does ship
 * with a 2500 concurrency cap and with images enabled); a row the user created resets
 * to what a fresh row would carry. There is no third case — which is what keeps the
 * page's ↺ buttons explainable in one sentence.
 */
export function defaultsForProvider(id: string): ProviderDefaults {
  return id === VENDORED_PROVIDER.id ? BUILTIN_PROVIDER_DEFAULTS : FRESH_PROVIDER_DEFAULTS;
}

export function defaultsForCard(id: string): CardDefaults {
  return id === VENDORED_CARD.id ? BUILTIN_CARD_DEFAULTS : FRESH_CARD_DEFAULTS;
}

/** What the provider installed from the settings. */
interface InstalledCatalog {
  providers: ProviderSpec[];
  cards: ModelCard[];
}

let installed: InstalledCatalog = { providers: [], cards: [] };

/**
 * Install the parsed `spinney.providers` / `spinney.modelCards`. Called by the
 * chat provider on activation and on every settings change; the catalog is *user*
 * configuration, never discovered by talking to the API.
 */
export function setCatalog(providers: readonly ProviderSpec[], cards: readonly ModelCard[]): void {
  installed = { providers: [...providers], cards: [...cards] };
}

/** The providers in force: the vendored one plus the user's, deduped by id. */
export function providerSpecs(): ProviderSpec[] {
  const merged = new Map<string, ProviderSpec>();
  merged.set(VENDORED_PROVIDER.id, VENDORED_PROVIDER);
  for (const provider of installed.providers) {
    merged.set(provider.id, provider);
  }
  return [...merged.values()];
}

/**
 * The provider a card routes to. A card whose provider was deleted (or renamed
 * in a hand-edited settings file) heals to the vendored provider rather than
 * failing the request; the caller logs the mismatch.
 */
export function providerById(id: string): ProviderSpec {
  return providerSpecs().find((p) => p.id === id) ?? VENDORED_PROVIDER;
}

/** True if the id is one the settings actually declared (not the vendored fallback). */
export function isDeclaredProvider(id: string): boolean {
  return installed.providers.some((p) => p.id === id);
}

/**
 * The cards in force. The configured ones win; an empty configuration falls back
 * to the vendored card, so a fresh (or hand-broken) profile still has exactly one
 * usable model instead of an empty dropdown.
 */
export function cards(): ModelCard[] {
  return installed.cards.length > 0 ? [...installed.cards] : [{ ...VENDORED_CARD, vision: { ...VENDORED_CARD.vision } }];
}

/** The card ids, in configuration order. */
export function cardIds(): string[] {
  return cards().map((c) => c.id);
}

/**
 * The card ids, under the name the pre-card guards know them by
 * (`tools/check-context-rollover.js` asserts the catalog and the list agree).
 */
export function modelIds(): string[] {
  return cardIds();
}

/** The card with this id, or undefined. */
export function cardById(id: string): ModelCard | undefined {
  return cards().find((c) => c.id === id);
}

/** True if the id is one this harness knows about. */
export function isKnownModel(id: string): boolean {
  return cardById(id) !== undefined;
}

/**
 * The card a user-facing value names. Accepts the card id first (what everything
 * persisted holds), then the card name, then the wire model name — so a stored
 * legacy id, a hand-typed `spinney.model`, and the `model` argument of the
 * `spawn_agents` tool all resolve. Comparison is case-insensitive for the two
 * human spellings and exact for the id.
 */
export function resolveCard(value: string | undefined): ModelCard | undefined {
  const wanted = (value ?? '').trim();
  if (!wanted) {
    return undefined;
  }
  const all = cards();
  return (
    all.find((c) => c.id === wanted) ??
    all.find((c) => c.name.toLowerCase() === wanted.toLowerCase()) ??
    all.find((c) => c.oaiModel.toLowerCase() === wanted.toLowerCase())
  );
}

/** The card a session with no pick of its own uses; `defaultId` is `spinney.model`. */
export function defaultCard(defaultId: string): ModelCard | undefined {
  return resolveCard(defaultId) ?? cards()[0];
}

/** Context window in tokens for a card id (the default when the card is unknown). */
export function contextWindowFor(id: string): number {
  return cardById(id)?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
}

/** True if the card accepts image content blocks. */
export function isVisionCard(card: ModelCard | undefined): boolean {
  return card?.vision.enabled === true;
}

/** The vision cards, in configuration order. */
export function visionCards(): ModelCard[] {
  return cards().filter((c) => c.vision.enabled);
}

/**
 * The vision cards as prose for a message to the user/model, e.g. "a or b". Empty
 * string when no vision card is configured — callers must handle that (never
 * print an empty parenthesis).
 */
export function visionCardsLabel(): string {
  return visionCards()
    .map((c) => cardDisplayName(c))
    .join(' or ');
}

/**
 * What to call a card in prose for the model/user: the name if the user gave it
 * one, the wire name otherwise — and the wire name in parentheses when the two
 * differ, so a `[image hidden]` note never lies about which endpoint answered.
 */
export function cardDisplayName(card: ModelCard | undefined): string {
  if (!card) {
    return DEFAULT_MODEL;
  }
  const name = card.name.trim() || card.oaiModel;
  return name === card.oaiModel ? name : `${name} (${card.oaiModel})`;
}

/** The levels a card offers (the built-in set when a hand-edited card has none). */
export function effortsFor(card: ModelCard | undefined): string[] {
  const levels = (card?.efforts ?? []).filter((level) => typeof level === 'string' && level.trim() !== '');
  return levels.length > 0 ? levels : [...BUILTIN_EFFORTS];
}

/**
 * The level to send for a card: the requested one when the card offers it,
 * otherwise the card's default (which itself falls back to the built-in default).
 * A session pick that the current card does not offer therefore lands somewhere
 * valid instead of sending a level the provider never heard of.
 */
export function normalizeEffort(card: ModelCard | undefined, level: string | undefined): string {
  const levels = effortsFor(card);
  const wanted = (level ?? '').trim();
  if (wanted && levels.some((l) => l.toLowerCase() === wanted.toLowerCase())) {
    return levels.find((l) => l.toLowerCase() === wanted.toLowerCase()) as string;
  }
  const preferred = (card?.defaultEffort ?? '').trim();
  if (preferred && levels.some((l) => l.toLowerCase() === preferred.toLowerCase())) {
    return levels.find((l) => l.toLowerCase() === preferred.toLowerCase()) as string;
  }
  return levels.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : levels[0];
}

/** A fresh card/provider id. GUIDs keep renames from invalidating stored sessions. */
export function newId(): string {
  try {
    return randomUUID();
  } catch {
    // `randomUUID` is present in every supported Node; keep a fallback so a
    // stripped runtime degrades instead of throwing at the user.
    return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * A provider name and wallet dialect for a URL. The name is normally its host — a
 * derived name must not invent copy — but the one endpoint this harness ships
 * knowledge about gets its own product name (`api.deepseek.com` → `DeepSeek`),
 * because that is what the built-in provider is called everywhere else. The name
 * stays editable either way.
 *
 * The dialect is the same knowledge, used where it matters: a provider row that
 * leaves `balance` out is answered by its host. That is a **declaration by host**,
 * not a probe — this table is the whole of what the build knows, and every other
 * endpoint (a local vLLM, a gateway, a vendor nobody wrote a parser for) is
 * honestly `none` until the user says otherwise.
 */
const KNOWN_PROVIDER_HOSTS: ReadonlyArray<{ suffix: string; name: string; balance: BalanceDialect }> = [
  { suffix: 'deepseek.com', name: 'DeepSeek', balance: 'deepseek' },
];

/** The known-host entry for a URL, when this build ships knowledge about that host. */
function knownProviderHost(url: string): (typeof KNOWN_PROVIDER_HOSTS)[number] | undefined {
  const raw = (url ?? '').trim();
  if (!raw) {
    return undefined;
  }
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(raw);
  const host = match ? match[1] : raw;
  return KNOWN_PROVIDER_HOSTS.find((entry) => host === entry.suffix || host.endsWith('.' + entry.suffix));
}

export function providerNameFromUrl(url: string): string {
  const raw = (url ?? '').trim();
  if (!raw) {
    return VENDORED_PROVIDER.name;
  }
  const known = knownProviderHost(raw);
  if (known) {
    return known.name;
  }
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(raw);
  return match ? match[1] : raw;
}

/** The wallet dialect a provider row takes when it leaves `balance` out (see above). */
export function providerBalanceFromUrl(url: string): BalanceDialect {
  return knownProviderHost(url)?.balance ?? 'none';
}

/**
 * One unusable settings row, as **data rather than a sentence**: `code` names the rule
 * and `args` fills its placeholders. The English line is built here
 * (`CATALOG_ISSUE_TEXT` → `formatIssue`) for the output channel, and the Model Card
 * Tree page's banner reads the *same* source sentence through `vscode.l10n.t` in
 * `src/chat/modelTree.ts` — the parity of the two tables is checked by
 * `tools/check-models.js`, because this module has to stay free of `vscode`: the dev
 * scripts `require` it in plain node.
 */
export type CatalogIssueCode =
  | 'provider-not-object'
  | 'provider-name'
  | 'provider-url'
  | 'provider-balance'
  | 'provider-unknown-field'
  | 'provider-url-missing'
  | 'row-concurrency'
  | 'card-not-object'
  | 'card-name'
  | 'card-provider-id'
  | 'card-wire-model'
  | 'card-context-window'
  | 'card-vision'
  | 'card-efforts-array'
  | 'card-efforts-empty'
  | 'card-default-effort'
  | 'card-unknown-field'
  | 'card-wire-model-missing'
  | 'card-default-effort-repaired'
  | 'catalog-not-object'
  | 'catalog-empty-id';

/** One reported problem, with the arguments its sentence interpolates. */
export interface CatalogIssue {
  code: CatalogIssueCode;
  args: (string | number)[];
}

/**
 * The English source of every issue, one literal per rule — the same wording the
 * parser has always printed. `{0}` / `{1}` are the placeholders the l10n catalogs use
 * (and `tools/check-l10n.js` compares), so a translation substitutes exactly like this
 * line does. `row-concurrency` is shared by both row kinds: its sentence differs only
 * in the row label, which travels as an argument.
 */
export const CATALOG_ISSUE_TEXT: Record<CatalogIssueCode, string> = {
  'provider-not-object': 'providers["{0}"]: expected { name, baseUrl, balance, concurrency }, got {1}',
  'provider-name': 'providers["{0}"]: name must be a non-empty string',
  'provider-url': 'providers["{0}"]: {1} must be a non-empty URL',
  'provider-balance': 'providers["{0}"]: {1} must be one of {2}, got {3}',
  'provider-unknown-field': 'providers["{0}"]: unknown field "{1}" (expected name, baseUrl, balance, concurrency)',
  'provider-url-missing': 'providers["{0}"]: baseUrl is required',
  'row-concurrency': '{0}["{1}"]: {2} must be 0 (unlimited) or a positive integer, got {3}',
  'card-not-object': 'modelCards["{0}"]: expected an object of card fields, got {1}',
  'card-name': 'modelCards["{0}"]: name must be a string',
  'card-provider-id': 'modelCards["{0}"]: providerId must be a non-empty string',
  'card-wire-model': 'modelCards["{0}"]: oaiModel must be a non-empty string',
  'card-context-window': 'modelCards["{0}"]: {1} must be a positive token count, got {2}',
  'card-vision': 'modelCards["{0}"]: vision must be true/false or { enabled, transport: "openai" | "deepseek" }',
  'card-efforts-array': 'modelCards["{0}"]: {1} must be an array of level names',
  'card-efforts-empty': 'modelCards["{0}"]: {1} must name at least one level',
  'card-default-effort': 'modelCards["{0}"]: {1} must be a level name',
  'card-unknown-field': 'modelCards["{0}"]: unknown field "{1}"',
  'card-wire-model-missing': 'modelCards["{0}"]: oaiModel is required',
  'card-default-effort-repaired': 'modelCards["{0}"]: defaultEffort "{1}" is not one of {2} — using "{3}"',
  'catalog-not-object': 'spinney.{0} must be an object of id → fields (got {1})',
  'catalog-empty-id': '{0}: a row has an empty id',
};

/** One issue, built at the site that found it. */
function issue(code: CatalogIssueCode, ...args: (string | number)[]): CatalogIssue {
  return { code, args };
}

/** Fill `{0}` / `{1}` … the way `vscode.l10n.t` does. */
function fill(text: string, args: readonly (string | number)[]): string {
  return text.replace(/\{(\d+)\}/g, (all, index) => {
    const value = args[Number(index)];
    return value === undefined ? all : String(value);
  });
}

/** The English line of one issue — what the Spinney output channel prints. */
export function formatIssue(reported: CatalogIssue): string {
  return fill(CATALOG_ISSUE_TEXT[reported.code], reported.args);
}

export interface CatalogParseResult {
  providers: ProviderSpec[];
  cards: ModelCard[];
  /** Every problem, structured: the load for a localized reader (the page's banner). */
  issues: CatalogIssue[];
  /** The same problems as English lines, for the output channel. */
  errors: string[];
}

const PROVIDER_URL_KEYS = new Set(['baseurl', 'url', 'endpoint']);
const PROVIDER_BALANCE_KEYS = new Set(['balance', 'wallet']);
const CARD_PROVIDER_KEYS = new Set(['providerid', 'provider']);
const CARD_WIRE_KEYS = new Set(['oaimodel', 'model', 'wiremodel']);
const WINDOW_KEYS = new Set(['contextwindow', 'max_tokens', 'context', 'window']);
const EFFORT_KEYS = new Set(['efforts', 'effortlevels', 'thinkinglevels']);
const DEFAULT_EFFORT_KEYS = new Set(['defaulteffort', 'default_effort', 'defaulteffortlevel']);
const CONCURRENCY_KEYS = new Set(['concurrency', 'maxconcurrent', 'concurrent']);

function positiveInt(raw: unknown, underscoreTolerant = false): number | undefined {
  const value = typeof raw === 'string' && underscoreTolerant ? Number(raw.replace(/[_,]/g, '')) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.floor(value) <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function nonNegativeInt(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') {
    return 0;
  }
  const value = typeof raw === 'string' ? Number(raw.trim()) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.floor(value) < 0) {
    return undefined;
  }
  return Math.floor(value);
}

/** A provider row's own key/field problems, collected as issues. */
function parseProviderRow(id: string, rawFields: unknown, issues: CatalogIssue[]): ProviderSpec | undefined {
  if (rawFields !== undefined && rawFields !== null && (typeof rawFields !== 'object' || Array.isArray(rawFields))) {
    issues.push(issue('provider-not-object', id, JSON.stringify(rawFields)));
    return undefined;
  }
  const fields = (rawFields ?? {}) as Record<string, unknown>;
  let name = '';
  let baseUrl = '';
  let balance: BalanceDialect | undefined;
  let concurrency = 0;
  for (const [rawKey, rawValue] of Object.entries(fields)) {
    const key = rawKey.trim().toLowerCase();
    if (key === 'name') {
      name = typeof rawValue === 'string' ? rawValue.trim() : '';
      if (!name) {
        issues.push(issue('provider-name', id));
        return undefined;
      }
    } else if (PROVIDER_URL_KEYS.has(key)) {
      baseUrl = typeof rawValue === 'string' ? rawValue.trim() : '';
      if (!baseUrl) {
        issues.push(issue('provider-url', id, rawKey));
        return undefined;
      }
    } else if (PROVIDER_BALANCE_KEYS.has(key)) {
      if (!isBalanceDialect(rawValue)) {
        issues.push(issue('provider-balance', id, rawKey, BALANCE_DIALECTS.join(', '), JSON.stringify(rawValue)));
        return undefined;
      }
      balance = rawValue;
    } else if (CONCURRENCY_KEYS.has(key)) {
      const value = nonNegativeInt(rawValue);
      if (value === undefined) {
        issues.push(issue('row-concurrency', 'providers', id, rawKey, JSON.stringify(rawValue)));
        return undefined;
      }
      concurrency = value;
    } else {
      issues.push(issue('provider-unknown-field', id, rawKey));
      return undefined;
    }
  }
  if (!baseUrl) {
    issues.push(issue('provider-url-missing', id));
    return undefined;
  }
  // An omitted `balance` is answered by the host: this build ships a parser for one
  // endpoint, and a row pointing at it must keep its wallet line without being told.
  return { id, name: name || providerNameFromUrl(baseUrl), baseUrl, balance: balance ?? providerBalanceFromUrl(baseUrl), concurrency };
}

/**
 * Read the `vision` field: a boolean (the pre-object shorthand), or
 * `{ enabled, transport }`. The transport must be one of the two vendor names —
 * anything else rejects the row, exactly like an unknown key does.
 */
function parseVision(raw: unknown): VisionSpec | undefined {
  if (raw === undefined || raw === null) {
    return { enabled: false, transport: 'openai' };
  }
  if (typeof raw === 'boolean') {
    return { enabled: raw, transport: 'openai' };
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const fields = raw as Record<string, unknown>;
    let enabled = false;
    let transport: VisionTransport = 'openai';
    for (const [rawKey, rawValue] of Object.entries(fields)) {
      const key = rawKey.trim().toLowerCase();
      if (key === 'enabled') {
        if (typeof rawValue !== 'boolean') {
          return undefined;
        }
        enabled = rawValue;
      } else if (key === 'transport' || key === 'api') {
        if (rawValue !== 'openai' && rawValue !== 'deepseek') {
          return undefined;
        }
        transport = rawValue;
      } else {
        return undefined;
      }
    }
    return { enabled, transport };
  }
  return undefined;
}

function parseCardRow(id: string, rawFields: unknown, issues: CatalogIssue[]): ModelCard | undefined {
  if (rawFields !== undefined && rawFields !== null && (typeof rawFields !== 'object' || Array.isArray(rawFields))) {
    issues.push(issue('card-not-object', id, JSON.stringify(rawFields)));
    return undefined;
  }
  const fields = (rawFields ?? {}) as Record<string, unknown>;
  const card: ModelCard = {
    id,
    name: '',
    providerId: DEFAULT_PROVIDER_ID,
    oaiModel: '',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    vision: { enabled: false, transport: 'openai' },
    efforts: [...BUILTIN_EFFORTS],
    defaultEffort: DEFAULT_EFFORT,
    concurrency: 0,
  };
  for (const [rawKey, rawValue] of Object.entries(fields)) {
    const key = rawKey.trim().toLowerCase();
    if (key === 'name') {
      if (typeof rawValue !== 'string') {
        issues.push(issue('card-name', id));
        return undefined;
      }
      card.name = rawValue.trim();
    } else if (CARD_PROVIDER_KEYS.has(key)) {
      if (typeof rawValue !== 'string' || !rawValue.trim()) {
        issues.push(issue('card-provider-id', id));
        return undefined;
      }
      card.providerId = rawValue.trim();
    } else if (CARD_WIRE_KEYS.has(key)) {
      if (typeof rawValue !== 'string' || !rawValue.trim()) {
        issues.push(issue('card-wire-model', id));
        return undefined;
      }
      card.oaiModel = rawValue.trim();
    } else if (WINDOW_KEYS.has(key)) {
      const value = positiveInt(rawValue, true);
      if (value === undefined) {
        issues.push(issue('card-context-window', id, rawKey, JSON.stringify(rawValue)));
        return undefined;
      }
      card.contextWindow = value;
    } else if (key === 'vision') {
      const vision = parseVision(rawValue);
      if (!vision) {
        issues.push(issue('card-vision', id));
        return undefined;
      }
      card.vision = vision;
    } else if (EFFORT_KEYS.has(key)) {
      if (!Array.isArray(rawValue) || rawValue.some((l) => typeof l !== 'string')) {
        issues.push(issue('card-efforts-array', id, rawKey));
        return undefined;
      }
      card.efforts = (rawValue as string[]).map((l) => l.trim()).filter((l) => l !== '');
      if (card.efforts.length === 0) {
        issues.push(issue('card-efforts-empty', id, rawKey));
        return undefined;
      }
    } else if (DEFAULT_EFFORT_KEYS.has(key)) {
      if (typeof rawValue !== 'string') {
        issues.push(issue('card-default-effort', id, rawKey));
        return undefined;
      }
      card.defaultEffort = rawValue.trim();
    } else if (CONCURRENCY_KEYS.has(key)) {
      const value = nonNegativeInt(rawValue);
      if (value === undefined) {
        issues.push(issue('row-concurrency', 'modelCards', id, rawKey, JSON.stringify(rawValue)));
        return undefined;
      }
      card.concurrency = value;
    } else {
      issues.push(issue('card-unknown-field', id, rawKey));
      return undefined;
    }
  }
  if (!card.oaiModel) {
    issues.push(issue('card-wire-model-missing', id));
    return undefined;
  }
  if (!card.name) {
    card.name = card.oaiModel;
  }
  // A default that is not on the menu would send a level the card never offered.
  const levels = card.efforts;
  const chosen = levels.find((l) => l.toLowerCase() === card.defaultEffort.toLowerCase());
  if (!chosen) {
    issues.push(issue('card-default-effort-repaired', id, card.defaultEffort, levels.join(', '), levels[0]));
    card.defaultEffort = levels.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : levels[0];
  } else {
    card.defaultEffort = chosen;
  }
  return card;
}

/**
 * Parse `spinney.providers` and `spinney.modelCards`. Both are **structured
 * data** — an object of id → fields — because that is what a hand-edited
 * `settings.json` should contain; the Model Card Tree page is their editor and
 * writes them back through `configuration.update`. A row that cannot be parsed is
 * skipped and reported, so the settings can never silently half-apply.
 */
export function parseCatalog(providersRaw: unknown, cardsRaw: unknown): CatalogParseResult {
  const providers: ProviderSpec[] = [];
  const cardsOut: ModelCard[] = [];
  const issues: CatalogIssue[] = [];

  for (const [label, raw, row, push] of [
    ['providers', providersRaw, parseProviderRow, providers],
    ['modelCards', cardsRaw, parseCardRow, cardsOut],
  ] as const) {
    if (raw === undefined || raw === null || raw === '') {
      continue;
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      issues.push(issue('catalog-not-object', label, Array.isArray(raw) ? 'an array' : typeof raw));
      continue;
    }
    for (const [rawId, rawFields] of Object.entries(raw as Record<string, unknown>)) {
      const id = rawId.trim();
      if (!id) {
        issues.push(issue('catalog-empty-id', label));
        continue;
      }
      const parsed = row(id, rawFields, issues);
      if (parsed) {
        (push as unknown[]).push(parsed);
      }
    }
  }

  // The English copy is a projection of the issues, never a second source: the output
  // channel prints these lines, the page's banner asks `src/chat/modelTree.ts` for the
  // same issues in the display language.
  return { providers, cards: cardsOut, issues, errors: issues.map(formatIssue) };
}

/** The provider's own sentence: "maximum context length is <N> tokens. However, you requested <M>". */
const CONTEXT_WINDOW_SENTENCE =
  /maximum\s+context\s+length\s+is\s+([\d][\d.,_]*)\s*tokens\b[\s\S]{0,160}?you\s+requested\s+([\d][\d.,_]*)/i;
/** The same sentence without the "requested" half (a reworded provider still names its window). */
const CONTEXT_WINDOW_ONLY = /maximum\s+context\s+length\s+is\s+([\d][\d.,_]*)\s*tokens\b/i;
/** The window named loosely, for a provider that reorders the sentence. */
const LOOSE_WINDOW = /(?:context\s+length|context\s+window|maximum\s+context)[^\d]{0,32}?([\d][\d.,_]*)/i;
/** The refused size, phrased loosely. */
const REQUESTED_SIZE = /(?:you\s+requested|requested|you\s+sent|sent)[^\d]{0,24}([\d][\d.,_]*)/i;
/**
 * The wording that means "this request was refused for being too big". Deliberately
 * a fixed list: an unrelated failure must never start a rollover (§11 of the
 * contract has no threshold pre-emption, so the trigger has to be exactly this).
 */
const CONTEXT_LENGTH_HINT = /context_length_exceeded|context length|reduce the length|too many tokens|maximum context/i;

/** Digits of a token count, tolerating thousands separators (`1,048,576`). */
function tokenCount(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const digits = raw.replace(/[^0-9]/g, '');
  if (!digits) {
    return undefined;
  }
  const value = Number(digits);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Read the window and the refused size out of a provider context-length error —
 * the **only** authoritative runtime statement of a context window (see
 * `docs/agents/invariants/model-capabilities.md`: no listing, header or probe
 * carries one). It is the rollover trigger: a node is context-full exactly when
 * its failure text parses here, and a `usage.prompt_tokens` readout never is.
 *
 * It is a pure *reader* of error text: it must never write a card.
 */
export function parseContextLengthError(text: string): { window?: number; requested?: number } | undefined {
  const body = text ?? '';
  const sentence = CONTEXT_WINDOW_SENTENCE.exec(body);
  if (sentence) {
    return { window: tokenCount(sentence[1]), requested: tokenCount(sentence[2]) };
  }
  const windowOnly = CONTEXT_WINDOW_ONLY.exec(body);
  if (!windowOnly && !CONTEXT_LENGTH_HINT.test(body)) {
    return undefined;
  }
  const window = windowOnly ? tokenCount(windowOnly[1]) : tokenCount(LOOSE_WINDOW.exec(body)?.[1]);
  return { window, requested: tokenCount(REQUESTED_SIZE.exec(body)?.[1]) };
}
