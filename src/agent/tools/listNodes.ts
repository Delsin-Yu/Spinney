import type { InterceptedTool } from './index';

/**
 * Read-only view of one session's chat tree. Node ids are for **reading**: no tool
 * takes one as an address any more, so they live in the persisted tree and in this
 * render, nowhere else.
 *
 * Rewritten for the session tools: it takes `session_id` (default: the caller's own
 * session, see `list_sessions`) and `query`, and every node line carries its **true**
 * state, read from that session's live runtime rather than from a stored status
 * field — `running`, `busy` (unfinished work) and, for the window's focused session,
 * `checked out`. Rendered by `SessionRuntime.handleListNodes`.
 */
export const listNodesTool: InterceptedTool = {
  requires: 'sessions',
  definition: {
    type: 'function',
    function: {
      name: 'list_nodes',
      description:
        'List one session\'s chat tree: one indented line per node with its id, its state and its title. The state is live, not stored: `running` means a turn is streaming there now, `busy` means the node still owns unfinished work (a background terminal, a sub-agent batch or a queued completion notice) and refuses a send, and `checked out` marks the node the session\'s view focuses — only for the session this window is focused on. Defaults to this conversation; `session_id` reads another one (list_sessions gives the ids), so a message can be addressed to a node of any session. `query` filters by id or title substring, case-insensitive.',
      parameters: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'Optional session id; defaults to the session this agent runs in.',
          },
          query: {
            type: 'string',
            description: 'Optional filter: a substring of a node id or title, case-insensitive.',
          },
        },
        required: [],
      },
    },
  },
};
