import * as vscode from 'vscode';
import { ChatViewProvider } from './chat/ChatViewProvider';
import { SessionsProvider } from './chat/SessionsProvider';
import { ControlServer } from './http/controlServer';

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
  chatProvider = new ChatViewProvider(context.extensionUri, context.workspaceState, context.globalStorageUri);

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
  const sessionsTree = vscode.window.createTreeView('agentHarness.sessions', {
    treeDataProvider: sessionsProvider,
    showCollapseAll: false,
  });

  context.subscriptions.push(
    sessionsTree,
    controlServer,
    vscode.commands.registerCommand('agentHarness.openChat', () => chatProvider?.openChat()),
    vscode.commands.registerCommand('agentHarness.focus', () => chatProvider?.openChat()),
    vscode.commands.registerCommand('agentHarness.openSession', (arg) => {
      const id = toSessionId(arg);
      if (id) {
        chatProvider?.openSession(id);
      }
    }),
    vscode.commands.registerCommand('agentHarness.newSession', () => chatProvider?.newSession()),
    vscode.commands.registerCommand('agentHarness.deleteSession', async (arg) => {
      const explicit = toSessionId(arg);
      const id = explicit || chatProvider?.currentSessionId || '';
      if (!id) {
        return;
      }
      // Invoked from the palette (no explicit session id): deleting is
      // irreversible (conversation + sub-agent transcripts), so confirm first.
      if (!explicit) {
        const pick = await vscode.window.showWarningMessage(
          'Delete the current Agent Harness session? Its conversation and sub-agent transcripts are removed.',
          { modal: true },
          'Delete',
        );
        if (pick !== 'Delete') {
          return;
        }
      }
      chatProvider?.deleteSession(id);
    }),
    vscode.commands.registerCommand('agentHarness.clear', () => chatProvider?.clear()),
  );
}

export function deactivate(): void {
  // Kill any background terminals still running so they are not orphaned when
  // the extension host goes away.
  chatProvider?.dispose();
}
