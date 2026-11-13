import type { InterceptedTool } from './index';

/**
 * Start a **fresh session** and leave it running.
 *
 * The symmetric half of `send_session_message`: this tool starts a conversation
 * elsewhere, that one talks to it (in either direction). Nothing waits here — the
 * new session's first turn is already running when the call returns, no tab is
 * opened or focused, and this conversation's view does not move — so a caller that
 * wants an answer has to say how to get one: the child calls
 * `send_session_message` with this session's id and node, or the caller reads
 * `list_nodes`.
 *
 * Orchestrated by the provider (`ChatViewProvider.handleCreateSession`): the
 * session is created with the explicit, locking title, its first turn is
 * dispatched headless, and the result names both ids.
 */
export const createSessionTool: InterceptedTool = {
  requires: 'sessions',
  definition: {
    type: 'function',
    function: {
      name: 'create_session',
      description:
        'Start a fresh session and give it its first turn, then return immediately. `session_name` is its title — an explicit name, locked so automatic naming never overwrites it; `session_initial_prompt` becomes its first user message, so it must be self-contained (the new session cannot see this conversation). This call does not wait for the turn, does not open or focus a tab, and does not move this conversation\'s view. Nothing is delivered back to you on its own: tell the new session where to report (it calls send_session_message with your session id and node id), keep the ids the result gives you, and check on it with list_nodes. Use it for a long, self-contained task that benefits from a clean context, or to keep a side task out of this conversation — not for work you can finish here.',
      parameters: {
        type: 'object',
        properties: {
          session_name: {
            type: 'string',
            description:
              'The new session\'s title: short (≤ 20 chars), one line, no trailing punctuation. It is locked, so automatic naming never overwrites it.',
          },
          session_initial_prompt: {
            type: 'string',
            description:
              'The task the new session starts with (its first user message). Self-contained: it cannot see this conversation.',
          },
        },
        required: ['session_name', 'session_initial_prompt'],
      },
    },
  },
};
