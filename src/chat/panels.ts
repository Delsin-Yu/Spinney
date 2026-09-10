/**
 * PanelManager — one editor tab per session.
 *
 * The provider used to own a single `ChatPanel` and rebind it on every session
 * switch; P1 gives each session its own tab so two conversations can be on screen
 * (and stream) side by side. This class is the only place that knows the
 * `sessionId → ChatPanel` mapping, and it owns the webview lifecycle glue:
 *
 *  - `ensure(sessionId)` returns the session's existing tab (focusing it) or
 *    creates a fresh one;
 *  - `adopt(panel, sessionId)` takes over a panel VS Code recreated after a
 *    window reload (the serializer hands it back), returning the existing tab
 *    when that session is already open;
 *  - closing a tab (by the user or via `close`) drops it from the map and reports
 *    it through `onClosed` — the session itself is never deleted;
 *  - bringing a tab to the foreground reports the newly focused session through
 *    `onFocusChange` (that is what makes `activeSessionId` "the last focused
 *    tab", nothing more).
 *
 * Everything else (HTML, message routing, titles) stays on the provider and is
 * injected here as callbacks, so this file has no dependency on the provider.
 */
import * as vscode from 'vscode';
import { ChatPanel } from './ChatPanel';

export interface PanelManagerOptions {
  /** Local resource root for the webview. */
  extensionUri: vscode.Uri;
  /** Tab title for a session (the provider renders it from the session title). */
  titleFor: (sessionId: string) => string;
  /** The webview's HTML (the provider renders the template). */
  getHtml: (webview: vscode.Webview) => string;
  /** Messages from a panel's webview, in the context of that panel. */
  onMessage: (panel: ChatPanel, message: unknown) => void;
  /** A panel became the focused/visible tab. */
  onFocusChange: (sessionId: string) => void;
  /** A panel was closed (by the user or `close`); the session still exists. */
  onClosed: (sessionId: string) => void;
}

export class PanelManager {
  private readonly panels = new Map<string, ChatPanel>();
  /** The last tab brought to the foreground; `null` until a panel reports active. */
  private focusedId: string | null = null;

  constructor(private readonly opts: PanelManagerOptions) {}

  /** The session's tab: focus it when it already exists, else create + focus it. */
  ensure(sessionId: string): ChatPanel {
    const existing = this.panels.get(sessionId);
    if (existing) {
      this.focusedId = sessionId;
      existing.focus();
      return existing;
    }
    let created!: ChatPanel;
    created = ChatPanel.create({
      sessionId,
      title: this.opts.titleFor(sessionId),
      extensionUri: this.opts.extensionUri,
      getHtml: (webview) => this.opts.getHtml(webview),
      onMessage: (message) => this.opts.onMessage(created, message),
      onDispose: () => this.onPanelDisposed(created),
    });
    this.wire(created);
    this.panels.set(sessionId, created);
    this.focusedId = sessionId;
    created.focus();
    return created;
  }

  /**
   * Take ownership of a panel VS Code recreated from serialized state
   * (`registerWebviewPanelSerializer`). When that session already has a tab the
   * incoming duplicate is disposed — a session has exactly one tab.
   */
  adopt(panel: vscode.WebviewPanel, sessionId: string): ChatPanel {
    const existing = this.panels.get(sessionId);
    if (existing) {
      panel.dispose();
      return existing;
    }
    let adopted!: ChatPanel;
    adopted = ChatPanel.revive({
      sessionId,
      panel,
      getHtml: (webview) => this.opts.getHtml(webview),
      onMessage: (message) => this.opts.onMessage(adopted, message),
      onDispose: () => this.onPanelDisposed(adopted),
    });
    this.wire(adopted);
    this.panels.set(sessionId, adopted);
    if (panel.active) {
      this.focusedId = sessionId;
      this.opts.onFocusChange(sessionId);
    }
    return adopted;
  }

  get(sessionId: string): ChatPanel | undefined {
    return this.panels.get(sessionId);
  }

  /** True when a tab is open for the session. */
  has(sessionId: string): boolean {
    return this.panels.has(sessionId);
  }

  focus(sessionId: string): void {
    const panel = this.panels.get(sessionId);
    if (!panel) {
      return;
    }
    this.focusedId = sessionId;
    panel.focus();
  }

  setTitle(sessionId: string, title: string): void {
    this.panels.get(sessionId)?.setTitle(title);
  }

  /** Close (and stop tracking) a session's tab. The session itself is untouched. */
  close(sessionId: string): void {
    const panel = this.panels.get(sessionId);
    if (!panel) {
      return;
    }
    this.panels.delete(sessionId);
    if (this.focusedId === sessionId) {
      this.focusedId = null;
    }
    panel.dispose();
  }

  /** Dispose every open tab (window teardown paths that really close the chat). */
  disposeAll(): void {
    for (const panel of [...this.panels.values()]) {
      panel.dispose();
    }
    this.panels.clear();
    this.focusedId = null;
  }

  /** The last focused tab's session id (or `null` when no tab is open/focused). */
  get activeSessionId(): string | null {
    return this.focusedId;
  }

  ids(): string[] {
    return [...this.panels.keys()];
  }

  /** Wire the two panel events whose meaning depends on the map (see the class doc). */
  private wire(panel: ChatPanel): void {
    panel.panel.onDidChangeViewState(() => {
      if (panel.panel.active) {
        this.focusedId = panel.sessionId;
        this.opts.onFocusChange(panel.sessionId);
      }
    });
  }

  private onPanelDisposed(panel: ChatPanel): void {
    // Only the panel still registered under that session should remove it: a
    // disposed duplicate adopted away in `adopt` must not evict the live tab.
    if (this.panels.get(panel.sessionId) === panel) {
      this.panels.delete(panel.sessionId);
    }
    if (this.focusedId === panel.sessionId && !this.panels.has(panel.sessionId)) {
      this.focusedId = null;
    }
    this.opts.onClosed(panel.sessionId);
  }
}
