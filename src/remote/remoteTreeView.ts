/**
 * remoteTreeView.ts — the **room tree**: one native VS Code tree view of the rooms this
 * window is in, and of everything a room can reach.
 *
 * The hierarchy is `room → device → instance → session` (`docs/agents/plans/remote-control.md`
 * §11): a room is a local label, a device is one machine in it, an instance is one VS Code
 * window on that machine (its workspace folder, its model, whether it is busy), and a session
 * is one conversation on it. It is a **native** tree on purpose — folding, keyboard
 * navigation, theme and collapse state are the window's job, and a webview page would have
 * re-implemented all four badly. (The plan first said "shared webview page so the phone could
 * render the same tree"; the phone grew its own native Compose tree, so there is nothing left
 * to share, and §11 records the switch.)
 *
 * The data comes from **one read** — `RemoteService.snapshot()` — and the view is re-drawn
 * from `RemoteService.onDidChange`, which the service fires from the same place every one of
 * its own state changes already passes through. Nothing here polls, nothing here caches, and
 * with the feature off (or no room configured) the provider answers an empty list: the view
 * is hidden by its own `when` clause anyway, and a window that never turns the feature on
 * must not be able to tell this file exists.
 *
 * Everything an item offers is one of two things, and never a third:
 *
 *  - a **`cmd` frame** to the publisher (`RemoteService.command`) for anything that acts on a
 *    session or on that window — "Send a message…", "Stop", "New session…" — because those
 *    have no webview of their own to ride and the command is executed there, by the same
 *    control-plane routes the local HTTP plane answers;
 *  - a **local** action for anything about this window (`kick`, `unblock`, the clipboard,
 *    `autoConnect`) — including the one where being local is the whole point: a kick is a
 *    blocklist in *this* window and nothing more (see {@link RemoteService.kick}).
 */
import * as vscode from 'vscode';
import {
  RemoteInstanceInfo,
  RemotePeerRef,
  RemotePeerView,
  RemoteRoomView,
  RemoteService,
  RemoteSessionInfo,
} from './remoteService';
import { RemoteSessionPanels } from './remoteSessionPanel';
import { RoomsStore } from './roomsStore';

/** One node of the tree. The four shapes are structurally distinct, so `kind` decides. */
export type RemoteTreeNode =
  | { kind: 'room'; room: RemoteRoomView }
  | { kind: 'device'; room: RemoteRoomView; peer: RemotePeerView }
  | { kind: 'instance'; room: RemoteRoomView; peer: RemotePeerView; instance: RemoteInstanceInfo }
  | {
      kind: 'session';
      room: RemoteRoomView;
      peer: RemotePeerView;
      instance: RemoteInstanceInfo;
      session: RemoteSessionInfo;
    };

/** What the tree's actions need. Deliberately smaller than the whole extension. */
export interface RemoteTreeContext {
  readonly service: RemoteService;
  readonly store: RoomsStore;
  readonly panels: RemoteSessionPanels;
  /** An English line for the output channel. */
  readonly log: (line: string) => void;
  /** M1's room editor (`Spinney: Manage Remote Rooms`) — the welcome view points at it too. */
  readonly manageRooms: () => void;
}

/** The context key the view's welcome messages read (`package.json` → `contributes.viewsWelcome`). */
export const REMOTE_HAS_ROOMS_KEY = 'spinney.remote.hasRooms';

/** The peer identity every `cmd`, `input` and panel is addressed by (never the relay's peer id). */
function peerRef(room: RemoteRoomView, peer: RemotePeerView): RemotePeerRef {
  return {
    room: room.name,
    deviceId: peer.deviceId,
    instanceId: peer.instanceId,
    deviceName: peer.deviceName,
  };
}

/** A short, stable label for a device whose `hello` has not arrived (or carried no name). */
function deviceLabel(peer: RemotePeerView): string {
  return peer.deviceName || peer.deviceId.slice(0, 12) || peer.key;
}

/** The folder label of an instance: its basename, or the sentence for "no folder open". */
function workspaceLabel(workspace: string): string {
  if (!workspace) {
    return vscode.l10n.t('no folder open');
  }
  const parts = workspace.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || workspace;
}

/** The model an instance is showing, as far as the wire says: its newest session's card. */
function instanceModel(instance: RemoteInstanceInfo): string {
  for (const session of instance.sessions) {
    const name = (session.modelName ?? '').trim() || (session.model ?? '').trim();
    if (name) {
      return name;
    }
  }
  return '';
}

