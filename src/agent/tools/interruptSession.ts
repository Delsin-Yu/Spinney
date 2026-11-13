import type { InterceptedTool } from './index';

/**
 * End the live work an agent's prompt started in a session, and nothing else.
 *
 * The scope is a **filter over nodes, not a position in the tree**: a node qualifies
 * when its `lastFrom` names the calling session and it still has a live turn, a
 * background terminal or a running sub-agent. That is why the tool takes no node
 * id, and why it cannot reach a line a human started (`lastFrom` is empty there) or
 * another agent's request.
 *
 * The kill is the same union kill the composer's Stop performs on one line
 * (`SessionRuntime.stopNode`): the turn is cancelled, its background terminals and
 * sub-agents die with it, and pending notices become writebacks, so they reach the
 * model only with its next prompt and nothing continues on its own
 * (`docs/agents/plans/session-prompt-addressing.md` §2.3).
 */
export const interruptSessionTool: InterceptedTool = {
  requires: 'sessions',
  definition: {
    type: 'function',
    function: {
      name: 'interrupt_session',
      description:
        'End the live work in a session that an agent\'s prompt started, and nothing else. It kills every line whose prompt came from this session and which still has a live turn, background terminals or running sub-agents, and reports what died. It is the same union kill the human\'s Stop performs on one line: pending notices are kept for that node\'s next prompt instead of opening a turn, so nothing continues on its own. A line a human started is never in scope, and neither is another agent\'s request. `Nothing of yours to interrupt` is a normal result and names what is still busy. Use it after `wait_for_session_idle` runs out, then send the prompt again; the next prompt on that line resumes the conversation.',
      parameters: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'The id of the session whose agent-started work should be ended (list_sessions lists them).',
          },
        },
        required: ['session_id'],
      },
    },
  },
};
