import type { InterceptedTool } from './index';

/**
 * Hand a self-contained task to a **fresh session** and get its answer back.
 * Orchestrated by the provider: the hop is queued (the current turn has to end
 * first), a new session runs `prompt` as its first message, and when that turn
 * finishes the harness switches back here and delivers the new session's final
 * answer as a user message. Only the main agent sees this tool.
 */
export const hopSessionTool: InterceptedTool = {
  requires: 'hop',
  definition: {
    type: 'function',
    function: {
      name: 'hop_session',
      description:
        'Hand a self-contained task to a **fresh conversation** and get its final answer back. The hop is queued and returns immediately — your current turn ends. A new session is created, `prompt` runs there as its first message, and when that turn finishes the harness switches back to this session and delivers the new session\'s final answer to you as a user message (you resume in a new turn). Use it for a long, self-contained job that benefits from a clean context, or to try something in a fresh session without polluting this conversation. The new session cannot see this conversation, so `prompt` must be self-contained. `returnNodeId` (see `list_nodes`) makes the answer come back as a **new branch** off that node instead of continuing the checked-out node — use it to keep the result out of the current line of conversation. One hop at a time; do not use it for work you can finish here.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'The full, self-contained task for the new session (it cannot see this conversation).',
          },
          title: { type: 'string', description: 'Optional short title for the new session.' },
          returnNodeId: {
            type: 'string',
            description:
              'Optional node id in THIS session to branch from when the answer comes back (see list_nodes). Omit to continue the checked-out node.',
          },
        },
        required: ['prompt'],
      },
    },
  },
};
