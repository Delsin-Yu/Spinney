import type { InterceptedTool } from './index';

/**
 * Wait for a session to be able to take a prompt.
 *
 * Shaped like `wait_for_command` (`src/tools/backgroundTools.ts`): a **slice, not a
 * timeout**. It returns the moment the session's active node is free, and a normal
 * result (never an `Error:`) when the window runs out, because "still busy" is an
 * answer the caller acts on, not a failure.
 *
 * It waits on **the same predicate `send_session_prompt` checks** — no live turn on
 * the node a prompt would land on, and no unfinished work it still owns — so `idle`
 * means the prompt will be accepted, and nothing else does.
 */
export const waitForSessionIdleTool: InterceptedTool = {
  requires: 'sessions',
  definition: {
    type: 'function',
    function: {
      name: 'wait_for_session_idle',
      description:
        'Wait for a session to be able to take a prompt, up to `seconds` (default 30, clamped to 1-300), and return as soon as it can. `idle` means `send_session_prompt` will be accepted for that session; that is the same check the prompt itself makes, so nothing else counts as idle. When the window runs out the result is normal, never an error: it names the node that is holding the line, whether it is running a turn or still owns a background terminal / sub-agent, and how long it has been busy, so the next step is wait again, `interrupt_session`, or report back to your user. Respects Stop.',
      parameters: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'The id of the session to wait for (list_sessions lists them).',
          },
          seconds: {
            type: 'integer',
            minimum: 1,
            maximum: 300,
            description: 'How long to wait, in seconds (default 30, clamped to 1-300).',
          },
        },
        required: ['session_id'],
      },
    },
  },
};
