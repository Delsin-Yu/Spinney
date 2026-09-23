/*
 * remote-surfaces-acceptance — the *service-side* half of M2, as a dev-only acceptance run
 * (needs `out/`, no window, no network: the shape `tools/relay-acceptance.js` established).
 *
 * WHAT IT PINS, AND WHY IT IS NOT ALREADY PINNED ELSEWHERE.
 *
 *   1. **The `cmd`/`result` pair** (`remote/PROTOCOL.md` §5). A `cmd` is one control-plane
 *      route executed by the publisher — `session/start` literally creates a session — so the
 *      two properties that matter are *reached the right route* and *reached exactly once*.
 *      The second one is the idempotency cache: a replica that reconnects and repeats its
 *      frame id must get the cached answer and **no second session**. Nothing in the product
 *      can show that; its failure is a duplicated session on somebody else's machine.
 *   2. **The refusals** `unknown-session` / `readonly` / `busy` / `unsupported`, each answered
 *      as `error{code}` carrying the request's own id — the only way a replica learns why
 *      nothing happened.
 *   3. **`kick`**, and what it honestly is: mirroring stops, the peer's `input`/`cmd` frames
 *      are dropped *unanswered*, a `bye` goes out, the peer stays listed as blocked (so
 *      Unblock is reachable even after it times out of the registry) — and nothing about it
 *      revokes anything, because it cannot.
 *   4. **The replica side**: `attach` on open, `input`/`cmd` addressed to that peer, `detach`
 *      on close, a mirrored message routed to the surface that asked, and a re-`attach` after
 *      this window's own reconnect (a lost attachment is not a lost tab).
 *   5. **The frozen 1:1 routing table** (`src/remote/replicaRouting.ts`): reading and your own
 *      device stay local and are never forwarded, everything on the control allow-list is
 *      forwarded, everything else is refused, and the two sets do not overlap.
 *
 * HOW IT REACHES THE SERVICE WITHOUT A WINDOW. It stubs `vscode` (the same `Module._load` hook
 * `tools/relay-acceptance.js` and `tools/rollover-acceptance.js` use) and replaces
 * `RelayTransport.prototype` with a recorder: `start()` reports `online` with a peer id and
 * `send()` writes each outbound frame on a list. The real `RemoteService` then runs its own
 * code — the setting reconciliation, the key derivation (PBKDF2, paid once), the frame
 * routing, the de-dupe cache and the blocklist — and every assertion reads frames it produced.
 *
 * Needs `out/` (run `npm run compile` first):
 *   node tools/remote-surfaces-acceptance.js
 */
const path = require('path');
const Module = require('module');

const ROOT = process.argv[2] || path.join(__dirname, '..');
/** The context keys the extension published (`setContext`) — the welcome views read them. */
const contextKeys = {};
const problems = [];
const ok = (label, cond, detail) => {
  console.log(`  [${cond ? 'ok  ' : 'FAIL'}] ${label}${detail ? '  (' + detail + ')' : ''}`);
  if (!cond) {
    problems.push(label);
  }
};

// ---- the `vscode` stub -----------------------------------------------------

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => {
      this.listeners.push(listener);
      return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
    };
  }
  fire(value) {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }
  dispose() {
    this.listeners = [];
  }
}

const vscodeStub = {
  l10n: { t: (s, ...args) => String(s).replace(/\{(\d+)\}/g, (_, i) => String(args[i] ?? '')) },
  env: { language: 'en', machineId: 'acceptance-machine-id' },
  window: {
    createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show() {}, hide() {}, dispose() {} }),
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showInputBox: async () => undefined,
    createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, dispose() {}, clear() {} }),
  },
  workspace: {
    getConfiguration: () => ({ get: () => undefined, update: async () => undefined, has: () => false }),
    workspaceFolders: [],
  },
  commands: {
    executeCommand: async (command, ...args) => {
      if (command === 'setContext') {
        contextKeys[String(args[0])] = args[1];
      }
      return undefined;
    },
    registerCommand: () => ({ dispose() {} }),
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TreeItem: class {
    constructor(label, collapsibleState) {
      this.label = label;
      this.collapsibleState = collapsibleState;
      this.id = undefined;
      this.description = undefined;
      this.contextValue = undefined;
      this.iconPath = undefined;
      this.tooltip = undefined;
      this.command = undefined;
    }
  },
  ThemeIcon: class {
    constructor(id) {
      this.id = id;
    }
  },
  ViewColumn: { Active: -1 },
  EventEmitter,
  Disposable: class { constructor(fn) { this.fn = fn; } dispose() { this.fn && this.fn(); } },
  Uri: {
    file: (p) => ({ fsPath: p, scheme: 'file', toString: () => String(p) }),
    parse: (p) => ({ toString: () => String(p) }),
  },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeStub;
  }
  return origLoad.call(this, request, parent, isMain);
};

