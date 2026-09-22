import * as vscode from 'vscode';
import { currentOp, harnessLog, perf, timedSync } from '../perf';

/** View type of the editor chat surface; also the serializer id (window recovery). */
export const CHAT_VIEW_TYPE = 'spinney.chatTree';

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
  /**
   * This panel's view state: once when the listeners are wired, then on every
   * `onDidChangeViewState`. A hidden or inactive tab is not painted by the window
   * manager, so "the tab stopped painting" has to be told apart from "the tab is not
   * on screen" before anything is reported. Diagnostics only: nothing here changes
   * what the panel does.
   */
  onViewState?: (state: { visible: boolean; active: boolean }) => void;
  /**
   * A `postMessage` to this panel was **rejected**: the document is gone (torn down, or
   * never loaded) and nothing can be delivered from here on. Reported because the
   * rejection used to be swallowed, and "the host is posting into a webview that is not
   * there" is one of the two shapes a tab that stopped painting hides behind — the other
   * being a document that is there and paints nothing. Diagnostics only.
   */
  onPostFailed?: (type: string) => void;
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
  /**
   * The renderer this panel's document was built with, kept so `reload()` can rebuild
   * that same document (the provider's template is the only place that knows how).
   */
  private readonly getHtml: (webview: vscode.Webview) => string;
  /** The view-state reporter handed in by the caller (`null` when none was). */
  private readonly onViewState: ((state: { visible: boolean; active: boolean }) => void) | null;
  /** The failed-delivery reporter handed in by the caller (`null` when none was). */
  private readonly onPostFailed: ((type: string) => void) | null;
  /**
   * When this panel's **current** webview document was created (`[perf] webview-ready`
   * elapsed). Not `readonly`: `reload()` replaces the document, and a new document has
   * its own age — keeping the old one would make a reload read as a cold start of
   * whatever the tab had already been up for.
   */
  private createdAt = Date.now();
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
    this.getHtml = opts.getHtml;
    this.onViewState = opts.onViewState ?? null;
    this.onPostFailed = opts.onPostFailed ?? null;
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
    // The state is reported once here — the wiring moment — and on every change after
    // it: a listener that only fires on *change* would leave the first question ("is the
    // tab the diagnostic is about the one the user is looking at?") unanswered until the
    // user clicks somewhere, which is exactly when a tab that stopped painting gets
    // noticed.
    this.reportViewState();
    this.panel.onDidChangeViewState(() => this.reportViewState());
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
      onViewState: opts.onViewState,
      onPostFailed: opts.onPostFailed,
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

  /**
   * Is this tab on screen? A hidden tab is not painted by the window manager, so a
   * "the tab stopped painting" report has to know the answer before it blames the
   * webview. Read straight from the panel, never cached: the diagnostic asks at the
   * moment it needs it.
   */
  visible(): boolean {
    return this.panel.visible;
  }

  /** Does this tab have the focus in its editor group (see {@link visible})? */
  active(): boolean {
    return this.panel.active;
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

  /**
   * Ask the webview whether it is still painting (`{ type:'probe', id }`). The tab
   * answers with its own `perfDiag` reports carrying that id — the counters and surface
   * readout of `kind:'probe'`, then the `kind:'probe-frame'` of the frame it takes after
   * the reply — which is what separates a script that is still running from one that is
   * not, and a tab that is drawing from a tab whose surface is gone.
   *
   * It goes through {@link post} like every other message, which is the point: a probe
   * sent at a webview that has not said `ready` yet is **held** rather than dropped, so
   * the diagnostic gets its answer from the document that comes up instead of counting a
   * cold tab as a dead one. A probe is diagnostics only — no reply changes what the
   * webview renders.
   */
  probe(id: number): void {
    this.post({ type: 'probe', id });
  }

  /**
   * Ask the webview to prove it can still take a frame (`{ type:'nudge', id }`), and to
   * answer with `kind:'nudge-frame'` when it does. This is the one automatic move the
   * diagnostic is allowed: a nudge re-applies the transform that is already in effect and
   * re-runs the layout, so it repaints without moving the camera — which is also why a
   * document reload ({@link reload}), losing the scroll position and the expanded cards,
   * stays the *user's* move instead of the ladder's. Posted through {@link post}, so the
   * pre-ready hold applies here too.
   */
  nudge(id: number): void {
    this.post({ type: 'nudge', id });
  }

  /** The webview's script is up: messages are delivered from now on. */
  markReady(): void {
    // A `ready` for a panel that was **already** ready is not the cold start the
    // provider reads it as: that document loaded itself a second time, which is either a
    // renderer crash VS Code recovered from, or a `reload()` — and that line, on its own,
    // is the defect announcing itself, where `reload()`'s `[panel] webview reload` is what
    // says a user asked for the rebuild. (A document that never says `ready` at all writes
    // nothing here, and *that* silence is what the watchdog exists to catch.) Named before
    // the usual work, so the line is written even if the repaint that follows throws.
    if (this.ready) {
      perf(`webview-reloaded session=${this.sessionId}`);
    }
    this.ready = true;
  }

  /**
   * Rebuild this panel's document from the renderer it was handed: the user's escape
   * hatch for a webview that ends up showing a stale frame (`Spinney: Reload Chat
   * Webview`). Rebuilding the **document** is the whole of it — the session, its runtime
   * and a running turn are untouched, so nothing is lost but the view, and the fresh
   * script posts `ready` like a cold tab, which drives the provider's usual repaint. Its
   * price is what keeps it out of the automatic ladder: the new document starts empty, so
   * the scroll position and the cards the user had expanded are gone.
   *
   * The bookkeeping a reload has to reset, or the panel lies about itself afterwards:
   * `ready` (the new document has not spoken yet) and `held` (those messages belonged to
   * the document that is gone). `createdAt` is reset because the age is what the
   * `webview-ready +Nms` line reports: kept, a reload would read as the cold start time
   * of a document that no longer exists.
   */
  reload(): void {
    // Nothing to rebuild when the panel is disposed (`dispose()` set this, and assigning
    // to a disposed webview's `html` throws); a palette command or a timer can easily
    // arrive after the tab was closed.
    if (this.disposed) {
      return;
    }
    this.webview.html = this.getHtml(this.webview);
    this.ready = false;
    this.held = [];
    this.createdAt = Date.now();
    harnessLog(`[panel] webview reload session=${this.sessionId}`);
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

  /**
   * Report this panel's view state to the caller's hook (see {@link ChatPanelWiring}).
   *
   * Diagnostics only, so the exception is swallowed: this runs *inside the constructor*
   * (a consumer that reads the state before its own bookkeeping exists would otherwise
   * break panel creation) and inside VS Code's view-state emitter, and neither may fail
   * because a diagnostic did.
   */
  private reportViewState(): void {
    const onViewState = this.onViewState;
    if (!onViewState) {
      return;
    }
    try {
      onViewState({ visible: this.panel.visible, active: this.panel.active });
    } catch {
      /* diagnostics only: a consumer bug is never a reason to break the panel */
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
        // The webview is gone (disposed mid-flight, or its document never came up): report
        // it instead of swallowing it. The call goes through the *container* this panel was
        // created with, so the caller's own bookkeeping — and its de-dupe — owns the line.
        try {
          this.onPostFailed?.(String(type));
        } catch {
          /* diagnostics only: a consumer bug is never a reason to break the panel */
        }
      },
    );
  }

  dispose(): void {
    this.disposed = true;
    this.held = [];
    this.panel.dispose();
  }
}
