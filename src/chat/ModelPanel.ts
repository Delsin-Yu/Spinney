import * as vscode from 'vscode';
import { BalanceDialect } from '../agent/balance';
import { CardDefaults, ProviderDefaults } from '../agent/models';
import { displayLocale, webviewL10n } from '../i18n';

/**
 * View type of the Model Card Tree page; also its serializer id (window recovery).
 *
 * The page is a *browser and editor of the stored model configuration*: one card
 * per provider, the provider's model cards branching below it. It is deliberately
 * not part of the chat surface — the chat tree shows a session, this page shows
 * settings — but it is the same kind of thing structurally (one webview document
 * driven by a frozen message protocol), so it mirrors `ChatPanel`'s lifecycle
 * exactly: build the shell in the constructor, hold what is posted before the
 * page says `ready`, and hand every page→host message to the provider verbatim.
 *
 * The host glue (the command, the serializer, reading/writing the settings store,
 * the chat-side dropdowns) lives elsewhere and imports the types below.
 */
export const MODEL_VIEW_TYPE = 'spinney.modelTree';

/** One provider node, as the page renders it. */
export interface ProviderView {
  id: string;
  name: string;
  baseUrl: string;
  concurrency: number;
  /** How this endpoint's wallet line is read (see `src/agent/balance.ts`). */
  balance: BalanceDialect;
  hasKey: boolean;
  isBuiltin: boolean;
}

/** One model card hanging off a provider. */
export interface CardView {
  id: string;
  name: string;
  providerId: string;
  oaiModel: string;
  contextWindow: number;
  concurrency: number;
  vision: { enabled: boolean; transport: 'openai' | 'deepseek' };
  efforts: string[];
  defaultEffort: string;
  isBuiltin: boolean;
}

/**
 * What every reset button restores, per row kind: `builtin` is the built-in provider /
 * vendored card's own factory state, `fresh` is what a brand-new row carries. The page
 * never hardcodes a default — it asks the host, so there is exactly one copy of them
 * (see `defaultsForProvider` / `defaultsForCard` in `src/agent/models.ts`).
 */
export interface ModelTreeDefaults {
  builtin: { provider: ProviderDefaults; card: CardDefaults };
  fresh: { provider: ProviderDefaults; card: CardDefaults };
}

/** Everything the page needs to draw itself once (posted on `ready`). */
export interface ModelTreeSnapshot {
  providers: ProviderView[];
  cards: CardView[];
  defaultCardId: string;
  errors: string[];
  defaults: ModelTreeDefaults;
}

/** A provider as it is written back: the derived fields are the host's business. */
export type ProviderSave = Omit<ProviderView, 'hasKey' | 'isBuiltin'>;
/** A card as it is written back (`isBuiltin` is not a user-editable field). */
export type CardSave = Omit<CardView, 'isBuiltin'>;

/**
 * The whole desired state, always: the page edits a local draft and posts all of
 * it, so a deletion is simply an id that is no longer in the list.
 */
export interface ModelTreeSave {
  providers: ProviderSave[];
  cards: CardSave[];
  defaultCardId: string;
  apiKeys: { providerId: string; key: string }[];
  clearedKeys: string[];
}

/** Everything a panel needs regardless of how it came into existence. */
export interface ModelPanelOptions {
  extensionUri: vscode.Uri;
  /** The `?v=` cache-buster for the two media files (`mediaVersion` in the provider). */
  mediaVersion: string;
  title: string;
  /** Every page→host message, verbatim (the glue owns the protocol). */
  onMessage: (message: unknown) => void;
  onDispose: () => void;
}

/**
 * Message types a fresh `modelTree` snapshot supersedes. A panel whose webview has
 * not said `ready` yet holds its messages; on `ready` these are dropped, because
 * the snapshot the host posts right after `ready` replaces them wholesale (the
 * same rule as `ChatPanel`'s `REPAINT_TYPES`).
 */
const REPAINT_TYPES = new Set(['modelTree']);
/** Safety cap for the pre-ready queue: a webview that never says `ready` must not grow it. */
const MAX_HELD = 400;

