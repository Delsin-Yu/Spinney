/**
 * remoteSessionPanel.ts — the **replicated session panel**: another window's session, rendered
 * in this one by the shipped `media/main.js`.
 *
 * One panel per `(room, deviceId, instanceId, sessionId)`. Opening a session that is already
 * open focuses its tab instead of making a second one, and the tab survives a window reload
 * through the same `WebviewPanelSerializer` route the chat tab and the Model Cards page use.
 *
 * WHAT IT RENDERS. Only what arrives as `mirror` frames — it never reads this window's own
 * session store, and it has no runtime, no persistence and no agent. The publisher mirrors the
 * very host→webview messages its own tab receives (`remote/PROTOCOL.md` §5), so the replica is
 * the *same renderer* fed from a socket: there is no second protocol and no second source of
 * truth, which is what makes a rendering divergence a transport defect instead of a renderer
 * difference.
 *
 * WHAT IT ANSWERS ITSELF (the frozen 1:1 rule, §3): anything about reading and interacting with
 * **your own device** — the file picker, the clipboard, an external link, card geometry, the
 * local Model Cards page, the webview's own diagnostics. The table that decides it is
 * `src/remote/replicaRouting.ts`, one entry per message type, and it is guarded by
 * `tools/remote-surfaces-acceptance.js`. The two that need more than a hand-off:
 *
 *  - **`pickImage`** opens *this* machine's file dialog, reads the bytes and feeds them back to
 *    the composer with the very message the local host posts (`imagePicked`). The attachment
 *    then travels to the publisher inside `userMessage` — the same path a locally picked image
 *    takes (§4), so nothing needs a file-transfer channel.
 *  - **`deleteBranch`** asks for the confirmation **here**, and only then submits the deletion
 *    with a `confirmed` marker. The frozen contract says the confirmation belongs where the
 *    click happened: a remote click must not pop a modal on the owner's screen. The publisher
 *    runs that one marked input through its non-interactive delete path
 *    (`ChatViewProvider.applyRemoteInput`), and an input *without* the marker still goes
 *    through its dialog — so a peer cannot skip the confirm by leaving the field out.
 *
 * THE LOCK. The panel forces `readOnly: false` on the `state` message it hands its webview,
 * whatever this window's own workspace lock says. The two are different things: this window's
 * lock is about *this* workspace's session data, and the session on screen belongs to another
 * window, which enforces its own lock. So the composer here stays live and a publisher-side
 * lock arrives as a refusal (`error{code:'readonly'}`) — see `onRefused`, which shows it as a
 * notice on this surface.
 */
import * as vscode from 'vscode';
import { buildChatShell } from '../chat/webviewShell';
import { pickImageAttachment } from '../chat/imagePick';
import { replicaRoute } from './replicaRouting';
import { RemotePeerRef, RemoteReplicaHandle, RemoteReplicaTarget, RemoteService } from './remoteService';

/** View type of the replicated session panel; also its serializer id (window recovery). */
export const REMOTE_SESSION_VIEW_TYPE = 'spinney.remoteSession';

/** Open panels are held to this many mirror messages before `ready` (a cap, never a queue). */
const MAX_HELD = 400;

/**
 * The message types a fresh repaint supersedes while the webview is still loading. The same
 * rule `ChatPanel` uses, for the same reason: a document that comes up late should render once
 * (the `tree` the publisher sends for the `attach` is the whole state) instead of rendering a
 * stale tree and then tearing it down.
 */
const REPAINT_TYPES = new Set(['tree', 'path', 'reset', 'state', 'config', 'context', 'sessionStats']);

/** What the serializer hands back for one panel (window recovery). */
export interface RemoteSessionPanelState {
  room: string;
  deviceId: string;
  deviceName: string;
  instanceId: string;
  sessionId: string;
  /** The last title we knew; the tree's own label. Cosmetic only. */
  title?: string;
}

export interface RemoteSessionPanelsOptions {
  extensionUri: vscode.Uri;
  /** The `?v=` cache-buster, so a replica and a local tab never load different media. */
  mediaVersion: string;
  service: RemoteService;
  /** An English line for the output channel. */
  log: (line: string) => void;
  /** The *local* Model Cards page (the gear in the shell is a local settings page, §6). */
  openModelCards: () => void;
}

