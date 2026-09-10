import type { InterceptedTool } from './index';

/**
 * Read-only sub-agents may not call `spawn_agents` (a child could be created with
 * `write:true`, bypassing their own restriction), so they get this variant
 * instead: same orchestration, but the `write` flag does not exist — every child
 * is read-only by construction. `Agent.executeToolCall` additionally forces
 * `write:false` on each spec, so stuffing a `write` key into the arguments cannot
 * escalate either.
 */
export const spawnReadonlyAgentsTool: InterceptedTool = {
  requires: 'spawnReadOnly',
  definition: {
    type: 'function',
    function: {
      name: 'spawn_readonly_agents',
      description:
        'Spawn one or more **read-only** sub-agents as parallel worker branches (they can read_file / list_dir / search_files but cannot write files or run commands). `agents` is an array of { instruction (the task), model (optional; only set a different model when the user explicitly asked you to) }. `mode` is "sync" (default: block until all finish, return every summary) or "async" (return immediately with the agent ids; results are delivered to you as a notice when each finishes). Every finished sub-agent also gets `stats` (its `toolCalls` / `deniedToolCalls` counts and token usage) and `transcript`: the absolute path of a JSONL dump of its full conversation.',
      parameters: {
        type: 'object',
        properties: {
          agents: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                instruction: { type: 'string', description: 'The task for this sub-agent.' },
                model: { type: 'string', description: 'Optional different model id. Only set it when the user explicitly asked you to use another model.' },
              },
              required: ['instruction'],
            },
          },
          mode: { type: 'string', enum: ['sync', 'async'], description: 'sync (default) or async.' },
        },
        required: ['agents'],
      },
    },
  },
};
