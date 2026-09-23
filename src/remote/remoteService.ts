/**
 * remoteService.ts — the **publisher**: one service per window, one transport per room.
 *
 * The publisher is the half of remote control that makes a window visible in a room and
 * answerable from it. It owns four things and nothing else:
 *
 *  1. **the room lifecycle** — for every room whose row says `autoConnect` (and only while
 *     `spinney.remote.enabled` is on) it derives the room's keys from the token, opens one
 *     {@link RelayTransport} and tears it down again when the setting changes. A settings
 *     change is applied *here*, so it takes effect exactly like a hand edit of
 *     `settings.json` and never needs a window reload.
 *  2. **the peer registry** — who is in the room, learned from `hello` / `instances` /
 *     `bye` and keyed by **`deviceId`+`instanceId`**, never by the relay's transient peer
 *     id (`remote/PROTOCOL.md` §2). It is what the room tree of M2 will draw, exposed as a
 *     read-only {@link RemoteService.snapshot}.
 *  3. **the mirror seam** — {@link RemoteService.mirrorLocal} is called from the *one*
 *     funnel every session-facing host→webview message passes through
 *     (`ChatViewProvider.postTo`), filters the message through `mayMirrorToPeer()` and
 *     forwards it **only** for sessions some peer has attached to. The call is
 *     synchronous and bounded on purpose: the transport owns the queue, drops on
 *     overflow, and the owner's own webview, agent loop and tool calls never wait for a
 *     peer (`docs/agents/plans/remote-control.md` §7).
 *  4. **input** — an inbound `input` frame is checked with `mayAcceptFromPeer()` and
 *     dispatched through the *same* path a local webview message takes
 *     (`ChatViewProvider.applyRemoteInput`), refused when this window is read-only, and
 *     de-duplicated per frame id so a replayed frame after a reconnect cannot send the
 *     same prompt twice.
 *
 * The token never leaves this module: it is read from SecretStorage, turned into key
 * material by `rooms.ts`, and only the derived room id (the relay's routing credential)
 * is ever sent anywhere. No token is logged, and no snapshot, status bar or tooltip ever
 * carries one.
 *
 * Nothing here runs while the feature is off: `spinney.remote.enabled` is checked before a
 * room is started, before a key is derived (PBKDF2 at 600000 iterations is *not* paid by a
 * window that does not use the feature) and before the status bar item is even created.
 */
import { createHash } from 'node:crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import { ControlSessionInfo, ControlState } from '../http/controlServer';
import { TreeNode } from '../chat/tree';
import { hasPendingTranscriptWrite } from '../chat/transcript';
import { mayAcceptFromPeer, mayMirrorToPeer } from './allowlist';
import { FRAME_VERSION, FrameEnvelope, newFrameId } from './frames';
import { OutboundFrame, RelayTransport, TransportStatus } from './relayClient';
import { deriveRoom } from './rooms';
import { RoomConfig, RoomsStore } from './roomsStore';
import type { RemoteOrigin } from './origin';

/**
 * A peer's application-level liveness probe interval.
 *
 * The transport's own 20 s heartbeat (`HEARTBEAT_MS`) is a *relay* heartbeat: it keeps the
 * SSE body non-idle and proves the link to the relay is alive. It says nothing about the
 * other members of the room, so the presence a room tree draws needs a second, peer-to-peer
 * `ping`/`pong` — the frame pair `remote/PROTOCOL.md` §5 defines for exactly this.
 */
const PEER_PING_MS = 30000;
/** Three missed probes and a peer is gone: it is dropped from the registry, with its attachments. */
const PEER_TIMEOUT_MS = 90000;
/** How often the liveness timeout is applied. */
const PEER_SWEEP_MS = 15000;
/**
 * The `instances` announcement is coalesced this long: a turn end fires several state
 * changes, and one announcement per burst is what the room tree needs (the frame says what
 * changed, not everything that happened).
 */
const INSTANCES_DEBOUNCE_MS = 400;
/**
 * How long a frame id is remembered, so that an `input` a replica re-sends after a
 * reconnect is recognised as the frame it already submitted. Five minutes is far longer
 * than any reconnect and short enough that the cache cannot grow across a session.
 */
const INPUT_DEDUPE_MS = 300000;
/** …and at most this many ids, so a hostile peer cannot grow the cache without bound. */
const INPUT_DEDUPE_MAX = 512;
/** A room re-pushes its attached sessions' state at most this often after drops. */
const RESYNC_MIN_INTERVAL_MS = 5000;
/** The room name shown in the status bar when several rooms are configured at once. */
const STATUS_ICON = '$(radio-tower)';

/**
 * The mark a remote-originated turn carries (`docs/agents/plans/remote-control.md` §13).
 *
 * The type itself lives in `./origin.ts`: `chat/tree.ts` needs it for `TreeNode.origin`, and
 * that module is loaded by plain node (guards, acceptance runs) and must not pull this
 * one's `vscode`/`node:crypto` imports in. It is re-exported here so every existing
 * importer of the publisher keeps compiling unchanged, and there is still exactly one copy
 * of the shape.
 */
export type { RemoteOrigin };

/**
 * A node's remote origin, written by `SessionRuntime.onUserMessage` for a turn a peer
 * started. `TreeNode` has no such field (it is owned elsewhere), and the field is
 * deliberately optional and additive: a node without one is an ordinary local turn.
 */
type NodeWithOrigin = TreeNode & { origin?: RemoteOrigin };

/** Mark a turn node as remote-originated (see {@link RemoteOrigin}). */
export function setNodeOrigin(node: TreeNode, origin: RemoteOrigin): void {
  (node as NodeWithOrigin).origin = origin;
}

/** A node's remote origin, if it has one — the shape a badge (and a dump) reads. */
export function nodeOrigin(node: TreeNode | undefined): RemoteOrigin | undefined {
  const origin = (node as NodeWithOrigin | undefined)?.origin;
  if (!origin || typeof origin.peerId !== 'string' || typeof origin.at !== 'number') {
    return undefined;
  }
  return origin;
}

/**
 * The **durable** half of the mark: add `origin` to a session transcript's line-1 meta
 * record (`docs/agents/plans/remote-control.md` §13).
 *
 * It is written after the dump has landed rather than with it, because the dump writer
 * builds its meta from a fixed field list — and the messages below the meta are then kept
 * **verbatim**, so the record of the conversation is byte-identical to a local turn's.
 *
 * Skipped while a newer dump for the same node is queued or in flight: that dump carries
 * the same node, and therefore the same origin, and patches itself. The remaining race —
 * a fresh dump queued between the read and the write — costs one generation of a
 * *transcript* file (never session state), which the node's next dump repairs.
 */
export async function writeOriginIntoTranscript(file: string, origin: RemoteOrigin): Promise<void> {
  if (hasPendingTranscriptWrite(file)) {
    return;
  }
  const text = await fs.promises.readFile(file, 'utf8');
  const cut = text.indexOf('\n');
  const head = cut < 0 ? text : text.slice(0, cut);
  const rest = cut < 0 ? '' : text.slice(cut);
  let meta: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(head);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return;
    }
    meta = parsed as Record<string, unknown>;
  } catch {
    return;
  }
  if (meta.origin) {
    return;
  }
  meta.origin = { peerId: origin.peerId, deviceName: origin.deviceName, at: origin.at };
  if (hasPendingTranscriptWrite(file)) {
    return;
  }
  await fs.promises.writeFile(file, JSON.stringify(meta) + rest, 'utf8');
}

/** What one session row of an `instances` frame carries — the control plane's own shape. */
export type RemoteSessionInfo = Pick<
  ControlSessionInfo,
  'id' | 'title' | 'running' | 'lockedNodes' | 'backgroundNodes' | 'model' | 'modelName' | 'effort' | 'nodes'
>;

/** One window of one peer, as the peer announces it (`instances`). */
export interface RemoteInstanceInfo {
  readonly instanceId: string;
  readonly workspace: string;
  readonly sessions: readonly RemoteSessionInfo[];
}

/** One other member of the room. */
export interface RemotePeerView {
  /** The registry key: `deviceId`+`instanceId`, stable across a reconnect. */
  readonly key: string;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly instanceId: string;
  readonly workspace: string;
  readonly appVersion: string;
  /** The protocol version the peer announced, or `null` before its `hello`. */
  readonly proto: number | null;
  /** True when this peer speaks a different `proto` than this window. */
  readonly incompatible: boolean;
  /** When a frame from it was last seen (host epoch ms); `0` for a blocked peer that is gone. */
  readonly lastSeenAt: number;
  /**
   * This window stopped talking to it (`RemoteService.kick`). The entry is kept — and
   * synthesized when the peer itself has timed out — so the room tree can offer **Unblock**:
   * the blocklist is keyed by `deviceId`+`instanceId` and outlives the peer's presence.
   */
  readonly blocked: boolean;
  /** False when the row exists only because it is on the blocklist (the peer is not here). */
  readonly live: boolean;
  readonly instances: readonly RemoteInstanceInfo[];
}

/** One room as the UI sees it: what it is, where it is, and who is in it. */
export interface RemoteRoomView {
  readonly name: string;
  readonly relayUrl: string;
  readonly autoConnect: boolean;
  readonly phase: RemoteRoomPhase;
  /** A short English reason for `error` / `backoff` (the UI localizes its own wording). */
  readonly error: string;
  /** The sessions of **this window** some peer in this room has attached to. */
  readonly attached: readonly string[];
  /** Every known peer, at most the number of members the relay admits to the room. */
  readonly peers: readonly RemotePeerView[];
}

/** The read-only snapshot of the whole feature (M2 draws the room tree from it). */
export interface RemoteSnapshot {
  readonly enabled: boolean;
  readonly rooms: readonly RemoteRoomView[];
}

/** The live phase of one room. */
export type RemoteRoomPhase =
  /** configured, not connecting (the feature is off, or the room is not `autoConnect`) */
  | 'off'
  /** joining the room (the key derivation is inside this phase) */
  | 'connecting'
  /** joined and streaming */
  | 'online'
  /** a failed attempt with a retry due */
  | 'backoff'
  /** a failure the transport will not retry on its own */
  | 'error'
  /** configured and wanted, but no token is stored for it */
  | 'no-token';

/** What the provider did with one peer-submitted message. */
export type RemoteInputResult = 'ok' | 'unknown-session' | 'readonly' | 'bad-message';

/** The refusal codes a `cmd` may be answered with (`remote/PROTOCOL.md` §5). */
export type RemoteCommandCode =
  /** the named session is not this window's */
  | 'unknown-session'
  /** this window lost the workspace lock, so it may not mutate the conversation */
  | 'readonly'
  /** the target node is streaming or owns unfinished work */
  | 'busy'
  /** the command or its arguments are not something this window knows */
  | 'unsupported';