/** The key of one panel: the peer's stable identity plus the session. */
function panelKey(target: RemoteReplicaTarget): string {
  return `${target.room}\u0000${target.deviceId}\u0000${target.instanceId}\u0000${target.sessionId}`;
}

/**
 * Every replicated session panel of this window.
 *
 * The manager owns the map (one panel per session, focus instead of duplicate) and the
 * serializer's adoption path; a panel owns its webview and its own `attach`/`detach`.
 */
export class RemoteSessionPanels implements vscode.Disposable {
  private readonly panels = new Map<string, RemoteSessionPanel>();
  private disposed = false;

  constructor(private readonly opts: RemoteSessionPanelsOptions) {}

  /**
   * Open (or focus) the replica of one peer's session. `title` is the session's label as the
   * room tree knows it; it is only used for the tab's caption.
   */
  open(peer: RemotePeerRef, sessionId: string, title?: string, column?: vscode.ViewColumn): RemoteSessionPanel | null {
    if (this.disposed || !sessionId) {
      return null;
    }
    const target: RemoteReplicaTarget = { ...peer, sessionId };
    const key = panelKey(target);
    const existing = this.panels.get(key);
    if (existing) {
      existing.focus();
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(
      REMOTE_SESSION_VIEW_TYPE,
      sessionCaption(title, peer),
      column ?? vscode.ViewColumn.Active,
      {
        enableScripts: true,
        // The tree of a live session is view state: switching tabs must not throw the scroll
        // position, the expanded cards and the composer's draft away.
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.opts.extensionUri, 'media')],
      },
    );
    const created = new RemoteSessionPanel(panel, target, title, this.opts, () => this.panels.delete(key));
    this.panels.set(key, created);
    this.opts.log(`[remote] replica opened for ${peer.deviceName || peer.deviceId} · ${sessionId}`);
    return created;
  }

  /**
   * Window recovery: VS Code hands back a panel it serialized at shutdown, and adoption is
   * mandatory (the serializer contract) — re-set the HTML, re-hook the events, re-`attach`.
   * A panel whose state no longer names a session is closed rather than shown empty.
   */
  restore(panel: vscode.WebviewPanel, state: unknown): void {
    if (this.disposed) {
      panel.dispose();
      return;
    }
    const parsed = parsePanelState(state);
    if (!parsed) {
      this.opts.log('[remote] a replicated-session tab could not be restored and was closed');
      panel.dispose();
      return;
    }
    const key = panelKey(parsed);
    const existing = this.panels.get(key);
    if (existing) {
      // Two tabs for one session (a reload can race a manual open): keep the first, drop the
      // newcomer, exactly like a session has exactly one chat tab.
      panel.dispose();
      existing.focus();
      return;
    }
    const restored = new RemoteSessionPanel(panel, parsed, parsed.title, this.opts, () => this.panels.delete(key));
    this.panels.set(key, restored);
    this.opts.log(`[remote] replica restored for ${parsed.deviceName || parsed.deviceId} · ${parsed.sessionId}`);
  }

  /** How many replica tabs are open (diagnostics and acceptance runs). */
  get size(): number {
    return this.panels.size;
  }

  dispose(): void {
    this.disposed = true;
    for (const panel of [...this.panels.values()]) {
      panel.dispose();
    }
    this.panels.clear();
  }
}

/** The tab caption: the session title, then the machine it lives on. */
function sessionCaption(title: string | undefined, peer: RemotePeerRef): string {
  const device = peer.deviceName || peer.deviceId.slice(0, 12);
  const name = (title ?? '').trim() || vscode.l10n.t('Remote session');
  return device ? `${name} — ${device}` : name;
}

/** The serializer's state, validated (it is written by a previous session of this window). */
function parsePanelState(state: unknown): RemoteSessionPanelState | null {
  if (!state || typeof state !== 'object') {
    return null;
  }
  const row = state as Record<string, unknown>;
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');
  const room = str(row.room);
  const deviceId = str(row.deviceId);
  const instanceId = str(row.instanceId);
  const sessionId = str(row.sessionId);
  if (!room || !deviceId || !instanceId || !sessionId) {
    return null;
  }
  return {
    room,
    deviceId,
    deviceName: str(row.deviceName),
    instanceId,
    sessionId,
    title: str(row.title) || undefined,
  };
}