/** Is any session of this instance running a turn? (drives the spinner) */
function instanceBusy(instance: RemoteInstanceInfo): boolean {
  return instance.sessions.some((session) => session.running);
}

/** The localized word for a session's state, and its icon. */
function sessionState(session: RemoteSessionInfo): { label: string; icon: string } {
  if (session.running) {
    return { label: vscode.l10n.t('running'), icon: 'sync~spin' };
  }
  if (session.lockedNodes.length > 0) {
    return { label: vscode.l10n.t('waiting for background work'), icon: 'lock' };
  }
  if (session.backgroundNodes.length > 0) {
    return { label: vscode.l10n.t('background terminals running'), icon: 'terminal' };
  }
  return { label: vscode.l10n.t('idle'), icon: 'comment' };
}

/**
 * The room tree's data source. One per window, created in `activate()` while the feature is
 * on (the view itself exists only then — `contributes.views` carries
 * `when: config.spinney.remote.enabled`).
 */
export class RemoteTreeProvider implements vscode.TreeDataProvider<RemoteTreeNode> {
  private readonly emitter = new vscode.EventEmitter<RemoteTreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private subscription: vscode.Disposable | null = null;

  constructor(private readonly ctx: RemoteTreeContext) {
    // Read, never poll: the service fires this from the one place every room/peer/attachment
    // change passes through, and a quiet room therefore costs nothing at all.
    this.subscription = this.ctx.service.onDidChange(() => this.refresh());
    this.publishContextKeys();
  }

  dispose(): void {
    this.subscription?.dispose();
    this.subscription = null;
    this.emitter.dispose();
  }

  /** Re-read on the next `getChildren` (VS Code coalesces the repaints itself). */
  refresh(): void {
    this.publishContextKeys();
    this.emitter.fire(undefined);
  }

  /**
   * The one context key the welcome views read. It is `setContext`, not a setting: it says
   * "a room is configured", which is what decides whether the welcome message ("point at
   * Manage Remote Rooms") is the right thing to show in an empty tree.
   */
  private publishContextKeys(): void {
    const hasRooms = this.ctx.service.snapshot().rooms.length > 0;
    void vscode.commands.executeCommand('setContext', REMOTE_HAS_ROOMS_KEY, hasRooms);
  }

  getTreeItem(element: RemoteTreeNode): vscode.TreeItem {
    switch (element.kind) {
      case 'room':
        return this.roomItem(element.room);
      case 'device':
        return this.deviceItem(element.room, element.peer);
      case 'instance':
        return this.instanceItem(element.room, element.peer, element.instance);
      default:
        // The node itself, not the `TreeItem` that was built from it: the item's own
        // command gets the node as its argument (see `sessionItem`), and every action
        // re-reads the live state from that node's identity.
        return this.sessionItem(element);
    }
  }

  getChildren(element?: RemoteTreeNode): RemoteTreeNode[] {
    const snapshot = this.ctx.service.snapshot();
    if (!element) {
      return snapshot.enabled ? snapshot.rooms.map((room) => ({ kind: 'room' as const, room })) : [];
    }
    switch (element.kind) {
      case 'room':
        return element.room.peers.map((peer) => ({ kind: 'device' as const, room: element.room, peer }));
      case 'device':
        // A blocked device that is no longer in the room has nothing to show: the row is
        // there so Unblock is reachable, not to invent an instance.
        return element.peer.instances.map((instance) => ({
          kind: 'instance' as const,
          room: element.room,
          peer: element.peer,
          instance,
        }));
      case 'instance':
        return element.instance.sessions.map((session) => ({
          kind: 'session' as const,
          room: element.room,
          peer: element.peer,
          instance: element.instance,
          session,
        }));
      default:
        return [];
    }
  }

  // ---- the four item shapes ----