const O = (name) => require(path.join(ROOT, 'out', 'remote', name));
const { RemoteService } = O('remoteService');
const allowlist = O('allowlist');
const routing = O('replicaRouting');
const relayClient = O('relayClient');

// ---- the transport recorder -------------------------------------------------

/** Every frame the service sent, in order: `{ type, id, to, body }`. */
const sent = [];
/** The last transport's options: how an inbound frame reaches the service. */
let transportOptions = null;
/** This window's current relay address (its `peerId` on the live connection). */
let ownPeerId = null;
let ownCounter = 0;
/** The other peer's address. It does NOT change when *this* window reconnects. */
const PEER_ID = 'abcdef01';

relayClient.RelayTransport.prototype.start = function () {
  ownCounter += 1;
  ownPeerId = String(ownCounter).padStart(8, '0');
  this.phase = 'online';
  this.peer = ownPeerId;
  transportOptions = this.options;
  this.options.onStatus({ phase: 'online', peerId: ownPeerId, dropped: 0 });
};
relayClient.RelayTransport.prototype.stop = function () {
  this.phase = 'idle';
  this.peer = null;
  this.options.onStatus({ phase: 'idle', peerId: null, dropped: 0 });
};
relayClient.RelayTransport.prototype.send = function (frame) {
  sent.push({ type: frame.type, id: frame.id ?? null, to: frame.to, body: frame.body });
  return true;
};

/** This window's connection dropped and re-joined with a fresh relay address. */
const reconnectOwn = () => {
  transportOptions.onStatus({ phase: 'backoff', peerId: null, dropped: 0, error: 'acceptance: link dropped' });
  relayClient.RelayTransport.prototype.start.call({ options: transportOptions, clearQueue() {}, abortConnection() {}, clearTimers() {} });
};

/** One inbound frame, from the other peer. */
const inbound = (type, body, id = '0000000000000000') => {
  transportOptions.onFrame({ v: 1, type, id, from: PEER_ID, to: '*', body });
};

const frames = (type) => sent.filter((frame) => frame.type === type);
const lastOf = (type) => frames(type).slice(-1)[0] ?? null;

// ---- the host stub ----------------------------------------------------------

const sessions = new Set(['s1']);
let commandCalls = [];
let commandOutcome = null;
let treeMessages = 0;
let appliedInputs = [];

const host = {
  output: { appendLine() {}, append() {}, show() {}, dispose() {}, clear() {} },
  disposed: false,
  controlState: () => ({
    busy: false,
    sessionId: 's1',
    activeNodeId: 'n1',
    runningSubAgents: 0,
    runningBackgrounds: false,
    sessions: [
      {
        id: 's1', title: 'acceptance session', nodes: 1, active: true, running: false,
        runningNodes: [], lockedNodes: [], runningBackgrounds: false, backgroundNodes: [],
      },
    ],
  }),
  hasSession: (id) => sessions.has(id),
  remoteTreeMessage: () => {
    treeMessages += 1;
    return { type: 'tree', nodes: [], rootIds: [], viewId: null };
  },
  applyRemoteInput: (sessionId, message) => {
    if (!sessions.has(sessionId)) {
      return 'unknown-session';
    }
    if (typeof message?.type !== 'string' || !message.type) {
      return 'bad-message';
    }
    appliedInputs.push({ sessionId, type: message.type });
    return 'ok';
  },
  remoteCommand: async (command, args) => {
    commandCalls.push({ command, args });
    if (commandOutcome) {
      return commandOutcome;
    }
    if (command === 'session/start') {
      const id = `s${sessions.size + 1}`;
      sessions.add(id);
      return { ok: true, body: { sessionId: id, nodeId: null, prompted: false } };
    }
    if (command === 'continue') {
      return { ok: true, body: { sessionId: args.sessionId ?? 's1', nodeId: 'n1' } };
    }
    if (command === 'stop') {
      return { ok: true, body: { sessionId: args.sessionId ?? 's1', stopped: 1 } };
    }
    // Anything else is what `ChatViewProvider.remoteCommand` answers for a name it does not
    // know: the route table is closed, so an unknown command is `unsupported`, never a no-op.
    return { ok: false, code: 'unsupported', message: `unknown command "${command}"` };
  },
  isReadOnly: () => false,
};

