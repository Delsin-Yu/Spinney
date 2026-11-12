import { TOOL_TITLE_DESCRIPTION } from '../types';
import type { InterceptedTool } from './index';

/**
 * Hand a self-contained task to a **fresh session**, and optionally get its
 * answer back. Orchestrated by the provider: the hop is queued (the current turn
 * has to end first) and a new session runs `prompt` as its first message. That
 * session **decides when it returns**: nothing comes back when a turn ends, and a
 * hand-back happens only when it calls its own `finish_hop` tool — which is what
 * lets the user interrupt or steer it without pulling the caller back. Then the
 * harness resumes the origin with the child's final answer as a user message —
 * unless `mode` is `fire_and_forget`, in which case nothing comes back at all.
 * Only the main agent sees this tool, and only while
 * `spinney.hopSession.enabled` is on.
 */
export const hopSessionTool: InterceptedTool = {
  requires: 'hopSession',
  definition: {
    type: 'function',
    function: {
      name: 'hop_session',
      description:
        'Hand a self-contained task to a **fresh conversation** and get its final answer back. The hop is queued and returns immediately — your current turn ends. A new session is created, `prompt` runs there as its first message, and that session hands its report back **when it calls its own `finish_hop` tool** — not when a turn ends, and not when it is interrupted or stopped, so the user can steer it as long as it takes. This conversation is resumed with the child\'s final reply as a user message (you resume in a new turn), as a new branch off the node you dispatched from (or the node the child names in `finish_hop`). Use it for a long, self-contained job that benefits from a clean context, or to try something in a fresh session without polluting this conversation. The new session cannot see this conversation, so `prompt` must be self-contained. `mode: "fire_and_forget"` skips the return trip entirely: this conversation is never resumed by the hop, so use it only when you do not need the answer here. `returnNodeId` (see `list_nodes`) sets the default branch point the answer comes back to; it is meaningless with `fire_and_forget`. One hop at a time per session; do not use it for work you can finish here.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'The full, self-contained task for the new session (it cannot see this conversation).',
          },
          title: { type: 'string', description: 'Optional short title for the new session; it is also the one-line label the UI shows for this step.' },
          mode: {
            type: 'string',
            enum: ['return_when_finished', 'fire_and_forget'],
            description:
              'Default "return_when_finished": the new session\'s report comes back here as a user message when that session calls `finish_hop` and is idle. "fire_and_forget": the new session runs the task and nothing is delivered back to this conversation.',
          },
          returnNodeId: {
            type: 'string',
            description:
              'Optional node id in THIS session to branch from when the answer comes back (see list_nodes) — the default landing node, which the child\'s `finish_hop` may override. Omit to come back to the node you dispatched from. Not allowed with mode "fire_and_forget".',
          },
        },
        required: ['prompt'],
      },
    },
  },
};
