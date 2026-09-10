import type { InterceptedTool } from './index';

/**
 * Read-only variant of `send_agent_message` (exposed to a read-only depth-1
 * sub-agent instead of it): resumes one of its own finished read-only children.
 * There is no `write` override, and `Agent.executeToolCall` pins `write:false`
 * anyway, so a read-only parent cannot escalate a child.
 */
export const sendReadonlyAgentMessageTool: InterceptedTool = {
  requires: 'spawnReadOnly',
  definition: {
    type: 'function',
    function: {
      name: 'send_readonly_agent_message',
      description:
        'Send a follow-up message to a previously spawned (now finished) read-only sub-agent so it resumes and continues its task, then return the result. `id` is the agent node id from a prior spawn_readonly_agents result; only a sub-agent **you** spawned can be messaged. There is no `write` override — the resumed run stays read-only. `model` (optional) overrides the model. `mode` is "sync" (default: block and return the result) or "async" (return immediately with the id; the result is delivered as a notice). The result carries `stats` and `transcript`: the path of that sub-agent\'s JSONL conversation dump, rewritten with the follow-up included.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The agent node id from a prior spawn_readonly_agents result.' },
          message: { type: 'string', description: 'The follow-up instruction for this sub-agent.' },
          model: { type: 'string', description: 'Optional different model id. Only set it when the user explicitly asked you to use another model.' },
          mode: { type: 'string', enum: ['sync', 'async'], description: 'sync (default) or async.' },
        },
        required: ['id', 'message'],
      },
    },
  },
};
