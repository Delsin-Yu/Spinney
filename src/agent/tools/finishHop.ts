import type { InterceptedTool } from './index';
import { TOOL_TITLE_DESCRIPTION } from '../types';

/**
 * The **hopped-to** session decides when it returns.
 *
 * A session that a `return_when_finished` hop started sees this tool, and nothing
 * returns to the origin until it calls it: a turn end, an interrupt or a Stop
 * before the call leaves the hop armed and the caller waiting. The call is the
 * hand-back — the child's own report, at the moment the child says the work is
 * done — which is what makes a hopped session steerable at all.
 *
 * Orchestrated by the provider: the call is delegated through
 * `Agent.setFinishHopHandler` to `ChatViewProvider.handleFinishHop`, which marks
 * the hop and stores the landing node. A session that was not started by such a
 * hop (a sub-agent, a `fire_and_forget` child, anyone else) never sees the tool,
 * and a call that reaches it anyway is refused by the same handler.
 */
export const finishHopTool: InterceptedTool = {
  requires: 'finishHop',
  definition: {
    type: 'function',
    function: {
      name: 'finish_hop',
      description:
        'Hand this session\'s report back to the conversation that dispatched it. This session was started by a hop, and **nothing returns to the caller on its own**: your turn ending, an interrupt and a Stop all leave the caller waiting, so the user may steer you as long as you like. Call this when the work is complete — your final reply of this turn is then delivered to the source session as a message to its agent, and this session stops being able to hand anything back. Put everything the caller needs in that reply.',
      parameters: {
        type: 'object',
        properties: {
          source_session_node_id: {
            type: 'string',
            description:
              'Optional node id of the **source** session the report lands on, as a new branch. Omit it to land where the task was dispatched from. search_transcripts with the source session id lists that conversation\'s nodes.',
          },
          title: { type: 'string', description: TOOL_TITLE_DESCRIPTION },
        },
        required: [],
      },
    },
  },
};
