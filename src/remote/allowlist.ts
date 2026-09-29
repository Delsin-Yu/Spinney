/**
 * allowlist.ts — the mirror's two deny-by-default tables, in both directions.
 *
 * The publisher mirrors the exact host⇄webview protocol it already speaks
 * (`docs/agents/plans/remote-control.md` §5), so "what may cross the room" is a decision
 * about *message types*, and it is written down here rather than inferred from a switch
 * somewhere: a type crosses only if it is on the list below.
 *
 * WHY deny-by-default and not a denylist: a new message type is the normal way this
 * product grows, and a denylist would ship it to peers on the day it is written — before
 * anyone asked whether it is safe to forward. With these tables, a new type is refused
 * until a person adds it, which is the only moment the question ("does this act on the
 * session, or on the surface it was invoked from?") actually gets asked.
 *
 * The split that decides every entry is the 1:1 rule (§3): anything acting on the
 * **session**, the working directory or the agent state is executed by the publisher and
 * may therefore be mirrored/submitted; anything about **reading and interacting with your
 * own device** — the clipboard, the file picker, opening a link, card geometry, zoom and
 * pan — belongs to the surface you are physically on and must stay there.
 *
 * Every host→webview type of the shipped protocol is now classified: it is either in
 * {@link MIRROR_TO_PEER} or in {@link MIRROR_REFUSED} with its reason.
 * {@link UNRESOLVED_MIRROR_TYPES} is the slot for the next type that arrives undecided —
 * a type parked there is refused (deny-by-default still applies), so leaving it out of the
 * tables is a decision that is visible rather than one that is silently made.
 *
 * The vocabulary is not guessed: `MIRROR_TO_PEER` is seeded from the host→webview types
 * the repo really posts (`src/chat/runtime.ts`, `src/chat/ChatViewProvider.ts`,
 * `src/chat/ChatPanel.ts`), and `ACCEPT_FROM_PEER` from the webview→host types
 * `main.js` really sends plus the cases `ChatViewProvider.onWebviewMessage` handles.
 * The refused-types table below is the same list the wire contract writes out in
 * `remote/PROTOCOL.md` §6.
 */

/**
 * Host→webview message types that may be mirrored to peers.
 *
 * Everything a replica needs to *be* the same session: the tree and its updates, the
 * stream of a running turn, the transcript echoes, and the chrome — including the owner's
 * `config` (the model/effort lists a replica's dropdowns must match) and `balance` (the
 * credit line is part of the session surface). A type that carries the owner's perf/trace
 * instrumentation is deliberately absent — see the exclusion block below.
 *
 * One caveat for whoever wires the mirror: `tree`, `path` and `reset` are posted with
 * `opTag()` (`src/perf.ts`), so their payload carries a `traceId`. The *type* is
 * mirrorable, but the payload is not — `remote/PROTOCOL.md` §6 rules out "anything
 * carrying a perf `traceId`" in the same breath as `probe`/`nudge`. The transport must
 * drop `traceId` (and any other `[perf]` field) while copying a frame into the room, or a
 * replica would answer the owner's own probes with its own counts and pollute the ladder
 * they exist to feed.
 */
export const MIRROR_TO_PEER: ReadonlySet<string> = new Set<string>([
  // Session structure and view focus.
  'state',
  'tree',
  'path',
  'nodeUpdate',
  'agentItems',
  // The answer to a peer's `loadNodeItems`: one node's items, fetched on demand. It is the
  // session's own transcript (the same body a local card gets from `path`), so it acts on
  // the session — a replica that attached to an idle session has nothing else to render.
  'nodeItems',
  'reset',
  // One running turn: text, thinking, tool calls, sub-agents, and its end.
  'delta',
  'thinkingDelta',
  'toolCallDelta',
  'toolStart',
  'toolEnd',
  'usage',
  'done',
  'interrupted',
  'error',
  'agentStart',
  'agentDone',
  // Transcript echoes of things that happened outside the stream.
  'user',
  'notice',
  'harnessNote',
  'backgroundNotice',
  // Chrome: what the composer's neighbourhood shows.
  'context',
  'sessionStats',
  'status',
  'backgrounds',
  // Configuration and the owner's account readout: the replica's dropdowns must offer the
  // same cards/efforts the owner picked from, and the wallet line is part of the surface.
  // `config` carries the owner's prompt snippets too; mirroring it whole is the frozen 1:1
  // rule, and filtering local-only fields out of it would be a later, deliberate change.
  'config',
  'balance',
]);

