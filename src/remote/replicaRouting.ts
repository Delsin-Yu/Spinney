/**
 * replicaRouting.ts — **where a replicated session's affordances run**: on your machine, or
 * on the publisher's.
 *
 * This is the frozen 1:1 rule of remote control, written as a decision about message types
 * (`docs/agents/plans/remote-control.md` §3, `remote/PROTOCOL.md` §6):
 *
 *  - anything that acts on the **session**, the working directory or the agent state is
 *    executed by the window that publishes the session (the **publisher**), and a replica
 *    submits it as an `input` frame;
 *  - anything about **reading and interacting with your own device** — the clipboard, the file
 *    picker, opening a link, zoom/pan, card geometry, the local settings page — happens on the
 *    **surface you are operating**, and must never be forwarded. Not because a peer is
 *    untrusted (a token grants full control, §1) but because the *effect* would land on the
 *    wrong machine: clicking a link in a replica has to open the link where you clicked it, and
 *    resizing a card has to resize the card you can see.
 *
 * A replica's webview is the shipped `media/main.js`, so it emits exactly the messages a local
 * tab emits — there is no replica-only message type and there never will be. That makes this
 * table the whole of the difference between the two surfaces, which is why it is data, in one
 * file, and guarded (`tools/remote-surfaces-acceptance.js`):
 *
 *  - a type on {@link REPLICA_LOCAL_MESSAGES} is answered **here** and never forwarded;
 *  - a type on `ACCEPT_FROM_PEER` (`src/remote/allowlist.ts`) is forwarded as an `input`
 *    frame and answered by the publisher;
 *  - anything else is refused — deny by default, exactly like the wire tables. A new webview
 *    message therefore reaches neither side until somebody decides which one it belongs to.
 *
 * The two sets may not overlap: a type that is both "run it locally" and "submit it to the
 * publisher" would have two effects for one click, and the guard fails the build if they do.
 */
import { mayAcceptFromPeer } from './allowlist';

/**
 * Webview→host types a **replica** answers itself.
 *
 * One line each, because the reason is the entry:
 *  - `ready` — the boot handshake of the document that is running *here*. The publisher's
 *    `ready` has long since happened; forwarding ours would repaint the owner's tab.
 *  - `perfDiag` — this surface's own perf report. Reaching the publisher it would feed the
 *    owner's "panel stopped painting" ladder (`ChatViewProvider.ts`) with a peer's counters.
 *  - `layoutDiagnostic` — the same, for the tree layout: our geometry is not the owner's.
 *  - `setNodeSize` — card geometry belongs to the surface you are looking at; the replica
 *    keeps its size in its own DOM and no size is persisted anywhere.
 *  - `copyNodeId` — the clipboard is the machine you are typing on.
 *  - `openExternal` — a link opens where it was clicked; there is deliberately no
 *    "open on the host" toggle.
 *  - `pickImage` — the picker opens on the surface you are operating; the chosen bytes then
 *    travel to the publisher inside `userMessage` as an attachment (§4), which is why nothing
 *    has to be forwarded here.
 *  - `openModelTree` — the model-config editor edits *local* settings and *local* secrets, so
 *    it opens this window's own Model Cards page, not the owner's.
 */
export const REPLICA_LOCAL_MESSAGES: ReadonlySet<string> = new Set<string>([
  'ready',
  'perfDiag',
  'layoutDiagnostic',
  'setNodeSize',
  'copyNodeId',
  'openExternal',
  'pickImage',
  'openModelTree',
]);

/** What a replica does with one webview→host message. */
export type ReplicaRoute =
  /** Answer it on this surface; never forward it. */
  | 'local'
  /** Forward it to the publisher as an `input` frame. */
  | 'forward'
  /** Not classified: drop it with a log line. */
  | 'refuse';

/**
 * Where one webview→host message from a replica's webview belongs.
 *
 * `type` is `unknown` because it comes from a webview (a plain document): a message with no
 * type, or a type that is not a string, is refused rather than guessed at.
 */
export function replicaRoute(type: unknown): ReplicaRoute {
  if (typeof type !== 'string' || !type) {
    return 'refuse';
  }
  if (REPLICA_LOCAL_MESSAGES.has(type)) {
    return 'local';
  }
  return mayAcceptFromPeer(type) ? 'forward' : 'refuse';
}
