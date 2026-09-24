/**
 * roomsCommand.ts — `Spinney: Manage Remote Rooms`: the one editor of the room table and
 * of the per-room tokens.
 *
 * It owns no state and connects nothing. Every action it offers ends in exactly one of two
 * writes — a `spinney.remote.rooms` row through `RoomsStore` (a `configuration.update` at
 * the scope the window reads from) or a token in SecretStorage — and the live path picks
 * them up as if the user had edited `settings.json` by hand (`remoteService.ts` listens to
 * `onDidChangeConfiguration`, and the command pokes `restartRoom` only where a *secret*
 * changed, because a secret is not a configuration event).
 *
 * `Connect` / `Disconnect` are the `autoConnect` field of the room's own row: "connect
 * this room in every window" is precisely what that field means, so the action is honest
 * about being persisted rather than a transient poke at this one window.
 *
 * The token is never echoed: the input box is `password: true`, a stored token is only
 * ever reported as "set"/"cleared", and nothing here puts a token in a message, a log
 * line or a tooltip. The reason a token is refused is a code from `rooms.ts`
 * (`tokenIssue`) mapped to a localized sentence **here**, because the pure module must
 * stay loadable from plain node and therefore cannot localize anything itself.
 */
import * as vscode from 'vscode';
import { MIN_DISTINCT_CHARS, MIN_TOKEN_CHARS, TokenIssue, deriveRoom, tokenIssue } from './rooms';
import { RemoteService } from './remoteService';
import { RoomsStore } from './roomsStore';

/** What the command needs: the two stores and the live view of the rooms. */
export interface RemoteRoomsContext {
  store: RoomsStore;
  service: RemoteService;
  /** An English line for the output channel. */
  log: (line: string) => void;
}

/**
 * The last-chosen entry of the room list. The discriminant is `mode`, not `kind`:
 * `QuickPickItem.kind` is VS Code's own (`QuickPickItemKind`), and reusing that name for
 * our own union would collide with it.
 */
type RoomPick = vscode.QuickPickItem &
  ({ mode: 'room'; name: string } | { mode: 'add' } | { mode: 'enable' });

/** One per-room action. */
type RoomAction = 'connect' | 'disconnect' | 'rename' | 'set-token' | 'clear-token' | 'copy' | 'remove';

/** The action list entry. */
type ActionPick = vscode.QuickPickItem & { action: RoomAction };

/** The one sentence for one `tokenIssue` code — the mapping lives in this module. */
function tokenProblem(issue: TokenIssue): string {
  switch (issue) {
    case 'empty':
      return vscode.l10n.t('A room token is required.');
    case 'too-short':
      return vscode.l10n.t('The token is too short — use at least {0} characters.', MIN_TOKEN_CHARS);
    case 'too-few-distinct':
      return vscode.l10n.t(
        'The token is too easy to guess — use at least {0} different characters.',
        MIN_DISTINCT_CHARS,
      );
  }
}

/** Validate a token the user typed, or `undefined` when it is unusable. */
function tokenValidation(value: string): string | undefined {
  const issue = tokenIssue((value ?? '').trim());
  return issue ? tokenProblem(issue) : undefined;
}

/**
 * The first 8 characters of the room id a token routes to — **the comparable
 * fingerprint**.
 *
 * The room id is derived from the token and from nothing else, and the room *name*
 * is only a local label, so two devices that both show a room called `home` can sit
 * in two different rooms with no visible sign of it. This is the value that makes
 * that checkable by eye: the same eight characters on both screens is the whole
 * proof, and it is safe to display because the room id is a routing credential, not
 * a key (`remote/PROTOCOL.md` §2-3).
 *
 * `undefined` for a token too short to derive — the phase (`key` / `no token`)
 * already says that, so there is nothing to add.
 */
function roomFingerprint(token: string): string | undefined {
  if (!token) {
    return undefined;
  }
  try {
    return deriveRoom(token).roomId.slice(0, 8);
  } catch {
    return undefined;
  }
}

/** Validate a relay URL: http(s), because that is the only transport this feature has. */
function relayUrlValidation(value: string): string | undefined {
  const raw = (value ?? '').trim();
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return undefined;
    }
  } catch {
    /* not a URL at all: the sentence below is the same for every rejection */
  }
  return vscode.l10n.t('A relay URL must start with http:// or https://');
}

