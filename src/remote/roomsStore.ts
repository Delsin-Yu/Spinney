/**
 * roomsStore.ts — the **persisted** half of remote control: `spinney.remote.*` and the
 * per-room token.
 *
 * Two stores, deliberately split, and this module is the only place either of them is
 * read or written by hand:
 *
 *  - the **room table** (`spinney.remote.rooms`) is a setting: an object keyed by the
 *    user's own room name, each value `{ relayUrl, autoConnect }`. The name is the key
 *    because it is a **local label** and nothing else — two machines meet in a room
 *    purely because their tokens match, so the name never travels and two peers may
 *    call the same room different things (`docs/agents/plans/remote-control.md` §11).
 *  - the **token** is a secret, one SecretStorage entry per room
 *    (`spinney.remote.password.<roomName>`), never a setting: a token in
 *    `settings.json` is plain text in a file that gets synced, diffed and pasted
 *    around, and the token is the **only** trust root of the whole feature (a wrong
 *    token is not an error, it is an empty room — `remote/PROTOCOL.md` §3, §9).
 *
 * The room name is what ties the two together, which is why a rename has to move the
 * secret as well as the row (see {@link RoomsStore.renameRoom}).
 *
 * `parseRooms` is the lenient reader of the setting: a row that cannot be parsed is
 * skipped with a reason for the output channel, exactly like `parseCatalog` does for
 * the provider/card tables — a typo in `settings.json` must not silently look like a
 * harness bug, and a bad row must never be half-applied. Nothing here connects
 * anything: this module is the data, `remoteService.ts` is the behaviour, and the
 * Room-Names command (`roomsCommand.ts`) is the editor.
 *
 * BYPASSING BOTH STORES (a supervisor, an acceptance driver)
 *
 * A token lives in SecretStorage, which nothing outside the window can write, so no
 * headless driver can put a window into a room. `src/http/controlServer.ts` solved the
 * same problem for the control plane with `SPINNEY_HTTP*`, and the remote-control
 * equivalents live here:
 *
 *  - `SPINNEY_REMOTE=1` enables the feature even when `spinney.remote.enabled` is off;
 *  - `SPINNEY_REMOTE_TOKEN` is the token of **every** room, in place of SecretStorage;
 *  - `SPINNEY_REMOTE_ROOM` names the room to use, and creates its row implicitly when
 *    `spinney.remote.rooms` does not have one — and that implicit row is *connected*,
 *    because a window that was told which room to be in is a window that joins it;
 *  - `SPINNEY_REMOTE_URL` is the relay address an **implicit** row gets. A row is where
 *    the relay URL lives, and a room that exists only because of an environment variable
 *    has no row to inherit one from; without it the implicit room is created with an empty
 *    `relayUrl` and the connect path refuses it with its own sentence ("the relay URL must
 *    be an http(s) address"), which is the honest outcome rather than a silent guess. The
 *    URL is where the traffic goes and is no more of a secret than the room name is — the
 *    token above is the whole trust root, and this is not a second one.
 *
 * These are **bypasses**, and an env var reaching a window is a trust decision and not a
 * convenience — exactly as the HTTP ones are. `SPINNEY_REMOTE=1` switches an off-by-default
 * feature on, and `SPINNEY_REMOTE_TOKEN` hands a window the only trust root the feature
 * has: full control of it, which `docs/agents/plans/remote-control.md` §1 spells out as
 * remote code execution on the machine that runs it. The env wins over the setting, so a
 * window launched this way cannot be switched off (or re-keyed) from the settings UI
 * either. Keep all four out of any window that is not a harness — and never put the token
 * in a log, an argument list that gets logged, or a transcript.
 *
 * Nothing below is weakened for their sake: with none of the four set, `enabled()`,
 * `read()` and `readToken()` return exactly what they returned before (the settings and
 * the secret, and nothing else), which is what keeps the shipped path byte-for-byte what
 * it was. They are also never *persisted*: the writers read the settings half alone, so a
 * Disconnect or a rename cannot write the env room's row into `settings.json`.
 */
import * as vscode from 'vscode';

