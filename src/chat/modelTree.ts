/**
 * The **Model Card Tree** page: the host half of the dedicated model-manager tab.
 *
 * The page is a second webview (`ModelPanel`, its own HTML shell and its own
 * `media/modeltree.js`) whose subject is `spinney.providers` +
 * `spinney.modelCards` + `spinney.model`. This controller is the only place that
 * reads or writes those three keys from the page, so the validation rules live in
 * exactly one place — the page mirrors them for instant feedback, and the host is
 * the authority (a hand-crafted `postMessage` can never write a card that would
 * break a request).
 *
 * The message protocol is documented at the top of `ModelPanel.ts` and mirrored
 * in `media/modeltree.js`; the guard `tools/check-modeltree.js` replays it.
 */

import * as vscode from 'vscode';
import { isBalanceDialect } from '../agent/balance';
import { CardView, ModelPanel, ModelPanelOptions, ModelTreeSave, ModelTreeSnapshot, ProviderView } from './ModelPanel';
import {
  BUILTIN_CARD_DEFAULTS,
  BUILTIN_PROVIDER_DEFAULTS,
  CatalogIssue,
  CatalogIssueCode,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_ID,
  FRESH_CARD_DEFAULTS,
  FRESH_PROVIDER_DEFAULTS,
  newId,
  parseCatalog,
} from '../agent/models';

/** The pre-card SecretStorage entry; the built-in provider keeps using it. */
export const LEGACY_API_KEY_SECRET = 'spinney.apiKey';

/**
 * Where a provider's key lives. The built-in provider keeps the historical name
 * so an existing install does not have to re-enter its key; every other provider
 * gets its own entry, so switching providers never leaks one key into another.
 */
export function apiKeySecretName(providerId: string): string {
  return providerId === DEFAULT_PROVIDER_ID ? LEGACY_API_KEY_SECRET : `${LEGACY_API_KEY_SECRET}.${providerId}`;
}

/** A parsed row of the settings, before the page's view shape is built. */
interface SettingsRows {
  providers: Record<string, unknown>;
  cards: Record<string, unknown>;
  defaultCardId: string;
}

export interface ModelTreeControllerOptions {
  extensionUri: vscode.Uri;
  /** The `?v=` cache-buster shared with the chat webview. */
  mediaVersion: string;
  /** True when a key is stored for the provider (or the environment supplies one). */
  hasKey(providerId: string): Promise<boolean>;
  /** Store a key for a provider (SecretStorage). */
  storeKey(providerId: string, key: string): Promise<void>;
  /** Forget a provider's key. */
  clearKey(providerId: string): Promise<void>;
  /**
   * Called after a successful save: re-read the three settings keys, reinstall
   * the catalog, push the change into every live session and refresh balances.
   */
  onSaved(): void;
  log(line: string): void;
}

export class ModelTreeController {
  private panel?: ModelPanel;

  constructor(private readonly opts: ModelTreeControllerOptions) {}

  /** The command / the gear button: open the page, or focus the tab that exists. */
  open(): void {
    if (this.panel) {
      this.panel.focus();
      void this.postSnapshot();
      return;
    }
    this.panel = ModelPanel.create(this.panelOptions());
  }

  /** A VS Code-restored tab (window reload) is adopted instead of created. */
  restore(panel: vscode.WebviewPanel): void {
    this.panel?.dispose();
    this.panel = ModelPanel.revive(panel, this.panelOptions());
  }

  private panelOptions(): ModelPanelOptions {
    return {
      extensionUri: this.opts.extensionUri,
      mediaVersion: this.opts.mediaVersion,
      title: vscode.l10n.t('Model Cards'),
      onMessage: (message) => this.handle(message),
      onDispose: () => {
        this.panel = undefined;
      },
    };
  }

  private handle(message: unknown): void {
    const type = (message as { type?: unknown } | null)?.type;
    switch (type) {
      case 'ready':
        void this.postSnapshot();
        return;
      case 'save':
        void this.save((message as { payload?: ModelTreeSave }).payload);
        return;
      case 'dirty':
        // The page's draft drifted from what the host last posted (or came back):
        // the panel's title carries the marker, nothing else here changes.
        this.applyDirty((message as { dirty?: unknown }).dirty === true);
        return;
      case 'openSettingsJson':
        void vscode.commands.executeCommand('workbench.action.openSettingsJson', {
          revealSetting: { key: 'spinney.modelCards', edit: true },
        });
        return;
      default:
        this.opts.log(`[model-tree] ignoring unknown page message: ${String(type)}`);
    }
  }