/**
 * One control-plane `cmd`'s outcome, from the host to the wire.
 *
 * `body` is the route's own answer spread into a `result` frame (`{ ok:true, sessionId,
 * nodeId, … }`) — the same fields `POST /session/start` answers with, so a replica reads one
 * vocabulary. A refusal travels as an `error{code}` instead, and `message` is the route's own
 * sentence (control-plane text is deliberately English, `docs/agents/invariants/i18n.md`).
 */
export interface RemoteCommandOutcome {
  readonly ok: boolean;
  readonly body?: Record<string, unknown>;
  readonly code?: RemoteCommandCode;
  readonly message?: string;
}

/** Where a replica surface has got to. */
export type ReplicaState =
  /** the room is off / connecting, or the peer is not in it yet */
  | 'waiting'
  /** `attach` has been sent on the live connection: `mirror` frames may arrive */
  | 'attached'
  /** the peer left the room (a `bye`, or its presence timed out) */
  | 'gone';

/**
 * One peer window, addressed for an outbound frame. `deviceId`+`instanceId` is the stable
 * identity the registry, the blocklist and every outbound address lookup are keyed by; the
 * relay's `peerId` is resolved from it at send time and never stored by a caller.
 */
export interface RemotePeerRef {
  /** The local room name (the room table's key — a local label, never sent). */
  readonly room: string;
  readonly deviceId: string;
  readonly instanceId: string;
  /** The OS hostname, for a title or a dialog; it is not part of the identity. */
  readonly deviceName: string;
}

/** One replicated session surface, as the service sees it. */
export interface RemoteReplicaTarget extends RemotePeerRef {
  /** The publisher's own session id. */
  readonly sessionId: string;
}

/** What a replica surface is told. Every callback runs on this window's own thread. */
export interface RemoteReplicaSink {
  /** One mirrored host→webview message, exactly as the publisher posted it. */
  onMirror(sessionId: string, message: unknown): void;
  /** The publisher refused something this surface sent (`error{code}`). */
  onRefused(code: string, message: string): void;
  /** The room or the peer moved on; `detail` is an English line for a log or a tooltip. */
  onState(state: ReplicaState, detail: string): void;
}

/** The handle one replica surface holds. */
export interface RemoteReplicaHandle {
  readonly target: RemoteReplicaTarget;
  /** One webview→host message, submitted as an `input` frame. `false` when unreachable. */
  sendInput(message: unknown): boolean;
  /** One control-plane command (`cmd`), correlated by the frame id it returns (`''` when unsent). */
  sendCommand(command: string, args: Record<string, unknown>): string;
  /** Leave: a `detach` frame and forget this surface. Idempotent. */
  detach(): void;
}

/**
 * The provider surface the service may use. Kept deliberately narrow, like `RuntimeHost`:
 * the service never reaches into sessions, tabs or persistence on its own.
 */
export interface RemotePublisherHost {
  readonly output: vscode.OutputChannel;
  readonly disposed: boolean;
  /** The control plane's readout of this window — the source of an `instances` frame. */
  controlState(): ControlState;
  /** Does this window have this session at all? (`attach` to anything else is refused.) */
  hasSession(sessionId: string): boolean;
  /**
   * The very `tree` message the **local** webview would receive for this session — the
   * state an `attach` is answered with, so a replica renders exactly what a tab renders.
   * `null` for a session this window does not have.
   */
  remoteTreeMessage(sessionId: string): unknown | null;
  /**
   * Apply one webview→host message a peer submitted, through the same path a local
   * webview message takes. Resolves to `ok` when it was dispatched, or to the reason it
   * was refused (each one is answered as an `error{code}` frame by the caller).
   */
  applyRemoteInput(sessionId: string, message: unknown, origin: RemoteOrigin): RemoteInputResult;
  /**
   * Run one control-plane `cmd` (`remote/PROTOCOL.md` §5): the same four routes the local
   * HTTP plane answers (`controlStartSession` / `controlNavigate` / `controlContinueFrom` /
   * `controlStop`), so a command sent from the room cannot behave differently from the
   * same command sent over `spinney.httpApi.*`. `args` is untrusted JSON from another
   * machine — the host checks every field it uses.
   */
  remoteCommand(command: string, args: Record<string, unknown>): Promise<RemoteCommandOutcome>;
  /** True when another window owns this workspace's sessions: every remote mutation is refused. */
  isReadOnly(): boolean;
}

export interface RemoteServiceOptions {
  /** The provider this service publishes and drives. */
  host: RemotePublisherHost;
  /** The settings and the tokens (see `roomsStore.ts`). */
  store: RoomsStore;
  /** An English line for the output channel (and the diagnostics log). */
  log: (line: string) => void;
  /** This extension's own version, reported in `hello`. */
  appVersion: string;
  /** Test seam; defaults to `Date.now`. */
  now?: () => number;
}

/** One peer's state in a room. */
interface PeerState {
  key: string;
  /**
   * The relay-assigned address of this peer **right now**. It is transport, never
   * identity: a peer that reconnects gets a new one and keeps its {@link key}.
   */
  peerId: string;
  deviceId: string;
  deviceName: string;
  instanceId: string;
  workspace: string;
  appVersion: string;
  proto: number | null;
  lastSeenAt: number;
  instances: RemoteInstanceInfo[];
}

/** One room's live state: the transport, the registry and the attachments. */
interface RoomRuntime {
  config: RoomConfig;
  transport: RelayTransport | null;
  phase: RemoteRoomPhase;
  error: string;
  peerId: string | null;
  /** `sha256(machineId + roomId)` — this window's identity **in this room**. */
  deviceId: string;
  /** Registry key → peer. Keyed by `deviceId`+`instanceId`, never by a transient peer id. */
  peers: Map<string, PeerState>;
  /** The transient address book: relay peer id → registry key. */
  addresses: Map<string, string>;
  /** Session id → the registry keys of the peers that attached to it. */
  attachments: Map<string, Set<string>>;
  /** The transport's dropped-frame counter as of the last status report. */
  lastDropped: number;
  lastResyncAt: number;
  /** A transport call already failed loudly; report it once, not once per frame. */
  broken: boolean;
}

/** The parsed `hello` body (untrusted input: every field is checked, none is trusted). */
interface HelloBody {
  deviceId: string;
  deviceName: string;
  instanceId: string;
  workspace: string;
  appVersion: string;
  proto: number | null;
}

/** The registry key of a peer: the two facts that survive a reconnect. */
function peerKeyOf(deviceId: string, instanceId: string): string {
  return `${deviceId}\u0000${instanceId}`;
}

/** `sha256hex(machineId + roomId)` — stable per machine per room, never a raw machine id. */
function deviceIdFor(roomId: string): string {
  return createHash('sha256').update(vscode.env.machineId + roomId, 'utf8').digest('hex');
}

/** An http(s) relay URL, or `''` — the only transport this feature has. */
function normalizeRelayUrl(value: string): string {
  const raw = (value ?? '').trim();
  if (!raw) {
    return '';
  }
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? raw.replace(/\/+$/, '') : '';
  } catch {
    return '';
  }
}

/** Parse a `hello` body; `null` when it cannot be a hello at all. */
function parseHello(body: unknown): HelloBody | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }
  const row = body as Record<string, unknown>;
  const deviceId = typeof row.deviceId === 'string' ? row.deviceId.trim() : '';
  if (!deviceId) {
    return null;
  }
  return {
    deviceId,
    deviceName: typeof row.deviceName === 'string' ? row.deviceName : '',
    instanceId: typeof row.instanceId === 'string' ? row.instanceId : '',
    workspace: typeof row.workspace === 'string' ? row.workspace : '',
    appVersion: typeof row.appVersion === 'string' ? row.appVersion : '',
    proto: typeof row.proto === 'number' ? row.proto : null,
  };
}

/** One session row of an `instances` frame; `null` when it is not a session at all. */
function parseSessionRow(raw: unknown): RemoteSessionInfo | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === 'string' ? row.id : '';
  if (!id) {
    return null;
  }
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  return {
    id,
    title: typeof row.title === 'string' ? row.title : '',
    running: row.running === true,
    lockedNodes: strings(row.lockedNodes),
    backgroundNodes: strings(row.backgroundNodes),
    model: typeof row.model === 'string' ? row.model : undefined,
    modelName: typeof row.modelName === 'string' ? row.modelName : undefined,
    effort: typeof row.effort === 'string' ? row.effort : undefined,
    nodes: typeof row.nodes === 'number' ? row.nodes : 0,
  };
}

/** Parse an `instances` body; `null` when the body is not the announced shape. */
function parseInstances(body: unknown): RemoteInstanceInfo[] | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }
  const rows = (body as Record<string, unknown>).instances;
  if (!Array.isArray(rows)) {
    return null;
  }
  const out: RemoteInstanceInfo[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      continue;
    }
    const row = raw as Record<string, unknown>;
    const instanceId = typeof row.instanceId === 'string' ? row.instanceId : '';
    if (!instanceId) {
      continue;
    }
    const sessions: RemoteSessionInfo[] = [];
    if (Array.isArray(row.sessions)) {
      for (const session of row.sessions) {
        const parsed = parseSessionRow(session);
        if (parsed) {
          sessions.push(parsed);
        }
      }
    }
    out.push({ instanceId, workspace: typeof row.workspace === 'string' ? row.workspace : '', sessions });
  }
  return out;
}

/** The `sessionId` of an `attach` / `detach` / `resync` / `input` body. */
function sessionIdOf(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return '';
  }
  const value = (body as Record<string, unknown>).sessionId;
  return typeof value === 'string' ? value : '';
}

/**
 * The copy of a message that goes into the room: the `traceId` an op-traced repaint carries
 * is **dropped** (`src/remote/allowlist.ts` — a replica must never run the owner's probes,
 * and a mirrored one would feed the owner's own stall ladder with a peer's counters).
 * Everything else is copied verbatim: the replica is a webview receiving the protocol the
 * shipped `media/main.js` already speaks.
 */
function messageForPeer(message: unknown): unknown {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return message;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(message as Record<string, unknown>)) {
    if (key === 'traceId' || key.startsWith('perf')) {
      continue;
    }
    copy[key] = value;
  }
  return copy;
}

/**
 * One replicated session surface this window is driving: a panel in this window (M2), and
 * in principle any other local renderer of the same protocol.
 */