  private roomItem(room: RemoteRoomView): vscode.TreeItem {
    const peers = room.peers.length;
    const item = new vscode.TreeItem(
      room.name,
      // One room expands itself (the common case: a single room is the whole view); several
      // start folded, so a window in three rooms is not a wall of peers.
      this.ctx.service.snapshot().rooms.length === 1
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = `room:${room.name}`;
    item.contextValue = 'remoteRoom';
    item.description = `${this.ctx.service.phaseLabel(room.phase)} · ${
      peers === 1 ? vscode.l10n.t('1 peer') : vscode.l10n.t('{0} peers', peers)
    }`;
    item.iconPath = new vscode.ThemeIcon(roomIcon(room.phase));
    const lines = [
      vscode.l10n.t('{0} — {1}', room.name, this.ctx.service.phaseLabel(room.phase)),
      room.relayUrl || vscode.l10n.t('no relay URL is configured for this room'),
    ];
    if (room.error) {
      lines.push(room.error);
    }
    if (!room.autoConnect) {
      lines.push(vscode.l10n.t('This room is configured but does not connect on its own.'));
    }
    lines.push(vscode.l10n.t('A room name is a local label: it is never sent, and two peers meet because their tokens match.'));
    item.tooltip = lines.join('\n');
    return item;
  }

  private deviceItem(room: RemoteRoomView, peer: RemotePeerView): vscode.TreeItem {
    const collapsible = peer.instances.length > 0
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(deviceLabel(peer), collapsible);
    item.id = `device:${room.name}:${peer.key}`;
    item.contextValue = peer.blocked ? 'remoteDeviceBlocked' : 'remoteDevice';
    const bits: string[] = [];
    if (peer.blocked) {
      bits.push(vscode.l10n.t('blocked'));
    }
    if (!peer.live) {
      bits.push(vscode.l10n.t('not here'));
    }
    if (peer.incompatible) {
      bits.push(vscode.l10n.t('different protocol version'));
    }
    if (peer.appVersion) {
      bits.push(`v${peer.appVersion}`);
    }
    if (bits.length > 0) {
      item.description = bits.join(' · ');
    }
    item.iconPath = new vscode.ThemeIcon(peer.blocked ? 'circle-slash' : 'device-desktop');
    const lines = [vscode.l10n.t('Device: {0}', deviceLabel(peer))];
    lines.push(vscode.l10n.t('Instance: {0}', peer.instanceId || vscode.l10n.t('unknown')));
    // The honest description of a kick, where the action lives: it is this window's own
    // decision, not a revocation — the peer still holds the token (§9).
    lines.push(
      vscode.l10n.t(
        'Kick stops this window talking to that device: it is not a revocation. A kicked peer can still reach every other window in the room, and it can rejoin at any time.',
      ),
    );
    item.tooltip = lines.join('\n');
    return item;
  }

  private instanceItem(room: RemoteRoomView, peer: RemotePeerView, instance: RemoteInstanceInfo): vscode.TreeItem {
    const collapsible = instance.sessions.length > 0
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(workspaceLabel(instance.workspace), collapsible);
    item.id = `instance:${room.name}:${peer.key}:${instance.instanceId}`;
    item.contextValue = 'remoteInstance';
    const model = instanceModel(instance);
    const bits = [model];
    bits.push(
      instance.sessions.length === 1
        ? vscode.l10n.t('1 session')
        : vscode.l10n.t('{0} sessions', instance.sessions.length),
    );
    item.description = bits.filter(Boolean).join(' · ');
    item.iconPath = new vscode.ThemeIcon(instanceBusy(instance) ? 'sync~spin' : 'window');
    item.tooltip = [
      vscode.l10n.t('VS Code window: {0}', instance.workspace || vscode.l10n.t('no folder open')),
      model ? vscode.l10n.t('Model: {0}', model) : '',
      instance.instanceId,
    ]
      .filter(Boolean)
      .join('\n');
    return item;
  }

  private sessionItem(node: {
    room: RemoteRoomView;
    peer: RemotePeerView;
    instance: RemoteInstanceInfo;
    session: RemoteSessionInfo;
  }): vscode.TreeItem {
    const { room, peer, session } = node;
    const state = sessionState(session);
    const item = new vscode.TreeItem(session.title || vscode.l10n.t('untitled'), vscode.TreeItemCollapsibleState.None);
    item.id = `session:${room.name}:${peer.key}:${session.id}`;
    item.contextValue = 'remoteSession';
    item.description = `${state.label} · ${
      session.nodes === 1 ? vscode.l10n.t('1 node') : vscode.l10n.t('{0} nodes', session.nodes)
    }`;
    item.iconPath = new vscode.ThemeIcon(state.icon);
    item.tooltip = [
      session.title || vscode.l10n.t('untitled'),
      vscode.l10n.t('Session: {0}', session.id),
      vscode.l10n.t('State: {0}', state.label),
      session.modelName || session.model || '',
    ]
      .filter(Boolean)
      .join('\n');
    // Enter (and a single click) opens the **replica** of that session: the same renderer the
    // owner's tab runs, attached to that window's session (M2's panel). The argument is the
    // **node**, not this `TreeItem`: an action is handed the tree's own element by VS Code
    // (the context menu does exactly that), so the two paths must agree on the shape.
    item.command = {
      command: 'spinney.remoteOpenSession',
      title: vscode.l10n.t('Open the session'),
      arguments: [node],
    };
    return item;
  }
}

/** The room node's icon, by phase (the same vocabulary the status bar and the editor use). */
function roomIcon(phase: string): string {
  switch (phase) {
    case 'online':
      return 'radio-tower';
    case 'connecting':
      return 'sync~spin';
    case 'backoff':
      return 'history';
    case 'error':
      return 'warning';
    case 'no-token':
      return 'key';
    default:
      return 'circle-slash';
  }
}

// ---- the actions ----

/**
 * The `RemoteTreeNode` a command was invoked with. The palette can invoke these without an
 * argument, and a stale tree item can survive a refresh by a frame or two, so every action
 * re-reads the state it needs from the snapshot instead of trusting the node it was handed.
 */
function nodeArg(arg: unknown): RemoteTreeNode | null {
  if (arg && typeof arg === 'object' && 'kind' in arg) {
    return arg as RemoteTreeNode;
  }
  return null;
}

/** Re-read a node's peers/instances from the live snapshot (see {@link nodeArg}). */
function liveNode(ctx: RemoteTreeContext, arg: unknown): RemoteTreeNode | null {
  const node = nodeArg(arg);
  if (!node) {
    return null;
  }
  const room = ctx.service.snapshot().rooms.find((entry) => entry.name === node.room.name);
  if (!room) {
    return null;
  }
  if (node.kind === 'room') {
    return { kind: 'room', room };
  }
  const peer = room.peers.find((entry) => entry.key === node.peer.key);
  if (!peer) {
    return null;
  }
  if (node.kind === 'device') {
    return { kind: 'device', room, peer };
  }
  const instance = peer.instances.find((entry) => entry.instanceId === node.instance.instanceId);
  if (!instance) {
    return null;
  }
  if (node.kind === 'instance') {
    return { kind: 'instance', room, peer, instance };
  }
  const session = instance.sessions.find((entry) => entry.id === node.session.id);
  if (!session) {
    return null;
  }
  return { kind: 'session', room, peer, instance, session };
}

/**
 * The peer of a node that has one, or `null` for a room (and for a node whose peer has left
 * between the repaint and the click).
 */
function peerOf(node: RemoteTreeNode | null): RemotePeerRef | null {
  if (!node || node.kind === 'room') {
    return null;
  }
  return peerRef(node.room, node.peer);
}

/** One refusal from the publisher, as a sentence in this window. */
function reportOutcome(ctx: RemoteTreeContext, what: string, outcome: { ok: boolean; code?: string; message?: string }): void {
  if (outcome.ok) {
    return;
  }
  ctx.log(`[remote] ${what} refused (${outcome.code ?? '?'}): ${outcome.message ?? ''}`);
  void vscode.window.showWarningMessage(
    vscode.l10n.t('The other window refused: {0}', outcome.message || (outcome.code ?? '')),
  );
}

/** `Open the session`: the replicated session panel, focused if it is already open. */
export function openRemoteSession(ctx: RemoteTreeContext, arg: unknown): void {
  const node = liveNode(ctx, arg);
  if (!node || node.kind !== 'session') {
    return;
  }
  ctx.panels.open(peerRef(node.room, node.peer), node.session.id, node.session.title);
}

/**
 * `Send a message…`: one line in an input box, then a `continue` command to the publisher —
 * a new turn branching off that session's checked-out node, on that machine.
 *
 * It is a `cmd` and not a composer message because the room tree has no composer: the session
 * does not have to be open in a tab anywhere, and the publisher's own control-plane route
 * (`POST /continue`) is what runs.
 */
export async function sendRemoteMessage(ctx: RemoteTreeContext, arg: unknown): Promise<void> {
  const node = liveNode(ctx, arg);
  if (!node || node.kind !== 'session') {
    return;
  }
  const peer = peerRef(node.room, node.peer);
  const message = await vscode.window.showInputBox({
    title: vscode.l10n.t('Send a message to “{0}” on {1}', node.session.title || vscode.l10n.t('untitled'), peer.deviceName || peer.deviceId.slice(0, 12)),
    prompt: vscode.l10n.t('The turn runs in that window, on that machine.'),
    placeHolder: vscode.l10n.t('What should the agent do?'),
    ignoreFocusOut: true,
  });
  if (!message || !message.trim()) {
    return;
  }
  const id = ctx.service.command(peer, 'continue', { sessionId: node.session.id, message }, (outcome) =>
    reportOutcome(ctx, 'continue', outcome),
  );
  if (!id) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t('That window is not reachable in this room right now.'),
    );
  }
}