/**
 * The Model Card Tree page in the editor area.
 *
 * One panel per page: the page has no session identity, so a second open tab is
 * just another editor view of the same stored configuration (they converge on the
 * next snapshot — the host decides whether it wants to allow more than one).
 */
export class ModelPanel {
  readonly panel: vscode.WebviewPanel;

  private readonly webview: vscode.Webview;
  /** Set by `dispose()`: a disposed webview rejects every postMessage. */
  private disposed = false;
  /** Set by the page's first `ready`: before that, nothing can be consumed. */
  private ready = false;
  /** Messages posted before `ready`, held for `markReady`/`flushHeld`. */
  private held: unknown[] = [];

  private constructor(opts: ModelPanelOptions & { panel: vscode.WebviewPanel }) {
    this.panel = opts.panel;
    this.webview = opts.panel.webview;
    // The shell has to exist before the first message is routed, and building it
    // is what tells VS Code which local files the document may load.
    this.webview.html = getHtml(this.webview, opts);
    this.webview.onDidReceiveMessage((message) => {
      // The page says `ready` once. That is the moment messages may be delivered:
      // release what was held first, then forward `ready` itself — the host's
      // `ready` handler posts the snapshot, which is the page's first repaint.
      if (isReady(message)) {
        this.markReady();
        this.flushHeld();
      }
      opts.onMessage(message);
    });
    this.panel.onDidDispose(() => opts.onDispose());
  }

  /** Create a new model card tree page in the active editor column. */
  static create(opts: ModelPanelOptions): ModelPanel {
    const panel = vscode.window.createWebviewPanel(
      MODEL_VIEW_TYPE,
      opts.title,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        // The page keeps a dirty draft: hiding the tab (switching editors) must
        // not throw unsaved edits away, exactly like the chat panel's tree state.
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(opts.extensionUri, 'media')],
      },
    );
    return new ModelPanel({ ...opts, panel });
  }

  /**
   * Adopt a panel VS Code recreated from serialized state after a window reload.
   * The serializer contract requires the extension to take ownership of the panel,
   * re-set the webview's HTML and re-hook all webview events — exactly what the
   * constructor does — so a revived page behaves like a fresh one (it posts
   * `ready` once loaded and the host answers with a snapshot).
   */
  static revive(panel: vscode.WebviewPanel, opts: ModelPanelOptions): ModelPanel {
    return new ModelPanel({ ...opts, panel });
  }

  /** Bring the page to the foreground and give it focus. */
  focus(): void {
    this.panel.reveal(undefined, false);
  }

  post(message: unknown): void {
    // `panel` is readonly and never null; the real hazard is posting after the
    // panel was disposed (the webview is gone and postMessage rejects).
    if (this.disposed) {
      return;
    }
    if (!this.ready) {
      // The page is still parsing its scripts (the vendored layout engine +
      // modeltree.js). Pushing a message at it now does not make it arrive sooner;
      // it merely queues in the webview's message port. Hold it — a held snapshot
      // is superseded by the one the `ready` handler triggers anyway.
      if (this.held.length >= MAX_HELD) {
        this.held.shift();
      }
      this.held.push(message);
      return;
    }
    this.send(message);
  }

  /** The page's script is up: messages are delivered from now on. */
  markReady(): void {
    this.ready = true;
  }

  /**
   * Release what was held before `ready`, dropping the superseded snapshots: the
   * host posts one fresh `modelTree` right after `ready`, so a page that came up
   * late renders once instead of rendering a stale tree and then replacing it.
   */
  flushHeld(): void {
    const held = this.held;
    this.held = [];
    for (const message of held) {
      const type = (message as { type?: unknown } | null)?.type;
      if (typeof type === 'string' && REPAINT_TYPES.has(type)) {
        continue;
      }
      this.send(message);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.held = [];
    this.panel.dispose();
  }

  /** Hand one message to the page. A torn-down webview rejects; nothing to do. */
  private send(message: unknown): void {
    void this.webview.postMessage(message).then(undefined, () => {
      /* the webview was torn down mid-flight */
    });
  }
}

