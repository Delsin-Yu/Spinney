import * as vscode from 'vscode';
import { CHAT_VIEW_TYPE } from './chat/ChatPanel';
import { MODEL_VIEW_TYPE } from './chat/ModelPanel';
import { ChatViewProvider } from './chat/ChatViewProvider';
import { SessionsProvider } from './chat/SessionsProvider';
import { ControlServer } from './http/controlServer';
import { showManual } from './manual';
import { RemoteService } from './remote/remoteService';
import { RoomsStore } from './remote/roomsStore';
import { manageRemoteRooms } from './remote/roomsCommand';
import { RemoteSessionPanels, REMOTE_SESSION_VIEW_TYPE } from './remote/remoteSessionPanel';
import {
  RemoteTreeContext,
  RemoteTreeProvider,
  RemoteTreeNode,
  copyRemoteDeviceName,
  kickRemoteDevice,
  newRemoteSession,
  openRemoteSession,
  sendRemoteMessage,
  setRemoteRoomConnected,
  stopRemoteSession,
  unblockRemoteDevice,
} from './remote/remoteTreeView';
import { setHarnessStorageDir } from './tools';
import { runWebSearchSelfTest } from './tools/webSearchDiagnostics';

let chatProvider: ChatViewProvider | undefined;
let remoteService: RemoteService | undefined;

/** A command arg may be a session id (string) or the clicked tree item (has `.id`). */
function toSessionId(arg: unknown): string {
  if (typeof arg === 'string') {
    return arg;
  }
  if (arg && typeof arg === 'object' && 'id' in arg) {
    return String((arg as { id: unknown }).id ?? '');
  }
  return '';
}