/** `spinney.remote.enabled` — the master kill switch (default `false`). */
export const REMOTE_ENABLED_KEY = 'remote.enabled';
/** `spinney.remote.rooms` — the room table, keyed by the local room name. */
export const REMOTE_ROOMS_KEY = 'remote.rooms';
/** SecretStorage prefix of one room's token: `<prefix><room name>`. */
export const ROOM_SECRET_PREFIX = 'spinney.remote.password.';

/**
 * The environment variables that bypass the settings and the secret store (see the file
 * header). Named here, once, so a driver and this module cannot drift apart.
 */
export const REMOTE_ENV = {
  /** `=1` enables the feature even when `spinney.remote.enabled` is off. */
  enabled: 'SPINNEY_REMOTE',
  /** The token used for every configured room, in place of SecretStorage. */
  token: 'SPINNEY_REMOTE_TOKEN',
  /** The room name to use, created implicitly when the room table does not have it. */
  room: 'SPINNEY_REMOTE_ROOM',
  /** The relay URL an implicitly created room gets (there is no row to read one from). */
  relayUrl: 'SPINNEY_REMOTE_URL',
} as const;

/** What the environment says, trimmed; every field is `''` / `false` when unset. */
export interface RemoteEnvOverrides {
  /** {@link REMOTE_ENV.enabled} was exactly `1`. */
  readonly enabled: boolean;
  /** {@link REMOTE_ENV.token}, or `''`. */
  readonly token: string;
  /** {@link REMOTE_ENV.room}, or `''`. */
  readonly room: string;
  /** {@link REMOTE_ENV.relayUrl}, or `''`. */
  readonly relayUrl: string;
}

/**
 * Read the four bypass variables. Pure, so a caller can be shown what a window was
 * launched with without a VS Code host; `env` is a seam, and defaults to this process's.
 */
export function remoteEnvOverrides(env: Record<string, string | undefined> = process.env): RemoteEnvOverrides {
  const read = (name: string): string => (env[name] ?? '').trim();
  return {
    enabled: read(REMOTE_ENV.enabled) === '1',
    token: read(REMOTE_ENV.token),
    room: read(REMOTE_ENV.room),
    relayUrl: read(REMOTE_ENV.relayUrl),
  };
}

/** One configured room, after parsing. */
export interface RoomConfig {
  /** The local label; it never travels, and it keys both the row and the secret. */
  readonly name: string;
  /** Where this room's relay lives, e.g. `https://relay.example.com`. */
  readonly relayUrl: string;
  /** Connect on activation (and on every settings change) without asking. */
  readonly autoConnect: boolean;
}

/** Everything the settings currently say, plus the reason each skipped row was skipped. */
export interface RoomsRead {
  readonly enabled: boolean;
  readonly rooms: readonly RoomConfig[];
  /** English lines for the output channel — a row the parser had to refuse. */
  readonly issues: readonly string[];
}

/** Why a rename did not happen; the command maps each one to a sentence. */
export type RenameRoomResult = { ok: true; name: string } | { ok: false; reason: 'empty' | 'exists' | 'unknown' };

/** The SecretStorage entry a room's token lives in — one entry per room, keyed by name. */
export function roomSecretName(roomName: string): string {
  return `${ROOM_SECRET_PREFIX}${roomName}`;
}

/**
 * Read `spinney.remote.rooms`. The shape is an object keyed by the **room name**
 * (not an array): the name is the identity a rename moves, the key of the token's
 * secret, and the label the room UI draws, so an array would need a second identity
 * beside it.
 *
 * A row is accepted when it is an object; `relayUrl` must be a string and
 * `autoConnect` must be exactly `true` to connect on its own (anything else is
 * `false` — a truthy string must not silently connect a window to a relay). A row
 * that cannot be read is skipped and reported, never repaired.
 */
