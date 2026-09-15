import type { InterceptedTool } from './index';

/**
 * The main agent can spawn sub-agents. Each spec carries a required `write` flag
 * (true ⇒ the sub-agent may write files and run commands; false ⇒ read-only),
 * an `instruction`, and an optional `model`. `mode` is "sync" (block and return
 * all summaries) or "async" (return immediately, results delivered as notices).
 */
export const spawnAgentsTool: InterceptedTool = {
  requires: 'spawn',
  definition: {
    type: 'function',
    function: {
      name: 'spawn_agents',
      description:
        'Spawn one or more sub-agents as parallel worker branches. Each agent runs its own conversation with a lean prompt and returns a summary. `agents` is an array of { instruction (the task), write (REQUIRED boolean: true allows the sub-agent to write_file / replace_in_file / exec_command; false is read-only: read_file / list_dir / search_files), model (optional model card — its id or the name the user gave it; only set it when the user explicitly asked you to use another model) }. `mode` is "sync" (default: block until all finish, return every summary) or "async" (return immediately with the agent ids; results are delivered to you as a notice when each finishes). Every finished sub-agent also gets `stats` (its `toolCalls` / `deniedToolCalls` counts and token usage) and `transcript`: the absolute path of a JSONL dump of its full conversation (line 1 = meta, then one API message per line — read it with read_file when the summary is not enough, e.g. to audit exactly which tools it called).',
      parameters: {
        type: 'object',
        properties: {
          agents: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                instruction: { type: 'string', description: 'The task for this sub-agent.' },
                write: { type: 'boolean', description: 'REQUIRED. true = may write files and run commands; false = read-only.' },
                model: { type: 'string', description: 'Optional different model card (its id, or the name the user gave it — or the model name the provider is asked for). Only set it when the user explicitly asked you to use another model.' },
              },
              required: ['instruction', 'write'],
            },
          },
          mode: { type: 'string', enum: ['sync', 'async'], description: 'sync (default) or async.' },
        },
        required: ['agents'],
      },
    },
  },
};
