import * as vscode from 'vscode';

/** View type of the editor chat surface; also the serializer id (window recovery). */
export const CHAT_VIEW_TYPE = 'agentHarness.chatTree';

/** Everything a chat panel needs regardless of how it came into existence. */
interface ChatPanelWiring {
  sessionId: string;
  getHtml: (webview: vscode.Webview) => string;
  onMessage: (message: unknown) => void | Promise<void>;
  onDispose: () => void;
}

/**
 * A chat surface in the editor area. P1 keeps a single panel (see
 * ChatViewProvider: switch session → rebind this panel's webview to the new
 * session). To support several parallel chats later, hold multiple ChatPanel
 * instances (one per session) and route `post`/`handlePanelMessage` through the
 * right one — this class already carries a `sessionId` so nothing needs to
 * change in the webview protocol.
 */
export class ChatPanel {
  readonly panel: vscode.WebviewPanel;
  sessionId: string;

  private readonly webview: vscode.Webview;
  /** Set by `dispose()`: a disposed webview rejects every postMessage. */
  private disposed = false;

  private constructor(opts: ChatPanelWiring & { panel: vscode.WebviewPanel }) {
    this.sessionId = opts.sessionId;
    this.panel = opts.panel;
    this.webview = opts.panel.webview;
    this.webview.html = opts.getHtml(this.webview);
    this.webview.onDidReceiveMessage((message) => {
      void opts.onMessage(message);
    });
    this.panel.onDidDispose(() => opts.onDispose());
  }

  /** Create a new chat panel in the active editor column. */
  static create(
    opts: ChatPanelWiring & { title: string; extensionUri: vscode.Uri },
  ): ChatPanel {
    const panel = vscode.window.createWebviewPanel(
      CHAT_VIEW_TYPE,
      opts.title,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(opts.extensionUri, 'media')],
      },
    );
    return new ChatPanel({
      sessionId: opts.sessionId,
      panel,
      getHtml: opts.getHtml,
      onMessage: opts.onMessage,
      onDispose: opts.onDispose,
    });
  }

  /**
   * Adopt a panel VS Code recreated from serialized state after a window reload.
   * The serializer contract requires the extension to take ownership of the
   * panel, re-set the webview's HTML and re-hook all webview events — exactly
   * what the constructor does — so a revived panel behaves like a fresh one
   * (its script posts 'ready' once loaded and the host repaints it).
   */
  static revive(opts: ChatPanelWiring & { panel: vscode.WebviewPanel }): ChatPanel {
    return new ChatPanel(opts);
  }

  setTitle(title: string): void {
    this.panel.title = title;
  }

  /** Bring the panel to the foreground and give it focus. */
  focus(): void {
    this.panel.reveal(undefined, false);
  }

  post(message: unknown): void {
    // `panel` is readonly and never null; the real hazard is posting after the
    // panel was disposed (the webview is gone and postMessage rejects).
    if (this.disposed) {
      return;
    }
    void this.webview.postMessage(message).then(undefined, () => {
      /* the webview was torn down mid-flight; nothing to do */
    });
  }

  dispose(): void {
    this.disposed = true;
    this.panel.dispose();
  }
}