export function parseRooms(raw: unknown): { rooms: RoomConfig[]; issues: string[] } {
  const rooms: RoomConfig[] = [];
  const issues: string[] = [];
  if (raw === undefined || raw === null) {
    return { rooms, issues };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push(
      `remote.rooms must be an object keyed by room name, e.g. { "home": { "relayUrl": "https://relay.example.com", "autoConnect": true } }; got ${
        Array.isArray(raw) ? 'an array' : typeof raw
      }`,
    );
    return { rooms, issues };
  }
  for (const [rawName, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = rawName.trim();
    if (!name) {
      issues.push('remote.rooms: a room name may not be empty');
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      issues.push(`remote.rooms["${name}"]: expected an object with relayUrl / autoConnect`);
      continue;
    }
    const row = value as Record<string, unknown>;
    if (row.relayUrl !== undefined && typeof row.relayUrl !== 'string') {
      issues.push(`remote.rooms["${name}"].relayUrl: expected a string`);
      continue;
    }
    rooms.push({
      name,
      relayUrl: (typeof row.relayUrl === 'string' ? row.relayUrl : '').trim(),
      autoConnect: row.autoConnect === true,
    });
  }
  return { rooms, issues };
}

/**
 * The rooms, their tokens and the one key that turns the feature on.
 *
 * `secrets` is optional so a host without secret storage (a test, a keyring that
 * refuses) still constructs: then no token can be read, and the connect path says so
 * instead of publishing a window into a room nobody holds.
 */
export class RoomsStore {
  constructor(private readonly secrets?: vscode.SecretStorage) {}

  /**
   * `spinney.remote.enabled` — read live, never cached (a change needs no reload). The
   * `SPINNEY_REMOTE=1` bypass is part of the answer on purpose: the room UI and the
   * service have to agree about whether the feature is on.
   */
  enabled(): boolean {
    return this.readSettings().enabled || remoteEnvOverrides().enabled;
  }

  /** The two settings alone — exactly what {@link read} saw before the env seam existed. */
  private readSettings(): RoomsRead {
    const cfg = vscode.workspace.getConfiguration('spinney');
    const parsed = parseRooms(cfg.get<unknown>(REMOTE_ROOMS_KEY));
    return { enabled: cfg.get<boolean>(REMOTE_ENABLED_KEY) === true, rooms: parsed.rooms, issues: parsed.issues };
  }

  /**
   * The settings as they are right now, with the parser's own complaints, plus whatever
   * the environment says (see the file header). The env seam only ever flips the master
   * switch, turns the named room's `autoConnect` on, or **adds** that room when the table
   * does not have it; a row the settings carry keeps its own `relayUrl`.
   */
  read(): RoomsRead {
    const settings = this.readSettings();
    const env = remoteEnvOverrides();
    const enabled = settings.enabled || env.enabled;
    if (!env.room) {
      return { enabled, rooms: settings.rooms, issues: settings.issues };
    }
    const rooms = settings.rooms.some((room) => room.name === env.room)
      ? settings.rooms.map((room) => (room.name === env.room ? { ...room, autoConnect: true } : room))
      : [...settings.rooms, { name: env.room, relayUrl: env.relayUrl, autoConnect: true }];
    return { enabled, rooms, issues: settings.issues };
  }

  /** The master kill switch itself: `spinney.remote.enabled`. */
  async setEnabled(enabled: boolean): Promise<void> {
    await this.updateSetting(REMOTE_ENABLED_KEY, enabled === true);
  }

  // ---- the token (SecretStorage: one entry per room) ----

  /**
   * A room's token, or `''`. A read can fail (a locked keyring, a headless host) and
   * that is not fatal: it means "no token", which is a room that refuses to connect
   * rather than a window that publishes itself into the wrong one.
   *
   * `SPINNEY_REMOTE_TOKEN` answers for **every** room and wins over the secret: a window
   * launched with it was put into a room by whoever launched it, and reading SecretStorage
   * instead would publish it into a different room (or into none).
   */
  async readToken(roomName: string): Promise<string> {
    const env = remoteEnvOverrides().token;
    if (env) {
      return env;
    }
    if (!this.secrets) {
      return '';
    }
    try {
      return ((await this.secrets.get(roomSecretName(roomName))) ?? '').trim();
    } catch {
      return '';
    }
  }

  /** Store a room's token. An empty token is refused (it would mean "delete"). */
  async storeToken(roomName: string, token: string): Promise<void> {
    const value = (token ?? '').trim();
    if (!value || !this.secrets || !roomName.trim()) {
      return;
    }
    await this.secrets.store(roomSecretName(roomName.trim()), value);
  }

  /** Forget a room's token. */
  async clearToken(roomName: string): Promise<void> {
    await this.secrets?.delete(roomSecretName(roomName.trim()));
  }

  // ---- the room table (settings) ----

  /** Add a room, or merge one field into an existing row of the same name. */
  async setRoom(room: RoomConfig): Promise<void> {
    const name = room.name.trim();
    if (!name) {
      return;
    }
    const current = this.readSettings().rooms;
    const next = current.some((row) => row.name === name)
      ? current.map((row) => (row.name === name ? { ...row, relayUrl: room.relayUrl.trim(), autoConnect: room.autoConnect } : row))
      : [...current, { name, relayUrl: room.relayUrl.trim(), autoConnect: room.autoConnect }];
    await this.writeRooms(next);
  }

  /** One field of one room (`Connect` / `Disconnect` are `autoConnect`). */
  async setRoomField(roomName: string, patch: { relayUrl?: string; autoConnect?: boolean }): Promise<void> {
    const current = this.readSettings().rooms;
    const next = current.map((row) => {
      if (row.name !== roomName) {
        return row;
      }
      return {
        ...row,
        relayUrl: patch.relayUrl !== undefined ? patch.relayUrl.trim() : row.relayUrl,
        autoConnect: patch.autoConnect !== undefined ? patch.autoConnect : row.autoConnect,
      };
    });
    await this.writeRooms(next);
  }

  /** Drop a room row. The caller drops its token too ({@link clearToken}). */
  async removeRoom(roomName: string): Promise<void> {
    await this.writeRooms(this.readSettings().rooms.filter((row) => row.name !== roomName));
  }

  /**
   * Rename a room: **move its secret**, then the row. The order matters — the secret
   * is moved first, so a failure between the two leaves a token under a name that has
   * no row (invisible, harmless) rather than a row that cannot connect.
   *
   * The name is the identity, so a rename into an existing name is refused instead of
   * silently merging two rooms' tokens under one name.
   */
  async renameRoom(from: string, to: string): Promise<RenameRoomResult> {
    const target = to.trim();
    if (!target) {
      return { ok: false, reason: 'empty' };
    }
    const rooms = this.readSettings().rooms;
    const row = rooms.find((r) => r.name === from);
    if (!row) {
      return { ok: false, reason: 'unknown' };
    }
    if (target === from) {
      return { ok: true, name: target };
    }
    if (rooms.some((r) => r.name === target)) {
      return { ok: false, reason: 'exists' };
    }
    const token = await this.readToken(from);
    if (token) {
      await this.storeToken(target, token);
    }
    await this.clearToken(from);
    await this.writeRooms(rooms.map((r) => (r.name === from ? { ...r, name: target } : r)));
    return { ok: true, name: target };
  }

  /**
   * Write the room table back, preserving the order of the rows that were already
   * there (an object's key order is its insertion order, and the settings UI keeps
   * that order — a rename must not shuffle the list).
   *
   * The write goes to the scope this window actually **reads** (`inspect`): a key
   * already set at workspace scope stays there, everything else goes to the user
   * (Global) scope, which is the only scope that exists in no-folder mode — the same
   * rule the Model Card Tree page follows for `spinney.providers`.
   */
  private async writeRooms(rooms: readonly RoomConfig[]): Promise<void> {
    const value: Record<string, { relayUrl: string; autoConnect: boolean }> = {};
    for (const room of rooms) {
      value[room.name] = { relayUrl: room.relayUrl, autoConnect: room.autoConnect };
    }
    await this.updateSetting(REMOTE_ROOMS_KEY, value);
  }

  /**
   * Write one `spinney.remote.*` key, at the **scope this window reads it from**
   * (`inspect`): a key already set at workspace scope stays there, everything else goes
   * to the user (Global) scope — which is the only scope that exists in no-folder mode.
   * The write then arrives through `onDidChangeConfiguration` like any hand edit, so a
   * command and the Settings UI are the same editor.
   */
  private async updateSetting(key: string, value: unknown): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('spinney');
    const inspect = cfg.inspect<unknown>(key);
    const target =
      inspect?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await cfg.update(key, value, target);
  }
}