  /**
   * The page's dirty flag, on the panel's title: `* Model Cards` while the draft holds
   * unsaved edits, plain `Model Cards` once it does not. VS Code cannot veto a tab
   * close (`WebviewPanel` only reports `onDidDispose`), so the title is the one place
   * the *tab itself* can say "this is not what is stored" — the strip the page draws at
   * the top of the view says it in words.
   *
   * The marker is a glyph prefixed to the translated name, not a translated sentence of
   * its own: a narrow tab truncates from the right, and `*` needs no translation (the
   * same rule the compact dock tokens follow, see docs/agents/invariants/i18n.md).
   */
  private applyDirty(dirty: boolean): void {
    const title = vscode.l10n.t('Model Cards');
    this.panel?.setTitle(dirty ? '* ' + title : title);
  }

  /** Read the settings, parse them, and hand the page its snapshot. */
  private async postSnapshot(): Promise<void> {
    if (!this.panel) {
      return;
    }
    const rows = this.readRows();
    const parsed = parseCatalog(rows.providers, rows.cards);
    const providers: ProviderView[] = await Promise.all(
      parsed.providers.map(async (provider) => ({
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        concurrency: provider.concurrency,
        balance: provider.balance,
        hasKey: await this.opts.hasKey(provider.id),
        isBuiltin: provider.id === DEFAULT_PROVIDER_ID,
      })),
    );
    const cards: CardView[] = parsed.cards.map((card) => ({
      id: card.id,
      name: card.name,
      providerId: card.providerId,
      oaiModel: card.oaiModel,
      contextWindow: card.contextWindow,
      concurrency: card.concurrency,
      vision: card.vision,
      efforts: card.efforts,
      defaultEffort: card.defaultEffort,
      // The **vendored** card is the built-in one: it cannot be deleted, and its reset
      // buttons restore the values it ships with. A card that merely *is* the current
      // default is not `isBuiltin` — being the default is a pointer, not an identity.
      isBuiltin: card.id === DEFAULT_MODEL,
    }));
    const snapshot: ModelTreeSnapshot = {
      providers,
      cards,
      defaultCardId: parsed.cards.some((c) => c.id === rows.defaultCardId) ? rows.defaultCardId : (parsed.cards[0]?.id ?? ''),
      // The page's banner shows these lines, so they travel **in the display language**:
      // the parser reports issues (`CatalogIssue`), and the English sentence its output
      // channel prints is only one of the two readings (`ISSUE_TEXT` below).
      errors: parsed.issues.map(issueText),
      defaults: {
        builtin: { provider: BUILTIN_PROVIDER_DEFAULTS, card: BUILTIN_CARD_DEFAULTS },
        fresh: { provider: FRESH_PROVIDER_DEFAULTS, card: FRESH_CARD_DEFAULTS },
      },
    };
    this.panel.post({ type: 'modelTree', snapshot });
  }

  /** The three raw settings values. */
  private readRows(): SettingsRows {
    const cfg = vscode.workspace.getConfiguration('spinney');
    const providers = cfg.get<Record<string, unknown>>('providers');
    const cards = cfg.get<Record<string, unknown>>('modelCards');
    return {
      providers: providers && typeof providers === 'object' && !Array.isArray(providers) ? providers : {},
      cards: cards && typeof cards === 'object' && !Array.isArray(cards) ? cards : {},
      defaultCardId: (cfg.get<string>('model') ?? '').trim(),
    };
  }

