import * as vscode from 'vscode';
import { ChatViewProvider } from './chat/ChatViewProvider';
import { SessionsProvider } from './chat/SessionsProvider';

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
  chatProvider = new ChatViewProvider(context.extensionUri, context.workspaceState);

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
    vscode.commands.registerCommand('agentHarness.openChat', () => chatProvider?.openChat()),
    vscode.commands.registerCommand('agentHarness.focus', () => chatProvider?.openChat()),
    vscode.commands.registerCommand('agentHarness.openSession', (arg) => {
      const id = toSessionId(arg);
      if (id) {
        chatProvider?.openSession(id);
      }
    }),
    vscode.commands.registerCommand('agentHarness.newSession', () => chatProvider?.newSession()),
    vscode.commands.registerCommand('agentHarness.deleteSession', (arg) => {
      const id = toSessionId(arg) || chatProvider?.currentSessionId || '';
      if (id) {
        chatProvider?.deleteSession(id);
      }
    }),
    vscode.commands.registerCommand('agentHarness.clear', () => chatProvider?.clear()),
  );
}

export function deactivate(): void {
  // Kill any background terminals still running so they are not orphaned when
  // the extension host goes away.
  chatProvider?.dispose();
}