/** `Stop`: the union kill of that session's node (`POST /stop`), run by the publisher. */
export function stopRemoteSession(ctx: RemoteTreeContext, arg: unknown): void {
  const node = liveNode(ctx, arg);
  if (!node || node.kind !== 'session') {
    return;
  }
  const peer = peerRef(node.room, node.peer);
  const id = ctx.service.command(peer, 'stop', { sessionId: node.session.id }, (outcome) =>
    reportOutcome(ctx, 'stop', outcome),
  );
  if (!id) {
    void vscode.window.showWarningMessage(vscode.l10n.t('That window is not reachable in this room right now.'));
  }
}

/**
 * `New session…`: an input box for the title, then a `session/start` command. The new session
 * appears in this very tree as soon as the publisher re-announces its instances — which is
 * the same path a locally created session takes, so there is nothing to refresh here.
 */
export async function newRemoteSession(ctx: RemoteTreeContext, arg: unknown): Promise<void> {
  const node = liveNode(ctx, arg);
  if (!node || node.kind !== 'instance') {
    return;
  }
  const peer = peerRef(node.room, node.peer);
  const title = await vscode.window.showInputBox({
    title: vscode.l10n.t('New session on {0}', peer.deviceName || peer.deviceId.slice(0, 12)),
    prompt: vscode.l10n.t('The session is created in that window. Leave the title empty to name it later.'),
    placeHolder: vscode.l10n.t('Session title'),
    ignoreFocusOut: true,
  });
  if (title === undefined) {
    return;
  }
  const id = ctx.service.command(peer, 'session/start', { title: title.trim() || undefined }, (outcome) =>
    reportOutcome(ctx, 'session/start', outcome),
  );
  if (!id) {
    void vscode.window.showWarningMessage(vscode.l10n.t('That window is not reachable in this room right now.'));
  }
}