/** The icon of one phase, so the list reads at a glance. */
function phaseIcon(phase: string): string {
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

/**
 * The whole command. It loops: an action that changes something (a rename, an added room,
 * a token) re-draws the list, so the user sees the result without running the command
 * again; dismissing the list leaves.
 */
export async function manageRemoteRooms(ctx: RemoteRoomsContext): Promise<void> {
  for (;;) {
    const read = ctx.store.read();
    const snapshot = ctx.service.snapshot();
    const enabled = snapshot.enabled;
    const items: RoomPick[] = [];
    for (const room of read.rooms) {
      const live = snapshot.rooms.find((view) => view.name === room.name);
      const phase = live?.phase ?? 'off';
      const peers = live?.peers.length ?? 0;
      // The fingerprint goes in `detail` — the second, dimmer line — rather than being
      // pasted into the description, so that no new *string* is introduced and nothing
      // new has to be localized.
      const fingerprint = roomFingerprint(await ctx.store.readToken(room.name));
      items.push({
        mode: 'room',
        name: room.name,
        label: room.name,
        iconPath: new vscode.ThemeIcon(phaseIcon(phase)),
        description: `${ctx.service.phaseLabel(phase)} · ${
          peers === 1 ? vscode.l10n.t('1 peer') : vscode.l10n.t('{0} peers', peers)
        }`,
        detail: fingerprint,
      });
    }
    if (!enabled) {
      items.push({
        mode: 'enable',
        label: vscode.l10n.t('Enable remote control…'),
        description: vscode.l10n.t('The feature is off; no window publishes itself.'),
        iconPath: new vscode.ThemeIcon('circle-slash'),
      });
    }
    items.push({
      mode: 'add',
      label: vscode.l10n.t('Add room…'),
      description: vscode.l10n.t('A name, a relay URL and a token.'),
      iconPath: new vscode.ThemeIcon('add'),
    });

    const pick = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t('Remote control'),
      placeHolder: vscode.l10n.t('Pick a room, or add one'),
      matchOnDescription: true,
    });
    if (!pick) {
      return;
    }
    if (pick.mode === 'add') {
      const added = await addRoom(ctx);
      if (added) {
        ctx.log(`[remote] added room ${added}`);
      }
      continue;
    }
    if (pick.mode === 'enable') {
      await ctx.store.setEnabled(true);
      ctx.log('[remote] remote control enabled');
      continue;
    }
    await runRoomAction(ctx, pick.name);
  }
}

/** The per-room actions. */
async function runRoomAction(ctx: RemoteRoomsContext, name: string): Promise<void> {
  const read = ctx.store.read();
  const room = read.rooms.find((row) => row.name === name);
  if (!room) {
    return;
  }
  const live = ctx.service.snapshot().rooms.find((view) => view.name === name);
  const actions: ActionPick[] = [];
  if (room.autoConnect) {
    actions.push({
      action: 'disconnect',
      label: vscode.l10n.t('Disconnect'),
      description: vscode.l10n.t('Stop connecting this room in every window.'),
      iconPath: new vscode.ThemeIcon('debug-disconnect'),
    });
  } else {
    actions.push({
      action: 'connect',
      label: vscode.l10n.t('Connect'),
      description: vscode.l10n.t('Connect this room in every window.'),
      iconPath: new vscode.ThemeIcon('plug'),
    });
  }
  actions.push(
    {
      action: 'rename',
      label: vscode.l10n.t('Rename…'),
      description: vscode.l10n.t('The name is a local label; its token moves with it.'),
      iconPath: new vscode.ThemeIcon('edit'),
    },
    {
      action: 'set-token',
      label: vscode.l10n.t('Set token…'),
      description: vscode.l10n.t('Stored in the OS-encrypted secret storage, not in settings.json.'),
      iconPath: new vscode.ThemeIcon('key'),
    },
    {
      action: 'clear-token',
      label: vscode.l10n.t('Clear token'),
      description: vscode.l10n.t('Forget this room\u2019s token and stop connecting it.'),
      iconPath: new vscode.ThemeIcon('trash'),
    },
    {
      action: 'copy',
      label: vscode.l10n.t('Copy room name'),
      iconPath: new vscode.ThemeIcon('copy'),
    },
    {
      action: 'remove',
      label: vscode.l10n.t('Remove'),
      description: vscode.l10n.t('Delete the room and its token.'),
      iconPath: new vscode.ThemeIcon('close'),
    },
  );

  const pick = await vscode.window.showQuickPick(actions, {
    title: name,
    placeHolder: vscode.l10n.t('{0} — {1}', name, ctx.service.phaseLabel(live?.phase ?? 'off')),
  });
  if (!pick) {
    return;
  }

  switch (pick.action) {
    case 'connect':
      await ctx.store.setRoomField(name, { autoConnect: true });
      ctx.log(`[remote] ${name}: connecting (autoConnect on)`);
      return;
    case 'disconnect':
      await ctx.store.setRoomField(name, { autoConnect: false });
      ctx.log(`[remote] ${name}: disconnected (autoConnect off)`);
      return;
    case 'rename':
      await renameRoom(ctx, name);
      return;
    case 'set-token': {
      const value = await askToken(name);
      if (!value) {
        return;
      }
      await ctx.store.storeToken(name, value);
      // The saved secret is not a configuration event, so the live room is pointed at it.
      ctx.service.restartRoom(name);
      await vscode.window.showInformationMessage(vscode.l10n.t('Spinney: token saved for room "{0}".', name));
      return;
    }
    case 'clear-token': {
      const confirmed = await vscode.window.showWarningMessage(
        vscode.l10n.t('Clear the token of room "{0}"? This window stops publishing that room.', name),
        { modal: true },
        vscode.l10n.t('Clear token'),
      );
      if (!confirmed) {
        return;
      }
      await ctx.store.clearToken(name);
      ctx.service.restartRoom(name);
      await vscode.window.showInformationMessage(vscode.l10n.t('Spinney: token cleared for room "{0}".', name));
      return;
    }
    case 'copy':
      await vscode.env.clipboard.writeText(name);
      vscode.window.setStatusBarMessage(vscode.l10n.t('Copied room name: {0}', name), 2000);
      return;
    case 'remove': {
      const confirmed = await vscode.window.showWarningMessage(
        vscode.l10n.t('Remove the room "{0}"? Its token is deleted from the secret storage.', name),
        { modal: true },
        vscode.l10n.t('Remove'),
      );
      if (!confirmed) {
        return;
      }
      await ctx.store.clearToken(name);
      await ctx.store.removeRoom(name);
      ctx.log(`[remote] removed room ${name}`);
      return;
    }
    default:
      return;
  }
}

