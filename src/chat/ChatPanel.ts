import * as vscode from 'vscode';
import { currentOp, timedSync } from '../perf';

/** View type of the editor chat surface; also the serializer id (window recovery). */
export const CHAT_VIEW_TYPE = 'agentHarness.chatTree';

/**
 * Message types a fresh `postAllState` repaint replaces. A panel whose webview has
 * not said `ready` yet holds its messages; on `ready` these are dropped and the one
 * repaint the provider sends right after covers them (see `markReady`/`flushHeld`).
 */
const REPAINT_TYPES = new Set([
  'reset', 'state', 'tree', 'path', 'config', 'context', 'sessionStats',
  'backgrounds', 'background', 'status', 'balance', 'usage',
]);
/** Safety cap for the pre-ready queue: a webview that never says `ready` must not grow it. */
const MAX_HELD = 400;

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
  /** When this panel's webview document was created (`[perf] webview-ready`). */
  private readonly createdAt = Date.now();
  /** Set by `dispose()`: a disposed webview rejects every postMessage. */
  private disposed = false;
  /** Set by the webview's first `ready`: before that, nothing can be consumed. */
  private ready = false;
  /** Messages posted before `ready`, held for `markReady`/`flushHeld`. */
  private held: unknown[] = [];

  private constructor(opts: ChatPanelWiring & { panel: vscode.WebviewPanel }) {
    this.sessionId = opts.sessionId;
    this.panel = opts.panel;
    this.webview = opts.panel.webview;
    // The shell has to exist before the first message is routed, but its size is
    // worth knowing: the webview parses this document (and the 4 scripts it
    // loads) before it can post 'ready', so it is on the cold-start path of every
    // session switch. The repaint itself is driven by that 'ready'.
    const html = opts.getHtml(this.webview);
    timedSync('panel-html', () => {
      this.webview.html = html;
    }, `bytes=${html.length}`);
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
    if (!this.ready) {
      // The webview is still parsing its scripts (main.js + markdown-it + the
      // layout engine ≈ 0.7 s on a cold tab). Pushing a repaint at it now does not
      // make it arrive sooner — it queues in the webview's message port and its
      // handler runs only once the scripts are up. Hold it: the repaint the
      // `ready` handler triggers supersedes the repaint ones, and holding the rest
      // keeps their order.
      if (this.held.length >= MAX_HELD) {
        this.held.shift();
      }
      this.held.push(message);
      return;
    }
    this.send(message);
  }

  /** The webview's script is up: messages are delivered from now on. */
  markReady(): void {
    this.ready = true;
  }

  /** How long this panel's webview took to come up (see the provider's `ready`). */
  ageMs(): number {
    return Date.now() - this.createdAt;
  }

  /**
   * Release what was held before `ready`, **dropping the superseded repaints**: the
   * provider sends one fresh `postAllState` between `markReady()` and this call, so
   * a cold tab renders once instead of rendering a stale tree and then tearing it
   * down again.
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

  /** Actually hand one message to the webview, timing the traced repaints. */
  private send(message: unknown): void {
    // The repaint messages of a traced op are big (a session's whole tree + path),
    // and how long the webview takes to *accept* them is part of the switch. Other
    // messages are posted hundreds of times per turn, so they are left alone.
    const type = (message as { type?: unknown } | null)?.type;
    const op = type === 'tree' || type === 'path' || type === 'reset' ? currentOp() : null;
    const t0 = Date.now();
    void this.webview.postMessage(message).then(
      () => {
        op?.mark(`deliver-${String(type)}`, `${Date.now() - t0}ms`);
      },
      () => {
        /* the webview was torn down mid-flight; nothing to do */
      },
    );
  }

  dispose(): void {
    this.disposed = true;
    this.held = [];
    this.panel.dispose();
  }
}
