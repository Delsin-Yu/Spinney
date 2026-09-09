import * as vscode from 'vscode';

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

  constructor(opts: {
    sessionId: string;
    viewType: string;
    title: string;
    extensionUri: vscode.Uri;
    getHtml: (webview: vscode.Webview) => string;
    onMessage: (message: unknown) => void | Promise<void>;
    onDispose: () => void;
  }) {
    this.sessionId = opts.sessionId;
    this.panel = vscode.window.createWebviewPanel(
      opts.viewType,
      opts.title,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(opts.extensionUri, 'media')],
      },
    );
    this.webview = this.panel.webview;
    this.webview.html = opts.getHtml(this.webview);
    this.webview.onDidReceiveMessage((message) => {
      void opts.onMessage(message);
    });
    this.panel.onDidDispose(() => opts.onDispose());
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
