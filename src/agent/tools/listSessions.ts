import type { InterceptedTool } from './index';

/**
 * The window's session list, as the agent sees it: one line per session with the
 * ids and counts the other session tools need.
 *
 * Node ids and session ids are otherwise invisible to the model — they live in the
 * persisted tree, not in the prompt — so `send_session_message` (and a node's own
 * `checked out` / `running` facts) would be unusable without this. Orchestrated by
 * the provider, which owns the session list (`ChatViewProvider.handleListSessions`).
 */
export const listSessionsTool: InterceptedTool = {
  requires: 'sessions',
  definition: {
    type: 'function',
    function: {
      name: 'list_sessions',
      description:
        'List the sessions of this window: one line per session with its id, title, node count, the node it has active, how many of its nodes are running a turn right now, whether it is the session this window is focused on, and the title\'s source (locked means automatic naming never overwrites it). Use it to find the session id for send_session_message or list_nodes. `query` filters by id or title substring, case-insensitive.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Optional filter: a substring of a session id or title, case-insensitive.',
          },
        },
        required: [],
      },
    },
  },
};
