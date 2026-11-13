import type { InterceptedTool } from './index';

/**
 * Deliver a message to **one node of one session** and start a turn there.
 *
 * This is the one channel between conversations, and it works in both directions:
 * a child session reports back with its caller's ids, a caller sends a follow-up
 * into a node it created earlier, and a node of this same session is a valid
 * target too. The target is named exactly — never "the active session" — so the
 * message can never land in whatever tab happens to have focus.
 *
 * Orchestrated by the provider (`ChatViewProvider.handleSendSessionMessage`): the
 * refusal while the target node is running or still owns unfinished work is the
 * provider's, because only it can read that session's live state.
 */
export const sendSessionMessageTool: InterceptedTool = {
  requires: 'sessions',
  definition: {
    type: 'function',
    function: {
      name: 'send_session_message',
      description:
        'Send `prompt` to one node of one session as a user message and start a turn there. This is how conversations talk to each other: a session started by create_session reports back by naming its caller\'s session id and node id, and you answer it the same way. `session_id` and `session_node_id` must name both exactly (list_sessions gives the session ids, list_nodes its node ids); `prompt` is the message the target receives. It is refused while that node is running a turn or still owns unfinished work (a background terminal, a sub-agent batch, a queued completion notice), so read list_sessions / list_nodes first when the target may be busy, and send again when it is idle. The message arrives as a new branch off the named node; this call does not wait for the target\'s answer.',
      parameters: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'The id of the session that owns the target node (list_sessions lists them).',
          },
          session_node_id: {
            type: 'string',
            description:
              'The id of the node the message branches off (list_nodes session_id=<session_id> lists them).',
          },
          prompt: {
            type: 'string',
            description: 'The user message the target receives and answers.',
          },
        },
        required: ['session_id', 'session_node_id', 'prompt'],
      },
    },
  },
};
