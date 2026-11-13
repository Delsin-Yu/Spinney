import type { InterceptedTool } from './index';

/**
 * Send a prompt to **a session**, the way a human's message arrives there: one new
 * turn on that session's active node, and the active node becomes the node it
 * created. The node is never named by the caller — a session id is the whole
 * address, because a node id only lives until the next turn and a reply address
 * that has to survive a round trip through another agent cannot be one
 * (`docs/agents/plans/session-prompt-addressing.md` §2).
 *
 * The call blocks until the **turn has started**, never until the answer is: the
 * other session answers by calling this tool itself. A session that is busy is a
 * refusal with a sentence, not a queued message, and `wait_for_session_idle` /
 * `interrupt_session` are the two ways out it names.
 *
 * `max_rounds` is required because two agents answering each other unattended is
 * the one thing this surface must not allow to run away. The allowance travels
 * with the prompt (`spinney.sessionMaxRounds` is the ceiling), the receiver
 * inherits one fewer and can never raise it, and a human message on that line
 * starts a fresh allowance.
 *
 * Orchestrated by the runtime (`SessionRuntime.handleSendSessionPrompt`, which owns
 * the caller node's allowance) and started by the provider
 * (`ChatViewProvider.deliverPrompt`, which owns every session's live state).
 */
export const sendSessionPromptTool: InterceptedTool = {
  requires: 'sessions',
  definition: {
    type: 'function',
    function: {
      name: 'send_session_prompt',
      description:
        'Send `prompt` to a session as a user message, the way a human\'s message arrives there: it starts one new turn on the session\'s active node, and that new node becomes the active node. Name the session with `session_id` (from `create_session` or `list_sessions`); a node id is never needed. It is refused while that node is running a turn or still owns unfinished work (a background terminal, a sub-agent batch, a notice still to be delivered): `wait_for_session_idle` waits for it, `interrupt_session` ends work an agent started, and then you send again. The call returns as soon as the turn has started and never waits for the answer. The answer is the other session calling this tool back, and it arrives as a **new turn on this node**, so END YOUR TURN after sending: a reply is refused while this session is still running one, exactly as it would be refused on the other side. `max_rounds` is required and is how many rounds this exchange may still use, including this one: an integer of at least 1, clamped to `spinney.sessionMaxRounds`. The receiving session inherits one fewer and can never raise it, a human message on that line starts a fresh allowance, and a sender with no allowance left is refused, so report back to your user instead of re-sending.',
      parameters: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'The id of the session to prompt (list_sessions lists them).',
          },
          prompt: {
            type: 'string',
            description: 'The user message that session receives.',
          },
          max_rounds: {
            type: 'integer',
            minimum: 1,
            description:
              'How many rounds this exchange may still use, including this message (>= 1, clamped to `spinney.sessionMaxRounds`). The receiving side inherits one fewer and cannot raise it.',
          },
        },
        required: ['session_id', 'prompt', 'max_rounds'],
      },
    },
  },
};
