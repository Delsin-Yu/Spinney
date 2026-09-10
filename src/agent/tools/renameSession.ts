import type { InterceptedTool } from './index';

/**
 * Rename a session. The harness names sessions automatically (from the
 * conversation); a rename here is explicit, so it locks the title and the
 * automatic namer stops touching it.
 */
export const renameSessionTool: InterceptedTool = {
  requires: 'hop',
  definition: {
    type: 'function',
    function: {
      name: 'rename_session',
      description:
        'Rename a session (the whole conversation, not a node). Use it when the title no longer describes the work. The harness also names sessions automatically from the conversation; an explicit rename locks the title, so automatic naming never overwrites it again. `sessionId` defaults to the active session (other session ids are not discoverable, so normally omit it). Returns the new title.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'The new session title: short (≤ 20 chars), one line, no trailing punctuation.',
          },
          sessionId: {
            type: 'string',
            description: 'Optional session id; defaults to the active session.',
          },
        },
        required: ['title'],
      },
    },
  },
};