interface ReplicaRuntime {
  target: RemoteReplicaTarget;
  /** `${room}\0${peerKey}\0${sessionId}` — the identity a second `open` focuses rather than duplicates. */
  key: string;
  sink: RemoteReplicaSink;
  /** The state last reported to {@link sink}, so `onState` fires on transitions only. */
  state: ReplicaState;
  /** True once an `attach` was sent on the **current** connection (a reconnect clears it). */
  sent: boolean;
  /** Frame ids this surface sent and has not been answered for, so an `error` can find it. */
  pending: Map<string, number>;
}

/** One outbound `cmd` waiting for its `result`/`error`, and who asked for it. */
interface PendingCommand {
  at: number;
  /** The replica that asked, when a replica did; a room-tree action has no surface. */
  replica: ReplicaRuntime | null;
  onResult: ((outcome: RemoteCommandOutcome) => void) | null;
}

/**
 * What one frame id was accepted as — the de-dupe cache's payload.
 *
 * `null` for an `input` (nothing is answered on the wire for a first submission), the
 * `remoteCommand` outcome for a `cmd`. Either way a repeated id is answered *from here*, so
 * the second arrival can never repeat the second effect.
 */
interface CommandAnswer {
  readonly ok: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly body?: Record<string, unknown>;
}

/**
 * The publisher of one window. Created in `activate()`, disposed with the extension.
 */
export class RemoteService implements vscode.Disposable {
  /** Every room this window currently runs a transport for, by room name. */
  private readonly rooms = new Map<string, RoomRuntime>();
  /** The one status bar item of this window (created only while the feature is on). */
  private statusItem: vscode.StatusBarItem | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private instancesTimer: ReturnType<typeof setTimeout> | null = null;
  /** Configuration changes are applied one at a time, in order. */
  private applyChain: Promise<void> = Promise.resolve();
  /** Frame id → what it was accepted as; the short-lived `input`/`cmd` de-dupe cache. */
  private readonly seenInputs = new Map<string, { at: number; answer: CommandAnswer | null }>();
  /** Frame id → the `cmd` waiting for its answer, in the same short-lived cache. */
  private readonly pendingCommands = new Map<string, PendingCommand>();
  /**
   * The **local blocklist** (`kick`), keyed by `deviceId`+`instanceId` — the identity that
   * survives a reconnect, never the relay's transient peer id. The value is only the last
   * `deviceName` we knew, so the room tree can keep offering **Unblock** after the peer has
   * timed out of the registry.
   */
  private readonly blocked = new Map<string, { deviceId: string; deviceName: string; instanceId: string }>();
  /** Every replicated session surface this window is driving (M2's panels). */
  private readonly replicas = new Map<string, ReplicaRuntime>();
  /**
   * Fired whenever the {@link snapshot} changed: a room's phase, a peer's presence, an
   * attachment, a block. The room tree subscribes to this instead of polling, and it is
   * fired from {@link refreshStatusBar} — the one place every state change already passes
   * through on its way to the status bar.
   */
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private disposed = false;

  constructor(private readonly options: RemoteServiceOptions) {}

  // ---- lifecycle ----

  /**
   * Bring the feature up: the first reconciliation, and nothing else.
   *
   * The two liveness timers are created **only once a room exists** (see
   * {@link ensureTimers}), so a window whose `spinney.remote.enabled` is `false` — or that
   * has no room — runs no timer, opens no socket, reads no secret and shows no UI: the
   * feature is invisible to a user who never turns it on.
   */
  start(): void {
    if (this.disposed) {
      return;
    }
    void this.apply();
  }

