import * as vscode from 'vscode';
import { CHAT_VIEW_TYPE } from './chat/ChatPanel';
import { ChatViewProvider } from './chat/ChatViewProvider';
import { SessionsProvider } from './chat/SessionsProvider';
import { ControlServer } from './http/controlServer';
import { setHarnessStorageDir } from './tools';

let chatProvider: ChatViewProvider | undefined;

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

  // Optional local control plane (off by default) for the external supervisor.
  const controlServer = new ControlServer(
    chatProvider,
    context.globalStorageUri,
    (line) => chatProvider?.outputLog(line),
  );
  void controlServer.start();

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

  context.subscriptions.push(
    sessionsTree,
    controlServer,
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
    }),
    vscode.commands.registerCommand('spinney.openChat', () => chatProvider?.openChat()),
    vscode.commands.registerCommand('spinney.focus', () => chatProvider?.openChat()),
    // The API key lives in SecretStorage: these two commands are the only way it
    // is read or written (`getConfig()` reports the live value). Both install the
    // key into the shared client, so no reload is needed.
    vscode.commands.registerCommand('spinney.setApiKey', () => void chatProvider?.setApiKeyInteractive()),
    vscode.commands.registerCommand('spinney.clearApiKey', () => void chatProvider?.clearApiKey()),
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
        const pick = await vscode.window.showWarningMessage(
          'Delete the current Spinney session? Its conversation and transcript dumps are removed.',
          { modal: true },
          'Delete',
        );
        if (pick !== 'Delete') {
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
      vscode.window.setStatusBarMessage(`Copied session id: ${id}`, 2000);
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
  );
}

export function deactivate(): Thenable<void> | void {
  // Flush a coalesced write before the host goes away — a window close is exactly
  // when the newest state may still be pending (see `ChatViewProvider.shutdown`).
  return chatProvider?.shutdown();
}
