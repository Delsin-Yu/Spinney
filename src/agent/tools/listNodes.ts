import type { InterceptedTool } from './index';

/**
 * Read-only view of the active session's chat tree, so the agent can name a
 * node (e.g. as `hop_session`'s `returnNodeId`) instead of guessing. Node ids
 * are otherwise invisible to the model: they live in the persisted tree, not in
 * the prompt.
 */
export const listNodesTool: InterceptedTool = {
  requires: 'hop',
  definition: {
    type: 'function',
    function: {
      name: 'list_nodes',
      description:
        'List the chat tree of the active session: one line per node with its id, status, parent and title, plus which node is currently checked out. Use it to pick a `returnNodeId` for hop_session, or to understand how the conversation branched.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
};