/** `Rename…`: the row and — because the name keys the secret — the token move together. */
async function renameRoom(ctx: RemoteRoomsContext, name: string): Promise<void> {
  const next = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('Room name — a local label; two machines meet in a room because their tokens match, not because of this name.'),
    value: name,
    ignoreFocusOut: true,
    validateInput: (value) => {
      const trimmed = (value ?? '').trim();
      if (!trimmed) {
        return vscode.l10n.t('A room name is required.');
      }
      if (trimmed === name) {
        return undefined;
      }
      return ctx.store.read().rooms.some((row) => row.name === trimmed)
        ? vscode.l10n.t('A room with this name already exists.')
        : undefined;
    },
  });
  const target = (next ?? '').trim();
  if (!target || target === name) {
    return;
  }
  const result = await ctx.store.renameRoom(name, target);
  if (!result.ok) {
    const reason =
      result.reason === 'exists'
        ? vscode.l10n.t('A room with this name already exists.')
        : result.reason === 'empty'
          ? vscode.l10n.t('A room name is required.')
          : vscode.l10n.t('That room no longer exists.');
    await vscode.window.showWarningMessage(reason);
    return;
  }
  ctx.log(`[remote] renamed room ${name} → ${target} (its token moved with it)`);
}

/** `Add room…`: name → relay URL → token, one input box each, nothing written until all three are in. */
async function addRoom(ctx: RemoteRoomsContext): Promise<string> {
  const name = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('Room name — a local label; two machines meet in a room because their tokens match, not because of this name.'),
    ignoreFocusOut: true,
    validateInput: (value) => {
      const trimmed = (value ?? '').trim();
      if (!trimmed) {
        return vscode.l10n.t('A room name is required.');
      }
      return ctx.store.read().rooms.some((row) => row.name === trimmed)
        ? vscode.l10n.t('A room with this name already exists.')
        : undefined;
    },
  });
  const roomName = (name ?? '').trim();
  if (!roomName) {
    return '';
  }
  const relayUrl = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('Relay URL — where your self-hosted relay answers, e.g. https://relay.example.com'),
    placeHolder: 'https://relay.example.com',
    ignoreFocusOut: true,
    validateInput: relayUrlValidation,
  });
  const relay = (relayUrl ?? '').trim();
  if (!relay) {
    return '';
  }
  const token = await askToken(roomName);
  if (!token) {
    return '';
  }
  await ctx.store.setRoom({ name: roomName, relayUrl: relay, autoConnect: true });
  await ctx.store.storeToken(roomName, token);
  ctx.service.restartRoom(roomName);
  await vscode.window.showInformationMessage(vscode.l10n.t('Spinney: room "{0}" added.', roomName));
  if (!ctx.store.enabled()) {
    // The master switch is off, so nothing publishes: say so, and offer to turn it on
    // rather than silently flipping a security-relevant setting.
    const enable = vscode.l10n.t('Enable remote control');
    const answer = await vscode.window.showInformationMessage(
      vscode.l10n.t('Remote control is off — no window publishes itself until you enable it.'),
      enable,
    );
    if (answer === enable) {
      await ctx.store.setEnabled(true);
      ctx.log('[remote] remote control enabled');
    }
  }
  return roomName;
}

/** One masked input box for a room token, validated by the same `tokenIssue` the connect path uses. */
async function askToken(roomName: string): Promise<string> {
  const value = await vscode.window.showInputBox({
    prompt: vscode.l10n.t(
      'Token for room "{0}" — the shared secret; it lives in the OS-encrypted secret storage, never in settings.json.',
      roomName,
    ),
    password: true,
    ignoreFocusOut: true,
    validateInput: tokenValidation,
  });
  return (value ?? '').trim();
}