  /**
   * Validate and write a full page state. The page sends the **whole** desired
   * world, so a deletion is simply an id that is absent; a rejected save writes
   * nothing at all (never a half-applied catalog) and answers with the reasons.
   */
  private async save(payload: ModelTreeSave | undefined): Promise<void> {
    const errors = [...validatePayload(payload), ...validateBuiltinsSurvive(payload, this.readRows())];
    if (errors.length > 0) {
      this.postResult(false, errors);
      return;
    }
    const save = payload as ModelTreeSave;
    const providers: Record<string, unknown> = {};
    for (const provider of save.providers) {
      providers[provider.id] = {
        name: provider.name.trim(),
        baseUrl: provider.baseUrl.trim(),
        concurrency: Math.floor(provider.concurrency) || 0,
        balance: provider.balance,
      };
    }
    const cards: Record<string, unknown> = {};
    for (const card of save.cards) {
      cards[card.id] = {
        name: card.name.trim(),
        providerId: card.providerId,
        oaiModel: card.oaiModel.trim(),
        contextWindow: Math.floor(card.contextWindow),
        concurrency: Math.floor(card.concurrency) || 0,
        vision: { enabled: card.vision.enabled, transport: card.vision.transport },
        efforts: card.efforts.map((level) => level.trim()),
        defaultEffort: card.defaultEffort,
      };
    }

    const cfg = vscode.workspace.getConfiguration('spinney');
    // `Global` (user settings): a provider table with API keys behind it is a
    // property of the reader, and it must survive in no-folder mode, where there is
    // no workspace scope to write to.
    const target = vscode.ConfigurationTarget.Global;
    try {
      await cfg.update('providers', providers, target);
      await cfg.update('modelCards', cards, target);
      if (save.defaultCardId && save.defaultCardId !== cfg.get<string>('model')) {
        await cfg.update('model', save.defaultCardId, target);
      }
    } catch (err) {
      this.postResult(false, [
        vscode.l10n.t('Could not write the settings: {0}', err instanceof Error ? err.message : String(err)),
      ]);
      return;
    }

    for (const entry of save.apiKeys ?? []) {
      const key = (entry.key ?? '').trim();
      if (key) {
        await this.opts.storeKey(entry.providerId, key);
      }
    }
    for (const providerId of save.clearedKeys ?? []) {
      await this.opts.clearKey(providerId);
    }

    this.opts.onSaved();
    this.opts.log(
      `[model-tree] saved ${save.providers.length} provider(s), ${save.cards.length} card(s), default=${save.defaultCardId}`,
    );
    this.postResult(true, []);
    // The ids are already stable (the page generates them), but a save re-reads
    // everything anyway: the parsed view can differ from what was sent (a card
    // whose default level was repaired, say), and the page must show the truth.
    void this.postSnapshot();
  }

  private postResult(ok: boolean, errors: string[]): void {
    this.panel?.post({ type: 'modelTreeSaveResult', ok, errors, savedAt: Date.now() });
  }
}

