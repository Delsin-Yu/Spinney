/**
 * The model catalog — the **single** place that knows which models this harness
 * recognizes, how big their context window is, and which of them accept images.
 *
 * Everything derives from here, so adding/removing a model is a one-line edit:
 *   - the settings dropdown (`package.json` `agentHarness.model.enum`, which
 *     cannot import TypeScript) is verified against this list by
 *     `tools/check-models.js` on every `build-deploy`,
 *   - user-facing copy (README, settings description) may name models, but only
 *     ones listed here — the same check fails the build otherwise,
 *   - plugin text that reaches the model (the system prompt, tool descriptions,
 *     tool error messages) must **never** hardcode a model id: it asks for
 *     `visionModelsLabel()` instead. Naming a model inline is a build error.
 */

export interface ModelSpec {
  /** The id sent to the API; also the value of `agentHarness.model`. */
  id: string;
  /** Context window in tokens, for the usage indicator. */
  contextWindow: number;
  /** True if the model accepts image input (attach/paste, `read_image`). */
  vision: boolean;
}

/** Used when a model is unknown or unset. */
const DEFAULT_CONTEXT_WINDOW = 1_000_000;

export const MODEL_CATALOG: readonly ModelSpec[] = [
  { id: 'deepseek-chat', contextWindow: DEFAULT_CONTEXT_WINDOW, vision: false },
  { id: 'deepseek-reasoner', contextWindow: DEFAULT_CONTEXT_WINDOW, vision: false },
  { id: 'deepseek-v4-flash', contextWindow: DEFAULT_CONTEXT_WINDOW, vision: false },
  { id: 'deepseek-v4-pro', contextWindow: DEFAULT_CONTEXT_WINDOW, vision: false },
  { id: 'deepseek-v4-flash-vision-exp', contextWindow: DEFAULT_CONTEXT_WINDOW, vision: true },
  { id: 'deepseek-v4.1-flash-expires-on-0910', contextWindow: DEFAULT_CONTEXT_WINDOW, vision: true },
];

/** The model used when nothing is configured. */
export const DEFAULT_MODEL = 'deepseek-chat';

/** The model ids the harness recognizes. */
export function modelIds(): string[] {
  return MODEL_CATALOG.map((m) => m.id);
}

/** True if the id is one this harness knows about. */
export function isKnownModel(model: string): boolean {
  return MODEL_CATALOG.some((m) => m.id === model);
}

/** True if the model accepts image content blocks. */
export function isVisionModel(model: string): boolean {
  return MODEL_CATALOG.find((m) => m.id === model)?.vision === true;
}

/** Context window in tokens (the default when the model is unknown). */
export function contextWindowFor(model: string): number {
  return MODEL_CATALOG.find((m) => m.id === model)?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
}

/** The vision model ids, in catalog order. */
export function visionModelIds(): string[] {
  return MODEL_CATALOG.filter((m) => m.vision).map((m) => m.id);
}

/**
 * The vision models as prose for a message to the user/model, e.g.
 * "deepseek-a 或 deepseek-b". Empty string when no vision model is configured —
 * callers must handle that (never print an empty parenthesis).
 */
export function visionModelsLabel(): string {
  return visionModelIds().join(' 或 ');
}
