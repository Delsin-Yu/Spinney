/**
 * origin.ts — the **remote-origin mark** of a turn, and nothing else.
 *
 * A turn a peer started carries this on its node (`TreeNode.origin`) and in its transcript
 * dump's line-1 meta record (`docs/agents/plans/remote-control.md` §13). It is deliberately
 * **node metadata, never message text**: the bytes sent to the provider must not change, and
 * the model is not told it is being driven from elsewhere.
 *
 * It lives in its own tiny module because two sides of the code need the *type* and must not
 * drag in each other's dependencies to get it: `src/chat/tree.ts` is the pure-data module
 * (it is `require`d by plain node, e.g. `tools/check-remote.js` and the acceptance runs),
 * while `src/remote/remoteService.ts` is a `vscode`-and-`node:crypto` module.
 * `remoteService.ts` re-exports it, so nothing that already imports `RemoteOrigin` from
 * there has to move.
 */
export interface RemoteOrigin {
  /** The transient peer id the frame came from — attribution only, never an identity. */
  readonly peerId: string;
  /** The peer's OS hostname, so a human reading the badge knows which machine it was. */
  readonly deviceName: string;
  /** When the turn was started, in host-epoch ms. */
  readonly at: number;
}