/**
 * `Kick this device` — and the reason the tooltip says what it says.
 *
 * A kick is a **local blocklist for this window**: this window stops mirroring to that peer,
 * drops its `input`/`cmd` frames unanswered, and tells it `bye`. It cannot revoke another
 * token holder (the token is the trust root, `remote/PROTOCOL.md` §9), so it is not a
 * revocation, and the tree says so where a user can read it.
 */
export function kickRemoteDevice(ctx: RemoteTreeContext, arg: unknown): void {
  const node = liveNode(ctx, arg);
  if (!node || node.kind !== 'device') {
    return;
  }
  ctx.service.kick({ deviceId: node.peer.deviceId, instanceId: node.peer.instanceId, deviceName: node.peer.deviceName });
  void vscode.window.showInformationMessage(
    vscode.l10n.t(
      'This window stopped talking to {0}. It is not a revocation: that device can still reach every other window.',
      deviceLabel(node.peer),
    ),
  );
}

/** `Unblock this device`: talk to it again (its attachments are re-established on request). */
export function unblockRemoteDevice(ctx: RemoteTreeContext, arg: unknown): void {
  const node = liveNode(ctx, arg);
  if (!node || node.kind !== 'device') {
    return;
  }
  ctx.service.unblock(node.peer.deviceId, node.peer.instanceId);
}

/** `Copy device name`: the clipboard belongs to the window you clicked in. */
export async function copyRemoteDeviceName(arg: unknown): Promise<void> {
  const node = nodeArg(arg);
  if (!node || node.kind === 'room') {
    return;
  }
  const name = deviceLabel(node.peer);
  await vscode.env.clipboard.writeText(name);
  vscode.window.setStatusBarMessage(vscode.l10n.t('Copied device name: {0}', name), 2000);
}

/**
 * `Connect` / `Disconnect` on a room: the room's own `autoConnect` field, written at the
 * scope this window reads it from (`RoomsStore.setRoomField`). It is the same write M1's
 * command makes, and it is deliberately a *setting* rather than a poke at this window: the
 * meaning of "connect this room" is "connect it in every window that has the token".
 */
export async function setRemoteRoomConnected(
  ctx: RemoteTreeContext,
  arg: unknown,
  connected: boolean,
): Promise<void> {
  const node = liveNode(ctx, arg);
  if (!node) {
    return;
  }
  await ctx.store.setRoomField(node.room.name, { autoConnect: connected });
  ctx.log(`[remote] ${node.room.name}: ${connected ? 'connect' : 'disconnect'} requested from the room tree`);
}

/** `Manage rooms…`: M1's editor, unchanged. */
export function manageRemoteRoomsFromTree(ctx: RemoteTreeContext): void {
  ctx.manageRooms();
}