  /** Start the presence timers if some room is (or is about to be) live. */
  private ensureTimers(): void {
    if (this.pingTimer) {
      return;
    }
    this.pingTimer = setInterval(() => this.probePeers(), PEER_PING_MS);
    this.pingTimer.unref?.();
    this.sweepTimer = setInterval(() => this.sweepPeers(), PEER_SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  private stopTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimers();
    if (this.instancesTimer) {
      clearTimeout(this.instancesTimer);
      this.instancesTimer = null;
    }
    for (const room of this.rooms.values()) {
      this.stopRoom(room);
    }
    this.rooms.clear();
    this.statusItem?.dispose();
    this.statusItem = null;
    this.seenInputs.clear();
    this.pendingCommands.clear();
    this.replicas.clear();
    this.changeEmitter.dispose();
  }

  /**
   * `spinney.remote.*` changed: apply it to the live rooms, right now.
   *
   * This is the whole "no reload required" path of the feature, and it is also what makes
   * the Room-Names command's writes take effect: the command only ever writes a setting or
   * a secret, and the change arrives here exactly as a hand edit would.
   */
  onConfigurationChanged(event: vscode.ConfigurationChangeEvent): void {
    if (!event.affectsConfiguration('spinney.remote')) {
      return;
    }
    this.options.log('[remote] remote-control settings changed; re-applying rooms');
    void this.apply();
  }

  /**
   * Some session state changed (the sidebar's own refresh runs beside this): the room's
   * `instances` announcement is re-sent, coalesced.
   *
   * Deliberately cheap on the hot path: with no room online this returns after one map
   * length check, which is what keeps "a user who never enables the feature cannot tell
   * that this code exists" true even though every session change reaches here.
   */
  onLocalStateChanged(): void {
    if (this.rooms.size === 0 || this.instancesTimer) {
      return;
    }
    if (!this.anyOnline()) {
      return;
    }
    this.instancesTimer = setTimeout(() => {
      this.instancesTimer = null;
      this.sendInstances();
    }, INSTANCES_DEBOUNCE_MS);
    this.instancesTimer.unref?.();
  }

  /**
   * A room's token changed under it (the command's Set / Clear token): reconnect that one
   * room against the new secret, so a cleared token stops the connection instead of leaving
   * the window published until the next reconnect.
   */
  restartRoom(roomName: string): void {
    this.enqueue(async () => {
      const live = this.rooms.get(roomName);
      if (live) {
        this.stopRoom(live);
        this.rooms.delete(roomName);
      }
      const read = this.options.store.read();
      const config = read.rooms.find((room) => room.name === roomName);
      if (!read.enabled || !config || !config.autoConnect) {
        this.refreshStatusBar();
        return;
      }
      await this.startRoom(config);
      this.refreshStatusBar();
    });
  }

  /** The read-only state M2's room tree draws: rooms → peers → instances → sessions. */
  snapshot(): RemoteSnapshot {
    const read = this.options.store.read();
    const rooms = read.rooms.map((config) => {
      const live = this.rooms.get(config.name);
      if (!live) {
        return {
          name: config.name,
          relayUrl: config.relayUrl,
          autoConnect: config.autoConnect,
          phase: 'off' as RemoteRoomPhase,
          error: '',
          attached: [],
          peers: [],
        };
      }
      const peers: RemotePeerView[] = [...live.peers.values()]
        .sort((a, b) => a.deviceName.localeCompare(b.deviceName) || a.key.localeCompare(b.key))
        .map((peer) => ({
          key: peer.key,
          deviceId: peer.deviceId,
          deviceName: peer.deviceName,
          instanceId: peer.instanceId,
          workspace: peer.workspace,
          appVersion: peer.appVersion,
          proto: peer.proto,
          incompatible: peer.proto !== null && peer.proto !== FRAME_VERSION,
          lastSeenAt: peer.lastSeenAt,
          blocked: this.isBlocked(peer.deviceId, peer.instanceId),
          live: true,
          instances: peer.instances,
        }));
      // A blocked peer that has since timed out of the registry keeps a row: the blocklist
      // is keyed by `deviceId`+`instanceId` and is what the room tree's **Unblock** acts on,
      // so it must be reachable even while the peer is not in the room at all. `live:false`
      // says exactly that, and `instances: []` means the node has no children.
      for (const entry of this.blocked.values()) {
        if (peers.some((peer) => peer.deviceId === entry.deviceId && peer.instanceId === entry.instanceId)) {
          continue;
        }
        peers.push({
          key: peerKeyOf(entry.deviceId, entry.instanceId),
          deviceId: entry.deviceId,
          deviceName: entry.deviceName,
          instanceId: entry.instanceId,
          workspace: '',
          appVersion: '',
          proto: null,
          incompatible: false,
          lastSeenAt: 0,
          blocked: true,
          live: false,
          instances: [],
        });
      }
      peers.sort((a, b) => a.deviceName.localeCompare(b.deviceName) || a.key.localeCompare(b.key));
      return {
        name: config.name,
        relayUrl: config.relayUrl,
        autoConnect: config.autoConnect,
        phase: live.phase,
        error: live.error,
        attached: [...live.attachments.keys()].sort(),
        peers,
      };
    });
    return { enabled: read.enabled, rooms };
  }

  // ---- the mirror seam ----

  /**
   * Hand one host→webview message to the room. Called from the single funnel every
   * session-facing message passes through (`ChatViewProvider.postTo`), so what a replica
   * sees is exactly what a local tab sees — with two deliberate exceptions, both on this
   * side of the wire: a type the allow-list refuses is never forwarded, and the `traceId`
   * of an op-traced repaint is dropped.
   *
   * **Never blocking**: there is no queue here and no `await`. `RelayTransport.send` owns
   * a bounded queue and returns `false` when it drops, so a peer that cannot keep up can
   * only cost itself frames — the caller has already delivered to the local panel before
   * this runs, and a session nobody attached to returns before any copy is made.
   */
  mirrorLocal(sessionId: string, message: unknown): void {
    if (this.rooms.size === 0) {
      return;
    }
    const type = (message as { type?: unknown } | null | undefined)?.type;
    if (typeof type !== 'string' || !mayMirrorToPeer(type)) {
      return;
    }
    let copy: unknown;
    let copied = false;
    for (const room of this.rooms.values()) {
      if (room.phase !== 'online') {
        continue;
      }
      const attached = room.attachments.get(sessionId);
      if (!attached || attached.size === 0) {
        continue;
      }
      if (!copied) {
        copy = messageForPeer(message);
        copied = true;
      }
      for (const key of attached) {
        // A kicked peer keeps a registry row but never a frame: the mirror is the thing a
        // kick actually stops, and it stops even if an `attach` slipped in before it.
        const peer = room.peers.get(key);
        if (!peer || this.isBlocked(peer.deviceId, peer.instanceId)) {
          continue;
        }
        if (!peer.peerId) {
          continue;
        }
        this.sendFrame(room, { type: 'mirror', to: peer.peerId, body: { sessionId, message: copy } });
      }
    }
  }

  // ---- the replica side (M2's panels) ----

  /**
   * Attach one **surface** to a peer's session: from here the publisher mirrors that session
   * to us (`mirror` frames) and our `input`/`cmd` frames are addressed to it.
   *
   * Re-opening the same `(room, device, instance, session)` hands the *same* runtime a new
   * sink and returns a fresh handle — the caller (a panel manager) is what focuses an
   * existing tab, and the service is what refuses to hold two attachments to one session.
   *
   * Attaching never throws and never blocks on the network: it either sends the `attach`
   * frame now or reports `waiting`, and {@link attachReplicas} re-tries when the room comes
   * online or the peer says `hello`. The publisher answers an `attach` with the very `tree`
   * message a local tab receives, so a replica that opens against a live session paints
   * itself from one frame.
   */
  openReplica(target: RemoteReplicaTarget, sink: RemoteReplicaSink): RemoteReplicaHandle {
    const key = `${target.room}\u0000${peerKeyOf(target.deviceId, target.instanceId)}\u0000${target.sessionId}`;
    let runtime = this.replicas.get(key);
    if (runtime) {
      runtime.sink = sink;
    } else {
      runtime = { target, key, sink, state: 'waiting', sent: false, pending: new Map() };
      this.replicas.set(key, runtime);
    }
    const self = runtime;
    const handle: RemoteReplicaHandle = {
      target,
      sendInput: (message) => this.sendReplicaInput(self, message),
      sendCommand: (command, args) => this.sendReplicaCommand(self, command, args),
      detach: () => this.closeReplica(self),
    };
    this.attachReplica(self);
    return handle;
  }

  /** How many replicated surfaces this window is driving (diagnostics and acceptance runs). */
  replicaCount(): number {
    return this.replicas.size;
  }

  /**
   * The publisher of one session refused something this replica sent. Answered as an
   * `error{code}` frame (`remote/PROTOCOL.md` §5); the surface decides how loud that is.
   */
  private sendReplicaInput(replica: ReplicaRuntime, message: unknown): boolean {
    const room = this.rooms.get(replica.target.room);
    const peerId = this.peerAddress(room, replica.target);
    if (!room || !peerId || this.isBlocked(replica.target.deviceId, replica.target.instanceId)) {
      return false;
    }
    const type = (message as { type?: unknown } | null | undefined)?.type;
    if (typeof type !== 'string' || !type) {
      return false;
    }
    return this.sendFrame(room, {
      type: 'input',
      to: peerId,
      body: { sessionId: replica.target.sessionId, message },
    });
  }

  /** One control-plane `cmd` from a replica surface, correlated by the frame id. */
  private sendReplicaCommand(replica: ReplicaRuntime, command: string, args: Record<string, unknown>): string {
    const id = this.sendCmd(replica.target, command, args, (outcome) => {
      if (!outcome.ok) {
        replica.sink.onRefused(outcome.code ?? 'unsupported', outcome.message ?? 'the command was refused');
      }
    });
    if (id) {
      replica.pending.set(id, this.now());
      for (const [old, at] of [...replica.pending]) {
        if (this.now() - at > INPUT_DEDUPE_MS) {
          replica.pending.delete(old);
        }
      }
    }
    return id;
  }

  /** Forget one replicated surface (the panel closed). A `detach` goes out when it can. */
  private closeReplica(replica: ReplicaRuntime): void {
    this.replicas.delete(replica.key);
    replica.pending.clear();
    const room = this.rooms.get(replica.target.room);
    const peerId = this.peerAddress(room, replica.target);
    if (room && peerId && !this.isBlocked(replica.target.deviceId, replica.target.instanceId)) {
      this.sendFrame(room, {
        type: 'detach',
        to: peerId,
        body: { sessionId: replica.target.sessionId },
      });
      this.options.log(`[remote] ${room.config.name}: detached from ${replica.target.sessionId}`);
    }
  }

  /**
   * One replicated surface, as soon as its room and peer allow it: send `attach` if we have
   * not on **this** connection, else report where it stands.
   *
   * A reconnect is the reason `sent` exists: a new connection means a new peer id and a lost
   * attachment, so the next call re-attaches (`remote/PROTOCOL.md` §7) — and the mirror
   * state the publisher answers with is what a fresh webview would have received, which is
   * why a reconnect costs one frame and no state of its own.
   */
  private attachReplica(replica: ReplicaRuntime): void {
    const room = this.rooms.get(replica.target.room);
    if (!room || room.phase !== 'online') {
      replica.sent = false;
      this.reportReplicaState(replica, 'waiting', !room ? 'the room is not connected' : 'waiting for the room');
      return;
    }
    if (this.isBlocked(replica.target.deviceId, replica.target.instanceId)) {
      replica.sent = false;
      this.reportReplicaState(replica, 'waiting', 'this window blocked that device');
      return;
    }
    const peerId = this.peerAddress(room, replica.target);
    if (!peerId) {
      replica.sent = false;
      this.reportReplicaState(replica, 'waiting', `${replica.target.deviceName || 'the peer'} is not in the room`);
      return;
    }
    if (!replica.sent) {
      const id = newFrameId();
      replica.sent = this.sendFrame(room, {
        type: 'attach',
        id,
        to: peerId,
        body: { sessionId: replica.target.sessionId },
      });
      replica.pending.set(id, this.now());
      this.options.log(
        `[remote] ${room.config.name}: attaching to ${replica.target.deviceName || replica.target.deviceId} · ${replica.target.sessionId}`,
      );
    }
    this.reportReplicaState(replica, 'attached', `mirroring ${replica.target.sessionId}`);
  }

  /** Re-attach every surface of one room (a join, a `hello`, a `resync`). */
  private attachReplicas(room: RoomRuntime): void {
    for (const replica of this.replicas.values()) {
      if (replica.target.room === room.config.name) {
        this.attachReplica(replica);
      }
    }
  }

  /**
   * Tell one surface where it stands, **on a transition only**: a state that has not changed
   * is not news, and a room that stays quiet must not repaint a panel every 30 s.
   */
  private reportReplicaState(replica: ReplicaRuntime, state: ReplicaState, detail: string): void {
    if (replica.state === state) {
      return;
    }
    replica.state = state;
    try {
      replica.sink.onState(state, detail);
    } catch (err) {
      this.options.log(`[remote] a replica surface threw in onState: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * The relay address of a peer, from its **stable** identity. The relay's peer id is
   * transient (§2), so every outbound frame looks it up here at send time and no caller ever
   * stores one.
   */
  private peerAddress(room: RoomRuntime | undefined, peer: { deviceId: string; instanceId: string }): string | null {
    if (!room || room.phase !== 'online') {
      return null;
    }
    const entry = room.peers.get(peerKeyOf(peer.deviceId, peer.instanceId));
    if (!entry || !entry.peerId || !room.addresses.get(entry.peerId)) {
      return null;
    }
    return entry.peerId;
  }

  // ---- the local blocklist (kick) ----

  /**
   * **Kick**: stop talking to one peer from this window.
   *
   * Be honest about what this is, because it is not what it sounds like. A kick cannot revoke
   * another token holder: the token is the trust root and the peer still holds it, so it can
   * rejoin the room, re-announce itself, and reach every *other* window in the room
   * (`remote/PROTOCOL.md` §9). What it does is exactly this window's own:
   *
   *  1. it stops mirroring to that peer (its attachments are dropped, and `attach` is refused
   *     from now on),
   *  2. its `input` and `cmd` frames are dropped **unanswered but logged** — a peer this
   *     window no longer talks to is not argued with, and the log is the record,
   *  3. it is told `bye`, so a well-behaved peer stops expecting frames from here.
   *
   * The blocklist is keyed by `deviceId`+`instanceId`, because that is the identity that
   * survives a reconnect; the relay's peer id, which changes on every reconnect, would forget
   * the kick the moment the peer came back. It is **in memory**: a kick is this window's
   * decision about the current session of work, not a persisted policy, and a reload is a
   * fresh start (the peer's own window will keep its token either way).
   */
  kick(peer: { deviceId: string; instanceId: string; deviceName?: string }): void {
    const deviceId = (peer.deviceId ?? '').trim();
    const instanceId = (peer.instanceId ?? '').trim();
    if (!deviceId || !instanceId) {
      return;
    }
    const key = peerKeyOf(deviceId, instanceId);
    if (this.blocked.has(key)) {
      return;
    }
    this.blocked.set(key, { deviceId, deviceName: peer.deviceName ?? '', instanceId });
    this.options.log(
      `[remote] kicked ${peer.deviceName || deviceId} — this window stops mirroring to it and drops its frames; it can still reach every other window`,
    );
    for (const room of this.rooms.values()) {
      const entry = room.peers.get(key);
      if (!entry) {
        continue;
      }
      // Drop every session it had attached to *this* window, so the mirror stops at once
      // rather than at the next frame.
      for (const [sessionId, attached] of [...room.attachments]) {
        if (attached.delete(key)) {
          this.options.log(`[remote] ${room.config.name}: un-mirroring ${sessionId} from the kicked peer`);
        }
        if (attached.size === 0) {
          room.attachments.delete(sessionId);
        }
      }
      this.sendFrame(room, { type: 'bye', to: entry.peerId, body: {} });
      // The registry entry stays: the room tree draws it as **blocked** and offers Unblock.
      entry.instances = [];
      entry.lastSeenAt = this.now();
    }
    for (const replica of [...this.replicas.values()]) {
      if (replica.target.deviceId === deviceId && replica.target.instanceId === instanceId) {
        replica.sent = false;
        this.reportReplicaState(replica, 'waiting', 'this window blocked that device');
      }
    }
    this.refreshStatusBar();
  }

  /** Lift a kick: this window talks to that peer again (it never stopped being able to). */
  unblock(deviceId: string, instanceId: string): void {
    const key = peerKeyOf((deviceId ?? '').trim(), (instanceId ?? '').trim());
    const entry = this.blocked.get(key);
    if (!entry) {
      return;
    }
    this.blocked.delete(key);
    this.options.log(`[remote] unblocked ${entry.deviceName || entry.deviceId}`);
    for (const room of this.rooms.values()) {
      this.attachReplicas(room);
    }
    this.refreshStatusBar();
  }

  /** Is that peer on this window's blocklist? (`deviceId`+`instanceId`, never a peer id.) */
  isBlocked(deviceId: string, instanceId: string): boolean {
    if (!deviceId || !instanceId) {
      return false;
    }
    return this.blocked.has(peerKeyOf(deviceId, instanceId));
  }

  // ---- outbound control-plane commands (`cmd`) ----

  /**
   * Send one control-plane `cmd` to a peer's window and return its frame id (`''` when it
   * could not be sent at all).
   *
   * This is the *tree's* door to `cmd` — "Send a message…", "Stop", "New session…" have no
   * webview of their own to ride, and no session has to be open in a tab. The answer comes
   * back as a `result` (or an `error{code}`) carrying this id, and is handed to `onResult`
   * when one was given. Nothing here decides *what* a command means: that is the publisher's
   * `remoteCommand` (the same four routes the local HTTP plane answers).
   */
  command(
    peer: RemotePeerRef,
    command: string,
    args: Record<string, unknown>,
    onResult?: (outcome: RemoteCommandOutcome) => void,
  ): string {
    return this.sendCmd(peer, command, args, onResult ?? null);
  }

  private sendCmd(
    peer: RemotePeerRef,
    command: string,
    args: Record<string, unknown>,
    onResult: ((outcome: RemoteCommandOutcome) => void) | null,
  ): string {
    const room = this.rooms.get(peer.room);
    const peerId = this.peerAddress(room, peer);
    if (!room || !peerId) {
      this.options.log(`[remote] ${peer.room}: cannot reach ${peer.deviceName || peer.deviceId} for "${command}"`);
      return '';
    }
    if (this.isBlocked(peer.deviceId, peer.instanceId)) {
      this.options.log(`[remote] ${peer.room}: "${command}" not sent — that device is blocked in this window`);
      return '';
    }
    const id = newFrameId();
    if (!this.sendFrame(room, { type: 'cmd', id, to: peerId, body: { command, args } })) {
      return '';
    }
    this.rememberPending(room, id, null, onResult);
    return id;
  }

  /** Remember one outbound `cmd`'s id, so its `result`/`error` can find its way back. */
  private rememberPending(
    room: RoomRuntime,
    id: string,
    replica: ReplicaRuntime | null,
    onResult: ((outcome: RemoteCommandOutcome) => void) | null,
  ): void {
    const at = this.now();
    for (const [key, entry] of [...this.pendingCommands]) {
      if (at - entry.at > INPUT_DEDUPE_MS) {
        this.pendingCommands.delete(key);
      }
    }
    while (this.pendingCommands.size >= INPUT_DEDUPE_MAX) {
      const oldest = this.pendingCommands.keys().next();
      if (oldest.done) {
        break;
      }
      this.pendingCommands.delete(oldest.value);
    }
    this.pendingCommands.set(`${room.config.name}\u0000${id}`, { at, replica, onResult });
  }

  /**
   * One `cmd` from a peer, answered with a `result` correlated by the frame `id`.
   *
   * The gates are the ones `input` has, in the same order — allow-listed command name, one
   * dispatch per frame id, the named session must exist, the window must be writable — plus
   * the route's own refusals turned into `error{code}` (`unknown-session` / `readonly` /
   * `busy` / `unsupported`). The de-dupe cache is the **same one** `input` uses, which is the
   * point: a replica that reconnects and repeats its `session/start` frame id must not create
   * a second session.
   */
  private async onCmd(room: RoomRuntime, frame: FrameEnvelope, peerKey: string): Promise<void> {
    const peer = room.peers.get(peerKey);
    const body = frame.body as { command?: unknown; args?: unknown } | null;
    const command = body && typeof body === 'object' ? body.command : undefined;
    const rawArgs = body && typeof body === 'object' ? body.args : undefined;
    if (typeof command !== 'string' || !command) {
      this.sendError(room, frame.from, 'unsupported', 'cmd needs { command, args }', frame.id);
      return;
    }
    if (peer && peer.proto !== null && peer.proto !== FRAME_VERSION) {
      this.sendError(room, frame.from, 'version', `this window speaks proto ${FRAME_VERSION}`, frame.id);
      return;
    }
    const args: Record<string, unknown> =
      rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {};
    if (rawArgs !== undefined && (typeof rawArgs !== 'object' || Array.isArray(rawArgs))) {
      this.sendError(room, frame.from, 'unsupported', 'cmd args must be an object', frame.id);
      return;
    }
    const cacheKey = `${room.config.name}\u0000${frame.id}`;
    if (this.seenInputs.has(cacheKey)) {
      // The same frame id, twice: it already ran (typically a replica re-sending after a
      // reconnect). The cached answer is re-sent, never re-executed — this is the one thing
      // that keeps a repeated `session/start` from creating a second session.
      const cached = this.seenInputs.get(cacheKey)?.answer;
      this.options.log(`[remote] ${room.config.name}: replayed cmd ${frame.id} — answering from the cache`);
      if (cached && !cached.ok) {
        this.sendError(room, frame.from, cached.code ?? 'unsupported', cached.message ?? 'refused', frame.id);
      } else {
        this.sendFrame(room, {
          type: 'result',
          id: frame.id,
          to: frame.from,
          body: { ...(cached?.body ?? {}), ok: true, duplicated: true },
        });
      }
      return;
    }
    const sessionId = typeof args.sessionId === 'string' ? args.sessionId : '';
    if (sessionId && !this.options.host.hasSession(sessionId)) {
      this.rememberAnswer(room, frame.id, {
        ok: false,
        code: 'unknown-session',
        message: `this window has no session ${sessionId}`,
      });
      this.sendError(room, frame.from, 'unknown-session', `this window has no session ${sessionId}`, frame.id);
      return;
    }
    let outcome: RemoteCommandOutcome;
    try {
      outcome = await this.options.host.remoteCommand(command, args);
    } catch (err) {
      outcome = {
        ok: false,
        code: 'unsupported',
        message: err instanceof Error ? err.message : String(err),
      };
    }
    if (this.disposed) {
      return;
    }
    this.rememberAnswer(room, frame.id, outcome);
    if (outcome.ok) {
      this.options.log(
        `[remote] ${room.config.name}: "${command}" from ${peer?.deviceName || frame.from} → ok${
          outcome.body?.sessionId ? ` (${String(outcome.body.sessionId)})` : ''
        }`,
      );
      this.sendFrame(room, { type: 'result', id: frame.id, to: frame.from, body: { ...(outcome.body ?? {}), ok: true } });
      return;
    }
    const code = outcome.code ?? 'unsupported';
    this.options.log(
      `[remote] ${room.config.name}: "${command}" from ${peer?.deviceName || frame.from} → ${code}: ${outcome.message ?? ''}`,
    );
    this.sendError(room, frame.from, code, outcome.message ?? 'the command was refused', frame.id);
  }

  /**
   * One `result`: the answer to a `cmd` this window sent. It ends the pending entry and is
   * handed to whoever asked (a replica surface, or the room tree's own action).
   */
  private onResult(room: RoomRuntime, frame: FrameEnvelope): void {
    const pending = this.pendingCommands.get(`${room.config.name}\u0000${frame.id}`);
    if (!pending) {
      // Nothing waits for it: a `result` for a command this window never sent (or one whose
      // entry already expired). Ignoring it is the whole handling — a correlation id that
      // names nothing is not an error on the wire.
      return;
    }
    this.pendingCommands.delete(`${room.config.name}\u0000${frame.id}`);
    const body = frame.body && typeof frame.body === 'object' ? (frame.body as Record<string, unknown>) : {};
    const outcome: RemoteCommandOutcome = {
      ok: body.ok !== false,
      body,
      message: typeof body.message === 'string' ? body.message : undefined,
      code: typeof body.code === 'string' ? (body.code as RemoteCommandOutcome['code']) : undefined,
    };
    try {
      pending.onResult?.(outcome);
    } catch (err) {
      this.options.log(`[remote] a cmd answer threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** One `mirror` frame: hand it to the surface that attached to that peer and session. */
  private onMirrorFrame(room: RoomRuntime, frame: FrameEnvelope, peerKey: string): void {
    const sessionId = sessionIdOf(frame.body);
    const message = (frame.body as { message?: unknown } | null)?.message;
    if (!sessionId || message === undefined) {
      this.sendError(room, frame.from, 'unsupported', 'mirror needs { sessionId, message }', frame.id);
      return;
    }
    const suffix = `\u0000${peerKey}\u0000${sessionId}`;
    let delivered = 0;
    for (const replica of this.replicas.values()) {
      if (!replica.key.startsWith(`${room.config.name}\u0000`) || !replica.key.endsWith(suffix)) {
        continue;
      }
      try {
        replica.sink.onMirror(sessionId, message);
        delivered++;
      } catch (err) {
        this.options.log(
          `[remote] a replica surface threw in onMirror: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (delivered === 0) {
      // Nothing in this window is rendering that session. A `mirror` frame nobody wants is
      // not an error (the publisher may still be attached to a panel we just closed), so it
      // is dropped quietly — but the frame id is remembered, so a repeated one is not.
      return;
    }
  }

  /** The one record an accepted frame id leaves: when it was accepted, and what it answered. */
  private rememberAnswer(room: RoomRuntime, id: string, answer: CommandAnswer): void {
    this.rememberInput(room, id, answer);
  }

  // ---- settings → rooms ----

  /** Queue one reconciliation after the previous one (settings events arrive in bursts). */
  private apply(): Promise<void> {
    return this.enqueue(() => this.applyNow());
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.applyChain.then(async () => {
      if (this.disposed) {
        return;
      }
      await task();
    });
    this.applyChain = next.catch(() => undefined);
    return this.applyChain;
  }

  /**
   * The reconciliation: every room that should be up is started, every room that should
   * not is torn down. A room whose `relayUrl` moved is restarted (its transport holds the
   * old address); a room that is `autoConnect: false` or that no longer exists is stopped.
   */
  private async applyNow(): Promise<void> {
    const read = this.options.store.read();
    for (const issue of read.issues) {
      this.options.log(`[remote] ${issue}`);
    }
    for (const [name, room] of [...this.rooms]) {
      const config = read.enabled ? read.rooms.find((row) => row.name === name) : undefined;
      if (config && config.autoConnect && config.relayUrl === room.config.relayUrl) {
        room.config = config;
        continue;
      }
      this.stopRoom(room);
      this.rooms.delete(name);
    }
    if (read.enabled) {
      for (const config of read.rooms) {
        if (config.autoConnect && !this.rooms.has(config.name)) {
          await this.startRoom(config);
        }
      }
    }
    if (this.rooms.size > 0) {
      this.ensureTimers();
    } else {
      this.stopTimers();
    }
    this.refreshStatusBar();
  }

  /**
   * Start one room: read its token, derive its keys, open the transport.
   *
   * The derivation (PBKDF2, 600000 iterations, hundreds of milliseconds) happens only
   * here, once per connection, which is the whole reason a window that never enables the
   * feature pays nothing for it.
   */
  private async startRoom(config: RoomConfig): Promise<void> {
    const room: RoomRuntime = {
      config,
      transport: null,
      phase: 'connecting',
      error: '',
      peerId: null,
      deviceId: '',
      peers: new Map(),
      addresses: new Map(),
      attachments: new Map(),
      lastDropped: 0,
      lastResyncAt: 0,
      broken: false,
    };
    this.rooms.set(config.name, room);
    const relayUrl = normalizeRelayUrl(config.relayUrl);
    if (!relayUrl) {
      room.phase = 'error';
      room.error = 'the relay URL must be an http(s) address';
      this.options.log(`[remote] ${config.name}: refusing to connect — ${room.error}`);
      this.refreshStatusBar();
      return;
    }
    const token = await this.options.store.readToken(config.name);
    if (this.disposed) {
      return;
    }
    if (!token) {
      room.phase = 'no-token';
      this.options.log(`[remote] ${config.name}: no token stored (Spinney: Manage Remote Rooms → Set token)`);
      this.refreshStatusBar();
      return;
    }
    let keys;
    try {
      keys = deriveRoom(token);
    } catch (err) {
      room.phase = 'error';
      room.error = err instanceof Error ? err.message : String(err);
      this.options.log(`[remote] ${config.name}: could not derive the room: ${room.error}`);
      this.refreshStatusBar();
      return;
    }
    room.deviceId = deviceIdFor(keys.roomId);
    try {
      room.transport = new RelayTransport({
        relayUrl,
        roomId: keys.roomId,
        encKey: keys.encKey,
        deviceId: room.deviceId,
        onFrame: (frame) => this.onFrame(room, frame),
        onStatus: (status) => this.onStatus(room, status),
      });
      room.transport.start();
      this.options.log(`[remote] ${config.name}: connecting to ${relayUrl} as device ${room.deviceId.slice(0, 12)}…`);
    } catch (err) {
      this.transportFailed(room, err);
    }
    this.refreshStatusBar();
  }

  /** Tear one room down and forget everything transient about it. */
  private stopRoom(room: RoomRuntime): void {
    const transport = room.transport;
    room.transport = null;
    if (transport) {
      try {
        transport.stop();
      } catch {
        /* tearing down a transport that is already gone is not a failure */
      }
    }
    room.phase = 'off';
    room.error = '';
    room.peerId = null;
    room.peers.clear();
    room.addresses.clear();
    room.attachments.clear();
    // Surfaces driving a session in this room are back to `waiting`: the room is gone (the
    // feature was turned off, or the room was disconnected) and a panel must not claim to be
    // mirroring anything.
    for (const replica of this.replicas.values()) {
      if (replica.target.room === room.config.name) {
        replica.sent = false;
        this.reportReplicaState(replica, 'waiting', 'the room is not connected');
      }
    }
  }

  // ---- the transport's two callbacks ----

  private onStatus(room: RoomRuntime, status: TransportStatus): void {
    if (this.disposed) {
      return;
    }
    const wasOnline = room.phase === 'online';
    room.broken = false;
    room.phase = this.phaseOf(status);
    room.error = status.error ?? '';
    room.peerId = status.peerId;
    if (room.phase !== 'online') {
      // The connection (and with it every attachment this window had in the room) is gone:
      // a replica surface must re-`attach` on the next join — a new `peerId` means the
      // publisher has forgotten us (§7).
      for (const replica of this.replicas.values()) {
        if (replica.target.room === room.config.name) {
          replica.sent = false;
        }
      }
    }
    if (room.phase === 'online' && !wasOnline) {
      // Arriving in the room: announce ourselves, then re-state what this window has.
      // Both are re-sent here (not only at the first join), which is exactly what a
      // reconnect needs: a new peer id, the peers' presence re-learned, this window's
      // session list re-announced.
      this.options.log(`[remote] ${room.config.name}: online as peer ${status.peerId ?? '?'}`);
      this.sendHello(room);
      this.sendInstancesTo(room);
      // Sessions this window is *driving* are re-attached on the new connection: a peer id
      // does not survive a reconnect, so the publisher has no idea we are still watching
      // (§7). Attaching before the peers' `hello`s arrive is fine — the ones whose peer id
      // is not known yet stay `waiting` and are re-tried by `onHello`.
      this.attachReplicas(room);
    } else if (room.phase === 'backoff' || room.phase === 'error') {
      this.options.log(
        `[remote] ${room.config.name}: ${room.phase}${status.error ? ` — ${status.error}` : ''}${
          status.retryAt ? ` (retry in ${Math.max(0, Math.round((status.retryAt - this.now()) / 1000))}s)` : ''
        }`,
      );
    }
    if (status.dropped > room.lastDropped) {
      room.lastDropped = status.dropped;
      const at = this.now();
      if (at - room.lastResyncAt >= RESYNC_MIN_INTERVAL_MS) {
        // The transport drops a frame it cannot deliver rather than queue without bound.
        // A dropped frame is never re-sent by itself, so the sessions some peer watches
        // are re-stated instead: the same message a fresh `attach` would get.
        room.lastResyncAt = at;
        this.options.log(`[remote] ${room.config.name}: ${status.dropped} mirrored frame(s) dropped; re-stating attached sessions`);
        for (const sessionId of room.attachments.keys()) {
          this.mirrorTree(room, sessionId);
        }
      }
    } else {
      room.lastDropped = status.dropped;
    }
    this.refreshStatusBar();
  }

  private phaseOf(status: TransportStatus): RemoteRoomPhase {
    switch (status.phase) {
      case 'online':
        return 'online';
      case 'connecting':
        return 'connecting';
      case 'backoff':
        return 'backoff';
      case 'error':
        return 'error';
      default:
        return 'off';
    }
  }

  /** A transport call threw: report it once, keep the room (a settings change restarts it). */
  private transportFailed(room: RoomRuntime, err: unknown): void {
    if (room.broken) {
      return;
    }
    room.broken = true;
    room.phase = 'error';
    room.error = err instanceof Error ? err.message : String(err);
    this.options.log(`[remote] ${room.config.name}: the room transport failed: ${room.error}`);
    this.refreshStatusBar();
  }

  private sendFrame(room: RoomRuntime, frame: OutboundFrame): boolean {
    const transport = room.transport;
    if (!transport || room.broken) {
      return false;
    }
    try {
      return transport.send(frame);
    } catch (err) {
      this.transportFailed(room, err);
      return false;
    }
  }

  // ---- presence ----

  /** `hello`: who this window is, in this room. Re-sent on every (re)join. */
  private sendHello(room: RoomRuntime, to = '*'): void {
    this.sendFrame(room, {
      type: 'hello',
      to,
      body: {
        deviceId: room.deviceId,
        deviceName: os.hostname(),
        instanceId: this.instanceId(),
        workspace: this.workspace(),
        appVersion: this.options.appVersion,
        proto: FRAME_VERSION,
      },
    });
  }

  /** `instances`: what this window has to attach to. */
  private sendInstances(): void {
    for (const room of this.rooms.values()) {
      if (room.phase === 'online') {
        this.sendInstancesTo(room);
      }
    }
  }

  private sendInstancesTo(room: RoomRuntime, to = '*'): void {
    this.sendFrame(room, { type: 'instances', to, body: { instances: [this.localInstance()] } });
  }

  /** This window's own `instances` row — the control plane's session shape, verbatim. */
  private localInstance(): RemoteInstanceInfo {
    const state = this.options.host.controlState();
    return {
      instanceId: this.instanceId(),
      workspace: this.workspace(),
      sessions: state.sessions.map((session: ControlSessionInfo) => ({
        id: session.id,
        title: session.title,
        running: session.running,
        lockedNodes: session.lockedNodes,
        backgroundNodes: session.backgroundNodes,
        model: session.model,
        modelName: session.modelName,
        effort: session.effort,
        nodes: session.nodes,
      })),
    };
  }

  private instanceId(): string {
    return (process.env.SPINNEY_INSTANCE_ID ?? '').trim() || `pid-${process.pid}`;
  }

  private workspace(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  }

  /** One application-level `ping` into every online room (the presence probe). */
  private probePeers(): void {
    for (const room of this.rooms.values()) {
      if (room.phase === 'online') {
        this.sendFrame(room, { type: 'ping', to: '*', body: {} });
      }
    }
  }

  /**
   * Drop the peers no frame has been seen from for {@link PEER_TIMEOUT_MS} — and with
   * them their attachments, so the mirror never addresses a member that is gone. A peer
   * that comes back announces itself again (`hello`) and attaches again.
   */
  private sweepPeers(): void {
    if (this.disposed) {
      return;
    }
    const at = this.now();
    let changed = false;
    for (const room of this.rooms.values()) {
      for (const [key, peer] of [...room.peers]) {
        if (at - peer.lastSeenAt <= PEER_TIMEOUT_MS) {
          continue;
        }
        this.forgetPeer(room, key);
        this.options.log(`[remote] ${room.config.name}: ${peer.deviceName || key} timed out`);
        changed = true;
      }
    }
    if (changed) {
      this.refreshStatusBar();
    }
  }

  /** Forget one peer: its addresses and every session it had attached to. */
  private forgetPeer(room: RoomRuntime, key: string): void {
    room.peers.delete(key);
    for (const [peerId, mapped] of [...room.addresses]) {
      if (mapped === key) {
        room.addresses.delete(peerId);
      }
    }
    for (const [sessionId, attached] of [...room.attachments]) {
      attached.delete(key);
      if (attached.size === 0) {
        room.attachments.delete(sessionId);
      }
    }
    // A replica surface watching a session on that peer has lost its publisher: it is told so
    // (a panel shows no invented state for a session nobody is mirroring any more), and it
    // re-attaches by itself if the peer comes back — its blocklist entry, if any, survives.
    for (const replica of this.replicas.values()) {
      if (replica.target.room === room.config.name && peerKeyOf(replica.target.deviceId, replica.target.instanceId) === key) {
        replica.sent = false;
        this.reportReplicaState(replica, 'gone', `${replica.target.deviceName || 'that peer'} left the room`);
      }
    }
  }

  // ---- inbound frames ----

  /**
   * One decoded frame from another member of the room.
   *
   * Everything here is untrusted input: the frame was closed under the room's AEAD key, so
   * the sender holds the token, but its *body* is still arbitrary JSON written by another
   * machine — every field is therefore checked before it is used, and every refusal is
   * answered with an `error{code}` frame rather than an exception (`remote/PROTOCOL.md` §5).
   */
  private onFrame(room: RoomRuntime, frame: FrameEnvelope): void {
    if (this.disposed) {
      return;
    }
    const hello = frame.type === 'hello' ? parseHello(frame.body) : null;
    if (frame.type === 'hello' && !hello) {
      this.sendError(room, frame.from, 'unsupported', 'malformed hello body', frame.id);
      return;
    }
    const peer = this.touchPeer(room, frame.from, hello);
    if (this.onBlockedFrame(room, frame, peer.key)) {
      return;
    }
    switch (frame.type) {
      case 'hello':
        this.onHello(room, frame, peer);
        return;
      case 'instances':
        this.onInstances(room, frame, peer.key);
        return;
      case 'attach':
        this.onAttach(room, frame, peer.key);
        return;
      case 'detach':
        this.onDetach(room, frame, peer.key);
        return;
      case 'resync':
        this.onResync(room, frame, peer.key);
        return;
      case 'input':
        this.onInput(room, frame, peer.key);
        return;
      case 'cmd':
        void this.onCmd(room, frame, peer.key);
        return;
      case 'mirror':
        this.onMirrorFrame(room, frame, peer.key);
        return;
      case 'result':
        this.onResult(room, frame);
        return;
      case 'ping':
        this.sendFrame(room, { type: 'pong', to: frame.from, body: {} });
        return;
      case 'pong':
        return;
      case 'bye':
        this.options.log(`[remote] ${room.config.name}: ${room.peers.get(peer.key)?.deviceName ?? frame.from} left`);
        this.forgetPeer(room, peer.key);
        this.refreshStatusBar();
        return;
      case 'error': {
        const body = (frame.body ?? {}) as { code?: unknown; message?: unknown };
        const code = String(body.code ?? '?');
        const message = typeof body.message === 'string' ? body.message : '';
        this.options.log(`[remote] ${room.config.name}: peer ${frame.from} reported ${code} ${message}`);
        // An `error` names the frame it refuses in `ref` (§5): a command this window sent
        // gets its refusal back here, where the caller that asked for it can react.
        this.onRefusal(room, frame, code, message);
        return;
      }
      default:
        this.sendError(room, frame.from, 'unknown-type', `unknown frame type "${frame.type}"`, frame.id);
        return;
    }
  }

  /**
   * A frame from a peer this window has **kicked**.
   *
   * Three of the four answers, and no fourth: `hello`/`instances`/`bye` are still read — they
   * are how the registry (and therefore the room tree's **Unblock** item) keeps knowing who
   * that device is — an `attach` is refused with the protocol's own `denied` code, and
   * everything else (`input`, `cmd`, `ping`, `resync`, …) is logged and **not answered at
   * all**. That last part is the point of a kick: a peer this window no longer talks to is
   * not argued with, so it learns nothing from its own frames — not even a refusal.
   */
  private onBlockedFrame(room: RoomRuntime, frame: FrameEnvelope, peerKey: string): boolean {
    const peer = room.peers.get(peerKey);
    if (!peer || !peer.deviceId || !this.isBlocked(peer.deviceId, peer.instanceId)) {
      return false;
    }
    switch (frame.type) {
      case 'hello':
      case 'instances':
      case 'bye':
        return false;
      case 'attach':
        this.options.log(
          `[remote] ${room.config.name}: refused attach from blocked ${peer.deviceName || frame.from} (${frame.id})`,
        );
        this.sendError(room, frame.from, 'denied', 'this window stopped talking to that device', frame.id);
        return true;
      default:
        this.options.log(
          `[remote] ${room.config.name}: dropped "${frame.type}" from blocked ${peer.deviceName || frame.from} (${frame.id}) unanswered`,
        );
        return true;
    }
  }

  /**
   * The refusal of a frame **this window sent**, delivered as an `error` whose body names the
   * refused request in `ref` (`remote/PROTOCOL.md` §5: an `error` body is
   * `{ code, message, ref }`, and `ref` is the correlation id of the frame it answers — the
   * `result` pair uses the frame's own `id` for the same job). The pending entry is closed and
   * the caller (a replica surface, or the tree action that asked) is told; an `error` with a
   * `ref` nobody waits for is only logged.
   */
  private onRefusal(room: RoomRuntime, frame: FrameEnvelope, code: string, message: string): void {
    const body = frame.body as { ref?: unknown } | null;
    const ref = body && typeof body === 'object' && typeof body.ref === 'string' ? body.ref : '';
    if (!ref) {
      return;
    }
    const pending = this.pendingCommands.get(`${room.config.name}\u0000${ref}`);
    if (!pending) {
      return;
    }
    this.pendingCommands.delete(`${room.config.name}\u0000${ref}`);
    try {
      pending.onResult?.({ ok: false, code: code as RemoteCommandOutcome['code'], message });
    } catch (err) {
      this.options.log(`[remote] a cmd refusal threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Register (or refresh) the peer `peerId` is, and return its registry key.
   *
   * The key is `deviceId`+`instanceId` and never the relay's peer id, which is reassigned
   * on every reconnect (§2) — that is what makes an attachment and a de-dupe entry survive
   * a reconnect. A frame from a peer we have never seen a `hello` from is parked under a
   * provisional key and promoted when the `hello` naming its instance arrives.
   */
  private touchPeer(room: RoomRuntime, peerId: string, hello: HelloBody | null): { key: string; fresh: boolean } {
    const at = this.now();
    const known = room.addresses.get(peerId);
    if (known) {
      const peer = room.peers.get(known);
      if (peer) {
        peer.lastSeenAt = at;
        peer.peerId = peerId;
        if (hello) {
          this.applyHello(room, peer, hello);
        }
        return { key: peer.key, fresh: false };
      }
      room.addresses.delete(peerId);
    }
    if (!hello) {
      const key = `?${peerId}`;
      let peer = room.peers.get(key);
      const fresh = !peer;
      if (!peer) {
        peer = {
          key,
          peerId,
          deviceId: '',
          deviceName: '',
          instanceId: '',
          workspace: '',
          appVersion: '',
          proto: null,
          lastSeenAt: at,
          instances: [],
        };
        room.peers.set(key, peer);
      }
      peer.lastSeenAt = at;
      peer.peerId = peerId;
      room.addresses.set(peerId, key);
      return { key, fresh };
    }
    const key = peerKeyOf(hello.deviceId, hello.instanceId);
    let peer = room.peers.get(key);
    let fresh = false;
    if (!peer) {
      // A provisional entry this `hello` names (`instances` arrived before it): adopt it,
      // so the attachments and the de-dupe keys collected under the provisional name keep
      // pointing at the same peer.
      for (const [oldKey, candidate] of room.peers) {
        if (oldKey.startsWith('?') && candidate.instanceId && candidate.instanceId === hello.instanceId) {
          room.peers.delete(oldKey);
          for (const [id, mapped] of room.addresses) {
            if (mapped === oldKey) {
              room.addresses.set(id, key);
            }
          }
          for (const attached of room.attachments.values()) {
            if (attached.delete(oldKey)) {
              attached.add(key);
            }
          }
          candidate.key = key;
          peer = candidate;
          break;
        }
      }
    }
    if (!peer) {
      fresh = true;
      peer = {
        key,
        peerId,
        deviceId: hello.deviceId,
        deviceName: hello.deviceName,
        instanceId: hello.instanceId,
        workspace: hello.workspace,
        appVersion: hello.appVersion,
        proto: hello.proto,
        lastSeenAt: at,
        instances: [],
      };
      room.peers.set(key, peer);
    }
    // One key, one current address: a peer that reconnected keeps its key but gets a new
    // peer id, and the old one must not stay addressable.
    for (const [id, mapped] of [...room.addresses]) {
      if (mapped === key && id !== peerId) {
        room.addresses.delete(id);
      }
    }
    room.addresses.set(peerId, key);
    peer.peerId = peerId;
    this.applyHello(room, peer, hello);
    peer.lastSeenAt = at;
    return { key, fresh };
  }

  private applyHello(room: RoomRuntime, peer: PeerState, hello: HelloBody): void {
    peer.deviceId = hello.deviceId;
    peer.deviceName = hello.deviceName || peer.deviceName;
    peer.instanceId = hello.instanceId || peer.instanceId;
    peer.workspace = hello.workspace || peer.workspace;
    peer.appVersion = hello.appVersion || peer.appVersion;
    peer.proto = hello.proto;
    if (peer.proto !== null && peer.proto !== FRAME_VERSION) {
      this.options.log(
        `[remote] ${room.config.name}: ${peer.deviceName || peer.deviceId} speaks proto ${peer.proto}; this window speaks ${FRAME_VERSION}`,
      );
    }
  }

  private onHello(room: RoomRuntime, frame: FrameEnvelope, peer: { key: string; fresh: boolean }): void {
    const state = room.peers.get(peer.key);
    if (!state) {
      return;
    }
    if (state.proto !== null && state.proto !== FRAME_VERSION) {
      this.sendError(room, frame.from, 'version', `this window speaks proto ${FRAME_VERSION}`, frame.id);
      return;
    }
    this.options.log(`[remote] ${room.config.name}: ${state.deviceName || state.deviceId} joined`);
    // A peer that has just joined has not seen this window's own announcement yet: answer
    // it directly, so both sides know each other without waiting for the next change.
    if (peer.fresh) {
      this.sendHello(room, frame.from);
      this.sendInstancesTo(room, frame.from);
    }
    // A replica surface waiting for this peer (it opened while the peer was away, or the
    // connection was replaced) can attach now: this is the first frame that names its
    // address.
    this.attachReplicas(room);
    this.refreshStatusBar();
  }

  private onInstances(room: RoomRuntime, frame: FrameEnvelope, peerKey: string): void {
    const peer = room.peers.get(peerKey);
    const instances = parseInstances(frame.body);
    if (!peer || !instances) {
      this.sendError(room, frame.from, 'unsupported', 'malformed instances body', frame.id);
      return;
    }
    peer.instances = instances;
    if (instances.length > 0) {
      // The peer's own `instanceId` / `workspace` are also in the frame, so an `instances`
      // announcement that arrives before a `hello` still names the instance a later
      // `hello` promotes this entry with.
      peer.instanceId = peer.instanceId || instances[0].instanceId;
      peer.workspace = peer.workspace || instances[0].workspace;
      // An `instances` row names the peer's instance, and a replica target IS a
      // `(deviceId, instanceId)`: this is the other frame that can make one addressable.
      this.attachReplicas(room);
    }
    this.refreshStatusBar();
  }

  private onAttach(room: RoomRuntime, frame: FrameEnvelope, peerKey: string): void {
    const peer = room.peers.get(peerKey);
    if (peer && peer.proto !== null && peer.proto !== FRAME_VERSION) {
      this.sendError(room, frame.from, 'version', `this window speaks proto ${FRAME_VERSION}`, frame.id);
      return;
    }
    const sessionId = sessionIdOf(frame.body);
    if (!sessionId) {
      this.sendError(room, frame.from, 'unsupported', 'attach needs a sessionId', frame.id);
      return;
    }
    if (!this.options.host.hasSession(sessionId)) {
      this.sendError(room, frame.from, 'unknown-session', `this window has no session ${sessionId}`, frame.id);
      return;
    }
    let attached = room.attachments.get(sessionId);
    if (!attached) {
      attached = new Set();
      room.attachments.set(sessionId, attached);
    }
    attached.add(peerKey);
    this.options.log(`[remote] ${room.config.name}: ${peer?.deviceName || frame.from} attached to ${sessionId}`);
    // Answer with the session's current state at once: the very `tree` message a local tab
    // receives, so the replica renders what the owner's tab renders and there is no second
    // source of truth to diverge from.
    this.mirrorTree(room, sessionId, frame.from);
    this.refreshStatusBar();
  }

  private onDetach(room: RoomRuntime, frame: FrameEnvelope, peerKey: string): void {
    const sessionId = sessionIdOf(frame.body);
    const attached = sessionId ? room.attachments.get(sessionId) : undefined;
    if (attached) {
      attached.delete(peerKey);
      if (attached.size === 0) {
        room.attachments.delete(sessionId);
      }
    }
    this.options.log(`[remote] ${room.config.name}: a peer detached from ${sessionId || '?'}`);
    this.refreshStatusBar();
  }

  /**
   * A peer lost frames and asks for fresh state: `{sessionId}` re-states one session,
   * `{}` re-announces this window and re-states everything it mirrors.
   */
  private onResync(room: RoomRuntime, frame: FrameEnvelope, _peerKey: string): void {
    const sessionId = sessionIdOf(frame.body);
    if (sessionId) {
      if (!this.options.host.hasSession(sessionId)) {
        this.sendError(room, frame.from, 'unknown-session', `this window has no session ${sessionId}`, frame.id);
        return;
      }
      this.mirrorTree(room, sessionId, frame.from);
      return;
    }
    this.sendInstancesTo(room, frame.from);
    for (const id of room.attachments.keys()) {
      this.mirrorTree(room, id, frame.from);
    }
  }

  /**
   * A peer submitted one webview→host message.
   *
   * Four gates, in this order: the type must be on `ACCEPT_FROM_PEER` (deny by default);
   * the frame's `id` must not have been accepted before (a replayed frame after a
   * reconnect is *the same submission*, not a second one); the window must be writable
   * (a window that lost the workspace lock publishes nothing); and the session must exist.
   * Every refusal answers `error{code}` — a peer always learns why nothing happened.
   */
  private onInput(room: RoomRuntime, frame: FrameEnvelope, peerKey: string): void {
    const body = frame.body as { sessionId?: unknown; message?: unknown } | null;
    const sessionId = sessionIdOf(frame.body);
    const message = body && typeof body === 'object' ? body.message : undefined;
    const type = (message as { type?: unknown } | null | undefined)?.type;
    if (!sessionId || typeof type !== 'string' || !type) {
      this.sendError(room, frame.from, 'unsupported', 'input needs { sessionId, message.type }', frame.id);
      return;
    }
    const peer = room.peers.get(peerKey);
    if (peer && peer.proto !== null && peer.proto !== FRAME_VERSION) {
      this.sendError(room, frame.from, 'version', `this window speaks proto ${FRAME_VERSION}`, frame.id);
      return;
    }
    if (!mayAcceptFromPeer(type)) {
      this.options.log(`[remote] ${room.config.name}: refused "${type}" from ${peer?.deviceName || frame.from} (not on the control allow-list)`);
      this.sendError(room, frame.from, 'denied', `"${type}" may not be submitted by a peer`, frame.id);
      return;
    }
    if (this.seenInputs.has(`${room.config.name}\u0000${frame.id}`)) {
      // The same frame id, twice: the submission already happened (typically a replica
      // re-sending its input after a reconnect). It is **answered from the cache** rather
      // than re-dispatched — the protocol's own rule (`remote/PROTOCOL.md` §5, §7: "the
      // publisher answers a repeated `id`", so a replica reconnecting into a lost answer
      // learns the submission stands instead of resending it blind). A second dispatch is
      // exactly the double-submit this cache exists to prevent.
      const cached = this.seenInputs.get(`${room.config.name}\u0000${frame.id}`)?.answer;
      this.options.log(`[remote] ${room.config.name}: replayed "${type}" frame ${frame.id} — answering from the cache`);
      if (cached && !cached.ok) {
        this.sendError(room, frame.from, cached.code ?? 'unsupported', cached.message ?? 'refused', frame.id);
      } else {
        this.sendFrame(room, { type: 'result', id: frame.id, to: frame.from, body: { ok: true, duplicated: true } });
      }
      return;
    }
    const result = this.options.host.applyRemoteInput(sessionId, message, {
      peerId: frame.from,
      deviceName: peer?.deviceName ?? '',
      at: this.now(),
    });
    switch (result) {
      case 'ok':
        this.rememberInput(room, frame.id, null);
        this.options.log(
          `[remote] ${room.config.name}: "${type}" from ${peer?.deviceName || frame.from} → session ${sessionId}`,
        );
        return;
      case 'readonly':
        this.rememberInput(room, frame.id, { ok: false, code: 'readonly', message: 'this window is read-only' });
        this.sendError(room, frame.from, 'readonly', 'this window is read-only', frame.id);
        return;
      case 'unknown-session':
        this.rememberInput(room, frame.id, {
          ok: false,
          code: 'unknown-session',
          message: `this window has no session ${sessionId}`,
        });
        this.sendError(room, frame.from, 'unknown-session', `this window has no session ${sessionId}`, frame.id);
        return;
      default:
        this.sendError(room, frame.from, 'unsupported', 'the submitted message has no type', frame.id);
        return;
    }
  }

  /**
   * Remember an accepted frame id ({@link INPUT_DEDUPE_MS}, at most {@link INPUT_DEDUPE_MAX}).
   *
   * One cache serves both `input` and `cmd`, because the question it answers is the same for
   * both ("has this exact submission already happened?"). The *answer* is stored with it: an
   * `input` is answered with nothing on the first pass (`null`), a `cmd` with its outcome,
   * and a repeated id is answered from this record instead of being executed again.
   */
  private rememberInput(room: RoomRuntime, id: string, answer: CommandAnswer | null): void {
    const at = this.now();
    for (const [key, entry] of [...this.seenInputs]) {
      if (at - entry.at > INPUT_DEDUPE_MS) {
        this.seenInputs.delete(key);
      }
    }
    while (this.seenInputs.size >= INPUT_DEDUPE_MAX) {
      const oldest = this.seenInputs.keys().next();
      if (oldest.done) {
        break;
      }
      this.seenInputs.delete(oldest.value);
    }
    this.seenInputs.set(`${room.config.name}\u0000${id}`, { at, answer });
  }

  private sendError(room: RoomRuntime, to: string, code: string, message: string, ref: string): void {
    this.sendFrame(room, { type: 'error', to, body: { code, message, ref } });
  }

  /**
   * Send one session's current state as a `mirror` frame carrying the very `tree` message
   * the local webview would receive.
   *
   * The tree message is the whole state a replica needs from this side: it is exactly what
   * a tab renders, and the two allow-listed additions a replica may need (a node's body
   * via `loadAgentItems`, the model list via `config`) arrive through the same funnel as
   * soon as the replica asks for them — with the *same* message the local webview gets.
   */
  private mirrorTree(room: RoomRuntime, sessionId: string, onlyPeerId?: string): void {
    const tree = this.options.host.remoteTreeMessage(sessionId);
    if (tree === undefined || tree === null) {
      return;
    }
    const attached = room.attachments.get(sessionId);
    const message = messageForPeer(tree);
    if (onlyPeerId) {
      this.sendFrame(room, { type: 'mirror', to: onlyPeerId, body: { sessionId, message } });
      return;
    }
    for (const key of attached ?? []) {
      const peerId = room.peers.get(key)?.peerId;
      if (peerId) {
        this.sendFrame(room, { type: 'mirror', to: peerId, body: { sessionId, message } });
      }
    }
  }

  // ---- the status bar ----

  private anyOnline(): boolean {
    for (const room of this.rooms.values()) {
      if (room.phase === 'online') {
        return true;
      }
    }
    return false;
  }

  /**
   * The status bar item: `$(radio-tower)` plus the room and its peer count, one item per
   * window, hidden while the feature is off or nothing is configured.
   *
   * It is created **lazily** — a window that never enables remote control never gets a
   * status bar item at all — and its tooltip names rooms and phases only: a token must
   * never reach a tooltip, a log or a settings file.
   */
  private refreshStatusBar(): void {
    // Every state change in this service already ends here, which is what makes this the one
    // place a subscriber (the room tree) has to listen to: no polling, no second bookkeeping.
    this.changeEmitter.fire();
    const snapshot = this.snapshot();
    const configured = snapshot.rooms.length > 0;
    if (!snapshot.enabled || !configured) {
      this.statusItem?.hide();
      return;
    }
    if (!this.statusItem) {
      this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
      // The click reveals the **room tree** (M2). It used to open the room editor directly,
      // which was the only remote surface that existed; now the tree is the surface, and the
      // editor is one of its own actions (`Manage rooms…` on a room) and the welcome view's
      // link. The command is registered by `activate()`; the tree's own focus command is what
      // it runs, falling back to the editor when the view does not exist (feature off).
      this.statusItem.command = 'spinney.remoteFocus';
    }
    const peers = snapshot.rooms.reduce((sum, room) => sum + room.peers.length, 0);
    const connected = snapshot.rooms.filter((room) => room.phase === 'online').length;
    if (snapshot.rooms.length === 1) {
      const room = snapshot.rooms[0];
      this.statusItem.text =
        room.peers.length === 1
          ? `${STATUS_ICON} ${vscode.l10n.t('{0} · 1 peer', room.name)}`
          : `${STATUS_ICON} ${vscode.l10n.t('{0} · {1} peers', room.name, room.peers.length)}`;
    } else {
      this.statusItem.text = `${STATUS_ICON} ${vscode.l10n.t('{0} rooms · {1} peers', snapshot.rooms.length, peers)}`;
    }
    const lines = [vscode.l10n.t('Spinney Remote Control — click to open the room tree.')];
    for (const room of snapshot.rooms) {
      lines.push(vscode.l10n.t('{0}: {1}', room.name, this.phaseLabel(room.phase)));
    }
    if (connected === 0 && snapshot.rooms.length > 0) {
      lines.push(vscode.l10n.t('Not connected.'));
    }
    this.statusItem.tooltip = lines.join('\n');
    this.statusItem.show();
  }

  /** The localized word for one room's phase — the room UI's own vocabulary is M2's. */
  phaseLabel(phase: RemoteRoomPhase): string {
    switch (phase) {
      case 'online':
        return vscode.l10n.t('online');
      case 'connecting':
        return vscode.l10n.t('connecting');
      case 'backoff':
        return vscode.l10n.t('reconnecting');
      case 'error':
        return vscode.l10n.t('error');
      case 'no-token':
        return vscode.l10n.t('no token');
      default:
        return vscode.l10n.t('off');
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}
