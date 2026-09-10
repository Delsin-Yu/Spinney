import type { InterceptedTool } from './index';

/**
 * The main agent (or a depth-1 sub-agent) can message an already-finished
 * sub-agent to make it continue: `send_agent_message` appends a follow-up
 * instruction to that sub-agent's own history and re-runs it. `id` is the agent
 * node id returned by a previous `spawn_agents`. `write`/`model` optionally
 * override the run's permission/model (model only for one the user explicitly
 * asked for). `mode` is "sync" (default: block and return the result) or
 * "async" (return immediately; the result is delivered as a notice).
 */
export const sendAgentMessageTool: InterceptedTool = {
  requires: 'spawn',
  definition: {
    type: 'function',
    function: {
      name: 'send_agent_message',
      description:
        'Send a follow-up message to a previously spawned (now finished) sub-agent so it resumes and continues its task, then return the result. `id` is the agent node id from a prior spawn_agents result. `message` is the follow-up instruction. `write` (optional) overrides this run\'s write permission (defaults to the sub-agent\'s original). `model` (optional) overrides the model — only set it when the user explicitly asked for a different model. `mode` is "sync" (default: block and return the result) or "async" (return immediately with the id; the result is delivered as a notice). The result carries `stats` (updated `toolCalls` / `deniedToolCalls` counts) and `transcript`: the path of that sub-agent\'s JSONL conversation dump, rewritten with the follow-up included.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'The agent node id from a prior spawn_agents result.',
          },
          message: {
            type: 'string',
            description: 'The follow-up instruction for the sub-agent.',
          },
          write: {
            type: 'boolean',
            description: 'Optional. Override this run\'s write permission.',
          },
          model: {
            type: 'string',
            description: "Optional. Override the model. Only set it when the user explicitly asked for a different model.",
          },
          mode: {
            type: 'string',
            enum: ['sync', 'async'],
            description: 'sync (default) or async.',
          },
        },
        required: ['id', 'message'],
      },
    },
  },
};
