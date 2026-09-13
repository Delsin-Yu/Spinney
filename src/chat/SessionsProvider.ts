import * as vscode from 'vscode';

/** Summary of a session for the sidebar list. */
export interface SessionTreeItem {
  id: string;
  title: string;
  updatedAt: number;
  nodeCount: number;
  active: boolean;
  busy: boolean;
}

/** Relative "time ago" label for a timestamp. */
function relTime(ts: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) {
    return 'just now';
  }
  const min = Math.round(sec / 60);
  if (min < 60) {
    return `${min}m ago`;
  }
  const hr = Math.round(min / 60);
  if (hr < 24) {
    return `${hr}h ago`;
  }
  return `${Math.round(hr / 24)}d ago`;
}

/**
 * Native sidebar tree listing each session. This is deliberately a minimal
 * wrapper: it asks ChatViewProvider for the current items and re-queries on
 * every `refresh()` call, so it never caches session state itself.
 */
export class SessionsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly getItems: () => SessionTreeItem[]) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    return this.getItems().map((it) => {
      const item = new vscode.TreeItem(it.title, vscode.TreeItemCollapsibleState.None);
      item.id = it.id;
      item.description = `${it.nodeCount} node${it.nodeCount === 1 ? '' : 's'} · ${relTime(it.updatedAt)}`;
      // Busy wins over active: the running session is always the active one, so
      // checking `active` first hid the spinner exactly when it mattered.
      item.iconPath = new vscode.ThemeIcon(it.busy ? 'sync~spin' : it.active ? 'comment-discussion' : 'comment');
      item.command = { command: 'spinney.openSession', title: 'Open Session', arguments: [it.id] };
      item.contextValue = 'session';
      return item;
    });
  }
}
