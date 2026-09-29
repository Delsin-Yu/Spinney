/**
 * webviewShell.ts — the **one** HTML shell of the chat surface, the document `media/main.js`
 * renders.
 *
 * The local chat tab opens it (`ChatViewProvider.getHtml()` → `ChatPanel`), and the caller
 * hands it a `webview` and its own `mediaVersion`.
 *
 * What this module deliberately does **not** own: the panel lifecycle, the message
 * routing, the held-before-`ready` queue. Those live in `ChatPanel` and are about *a*
 * panel, not about the document.
 *
 * Behaviour-preserving is the requirement: this is the byte-for-byte template
 * `ChatViewProvider.getHtml()` used to render — same script set and order (the vendored
 * layout engine, `markdown-it`, `media/tree.js`, `media/main.js`), same CSP, same
 * per-document nonce, same `window.__spinneyL10n` injection, same element ids, same
 * localized shell strings. `npm run check:webview` (the renderer) is the guard that decides
 * whether it still is.
 */
import * as vscode from 'vscode';
import { displayLocale, webviewL10n } from '../i18n';

/** Where the shell's assets come from, and the cache-buster they carry. */
export interface ChatShellOptions {
  /** The extension root; every asset is resolved relative to it. */
  readonly extensionUri: vscode.Uri;
  /**
   * The `?v=` suffix (`ChatViewProvider.mediaVersion`): `asWebviewUri` does not change
   * with a file's content, so without it a webview would keep a cached older script.
   */
  readonly mediaVersion: string;
}

/**
 * The chat surface's HTML document.
 *
 * A `ready` handshake, not a snapshot: the document renders itself from the messages the
 * host posts after the webview says `ready` (see `ChatPanel.markReady`).
 */
export function buildChatShell(webview: vscode.Webview, opts: ChatShellOptions): string {
  // A cache-busting version suffix so the webview re-fetches media files when
  // they change (asWebviewUri does not change with file content).
  const v = opts.mediaVersion;
  const withV = (uri: string) => `${uri}${uri.includes('?') ? '&' : '?'}v=${v}`;
  const scriptUri = withV(String(webview.asWebviewUri(vscode.Uri.joinPath(opts.extensionUri, 'media', 'main.js'))));
  const markdownItUri = withV(String(webview.asWebviewUri(vscode.Uri.joinPath(opts.extensionUri, 'media', 'vendor', 'markdown-it', 'markdown-it.min.js'))));
  const treeUri = withV(String(webview.asWebviewUri(vscode.Uri.joinPath(opts.extensionUri, 'media', 'tree.js'))));
  // Vendored, pinned tree-layout engine (non-layered-tidy-tree-layout@2.0.2, MIT).
  // Not an npm dependency — see media/vendor/non-layered-tidy-tree-layout/PROVENANCE.md.
  const layoutEngineUri = withV(String(webview.asWebviewUri(vscode.Uri.joinPath(opts.extensionUri, 'media', 'vendor', 'non-layered-tidy-tree-layout', 'dist', 'non-layered-tidy-tree-layout.js'))));
  const styleUri = withV(String(webview.asWebviewUri(vscode.Uri.joinPath(opts.extensionUri, 'media', 'style.css'))));
  const nonce = webviewNonce();
  // The webview has no `vscode.l10n`, so it gets the whole catalog as one
  // inline dictionary and looks strings up itself (media/main.js `tr()`). The
  // shell below is host-rendered and asks `vscode.l10n` directly — the same key,
  // one catalog file (see src/i18n.ts).
  const l10n = JSON.stringify(webviewL10n(opts.extensionUri)).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="${displayLocale()}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}';" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Spinney</title>
  <script nonce="${nonce}">window.__spinneyL10n = ${l10n};</script>
</head>
<body>
  <div id="tree-toolbar">
    <button id="follow-btn" class="active" title="${vscode.l10n.t('Follow the active node')}">⦿</button>
    <button id="fit-btn" title="${vscode.l10n.t('Fit the tree to view')}">⤢</button>
  </div>
  <div id="tree-wrap">
    <div id="tree-canvas">
      <svg id="tree-edges"></svg>
    </div>
  </div>
  <div id="composer">
    <div id="branch-banner" class="hidden"></div>
    <div id="attachments"></div>
    <div id="composer-row">
      <textarea id="input" placeholder="${vscode.l10n.t('Ask the agent… (Enter to send, Shift+Enter for newline)')}" rows="1" spellcheck="false" autocorrect="off" autocapitalize="off" autocomplete="off"></textarea>
      <div id="composer-controls">
        <button id="snippets-btn" class="icon-btn" title="${vscode.l10n.t('Prompt snippets')}" aria-label="${vscode.l10n.t('Prompt snippets')}" aria-haspopup="true">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 11h10M4 16h13"/></svg>
        </button>
        <button id="attach-btn" class="icon-btn" title="${vscode.l10n.t('Attach image')}" aria-label="${vscode.l10n.t('Attach image')}">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
        </button>
        <select id="model-select" title="${vscode.l10n.t('Model')}"></select>
        <button id="models-btn" class="icon-btn" title="${vscode.l10n.t('Manage model cards…')}" aria-label="${vscode.l10n.t('Manage model cards…')}">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </button>
        <select id="effort-select" title="${vscode.l10n.t('Thinking effort')}"></select>
        <div id="actions">
          <button id="stop-btn" class="hidden">${vscode.l10n.t('Stop')}</button>
          <button id="send-btn">${vscode.l10n.t('Send')}</button>
        </div>
      </div>
    </div>
    <div id="meter-row-readout" title="${vscode.l10n.t('Session prompt-cache hit rate + wallet')}">
      <span id="status-dot" class="dot idle"></span>
      <span id="status-text"></span>
      <span id="metrics">
        <span id="context" title="${vscode.l10n.t('Context window usage')}">
          <span id="context-label">ctx 0%</span>
        </span>
        <span id="stat-balance">bal –</span>
        <span id="tps-meter" title="${vscode.l10n.t('Token generation rate (realtime estimate)')}">
          <span id="tps-value">0</span>
          <span id="tps-unit">tok/s</span>
        </span>
      </span>
    </div>
  </div>
  <script nonce="${nonce}" src="${markdownItUri}"></script>
  <script nonce="${nonce}" src="${layoutEngineUri}"></script>
  <script nonce="${nonce}" src="${treeUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

/** The CSP nonce of one shell — per document, unpredictable (VS Code's own recipe). */
export function webviewNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
