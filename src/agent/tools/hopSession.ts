import type { InterceptedTool } from './index';

/**
 * Hand a self-contained task to a **fresh session**, and optionally get its
 * answer back. Orchestrated by the provider: the hop is queued (the current turn
 * has to end first), a new session runs `prompt` as its first message, and when
 * that turn finishes the harness resumes the origin with the new session's final
 * answer as a user message — unless `mode` is `fire_and_forget`, in which case
 * nothing comes back. Only the main agent sees this tool, and only while
 * `spinney.hopSession.enabled` is on.
 */
export const hopSessionTool: InterceptedTool = {
  requires: 'hopSession',
  definition: {
    type: 'function',
    function: {
      name: 'hop_session',
      description:
        'Hand a self-contained task to a **fresh conversation** and get its final answer back. The hop is queued and returns immediately — your current turn ends. A new session is created, `prompt` runs there as its first message, and when that turn finishes the harness switches back to this session and delivers the new session\'s final answer to you as a user message (you resume in a new turn), as a new branch off the node you dispatched from. Use it for a long, self-contained job that benefits from a clean context, or to try something in a fresh session without polluting this conversation. The new session cannot see this conversation, so `prompt` must be self-contained. `mode: "fire_and_forget"` skips the return trip entirely: this conversation is never resumed by the hop, so use it only when you do not need the answer here. `returnNodeId` (see `list_nodes`) overrides the branch point the answer comes back to; it is meaningless with `fire_and_forget`. One hop at a time per session; do not use it for work you can finish here.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'The full, self-contained task for the new session (it cannot see this conversation).',
          },
          title: { type: 'string', description: 'Optional short title for the new session.' },
          mode: {
            type: 'string',
            enum: ['return_when_finished', 'fire_and_forget'],
            description:
              'Default "return_when_finished": the new session\'s final answer comes back here as a user message when its turn finishes. "fire_and_forget": the new session runs the task and nothing is delivered back to this conversation.',
          },
          returnNodeId: {
            type: 'string',
            description:
              'Optional node id in THIS session to branch from when the answer comes back (see list_nodes). Omit to come back to the node you dispatched from. Not allowed with mode "fire_and_forget".',
          },
        },
        required: ['prompt'],
      },
    },
  },
};
