import type { InterceptedTool } from './index';

/**
 * The main agent can spawn sub-agents. Each spec carries a required `write` flag
 * (true ⇒ the sub-agent may write files and run commands; false ⇒ read-only),
 * an `instruction`, and an optional `model`. `mode` is "sync" (block for at most
 * `spinney.commandMaxForegroundDuration` and return all summaries — a batch still
 * running when that limit is reached is handed to the notice path instead) or
 * "async" (return immediately, results delivered as notices).
 */
export const spawnAgentsTool: InterceptedTool = {
  requires: 'spawn',
  definition: {
    type: 'function',
    function: {
      name: 'spawn_agents',
      description:
        'Spawn one or more sub-agents as parallel worker branches. Each agent runs its own conversation with a lean prompt and returns a summary. `agents` is an array of { instruction (the task), write (REQUIRED boolean: true allows the sub-agent to write_file / replace_in_file / exec_command; false is read-only: read_file / list_dir / search_files), model (optional model card — its id or the name the user gave it; only set it when the user explicitly asked you to use another model) }. `mode` is "sync" (default: block for at most the configured spinney.commandMaxForegroundDuration limit, in seconds, and return every summary; if the batch is still running when that limit is reached the call returns the agent ids instead — every summary is then delivered later as one batch notice, so a long batch costs the turn nothing) or "async" (return immediately with the agent ids; the results are delivered as one batch notice when the batch finishes). Every finished sub-agent also gets `stats` (its `toolCalls` / `deniedToolCalls` counts and token usage) and `transcript`: the absolute path of a JSONL dump of its full conversation (line 1 = meta, then one API message per line — read it with read_file when the summary is not enough, e.g. to audit exactly which tools it called).',
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
          mode: { type: 'string', enum: ['sync', 'async'], description: 'sync (default) blocks for at most the configured spinney.commandMaxForegroundDuration limit; if the batch is still running when that limit is reached, the call returns the agent ids and every summary is delivered later as one batch notice — so a long batch costs the turn nothing. async returns immediately and always notifies.' },
        },
        required: ['agents'],
      },
    },
  },
};
