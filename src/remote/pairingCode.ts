/**
 * pairingCode.ts — `Spinney: Show Room Pairing Code`: the desktop half of pairing a phone.
 *
 * WHAT IT DOES, IN THE ORDER THAT MATTERS. Resolve which room (the room tree hands it one; the
 * command palette is asked), ask the service for that room's **pairing payload** — the one read
 * of the token, through the same `RoomsStore` path the connect path uses — render it with
 * `qr.ts`, write the PNG, and open it. Nothing here composes the payload or touches a secret
 * itself, so there is exactly one place a token becomes a pairing string.
 *
 * WHY THE PNG GOES WHERE IT GOES. The image *is* the token, so its directory is a trust
 * decision. Not the **workspace**: a folder is something a user commits, syncs and shares, and
 * a token image inside one is a token in a repository. Not the **OS temp directory**: on a
 * shared machine it is other users' to read, and its cleanup belongs to nothing in particular.
 * The extension's own storage (`context.storageUri`, and `context.globalStorageUri` in a
 * no-folder window, which has no workspace-scoped storage) is per-user, private to this
 * machine, and deleted when the extension is — the lifetime this file should have.
 *
 * The name is fixed and carries neither the room name nor the token: a filename is a place a
 * secret leaks into a directory listing, an editor's recent-files entry and somebody's support
 * screenshot, and a file per room would leave a growing pile of token images behind. One fixed
 * name means each pairing overwrites the last.
 *
 * The token is never logged and never printed: the log line names the room only.
 */
import * as vscode from 'vscode';

import { encodeQr, QrCode, qrPng } from './qr';
import { RemoteService } from './remoteService';
import { RoomsStore } from './roomsStore';

/** The fixed file name under the extension's storage (see the module header for why no room name). */
const PAIRING_FILE_NAME = 'spinney-pairing-code.png';

/** What the command needs: the payload (from the service) and somewhere private to put the PNG. */
export interface PairingCodeContext {
  /** The publisher, for the payload — it owns the one read of the token (`pairingPayload`). */
  readonly service: RemoteService;
  /** The room table, for the quick pick when the command runs from the palette with no room. */
  readonly store: RoomsStore;
  /** The extension's own storage: `context.storageUri ?? context.globalStorageUri`. */
  readonly storage: vscode.Uri;
  /** An English line for the output channel. */
  readonly log: (line: string) => void;
}

/**
 * The room a tree item belongs to, or `''`. Every `RemoteTreeNode` carries its room, so any
 * node of the room tree can start a pairing for the room it is in — and the palette, which
 * passes nothing, is handled by asking instead.
 */
function roomNameFromNode(arg: unknown): string {
  if (!arg || typeof arg !== 'object') {
    return '';
  }
  const room = (arg as { room?: { name?: unknown } }).room;
  return typeof room?.name === 'string' ? room.name : '';
}

/** The one sentence per refusal code from `RemoteService.pairingPayload`. */
function pairingProblem(reason: 'unknown-room' | 'no-relay' | 'no-token' | 'unencodable', roomName: string): string {
  switch (reason) {
    case 'unknown-room':
      return vscode.l10n.t('That room no longer exists.');
    case 'no-relay':
      return vscode.l10n.t('Room "{0}" has no relay URL, so a device paired with it would have nowhere to connect.', roomName);
    case 'no-token':
      return vscode.l10n.t('Room "{0}" has no token yet, so there is nothing to pair.', roomName);
    case 'unencodable':
      return vscode.l10n.t('The token of room "{0}" cannot be encoded for a QR code.', roomName);
  }
}

/** Which room to pair: the clicked tree item's, the only one configured, or a choice. */
async function chooseRoom(ctx: PairingCodeContext, arg: unknown): Promise<string> {
  const fromTree = roomNameFromNode(arg);
  if (fromTree) {
    return fromTree;
  }
  const rooms = ctx.store.read().rooms;
  if (rooms.length === 0) {
    await vscode.window.showWarningMessage(
      vscode.l10n.t('No remote room is configured yet — add one with "Spinney: Manage Remote Rooms".'),
    );
    return '';
  }
  if (rooms.length === 1) {
    return rooms[0].name;
  }
  const pick = await vscode.window.showQuickPick(
    rooms.map((room) => ({
      label: room.name,
      // The relay URL, never the token: the URL is where the traffic goes and is not a secret.
      description: room.relayUrl || vscode.l10n.t('no relay URL is configured for this room'),
    })),
    { placeHolder: vscode.l10n.t('Pick the room to pair') },
  );
  return pick?.label ?? '';
}

/**
 * `spinney.remotePairingCode`. Renders the room's payload as a QR code, opens the PNG, and
 * says in one sentence what the image is — because the whole point of showing it is that it
 * carries the room's token, and a user who did not know that would leave it on screen.
 */
export async function showRoomPairingCode(ctx: PairingCodeContext, arg: unknown): Promise<void> {
  const roomName = await chooseRoom(ctx, arg);
  if (!roomName) {
    return;
  }
  const result = await ctx.service.pairingPayload(roomName);
  if (!result.ok) {
    await vscode.window.showWarningMessage(pairingProblem(result.reason, roomName));
    return;
  }
  let code: QrCode;
  try {
    code = encodeQr(result.payload);
  } catch (error) {
    // The encoder refuses a payload past version 10's capacity (`qr.ts`: 213 bytes at level M),
    // and a long token behind a long relay URL reaches that. Uncaught, the throw would escape
    // this command as a stack trace where the user expected a sentence; to them it is the same
    // fact as a token that cannot be encoded at all, with the same remedy, so it is the same
    // sentence. The log names the room and the size problem, never the token or the payload.
    ctx.log(
      `[remote] ${roomName}: pairing code not produced (${error instanceof Error ? error.message : String(error)})`,
    );
    await vscode.window.showWarningMessage(pairingProblem('unencodable', roomName));
    return;
  }
  const file = vscode.Uri.joinPath(ctx.storage, PAIRING_FILE_NAME);
  await vscode.workspace.fs.createDirectory(ctx.storage);
  await vscode.workspace.fs.writeFile(file, qrPng(code.modules));
  await vscode.commands.executeCommand('vscode.open', file);
  ctx.log(`[remote] ${roomName}: pairing code written (v${code.version}, level M, mask ${code.mask})`);
  await vscode.window.showInformationMessage(
    vscode.l10n.t(
      'This code contains the token of room "{0}": anyone who photographs it can control the room, so show it to the device you are pairing and close it afterwards.',
      roomName,
    ),
  );
}