export function activate(context: vscode.ExtensionContext): void {
  // Pick the Memento that owns sessions/config. With no folder open, VS Code
  // buckets `workspaceState` under the (empty) window workspace, so those
  // no-repo sessions would become invisible the moment a folder is opened;
  // no-folder sessions really belong to the profile, hence `globalState`.
  const storage = vscode.workspace.workspaceFolders?.length ? context.workspaceState : context.globalState;
  // Wire relative-path resolution to the extension's global storage before any
  // tool can run, so no-repo sessions (no workspace folder) still resolve.
  setHarnessStorageDir(context.globalStorageUri?.fsPath ?? null);
  // `context.globalState` owns the handful of small keys (the active-session pointer,
  // the model/effort default, the backfill markers): VS Code keeps an extension's
  // whole workspaceState as ONE row, so writing a small key in there rewrites the
  // entire content blob (~119 M chars) — see `ChatViewProvider`'s constructor.
  chatProvider = new ChatViewProvider(
    context.extensionUri,
    storage,
    context.globalStorageUri,
    context.globalState,
    // The API key's home: SecretStorage (never settings.json).
    context.secrets,
  );

  // Window recovery: VS Code re-creates the webview panels it serialized at
  // shutdown and hands each one back through this serializer. Registering it
  // during activation is what makes the chat tab survive a window reload (the
  // viewType must also be listed in package.json as `onWebviewPanel:<viewType>`).
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(CHAT_VIEW_TYPE, {
      deserializeWebviewPanel: (panel, state) => {
        chatProvider?.restorePanel(panel, state);
        return Promise.resolve();
      },
    }),
  );

  // The Model Card Tree page is a second webview editor tab with the same
  // recovery contract: its view type is listed in package.json as
  // `onWebviewPanel:spinney.modelTree`, and the controller adopts the panel VS
  // Code hands back (one page per window — the controller focuses an existing tab
  // instead of opening a second one).
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(MODEL_VIEW_TYPE, {
      deserializeWebviewPanel: (panel) => {
        chatProvider?.restoreModelPanel(panel);
        return Promise.resolve();
      },
    }),
  );

  // A replicated session tab has the same recovery contract (`spinney.remoteSession`): the
  // serializer state names the peer and the session it was attached to, and the panel
  // re-`attach`es when it is adopted — a reload must not silently leave the tab empty.
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(REMOTE_SESSION_VIEW_TYPE, {
      deserializeWebviewPanel: (panel, state) => {
        remotePanels.restore(panel, state);
        return Promise.resolve();
      },
    }),
  );

  // Optional local control plane (off by default) for the external supervisor.
  const controlServer = new ControlServer(
    chatProvider,
    context.globalStorageUri,
    (line) => chatProvider?.outputLog(line),
  );
  void controlServer.start();

  // Remote control (off by default): the publisher half — the rooms this window joins,
  // the mirror of the sessions a peer attached to, and the peers' input. It is created
  // here so its status bar item is window-scoped like every other piece of this window's
  // UI, and it connects nothing until `spinney.remote.enabled` is on and a room says
  // `autoConnect` — a window that never enables the feature runs no timer, opens no
  // socket and shows no UI.
  const remoteRooms = new RoomsStore(context.secrets);
  remoteService = new RemoteService({
    host: chatProvider,
    store: remoteRooms,
    log: (line) => chatProvider?.outputLog(line),
    appVersion: context.extension.packageJSON?.version ?? '',
  });
  chatProvider.attachRemote(remoteService);
  remoteService.start();
  // The module-level `let` is what `deactivate` disposes; inside activation the value is
  // definitely there, so the two surfaces below and their commands hold it directly (a
  // `RemoteService` is never replaced within one activation, only disposed at the end).
  const remote = remoteService;

  // Sidebar lists sessions; it asks the provider for items on every refresh so it
  // never caches session state itself.
  const sessionsProvider = new SessionsProvider(() => chatProvider?.getSessionTreeItems() ?? []);
  chatProvider.onStateChanged = () => sessionsProvider.refresh();
  const sessionsTree = vscode.window.createTreeView('spinney.sessions', {
    treeDataProvider: sessionsProvider,
    showCollapseAll: false,
    // Multi-select powers "Delete Selected Sessions…" (Ctrl/Shift-click in the
    // list). VS Code shows that command only while several items are selected
    // (`listMultiSelection`) and hands it the selection.
    canSelectMany: true,
  });

  // Remote control's two surfaces (M2). The **room tree** is native (`spinney.remote`):
  // a room → device → instance → session tree of the same snapshot the status bar reads,
  // re-drawn from `RemoteService.onDidChange` — no polling, and nothing at all while the
  // feature is off. The **replicated session panel** is the second place the shipped
  // `media/main.js` runs (`src/remote/remoteSessionPanel.ts`), one tab per remote session.
  const remotePanels = new RemoteSessionPanels({
    extensionUri: context.extensionUri,
    mediaVersion: chatProvider?.mediaVersion ?? '',
    service: remote,
    log: (line) => chatProvider?.outputLog(line),
    // The gear in the shell is a *local* settings page (`remote/PROTOCOL.md` §6), so a
    // replica opens this window's own Model Cards page.
    openModelCards: () => chatProvider?.openModelTree(),
  });
  const remoteTreeCtx: RemoteTreeContext = {
    service: remote,
    store: remoteRooms,
    panels: remotePanels,
    log: (line) => chatProvider?.outputLog(line),
    manageRooms: () =>
      void manageRemoteRooms({
        store: remoteRooms,
        service: remote,
        log: (line) => chatProvider?.outputLog(line),
      }),
  };
  const remoteTreeProvider = new RemoteTreeProvider(remoteTreeCtx);
  // The view is contributed with `when: config.spinney.remote.enabled`, so it does not exist
  // until the feature is on. `createTreeView` on a hidden view is fine, but a failure here
  // must never take activation down with it: a window that never turns the feature on has to
  // be unaffected by this code existing, so the error is reported and the feature degrades.
  let remoteTree: vscode.TreeView<RemoteTreeNode> | null = null;
  const ensureRemoteTree = (): void => {
    if (remoteTree) {
      return;
    }
    try {
      remoteTree = vscode.window.createTreeView('spinney.remote', {
        treeDataProvider: remoteTreeProvider,
        showCollapseAll: true,
      });
      context.subscriptions.push(remoteTree);
    } catch (err) {
      chatProvider?.outputLog(
        `[remote] the room tree view could not be created: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
  ensureRemoteTree();

  context.subscriptions.push(
    sessionsTree,
    controlServer,
    remoteService,
    remotePanels,
    remoteTreeProvider,
    // AGENTS.md is otherwise read once per activation: re-read it (and log the
    // new mode + agent root) whenever a folder is added or removed.
    vscode.workspace.onDidChangeWorkspaceFolders(() => chatProvider?.onWorkspaceFoldersChanged()),
    // Settings are otherwise read once per activation. Push a change into the
    // live objects (a new API key must work without reloading the window).
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('spinney')) {
        return;
      }
      chatProvider?.onConfigurationChanged(event);
      // The control plane can only be (re)bound by restarting its listener.
      if (event.affectsConfiguration('spinney.httpApi')) {
        void controlServer.restart();
      }
      // Remote control applies its own keys: a room brought up or torn down here, with
      // no reload — the same event that carries a hand edit of `settings.json` carries
      // the Room-Names command's writes, because that command only ever writes settings.
      remoteService?.onConfigurationChanged(event);
    }),
    // The API key lives in SecretStorage: these two commands are the only way it
    // is read or written. Both take an optional provider id — the Model Card Tree
    // page and the chat's nudge pass the provider they mean, the palette and the
    // `spinney.setApiKey` command default to the built-in one.
    vscode.commands.registerCommand('spinney.setApiKey', (arg) =>
      void chatProvider?.setApiKeyInteractive(typeof arg === 'string' ? arg : undefined),
    ),
    vscode.commands.registerCommand('spinney.clearApiKey', (arg) =>
      void chatProvider?.clearApiKey(typeof arg === 'string' ? arg : undefined),
    ),
    // The Model Card Tree page: the command and the gear beside the chat's model
    // dropdown both land on the same window-owned tab.
    vscode.commands.registerCommand('spinney.openModelCards', () => chatProvider?.openModelTree()),
    // Remote control: the one editor of the room table and the per-room tokens. The
    // status bar item's click lands here too (`RemoteService.refreshStatusBar`).
    vscode.commands.registerCommand('spinney.remoteRooms', () =>
      remoteService
        ? manageRemoteRooms({
            store: remoteRooms,
            service: remote,
            log: (line) => chatProvider?.outputLog(line),
          })
        : undefined,
    ),
    // The room tree's own actions (M2). Every one of them is either a `cmd` frame the
    // publisher runs (the same control-plane routes the local HTTP plane answers) or a local
    // action of this window — the split lives in `src/remote/remoteTreeView.ts`, and the
    // replica's own split in `src/remote/replicaRouting.ts`.
    vscode.commands.registerCommand('spinney.remoteOpenSession', (arg) =>
      openRemoteSession(remoteTreeCtx, arg),
    ),
    // The M1 status bar item's click lands here now: the room tree is the remote surface, and
    // the room *editor* is one of its own actions. The view's focus command is generated from
    // its id (`<viewId>.focus`); when the view does not exist — the feature is off — the
    // reveal fails and the editor opens instead, which is where the feature is turned on.
    vscode.commands.registerCommand('spinney.remoteFocus', () => {
      ensureRemoteTree();
      void vscode.commands.executeCommand('spinney.remote.focus').then(
        () => undefined,
        () => remoteTreeCtx.manageRooms(),
      );
    }),
    vscode.commands.registerCommand('spinney.remoteSendMessage', (arg) =>
      void sendRemoteMessage(remoteTreeCtx, arg),
    ),
    vscode.commands.registerCommand('spinney.remoteStopSession', (arg) =>
      stopRemoteSession(remoteTreeCtx, arg),
    ),
    vscode.commands.registerCommand('spinney.remoteNewSession', (arg) =>
      void newRemoteSession(remoteTreeCtx, arg),
    ),
    vscode.commands.registerCommand('spinney.remoteKick', (arg) => kickRemoteDevice(remoteTreeCtx, arg)),
    vscode.commands.registerCommand('spinney.remoteUnblock', (arg) => unblockRemoteDevice(remoteTreeCtx, arg)),
    vscode.commands.registerCommand('spinney.remoteCopyDeviceName', (arg) =>
      void copyRemoteDeviceName(arg),
    ),
    vscode.commands.registerCommand('spinney.remoteConnect', (arg) =>
      void setRemoteRoomConnected(remoteTreeCtx, arg, true),
    ),
    vscode.commands.registerCommand('spinney.remoteDisconnect', (arg) =>
      void setRemoteRoomConnected(remoteTreeCtx, arg, false),
    ),
    // Export/import of the session data folder: the user's own copy of their history, and the
    // way a rename or a new machine recovers it (see invariants/session-persistence.md).
    vscode.commands.registerCommand('spinney.exportData', () => chatProvider?.exportSessionData()),
    vscode.commands.registerCommand('spinney.openDiagnosticsLog', () => chatProvider?.openDiagnosticsLog()),
    // The user's own escalation when a tab stopped painting: the host deliberately leaves a
    // broken screen visible and repairs nothing on its own (see `ChatViewProvider.onStallReport`),
    // so rebuilding the document is a command the user runs while looking at it.
    vscode.commands.registerCommand('spinney.reloadChatWebview', () => chatProvider?.reloadActiveChatWebview()),
    // Reachability of the search backends is a property of *this machine's
    // network*, not of any setting: the same list is half-dead behind a firewall
    // and half-dead without it. So the user's interface to that fact is a
    // measurement, not a configuration form (see `webSearchDiagnostics.ts`).
    vscode.commands.registerCommand('spinney.testWebSearchBackends', () => void runWebSearchSelfTest()),
    vscode.commands.registerCommand('spinney.importData', () => chatProvider?.importSessionData()),
    vscode.commands.registerCommand('spinney.openSession', (arg) => {
      const id = toSessionId(arg);
      if (id) {
        chatProvider?.openSession(id);
      }
    }),
    vscode.commands.registerCommand('spinney.newSession', () => chatProvider?.newSession()),
    vscode.commands.registerCommand('spinney.renameSession', (arg) => {
      void chatProvider?.renameSessionInteractive(arg);
    }),
    vscode.commands.registerCommand('spinney.autoRenameSession', (arg) => {
      void chatProvider?.autoRenameSession(arg);
    }),
    vscode.commands.registerCommand('spinney.deleteSession', async (arg) => {
      const explicit = toSessionId(arg);
      // The inline bucket is the only delete entry, and the only sensible batch
      // one: right-clicking the list drops the selection, so a context-menu item
      // could never act on it. When the clicked item is part of a multi-selection
      // (hover + click keeps the selection), the bucket deletes the WHOLE
      // selection behind one confirmation; otherwise it is a plain single delete.
      const selection = sessionsTree.selection
        .map((item) => String((item as { id?: unknown }).id ?? ''))
        .filter((id) => !!id);
      if (explicit && selection.length > 1 && selection.includes(explicit)) {
        await chatProvider?.deleteSessionsInteractive(selection);
        return;
      }
      const id = explicit || chatProvider?.currentSessionId || '';
      if (!id) {
        return;
      }
      // Invoked from the palette (no explicit session id): deleting is
      // irreversible (conversation + transcript dumps), so confirm first.
      if (!explicit) {
        const DELETE = vscode.l10n.t('Delete');
        const pick = await vscode.window.showWarningMessage(
          vscode.l10n.t(
            'Delete the current Spinney session? Its conversation and transcript dumps are removed.',
          ),
          { modal: true },
          DELETE,
        );
        if (pick !== DELETE) {
          return;
        }
      }
      chatProvider?.deleteSession(id);
    }),
    vscode.commands.registerCommand('spinney.copySessionId', async (arg) => {
      // Right-clicking a session in the sidebar passes the tree item; from the
      // palette there is no arg, so fall back to the active session.
      const id = toSessionId(arg) || chatProvider?.currentSessionId || '';
      if (!id) {
        return;
      }
      await vscode.env.clipboard.writeText(id);
      vscode.window.setStatusBarMessage(vscode.l10n.t('Copied session id: {0}', id), 2000);
    }),
    vscode.commands.registerCommand('spinney.deleteBranch', () => {
      // Deletes the branch rooted at the checked-out turn; the provider asks for
      // a modal confirmation before anything is removed.
      void chatProvider?.deleteCheckedOutBranchInteractive();
    }),
    vscode.commands.registerCommand('spinney.clear', () => chatProvider?.clear()),
    vscode.commands.registerCommand('spinney.showSystemPrompt', () => {
      void chatProvider?.showSystemPrompt();
    }),
    // The user manual is not chat state: it is a page shipped in the `.vsix`
    // (`manual/`), rendered in an untitled tab for the window's display language.
    vscode.commands.registerCommand('spinney.showManual', () => {
      void showManual(context.extensionUri);
    }),
  );
}

export function deactivate(): Thenable<void> | void {
  // Stop publishing this window first: the room connection is outbound I/O, and a window
  // that is going away must not leave a peer waiting on frames that will never come. (It
  // is also in `context.subscriptions`, which VS Code disposes after this returns.)
  remoteService?.dispose();
  remoteService = undefined;
  // Flush a coalesced write before the host goes away — a window close is exactly
  // when the newest state may still be pending (see `ChatViewProvider.shutdown`).
  return chatProvider?.shutdown();
}