/**
 * Webview→host message types a remote peer may submit to the publisher.
 *
 * The peer is driving the owner's window, so this list is the *control* surface: send,
 * fork, stop, continue, roll over the context window, move the checkout, kill a
 * sub-agent or a background terminal, delete a branch, ask for a node's transcript (a
 * sub-agent's with `loadAgentItems`, a regular card's with `loadNodeItems`),
 * and pick the model or the thinking effort. A token grants full control (§1) — what is
 * *not* here is not a privilege question but a 1:1-rule question: those messages act on
 * the surface they were invoked from, and a peer is operating its own.
 *
 * Deliberately excluded, one reason each:
 * - `perfDiag` — the surface's own perf report; forwarded, it would feed the publisher's
 *   stall ladder with a peer's counters and can force a repaint of the owner's window.
 * - `layoutDiagnostic` — the same, for the tree layout; a peer's geometry must never
 *   trigger a re-layout decision in the owner's tab.
 * - `setNodeSize` — card geometry is per surface (the replica's cards are not the owner's).
 * - `copyNodeId` — the clipboard belongs to the surface you are on.
 * - `openExternal` — a link opens where it was clicked.
 * - `pickImage` — the file picker opens on the surface you are on; the chosen image
 *   travels as an attachment inside `userMessage` (§4), so no peer ever needs this.
 * - `openModelTree` — the model-config editor is a local settings page, one tab per window.
 * - `ready` — a webview boot handshake, not a command; a peer's replica says its own.
 * - `clear` — not posted by any webview any more, and it deletes the whole session: it
 *   stays out rather than being forwarded for symmetry with the other mutations.
 */
export const ACCEPT_FROM_PEER: ReadonlySet<string> = new Set<string>([
  'userMessage',
  'forkTurn',
  'stop',
  'continueTurn',
  'rolloverTurn',
  'checkout',
  'killAgent',
  'killBackground',
  'deleteBranch',
  'loadAgentItems',
  // A node's items on demand (`nodeItems`): it reads the session's transcript, not the
  // surface's — the peer needs the body of a card it cannot collect from `tree`/`path`.
  'loadNodeItems',
  'setModel',
  'setThinkingEffort',
]);

/** One type left undecided on purpose, with the question that decides it. */
export interface UnresolvedMirrorType {
  /** The host→webview message type. */
  readonly type: string;
  /** The one question a person has to answer to move it into (or permanently out of) `MIRROR_TO_PEER`. */
  readonly question: string;
}

/**
 * Host→webview types that are **left out** of both tables because the answer is not in the
 * 1:1 rule yet. Each one is refused today (deny-by-default), and moving it in is an edit to
 * a table plus the deletion of its row here.
 *
 * Empty on purpose: every type the shipped protocol posts has now been decided, and an
 * empty list is the strongest statement this file can make — there is nothing left that
 * nobody has looked at. The mechanism stays, because the next host message must land here
 * rather than be mirrored by accident.
 */
export const UNRESOLVED_MIRROR_TYPES: readonly UnresolvedMirrorType[] = [];

/**
 * Host→webview types that must **never** be mirrored, with the reason. Kept as data (and
 * not only as a comment) because the wiring layer can assert against it: a type that is
 * neither in {@link MIRROR_TO_PEER}, nor here, nor in {@link UNRESOLVED_MIRROR_TYPES} is a
 * type nobody has classified yet.
 */
export const MIRROR_REFUSED: ReadonlyMap<string, string> = new Map<string, string>([
  ['probe', 'the owner\'s stall watch: a mirrored probe makes a peer answer perfDiag, which feeds the owner\'s ladder'],
  ['nudge', 'a diagnostic repaint: the surface that receives it re-runs its layout, so it stays on the surface that asked'],
  ['imagePicked', 'the local picker\'s result; the attachment travels inside userMessage at send time instead'],
  ['composerClear', 'it clears the composer\'s text box — the box belongs to the surface you are typing on'],
  ['panTo', 'the camera is per surface, exactly like card geometry: a replica pans itself and never follows the owner'],
  ['background', 'the retired pre-P2 background list, which no host path posts any more; mirroring it would be dead weight'],
]);

/** May this host→webview type be mirrored into the room? Deny by default. */
export function mayMirrorToPeer(type: string): boolean {
  return typeof type === 'string' && MIRROR_TO_PEER.has(type);
}

/** May this webview→host type be submitted by a remote peer? Deny by default. */
export function mayAcceptFromPeer(type: string): boolean {
  return typeof type === 'string' && ACCEPT_FROM_PEER.has(type);
}