/** One replicated session tab. */
export class RemoteSessionPanel {
  private readonly webview: vscode.Webview;
  private handle: RemoteReplicaHandle | null = null;
  private disposed = false;
  /** Set by the webview's first `ready`: before that, mirror messages are held. */
  private ready = false;
  /** Mirror messages that arrived before `ready` (see {@link flushHeld}). */
  private held: unknown[] = [];
  /** Node id → title, from the last mirrored `tree`, for the `deleteBranch` confirmation. */
  private readonly nodeTitles = new Map<string, string>();

  constructor(
    readonly panel: vscode.WebviewPanel,
    target: RemoteReplicaTarget,
    title: string | undefined,
    private readonly opts: RemoteSessionPanelsOptions,
    private readonly onDispose: () => void,
  ) {
    this.webview = panel.webview;
    this.panel.title = sessionCaption(title, target);
    // The shell has to exist before the first message is routed, and it is the *same*
    // document the local chat tab renders (`src/chat/webviewShell.ts`): one renderer, so a
    // replica cannot look different from the tab it mirrors.
    this.webview.html = buildChatShell(this.webview, {
      extensionUri: opts.extensionUri,
      mediaVersion: opts.mediaVersion,
    });
    this.webview.onDidReceiveMessage((message) => void this.onMessage(message));
    this.panel.onDidDispose(() => this.dispose());
    // Attaching happens right here, not on `ready`: the publisher's answer (the session's
    // whole `tree`, and then every message the owner's tab receives) is what this panel
    // paints itself from, and holding it until the scripts are up loses nothing because the
    // mirror queue is this panel's own.
    this.handle = opts.service.openReplica(target, {
      onMirror: (sessionId, message) => this.onMirror(sessionId, message),
      onRefused: (code, message) => this.onRefused(code, message),
      onState: (state, detail) => this.onState(state, detail),
    });
  }

  /** Bring the tab forward (a second `Open the session` focuses, never duplicates). */
  focus(): void {
    if (!this.disposed) {
      this.panel.reveal(undefined, false);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.held = [];
    this.nodeTitles.clear();
    // Leaving the room politely: the publisher stops mirroring this session to us, which is
    // what keeps a closed tab from costing the owner a copy of every message.
    try {
      this.handle?.detach();
    } catch {
      /* a detach at teardown is best effort by definition */
    }
    this.handle = null;
    this.onDispose();
    this.panel.dispose();
  }

  // ---- the publisher -> this panel ----

  /** One `mirror` frame's message, on its way to the webview. */
  private onMirror(sessionId: string, message: unknown): void {
    if (this.disposed) {
      return;
    }
    const type = (message as { type?: unknown } | null | undefined)?.type;
    if (type === 'tree') {
      // The tree rows are the only place this panel can learn a node's title, and the
      // `deleteBranch` confirmation has to name the branch it is about to delete.
      this.rememberTitles(message);
    }
    this.post(forReplicaSurface(message), String(type ?? '?'));
  }

  /**
   * A message that crosses the seam needs one adjustment: the mirrored `state` carries the
   * *publisher's* `readOnly`, and the panel deliberately forces it `false` — see the module
   * comment. Everything else is handed over verbatim, because it *is* the protocol.
   */
  private post(message: unknown, type: string): void {
    if (!this.ready) {
      if (this.held.length >= MAX_HELD) {
        this.held.shift();
      }
      this.held.push(message);
      return;
    }
    void this.webview.postMessage(message).then(undefined, () => {
      this.opts.log(`[remote] replica webview rejected a "${type}" message`);
    });
  }

  /** Release what was held before `ready`, dropping the repaints the newest one supersedes. */
  private flushHeld(): void {
    const held = this.held;
    this.held = [];
    for (const message of held) {
      const type = (message as { type?: unknown } | null)?.type;
      if (typeof type === 'string' && REPAINT_TYPES.has(type) && message !== held[held.length - 1]) {
        continue;
      }
      void this.webview.postMessage(message);
    }
  }

  /** The publisher refused something this panel sent (`error{code}`). */
  private onRefused(code: string, message: string): void {
    if (this.disposed) {
      return;
    }
    this.opts.log(`[remote] replica refused ${code}: ${message}`);
    if (code === 'readonly') {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('The other window is read-only, so it refused that change. Nothing was sent to the agent.'),
      );
      return;
    }
    void vscode.window.showWarningMessage(vscode.l10n.t('The other window refused: {0}', message || code));
  }