/** Every rule the host enforces before writing; the page mirrors these for feedback. */
function validatePayload(payload: ModelTreeSave | undefined): string[] {
  const errors: string[] = [];
  if (!payload || typeof payload !== 'object') {
    return [vscode.l10n.t('The page sent no model configuration.')];
  }
  const providers = Array.isArray(payload.providers) ? payload.providers : [];
  const cards = Array.isArray(payload.cards) ? payload.cards : [];
  if (providers.length === 0) {
    errors.push(vscode.l10n.t('At least one provider is required.'));
  }
  if (cards.length === 0) {
    errors.push(vscode.l10n.t('At least one model card is required.'));
  }

  const providerIds = new Set<string>();
  for (const provider of providers) {
    const id = (provider.id ?? '').trim();
    const label = (provider.name ?? '').trim() || id || '?';
    if (!id) {
      errors.push(vscode.l10n.t('A provider has no id.'));
    } else if (providerIds.has(id)) {
      errors.push(vscode.l10n.t('Two providers share the id "{0}".', id));
    }
    providerIds.add(id);
    if (!isPlainString(provider.name)) {
      errors.push(vscode.l10n.t('Provider "{0}": a name is required.', label));
    }
    if (!isPlainString(provider.baseUrl) || /\s/.test(provider.baseUrl)) {
      errors.push(vscode.l10n.t('Provider "{0}": a base URL without spaces is required.', label));
    }
    if (!isCount(provider.concurrency)) {
      errors.push(vscode.l10n.t('Provider "{0}": concurrency must be 0 or a positive integer.', label));
    }
    if (!isBalanceDialect(provider.balance)) {
      errors.push(vscode.l10n.t('Provider "{0}": the wallet line is not a dialect this build knows.', label));
    }
  }

  const cardIds = new Set<string>();
  const cardNames = new Set<string>();
  for (const card of cards) {
    const id = (card.id ?? '').trim();
    const label = (card.name ?? '').trim() || id || '?';
    if (!id) {
      errors.push(vscode.l10n.t('A model card has no id.'));
    } else if (cardIds.has(id)) {
      errors.push(vscode.l10n.t('Two model cards share the id "{0}".', id));
    }
    cardIds.add(id);
    if (!isPlainString(card.name)) {
      errors.push(vscode.l10n.t('Card "{0}": a name is required.', label));
    } else if (cardNames.has(card.name.trim().toLowerCase())) {
      errors.push(vscode.l10n.t('Two model cards are called "{0}".', card.name.trim()));
    } else {
      cardNames.add(card.name.trim().toLowerCase());
    }
    if (!isPlainString(card.oaiModel)) {
      errors.push(vscode.l10n.t('Card "{0}": the model name sent to the provider is required.', label));
    }
    if (!providerIds.has((card.providerId ?? '').trim())) {
      errors.push(vscode.l10n.t('Card "{0}": pick a provider.', label));
    }
    if (!Number.isFinite(card.contextWindow) || Math.floor(card.contextWindow) < 1) {
      errors.push(vscode.l10n.t('Card "{0}": the context window must be at least 1 token.', label));
    }
    if (!isCount(card.concurrency)) {
      errors.push(vscode.l10n.t('Card "{0}": concurrency must be 0 or a positive integer.', label));
    }
    if (!card.vision || typeof card.vision.enabled !== 'boolean') {
      errors.push(vscode.l10n.t('Card "{0}": the vision settings are incomplete.', label));
    } else if (!isTransport(card.vision.transport)) {
      errors.push(vscode.l10n.t('Card "{0}": the image transport must be "openai" or "deepseek".', label));
    }
    const levels = Array.isArray(card.efforts) ? card.efforts.map((l) => String(l ?? '').trim()) : [];
    if (levels.length === 0 || levels.some((level) => !level)) {
      errors.push(vscode.l10n.t('Card "{0}": list at least one thinking level.', label));
    } else if (new Set(levels.map((l) => l.toLowerCase())).size !== levels.length) {
      errors.push(vscode.l10n.t('Card "{0}": the thinking levels repeat.', label));
    } else if (!levels.some((l) => l.toLowerCase() === String(card.defaultEffort ?? '').trim().toLowerCase())) {
      errors.push(vscode.l10n.t('Card "{0}": the default thinking level must be one of its levels.', label));
    }
  }

  if (payload.defaultCardId && !cardIds.has(payload.defaultCardId)) {
    errors.push(vscode.l10n.t('The default model must be one of the cards.'));
  }
  for (const entry of payload.apiKeys ?? []) {
    if (!providerIds.has((entry?.providerId ?? '').trim())) {
      errors.push(vscode.l10n.t('An API key was sent for a provider that does not exist.'));
    }
  }
  return errors;
}

/**
 * The built-in rows cannot be deleted. The page disables their delete buttons, but the
 * host is the authority (a deletion is implicit — an id that is absent from the
 * payload — so a crafted message could drop them): a row that exists in the stored
 * settings *and* carries a built-in id must still be there when the save lands.
 *
 * Renaming and editing them is fine; only their disappearance is refused.
 */
function validateBuiltinsSurvive(payload: ModelTreeSave | undefined, rows: SettingsRows): string[] {
  const errors: string[] = [];
  const saved = payload && typeof payload === 'object' ? payload : ({} as ModelTreeSave);
  const providerIds = new Set((saved.providers ?? []).map((provider) => provider && provider.id));
  const cardIds = new Set((saved.cards ?? []).map((card) => card && card.id));
  if (DEFAULT_PROVIDER_ID in rows.providers && !providerIds.has(DEFAULT_PROVIDER_ID)) {
    errors.push(vscode.l10n.t('The built-in provider cannot be removed.'));
  }
  if (DEFAULT_MODEL in rows.cards && !cardIds.has(DEFAULT_MODEL)) {
    errors.push(vscode.l10n.t('The built-in model card cannot be removed.'));
  }
  return errors;
}

function isPlainString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * A transport name the settings may hold: the two current values, named after the
 * vendor dialect. Anything else is a rejected save — the page only ever writes
 * this pair, and the parser (`parseVision` in `src/agent/models.ts`) reads it the
 * same way.
 */