/** Is this the page's one boot message? Guarded: `onMessage` carries untrusted shape. */
function isReady(message: unknown): boolean {
  return !!message && typeof message === 'object' && (message as { type?: unknown }).type === 'ready';
}

/**
 * The page's HTML shell.
 *
 * Fixed by the protocol (see the class comment): the vendored layout engine and
 * `media/modeltree.js`, in that order and both carrying the CSP nonce, the page's
 * stylesheet, and the whole l10n catalog inline — a webview has no `vscode.l10n`,
 * so `media/modeltree.js` looks strings up in `window.__spinneyL10n` with its own
 * `tr()` (the same key, one catalog file: see src/i18n.ts). The strings this shell
 * renders itself ask `vscode.l10n` directly.
 */
function getHtml(webview: vscode.Webview, opts: ModelPanelOptions): string {
  // A cache-busting version suffix so the webview re-fetches the media files when
  // they change (`asWebviewUri` does not change with file content).
  const withV = (uri: string) => `${uri}${uri.includes('?') ? '&' : '?'}v=${opts.mediaVersion}`;
  const scriptUri = withV(String(webview.asWebviewUri(vscode.Uri.joinPath(opts.extensionUri, 'media', 'modeltree.js'))));
  const styleUri = withV(String(webview.asWebviewUri(vscode.Uri.joinPath(opts.extensionUri, 'media', 'modeltree.css'))));
  // Vendored, pinned tree-layout engine (non-layered-tidy-tree-layout@2.0.2, MIT),
  // the same engine the chat tree draws with. Not an npm dependency — see
  // media/vendor/non-layered-tidy-tree-layout/PROVENANCE.md.
  const layoutEngineUri = withV(String(webview.asWebviewUri(vscode.Uri.joinPath(opts.extensionUri, 'media', 'vendor', 'non-layered-tidy-tree-layout', 'dist', 'non-layered-tidy-tree-layout.js'))));
  const nonce = getNonce();
  const l10n = JSON.stringify(webviewL10n(opts.extensionUri)).replace(/</g, '\\u003c');

  // The ids below are the page's whole fixed surface: media/modeltree.js fetches
  // every one of them by id at boot and renders everything inside them itself. There
  // is no dock and no second panel: the tree is the whole page, and the *selected*
  // card is rebuilt in place as its own form (see media/modeltree.js), so the only
  // containers here are the toolbar, the two message strips, the tree and the
  // empty-state hint.
  return `<!DOCTYPE html>
<html lang="${displayLocale()}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}';" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>${vscode.l10n.t('Model Cards')}</title>
  <script nonce="${nonce}">window.__spinneyL10n = ${l10n};</script>
</head>
<body>
  <div id="mt-toolbar">
    <button id="mt-add-provider">${vscode.l10n.t('Add provider')}</button>
    <span id="mt-spacer"></span>
    <button id="mt-fit" title="${vscode.l10n.t('Fit the tree to view')}">${vscode.l10n.t('Fit to view')}</button>
    <button id="mt-revert" disabled>${vscode.l10n.t('Revert')}</button>
    <button id="mt-save" disabled>${vscode.l10n.t('Save')}</button>
    <button id="mt-settings" title="${vscode.l10n.t('Open the settings JSON')}">${vscode.l10n.t('Settings JSON')}</button>
  </div>
  <div id="mt-banner" class="mt-banner hidden"></div>
  <div id="mt-main">
    <div id="mt-wrap">
      <div id="mt-canvas">
        <svg id="mt-edges" xmlns="http://www.w3.org/2000/svg"></svg>
        <div id="mt-nodes"></div>
      </div>
      <div id="mt-empty" class="mt-empty hidden"></div>
    </div>
  </div>
  <script nonce="${nonce}" src="${layoutEngineUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

/** The CSP nonce of one shell — per document, unpredictable (VS Code's own recipe). */
function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