const store = {
  read: () => ({ enabled: true, rooms: [{ name: 'home', relayUrl: 'http://127.0.0.1:1', autoConnect: true }], issues: [] }),
  readToken: async () => 'acceptance-token-with-enough-entropy-0123456789',
};

const lines = [];
let managedRooms = 0;
const service = new RemoteService({ host, store, log: (line) => lines.push(line), appVersion: '0.0.0-test' });

const PEER = { deviceId: 'device-aaaa', instanceId: 'pid-aaaa', deviceName: 'acceptance-peer' };
const helloBody = () => ({
  deviceId: PEER.deviceId,
  deviceName: PEER.deviceName,
  instanceId: PEER.instanceId,
  workspace: 'D:\\Repos\\Somewhere',
  appVersion: '9.9.9',
  proto: 1,
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (label, probe, ms = 5000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (probe()) {
      return true;
    }
    if (Date.now() > deadline) {
      ok(`timed out waiting for ${label}`, false);
      return false;
    }
    await wait(20);
  }
};

(async () => {
  service.start();
  await until('the room to come online', () => service.snapshot().rooms[0]?.phase === 'online');

  // ---- 1. the snapshot the room tree draws --------------------------------
  console.log('-- 1. the snapshot the room tree draws --');
  const first = service.snapshot();
  ok('a configured, enabled room is in the snapshot', first.enabled && first.rooms.length === 1, first.rooms[0]?.name);
  ok('its peer list starts empty (nobody said hello yet)', first.rooms[0].peers.length === 0);
  ok('the service publishes a change event for the tree to subscribe to', typeof service.onDidChange === 'function');
  let changed = 0;
  const subscription = service.onDidChange(() => { changed += 1; });

  // ---- 2. a peer that speaks ----------------------------------------------
  console.log('-- 2. a peer joins, attaches, and is mirrored --');
  inbound('hello', helloBody());
  await wait(10);
  const withPeer = service.snapshot().rooms[0];
  ok('the peer appeared under its stable identity (deviceId+instanceId)', withPeer.peers.length === 1, `${withPeer.peers[0]?.deviceName} · ${withPeer.peers[0]?.key?.slice(0, 20)}…`);
  ok('it is live and not blocked', withPeer.peers[0]?.blocked === false && withPeer.peers[0]?.live === true);
  ok('a change event fired (the tree would have repainted)', changed > 0, `${changed} event(s)`);

  inbound('instances', {
    instances: [
      {
        instanceId: PEER.instanceId,
        workspace: 'D:\\Repos\\Somewhere',
        sessions: [
          { id: 's1', title: 'remote session', running: true, lockedNodes: [], backgroundNodes: [], model: 'card-1', modelName: 'Card One', effort: 'medium', nodes: 3 },
        ],
      },
    ],
  });
  await wait(10);
  const instance = service.snapshot().rooms[0].peers[0].instances[0];
  ok('an `instances` announcement describes that peer\'s sessions', instance?.sessions[0]?.title === 'remote session' && instance.sessions[0].nodes === 3 && instance.sessions[0].modelName === 'Card One');

  inbound('attach', { sessionId: 's1' });
  await wait(10);
  const attachMirror = frames('mirror').filter((f) => f.body?.sessionId === 's1');
  ok('an `attach` is answered at once with the session state', attachMirror.length === 1, `${attachMirror.length} mirror frame(s)`);
  ok('  … carrying the very `tree` message a local tab receives', attachMirror[0]?.body?.message?.type === 'tree' && treeMessages > 0);
  ok('  … and the attachment shows in the snapshot', service.snapshot().rooms[0].attached.includes('s1'));

  // ---- 3. `cmd` / `result` ------------------------------------------------
  console.log('-- 3. the `cmd`/`result` pair, and the idempotency cache --');
  sent.length = 0;
  commandCalls = [];
  const cmdId = '0123456789abcdef';
  inbound('cmd', { command: 'session/start', args: { title: 'made remotely' } }, cmdId);
  await until('the `result` for the cmd', () => lastOf('result'));
  const result = lastOf('result');
  const sessionsAfterFirst = sessions.size;
  ok('the command reached the host\'s own control route', commandCalls.length === 1 && commandCalls[0].command === 'session/start', JSON.stringify(commandCalls[0] ?? null));
  ok('it was answered by a `result` carrying the request\'s id', result?.id === cmdId);
  ok('  … with the route\'s own body in it', result?.body?.ok === true && typeof result.body.sessionId === 'string', JSON.stringify(result?.body));

  sent.length = 0;
  inbound('cmd', { command: 'session/start', args: { title: 'made remotely' } }, cmdId);
  await until('the cached answer for the repeated id', () => lastOf('result'));
  const replay = lastOf('result');
  ok('a repeated frame id does NOT run the command again', commandCalls.length === 1, `${commandCalls.length} host call(s)`);
  ok('  … so no second session was created', sessions.size === sessionsAfterFirst, `${sessions.size} session(s)`);
  ok('  … it is answered from the same cache instead', replay?.body?.duplicated === true && replay.id === cmdId, JSON.stringify(replay?.body));

  commandCalls = [];
  sent.length = 0;
  inbound('cmd', { command: 'continue', args: { sessionId: 'nope', message: 'hi' } }, '1111111111111111');
  await until('the unknown-session refusal', () => lastOf('error'));
  ok('a session this window does not have is refused with `unknown-session`', lastOf('error')?.body?.code === 'unknown-session' && lastOf('error').body.ref === '1111111111111111');
  ok('  … without reaching the control route at all', commandCalls.length === 0);

  sent.length = 0;
  inbound('cmd', { command: 'wat/ever', args: {} }, '2222222222222222');
  await until('the unsupported refusal', () => lastOf('error'));
  ok('an unknown command name is refused with `unsupported`', lastOf('error')?.body?.code === 'unsupported');

  sent.length = 0;
  commandOutcome = { ok: false, code: 'busy', message: 'the agent is busy; wait for it to finish first' };
  inbound('cmd', { command: 'session/start', args: {} }, '3333333333333333');
  await until('the busy refusal', () => lastOf('error'));
  ok('a busy publisher answers `busy`, with its own sentence', lastOf('error')?.body?.code === 'busy' && /busy/.test(lastOf('error').body.message));

  sent.length = 0;
  commandOutcome = { ok: false, code: 'readonly', message: 'another window owns this workspace\u2019s sessions; this window is read-only' };
  inbound('cmd', { command: 'session/start', args: {} }, '4444444444444444');
  await until('the readonly refusal', () => lastOf('error'));
  ok('a read-only publisher answers `readonly`', lastOf('error')?.body?.code === 'readonly');
  commandOutcome = null;

  // ---- 4. `input` ----------------------------------------------------------
  console.log('-- 4. `input` — the same cache, the same double-submit rule --');
  sent.length = 0;
  appliedInputs = [];
  inbound('input', { sessionId: 's1', message: { type: 'userMessage', text: 'hello' } }, '5555555555555555');
  await wait(10);
  ok('an allow-listed input is dispatched', appliedInputs.length === 1 && appliedInputs[0].type === 'userMessage');
  ok('  … and nothing is promised on the wire for a first submission', lastOf('result') === null && lastOf('error') === null);
  sent.length = 0;
  appliedInputs = [];
  inbound('input', { sessionId: 's1', message: { type: 'userMessage', text: 'hello' } }, '5555555555555555');
  await wait(10);
  ok('its repeat is answered from the same cache, never re-dispatched', appliedInputs.length === 0 && lastOf('result')?.body?.duplicated === true);

  sent.length = 0;
  inbound('input', { sessionId: 's1', message: { type: 'pickImage' } }, '6666666666666666');
  await wait(10);
  ok('a local-affordance type is refused by the publisher\'s own allow-list', lastOf('error')?.body?.code === 'denied', String(lastOf('error')?.body?.message));

  // ---- 5. the replica surface ---------------------------------------------
  console.log('-- 5. the replica surface: attach, mirror, input, cmd, detach --');
  sent.length = 0;
  const mirrored = [];
  const refused = [];
  const states = [];
  const handle = service.openReplica(
    { room: 'home', deviceId: PEER.deviceId, instanceId: PEER.instanceId, deviceName: PEER.deviceName, sessionId: 's1' },
    {
      onMirror: (sessionId, message) => mirrored.push({ sessionId, type: message?.type }),
      onRefused: (code, message) => refused.push({ code, message }),
      onState: (state, detail) => states.push({ state, detail }),
    },
  );
  await wait(10);
  ok('opening a replica sends `attach` for that session', lastOf('attach')?.body?.sessionId === 's1', `to ${lastOf('attach')?.to}`);
  ok('  … and the surface is told it is attached', states.some((s) => s.state === 'attached'), JSON.stringify(states));
  ok('  … while the service knows exactly one surface', service.replicaCount() === 1);

  inbound('mirror', { sessionId: 's1', message: { type: 'tree', nodes: [{ id: 'n1', title: 'welcome' }] } });
  await wait(10);
  ok('a `mirror` frame reaches the surface that attached', mirrored.length === 1 && mirrored[0].type === 'tree', JSON.stringify(mirrored));

  sent.length = 0;
  ok('the surface can submit an input', handle.sendInput({ type: 'userMessage', text: 'from the replica' }) === true);
  await wait(10);
  ok('  … which travels as an `input` frame for that session', lastOf('input')?.body?.sessionId === 's1' && lastOf('input').to === PEER_ID);

  sent.length = 0;
  const sentCmd = handle.sendCommand('session/start', { title: 'from the replica' });
  await wait(10);
  ok('the surface can send a `cmd`, correlated by a generated frame id', /^[0-9a-f]{16}$/.test(sentCmd) && lastOf('cmd')?.id === sentCmd, sentCmd);
  inbound('result', { ok: true, sessionId: 's9' }, sentCmd);
  await wait(10);
  ok('a `result` for that id is routed back (no refusal raised)', refused.length === 0);

  sent.length = 0;
  const refusedCmd = handle.sendCommand('stop', { sessionId: 's1' });
  inbound('error', { code: 'readonly', message: 'this window is read-only', ref: refusedCmd });
  await wait(10);
  ok('an `error{ref}` for a surface\'s cmd is handed to that surface', refused.some((r) => r.code === 'readonly'), JSON.stringify(refused));

  // This window's own connection drops and re-joins: the attachment is gone, the tab is not.
  sent.length = 0;
  reconnectOwn();
  await wait(20);
  const reattach = lastOf('attach');
  ok('a reconnect re-`attach`es the session this window is driving', reattach?.body?.sessionId === 's1', `to ${reattach?.to}`);
  // The publisher answers the fresh `attach` with the session state (the same message a local
  // tab gets), and it must still find the surface: the tab survived the reconnect.
  mirrored.length = 0;
  inbound('mirror', { sessionId: 's1', message: { type: 'tree', nodes: [] } });
  await wait(10);
  ok('  … and a mirror after the re-attach still reaches the surface', mirrored.length === 1, JSON.stringify(mirrored));

  sent.length = 0;
  handle.detach();
  await wait(10);
  ok('closing the surface sends `detach`', lastOf('detach')?.body?.sessionId === 's1');
  ok('  … and the service forgets it', service.replicaCount() === 0);

  // ---- 6. kick -------------------------------------------------------------
  console.log('-- 6. kick: what it does, and what it honestly does not --');
  // Control: while the peer is welcome, the mirror really does reach it.
  sent.length = 0;
  service.mirrorLocal('s1', { type: 'delta', text: 'x' });
  await wait(10);
  ok('control: an attached peer receives mirror frames', frames('mirror').length === 1);

  sent.length = 0;
  service.kick({ ...PEER });
  await wait(10);
  ok('a kicked peer is told `bye`', !!lastOf('bye'), `to ${lastOf('bye')?.to}`);
  const blocked = service.snapshot().rooms[0].peers[0];
  ok('it is still listed, now as blocked (so Unblock is reachable)', blocked?.blocked === true && blocked.live === true);
  ok('  … and the blocklist is keyed by deviceId+instanceId, not the peer id', service.isBlocked(PEER.deviceId, PEER.instanceId) && !service.isBlocked(PEER.deviceId, 'other-instance'));

  sent.length = 0;
  service.mirrorLocal('s1', { type: 'delta', text: 'x' });
  await wait(10);
  ok('mirroring to it stopped', frames('mirror').length === 0);

  sent.length = 0;
  inbound('attach', { sessionId: 's1' }, '7777777777777777');
  await wait(10);
  ok('an `attach` from it is refused with `denied`', lastOf('error')?.body?.code === 'denied');

  sent.length = 0;
  appliedInputs = [];
  inbound('input', { sessionId: 's1', message: { type: 'userMessage', text: 'again' } }, '8888888888888888');
  inbound('cmd', { command: 'stop', args: { sessionId: 's1' } }, '9999999999999999');
  await wait(20);
  ok('its `input`/`cmd` frames are dropped UNANSWERED (no error, no result)', sent.length === 0, `${sent.length} frame(s) sent`);
  ok('  … and not dispatched either', appliedInputs.length === 0);
  ok('  … and the drop is logged, because the log is the record a kick leaves', lines.some((line) => /unanswered/.test(line)));
  ok('  … with the sentence that says what a kick is', lines.some((line) => /not a revocation|stops mirroring|stops talking/.test(line)));

  sent.length = 0;
  inbound('hello', helloBody(), '0000000000000001');
  await wait(10);
  ok('its `hello` is still read (that is how Unblock keeps a name)', service.snapshot().rooms[0].peers[0]?.deviceName === PEER.deviceName);

  service.unblock(PEER.deviceId, PEER.instanceId);
  await wait(10);
  ok('Unblock lifts it', service.snapshot().rooms[0].peers[0]?.blocked === false && !service.isBlocked(PEER.deviceId, PEER.instanceId));
  sent.length = 0;
  inbound('attach', { sessionId: 's1' });
  await wait(10);
  ok('  … and it can attach again', frames('mirror').length === 1);

  // ---- 7. the routing table ------------------------------------------------
  console.log('-- 7. the frozen 1:1 routing table --');
  const neverForwarded = ['perfDiag', 'layoutDiagnostic', 'setNodeSize', 'copyNodeId', 'openExternal', 'pickImage', 'openModelTree', 'ready'];
  ok('every never-forwarded type of §6 is answered locally', neverForwarded.every((type) => routing.replicaRoute(type) === 'local'), [...routing.REPLICA_LOCAL_MESSAGES].join(', '));
  ok('every type on the control allow-list is forwarded', [...allowlist.ACCEPT_FROM_PEER].every((type) => routing.replicaRoute(type) === 'forward'), `${allowlist.ACCEPT_FROM_PEER.size} type(s)`);
  ok('the two sets do not overlap (one click, one effect)', [...routing.REPLICA_LOCAL_MESSAGES].every((type) => !allowlist.ACCEPT_FROM_PEER.has(type)));
  ok('a type nobody classified is refused in both directions', ['probe', 'nudge', 'composerClear', 'clear', 'madeUpType', ''].every((type) => routing.replicaRoute(type) === 'refuse'));
  ok('  … including a message with no type at all', [undefined, null, 42, {}].every((value) => routing.replicaRoute(value) === 'refuse'));

  // ---- 8. the room tree's hierarchy and items ------------------------------
  console.log('-- 8. the room tree: room -> device -> instance -> session --');
  inbound('hello', helloBody(), '0000000000000003');
  inbound('instances', {
    instances: [
      {
        instanceId: PEER.instanceId,
        workspace: 'D:/Repos/Somewhere',
        sessions: [
          { id: 's1', title: 'remote session', running: true, lockedNodes: [], backgroundNodes: [], model: 'card-1', modelName: 'Card One', effort: 'medium', nodes: 3 },
          { id: 's2', title: 'an idle one', running: false, lockedNodes: ['n2'], backgroundNodes: ['n3'], nodes: 1 },
        ],
      },
    ],
  }, '0000000000000004');
  await wait(10);
  const { RemoteTreeProvider } = O('remoteTreeView');
  const tree = new RemoteTreeProvider({
    service,
    store,
    panels: { open() { return null; }, size: 0, dispose() {} },
    log: (line) => lines.push(line),
    manageRooms: () => { managedRooms += 1; },
  });
  const rooms = tree.getChildren();
  ok('the root is the room', rooms.length === 1 && rooms[0].kind === 'room', rooms[0]?.room?.name);
  const devices = tree.getChildren(rooms[0]);
  ok('a room holds its devices', devices.length === 1 && devices[0].kind === 'device');
  const instances = tree.getChildren(devices[0]);
  ok('a device holds its instances (one VS Code window each)', instances.length === 1 && instances[0].kind === 'instance');
  const sessionRows = tree.getChildren(instances[0]);
  ok('an instance holds its sessions', sessionRows.length === 2 && sessionRows.every((s) => s.kind === 'session'), sessionRows.map((s) => s.session.title).join(' | '));

  const roomItem = tree.getTreeItem(rooms[0]);
  ok('the room item shows its phase and peer count', /online/.test(roomItem.description) && /1 peer/.test(roomItem.description), roomItem.description);
  ok('  … with the phase in its tooltip and the local-label sentence', /online/.test(String(roomItem.tooltip)) && /local label/.test(String(roomItem.tooltip)));
  ok('  … and a context value the menu clauses use', roomItem.contextValue === 'remoteRoom', roomItem.contextValue);
  const deviceItem = tree.getTreeItem(devices[0]);
  ok('the device item is named by `deviceName`', deviceItem.label === PEER.deviceName && deviceItem.contextValue === 'remoteDevice', String(deviceItem.label));
  ok('  … and its tooltip says plainly what a kick is not', /not a revocation/.test(String(deviceItem.tooltip)));
  const instanceItem = tree.getTreeItem(instances[0]);
  ok('the instance item shows the workspace folder and the model', instanceItem.label === 'Somewhere' && /Card One/.test(instanceItem.description), `${instanceItem.label} · ${instanceItem.description}`);
  ok('  … and a busy instance spins', instanceItem.iconPath?.id === 'sync~spin', String(instanceItem.iconPath?.id));
  const sessionItem = tree.getTreeItem(sessionRows[0]);
  ok('the session item shows its title and running state', sessionItem.label === 'remote session' && /running/.test(sessionItem.description), `${sessionItem.label} · ${sessionItem.description}`);
  ok('  … and Enter opens the replica, with the node as its argument', sessionItem.command?.command === 'spinney.remoteOpenSession' && sessionItem.command.arguments[0] === sessionRows[0], JSON.stringify(sessionItem.command?.command));
  ok('a locked session shows "waiting for background work"', /waiting for background work/.test(String(tree.getTreeItem(sessionRows[1]).description)), String(tree.getTreeItem(sessionRows[1]).description));
  ok('the view publishes the welcome-view context key', contextKeys['spinney.remote.hasRooms'] === true, JSON.stringify(contextKeys));

  const blockedItem = (() => {
    service.kick({ ...PEER });
    const device = tree.getChildren(tree.getChildren()[0])[0];
    return tree.getTreeItem(device);
  })();
  ok('a kicked device is drawn as blocked, with the Unblock context value', blockedItem.contextValue === 'remoteDeviceBlocked' && /blocked/.test(String(blockedItem.description)), String(blockedItem.description));
  service.unblock(PEER.deviceId, PEER.instanceId);
  tree.dispose();

  // ---- 9. teardown ---------------------------------------------------------
  console.log('-- 9. teardown --');
  service.kick({ ...PEER });
  inbound('bye', {}, '0000000000000002');
  await wait(20);
  const afterBye = service.snapshot().rooms[0].peers;
  ok('a blocked peer that left is still listed (Unblock stays reachable)', afterBye.some((p) => p.blocked && !p.live), JSON.stringify(afterBye.map((p) => [p.deviceName, p.blocked, p.live])));
  ok('  … and the room tree can draw it without an instance', (afterBye.find((p) => !p.live)?.instances.length ?? -1) === 0);

  subscription.dispose();
  service.dispose();

  if (problems.length) {
    console.error(`\nFAIL remote-surfaces-acceptance: ${problems.length} check(s) failed:`);
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    process.exit(1);
  }
  console.log(
    '\nPASS remote-surfaces-acceptance: the room tree\'s room→device→instance→session hierarchy and its items, the cmd/result pair ' +
      'with its shared idempotency cache, the refusals (unknown-session/readonly/busy/unsupported), kick as a local blocklist with ' +
      'Unblock, the replica surface\'s attach/mirror/input/cmd/detach across a reconnect, and the frozen 1:1 routing table.',
  );
  process.exit(0);
})().catch((err) => {
  console.error(`FAIL remote-surfaces-acceptance: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