  /** Where the attachment to the publisher stands (a room that is off, a peer that left). */
  private onState(state: string, detail: string): void {
    if (this.disposed) {
      return;
    }
    if (state === 'gone') {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('“{0}” left the room; nothing is being mirrored any more.', this.panel.title),
      );
    }
    if (state === 'waiting') {
      this.opts.log(`[remote] replica waiting: ${detail}`);
    }
  }

  /** Keep the node id → title map of the last mirrored tree (bounded by the session's size). */
  private rememberTitles(message: unknown): void {
    const nodes = (message as { nodes?: unknown }).nodes;
    if (!Array.isArray(nodes)) {
      return;
    }
    this.nodeTitles.clear();
    for (const node of nodes) {
      if (!node || typeof node !== 'object') {
        continue;
      }
      const row = node as { id?: unknown; title?: unknown };
      if (typeof row.id === 'string') {
        this.nodeTitles.set(row.id, typeof row.title === 'string' ? row.title : '');
      }
    }
  }

  // ---- this panel's webview -> here, or the publisher ----

  /**
   * One webview→host message, routed by `replicaRoute` (the frozen 1:1 table):
   * `local` acts here, `forward` becomes an `input` frame, `refuse` is logged. The switch
   * below is the `local` half, and every branch is one of the things the protocol says must
   * never be forwarded (`remote/PROTOCOL.md` §6).
   */
  private async onMessage(message: unknown): Promise<void> {
    if (this.disposed) {
      return;
    }
    const type = (message as { type?: unknown } | null | undefined)?.type;
    switch (replicaRoute(type)) {
      case 'local':
        await this.onLocalMessage(String(type), message as Record<string, unknown>);
        return;
      case 'forward':
        this.forward(type as string, message as Record<string, unknown>);
        return;
      default:
        // A type nobody classified: deny by default, exactly like the wire tables. This is
        // where a new webview message lands until somebody decides which side it belongs to.
        this.opts.log(`[remote] replica: refusing "${String(type ?? '?')}" (not classified for a replica)`);
        return;
    }
  }

  /** The messages that act on **this** surface (see `replicaRouting.ts` for the reasons). */
  private async onLocalMessage(type: string, message: Record<string, unknown>): Promise<void> {
    switch (type) {
      case 'ready':
        // The document is up. Everything held is released; the state it paints comes from the
        // mirror, so there is nothing to request — `attach` was already sent.
        this.ready = true;
        this.flushHeld();
        return;
      case 'pickImage': {
        // The picker opens on the surface you are operating; the bytes then travel to the
        // publisher inside `userMessage` (the same attachment a local pick builds).
        const picked = await pickImageAttachment();
        if (picked.kind === 'cancelled') {
          return;
        }
        if (picked.kind === 'failed') {
          void this.webview.postMessage({ type: 'error', message: `Could not read image: ${picked.error}` });
          return;
        }
        void this.webview.postMessage({ type: 'imagePicked', dataUrl: picked.dataUrl, name: picked.name });
        return;
      }
      case 'copyNodeId': {
        // The clipboard is the machine you are typing on. There is no session state to
        // validate the id against here (the publisher's is elsewhere, and reading it is
        // exactly what a replica may not do), so the id is copied as it was asked for.
        const id = typeof message.id === 'string' ? message.id : '';
        if (!id) {
          return;
        }
        await vscode.env.clipboard.writeText(id);
        vscode.window.setStatusBarMessage(vscode.l10n.t('Copied node id: {0}', id), 2000);
        return;
      }
      case 'openExternal': {
        // A link opens where it was clicked — there is deliberately no "open on the host"
        // toggle, and the same http/https/mailto allow-list the local surface uses applies.
        const url = String(message.url ?? '');
        let uri: vscode.Uri;
        try {
          uri = vscode.Uri.parse(url);
        } catch {
          return;
        }
        if (uri.scheme === 'http' || uri.scheme === 'https' || uri.scheme === 'mailto') {
          void vscode.env.openExternal(uri);
        }
        return;
      }
      case 'openModelTree':
        // The model-config editor edits local settings and local secrets, so the gear opens
        // *this* window's Model Cards page, never the publisher's.
        this.opts.openModelCards();
        return;
      case 'perfDiag':
      case 'layoutDiagnostic':
      case 'setNodeSize':
        // This surface's own diagnostics and geometry: they change nothing here (the webview
        // has already applied a size to its own DOM) and must never reach the publisher,
        // where they would trip the owner's "panel stopped painting" ladder or rewrite the
        // owner's card geometry. Dropped on purpose, without a log line: they are emitted
        // constantly by a live tree.
        return;
      default:
        return;
    }
  }

  /**
   * Forward one message to the publisher — with the two exceptions a replica adds on top of
   * the allow-list, both about *where a dialog appears*:
   *
   *  - `deleteBranch` is confirmed **here** first (the frozen contract: the click happened on
   *    this surface), and only a confirmed deletion is submitted, marked `confirmed: true`.
   *    The publisher runs that marker through its non-interactive delete path, so no modal
   *    pops on the owner's screen; an input *without* the marker still asks the owner, which
   *    is why a peer cannot skip the confirm.
   */
  private forward(type: string, message: Record<string, unknown>): void {
    if (type === 'deleteBranch') {
      void this.confirmDeleteBranch(message);
      return;
    }
    if (!this.handle?.sendInput(message)) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('That window is not reachable in this room right now.'),
      );
    }
  }

  /**
   * The branch deletion's confirmation, asked on the surface the click came from. The wording
   * is the owner's own (`ChatViewProvider.deleteBranchInteractive`) for the two facts this
   * panel can know for certain — the branch's title, and that its transcripts go — because the
   * replica renders the publisher's session, not this window's.
   */
  private async confirmDeleteBranch(message: Record<string, unknown>): Promise<void> {
    const nodeId = String(message.id ?? '');
    if (!nodeId) {
      return;
    }
    const title = this.nodeTitles.get(nodeId) || vscode.l10n.t('untitled');
    const DELETE_BRANCH = vscode.l10n.t('Delete Branch');
    const detail = [
      vscode.l10n.t(
        'Transcripts: their JSONL dumps are deleted from disk, so search_transcripts will no longer find them.',
      ),
      vscode.l10n.t('The checked-out node moves to the parent of the deleted branch.'),
      vscode.l10n.t('This cannot be undone.'),
    ].join('\n');
    const pick = await vscode.window.showWarningMessage(
      vscode.l10n.t('Delete this branch — "{0}" and everything below it?', title),
      { modal: true, detail },
      DELETE_BRANCH,
    );
    if (pick !== DELETE_BRANCH || this.disposed) {
      return;
    }
    // The one marker the publisher special-cases: it says "the confirmation was shown on the
    // surface that asked", so the owner's dialog is deliberately skipped there.
    if (!this.handle?.sendInput({ ...message, confirmed: true })) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('That window is not reachable in this room right now.'),
      );
    }
  }
}

/**
 * One mirrored message, as this surface's webview must see it.
 *
 * Exactly one field is rewritten: `readOnly` on a `state` message. The publisher's `state`
 * carries the publisher's own lock, and this panel forces `false` — the composer here is
 * driving a *different* window's session, so a lock on this window (or a reading of the
 * publisher's lock that the protocol does not promise) must not disable it. The publisher
 * still refuses what it must, and the refusal reaches this surface as an
 * `error{code:'readonly'}` that {@link RemoteSessionPanel.onRefused} shows as a notice.
 */
function forReplicaSurface(message: unknown): unknown {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return message;
  }
  if ((message as { type?: unknown }).type !== 'state') {
    return message;
  }
  return { ...(message as Record<string, unknown>), readOnly: false };
}
