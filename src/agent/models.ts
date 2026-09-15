/**
 * The model catalog — the **single** place that knows which models this harness
 * recognizes, how big their context window is, and which of them accept images.
 *
 * Exactly one model is vendored: `deepseek-flash` (DeepSeek-V4.1-Flash, a
 * 1,048,576-token context window, image input). Everything else is the user's
 * business, declared in the `spinney.modelTable` setting — including the
 * legacy ids DeepSeek still accepts (they are served by the same V4.1-Flash
 * backend, so they are vision-capable no matter what their name suggests) and
 * `deepseek-v4-pro` once it is routed to V4.1-Flash as well. See
 * `docs/agents/invariants/model-capabilities.md` for why nothing is probed.
 *
 * Everything derives from here, so changing the vendored model is a one-line
 * edit:
 *   - the settings dropdown (`package.json` `spinney.model.enum`, which
 *     cannot import TypeScript) is verified against this list by
 *     `tools/check-models.js` on every `build-deploy`,
 *   - the chat's model dropdown is built at runtime from {@link modelIds}
 *     (vendored + `spinney.modelTable`), so a user-added model is pickable,
 *   - user-facing copy (README, settings description) may name models, but only
 *     ones listed here — the same check fails the build otherwise,
 *   - plugin text that reaches the model (the system prompt, tool descriptions,
 *     tool error messages) must **never** hardcode a model id: it asks for
 *     `visionModelsLabel()` instead. Naming a model inline is a build error.
 */