function isTransport(value: unknown): boolean {
  return value === 'openai' || value === 'deepseek';
}

function isCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && Math.floor(value) >= 0;
}

/**
 * The parser's sentences in the display language — one `vscode.l10n.t` literal per
 * rule, the **same** English source `CATALOG_ISSUE_TEXT` carries in
 * `src/agent/models.ts`. That module cannot translate them (its dev guards `require` it
 * in plain node, where `vscode` does not exist), so the pair is written twice and kept
 * honest mechanically: `tools/check-l10n.js` extracts exactly this literal shape, and
 * `tools/check-models.js` fails the build when a sentence stops matching the parser's.
 *
 * The values are **functions**, not strings: `vscode.l10n.t` is resolved when the
 * banner is built, never at module load.
 */
const ISSUE_TEXT: Record<CatalogIssueCode, (args: readonly (string | number)[]) => string> = {
  'provider-not-object': (a) =>
    vscode.l10n.t('providers["{0}"]: expected { name, baseUrl, balance, concurrency }, got {1}', a[0], a[1]),
  'provider-name': (a) => vscode.l10n.t('providers["{0}"]: name must be a non-empty string', a[0]),
  'provider-url': (a) => vscode.l10n.t('providers["{0}"]: {1} must be a non-empty URL', a[0], a[1]),
  'provider-balance': (a) => vscode.l10n.t('providers["{0}"]: {1} must be one of {2}, got {3}', a[0], a[1], a[2], a[3]),
  'provider-unknown-field': (a) =>
    vscode.l10n.t('providers["{0}"]: unknown field "{1}" (expected name, baseUrl, balance, concurrency)', a[0], a[1]),
  'provider-url-missing': (a) => vscode.l10n.t('providers["{0}"]: baseUrl is required', a[0]),
  'row-concurrency': (a) =>
    vscode.l10n.t('{0}["{1}"]: {2} must be 0 (unlimited) or a positive integer, got {3}', a[0], a[1], a[2], a[3]),
  'card-not-object': (a) => vscode.l10n.t('modelCards["{0}"]: expected an object of card fields, got {1}', a[0], a[1]),
  'card-name': (a) => vscode.l10n.t('modelCards["{0}"]: name must be a string', a[0]),
  'card-provider-id': (a) => vscode.l10n.t('modelCards["{0}"]: providerId must be a non-empty string', a[0]),
  'card-wire-model': (a) => vscode.l10n.t('modelCards["{0}"]: oaiModel must be a non-empty string', a[0]),
  'card-context-window': (a) =>
    vscode.l10n.t('modelCards["{0}"]: {1} must be a positive token count, got {2}', a[0], a[1], a[2]),
  'card-vision': (a) =>
    vscode.l10n.t('modelCards["{0}"]: vision must be true/false or { enabled, transport: "openai" | "deepseek" }', a[0]),
  'card-efforts-array': (a) => vscode.l10n.t('modelCards["{0}"]: {1} must be an array of level names', a[0], a[1]),
  'card-efforts-empty': (a) => vscode.l10n.t('modelCards["{0}"]: {1} must name at least one level', a[0], a[1]),
  'card-default-effort': (a) => vscode.l10n.t('modelCards["{0}"]: {1} must be a level name', a[0], a[1]),
  'card-unknown-field': (a) => vscode.l10n.t('modelCards["{0}"]: unknown field "{1}"', a[0], a[1]),
  'card-wire-model-missing': (a) => vscode.l10n.t('modelCards["{0}"]: oaiModel is required', a[0]),
  'card-default-effort-repaired': (a) =>
    vscode.l10n.t('modelCards["{0}"]: defaultEffort "{1}" is not one of {2} — using "{3}"', a[0], a[1], a[2], a[3]),
  'catalog-not-object': (a) => vscode.l10n.t('spinney.{0} must be an object of id → fields (got {1})', a[0], a[1]),
  'catalog-empty-id': (a) => vscode.l10n.t('{0}: a row has an empty id', a[0]),
};

/** One issue, as the line the page's banner shows. */
function issueText(reported: CatalogIssue): string {
  return ISSUE_TEXT[reported.code](reported.args);
}

/** The id a freshly created row gets. The page generates its own; this is the fallback. */
export function freshId(): string {
  return newId();
}
