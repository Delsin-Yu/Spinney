import * as vscode from 'vscode';
import { ChatViewProvider } from './chat/ChatViewProvider';

let chatProvider: ChatViewProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
  chatProvider = new ChatViewProvider(context.extensionUri, context.workspaceState);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agentHarness.focus', async () => {
      await vscode.commands.executeCommand('agentHarness.chat.focus');
    }),
    vscode.commands.registerCommand('agentHarness.clear', () => {
      chatProvider?.clear();
    }),
  );
}

export function deactivate(): void {
  // Kill any background terminals still running so they are not orphaned when
  // the extension host goes away.
  chatProvider?.dispose();
}