export interface ModelSpec {
  /** The id sent to the API; also the value of `spinney.model`. */
  id: string;
  /** Context window in tokens, for the usage indicator. */
  contextWindow: number;
  /** True if the model accepts image input (attach/paste, `read_image`). */
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

/** The model used when nothing is configured. */
export const DEFAULT_MODEL = VENDORED_MODEL.id;

/** Used when a model is unknown and nothing else applies. */
export const DEFAULT_CONTEXT_WINDOW = VENDORED_MODEL.contextWindow;

/** Ids listed in `spinney.modelTable`; empty until the provider applies the setting. */
let overrides: ModelSpec[] = [];

/**
 * Install the parsed `spinney.modelTable`. Called by the chat provider on
 * activation and on every settings change; the table is *user* configuration,
 * never discovered by talking to the API.
 */
export function setModelOverrides(specs: readonly ModelSpec[]): void {
  overrides = [...specs];
}

/**
 * The vendored models plus the user's table, deduped by id: a table row for
 * `deepseek-flash` overrides the vendored description of it, a row for an
 * unknown id adds a model, and the vendored entry keeps its position so the
 * dropdown order is stable.
 */
export function modelSpecs(): ModelSpec[] {
  const merged = new Map<string, ModelSpec>();
  for (const spec of MODEL_CATALOG) {
    merged.set(spec.id, spec);
  }
  for (const spec of overrides) {
    merged.set(spec.id, spec);
  }
  return [...merged.values()];
}

/** The model ids the harness recognizes (vendored first, then user-added). */
export function modelIds(): string[] {
  return modelSpecs().map((m) => m.id);
}

/** True if the id is one this harness knows about. */
export function isKnownModel(model: string): boolean {
  return modelSpecs().some((m) => m.id === model);
}

/** True if the id was listed in `spinney.modelTable` (row wins over the settings fallback). */
export function isTableModel(model: string): boolean {
  return overrides.some((m) => m.id === model);
}

/** True if the model accepts image content blocks. Unknown ids are not vision models. */
export function isVisionModel(model: string): boolean {
  return modelSpecs().find((m) => m.id === model)?.vision === true;
}

/** Context window in tokens (the default when the model is unknown). */
export function contextWindowFor(model: string): number {
  return modelSpecs().find((m) => m.id === model)?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
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
 * It is a pure *reader* of error text: it must never write `spinney.modelTable`.
 * When the 400's window disagrees with `contextWindowFor()`, the setting stays the
 * user's and the disagreement is only logged (`[config]`).
 *
 * Primary match is the sentence the provider actually emits (`maximum context
 * length is 1,048,576 tokens. However, you requested 2,000,000`, thousands
 * separators / casing / whitespace tolerated). The loose fallback keeps a
 * reworded provider triggering a rollover; it returns an object with its fields
 * `undefined` when the wording matches but no number can be read. Only text that
 * matches nothing at all returns `undefined`.
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
  const window = windowOnly
    ? tokenCount(windowOnly[1])
    : tokenCount(LOOSE_WINDOW.exec(body)?.[1]);
  return { window, requested: tokenCount(REQUESTED_SIZE.exec(body)?.[1]) };
}

/** The vision model ids, in catalog order. */
export function visionModelIds(): string[] {
  return modelSpecs().filter((m) => m.vision).map((m) => m.id);
}

/**
 * The vision models as prose for a message to the user/model, e.g.
 * "deepseek-a or deepseek-b". Empty string when no vision model is configured —
 * callers must handle that (never print an empty parenthesis).
 */
export function visionModelsLabel(): string {
  return visionModelIds().join(' or ');
}

export interface ModelTableParseResult {
  specs: ModelSpec[];
  /** One human-readable line per unusable row, for the output channel. */
  errors: string[];
}

/** Field names accepted for the context window (first one is the documented spelling). */
const WINDOW_KEYS = new Set(['max_tokens', 'context', 'context_window', 'window']);

/**
 * Parse the `spinney.modelTable` setting. It is **structured data** — an
 * object of model id → fields — because that is what a hand-edited
 * `settings.json` should contain, and the setting's own UI is just a link into
 * it (VS Code can only render a two-column key/value table from a schema).
 * A three-column model/vision/window editor was tried as a chat-panel table and
 * rejected: the data *is* the UI. See
 * `docs/agents/invariants/model-capabilities.md`.
 *
 *     "spinney.modelTable": {
 *       "deepseek-v4-pro": { "vision": false, "max_tokens": 1048576 }
 *     }
 *
 * `max_tokens` is the model's **context window** in tokens (not the API's
 * `max_tokens` output cap); `context_window` is accepted as an alias. An empty
 * entry is fine, and a field left out keeps the vendored value for that id, or
 * non-vision / {@link DEFAULT_CONTEXT_WINDOW} for a new one. A row that cannot be
 * parsed is skipped and reported, so the setting can never silently half-apply.
 */
export function parseModelTable(value: unknown): ModelTableParseResult {
  const specs: ModelSpec[] = [];
  const errors: string[] = [];

  if (value === undefined || value === null || value === '') {
    return { specs, errors };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    errors.push(
      `the setting must be an object of model id → { vision, max_tokens } (got ${Array.isArray(value) ? 'an array' : typeof value})`,
    );
    return { specs, errors };
  }

  for (const [rawId, rawFields] of Object.entries(value as Record<string, unknown>)) {
    const id = rawId.trim();
    if (!id) {
      errors.push('a row has an empty model id');
      continue;
    }
    if (rawFields !== undefined && rawFields !== null && (typeof rawFields !== 'object' || Array.isArray(rawFields))) {
      errors.push(`"${id}": expected { "vision": <bool>, "max_tokens": <int> }, got ${JSON.stringify(rawFields)}`);
      continue;
    }

    const vendored = MODEL_CATALOG.find((m) => m.id === id);
    const fields = (rawFields ?? {}) as Record<string, unknown>;
    let contextWindow: number | undefined;
    let vision: boolean | undefined;
    let bad = false;

    for (const [rawKey, rawValue] of Object.entries(fields)) {
      const key = rawKey.trim().toLowerCase();
      if (key === 'vision') {
        if (typeof rawValue === 'boolean') {
          vision = rawValue;
        } else {
          errors.push(`"${id}": vision must be true or false, got ${JSON.stringify(rawValue)}`);
          bad = true;
          break;
        }
      } else if (WINDOW_KEYS.has(key)) {
        const tokens = typeof rawValue === 'string' ? Number(rawValue.replace(/_/g, '')) : rawValue;
        if (typeof tokens !== 'number' || !Number.isFinite(tokens) || Math.floor(tokens) <= 0) {
          errors.push(`"${id}": ${rawKey} must be a positive token count, got ${JSON.stringify(rawValue)}`);
          bad = true;
          break;
        }
        contextWindow = Math.floor(tokens);
      } else {
        errors.push(`"${id}": unknown field "${rawKey}" (expected vision or max_tokens)`);
        bad = true;
        break;
      }
    }
    if (bad) {
      continue;
    }

    specs.push({
      id,
      contextWindow: contextWindow ?? vendored?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      vision: vision ?? vendored?.vision ?? false,
    });
  }

  return { specs, errors };
}
