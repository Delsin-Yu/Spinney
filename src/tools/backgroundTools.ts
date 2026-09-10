import { AgentTool } from '../agent/types';
import { BackgroundRegistry } from './background';
import { limitInline } from './index';

export function makeCheckBackgroundTool(getRegistry: () => BackgroundRegistry | null): AgentTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'check_background_terminal',
        description:
          'Check the status of a background terminal started by exec_command (timeout_behavior = move_to_background / start_in_background). Returns whether it is running or finished, its exit code (when finished), and the output accumulated so far.',
        parameters: {
          type: 'object',
          properties: {
            pid: { type: 'number', description: 'The background terminal id returned by exec_command.' },
          },
          required: ['pid'],
        },
      },
    },
    async execute(args, signal) {
      const registry = getRegistry();
      if (!registry) {
        return 'Error: background terminals are not available in this session.';
      }
      const id = Number(args.pid);
      if (!Number.isFinite(id)) {
        return 'Error: check_background_terminal requires a numeric pid.';
      }
      const task = registry.get(id);
      if (!task) {
        return `Error: no background terminal with id ${id}.`;
      }
      const elapsed = Math.round((Date.now() - task.startedAt) / 1000);
      const out = task.handle.getOutput().trim();
      const statusLine = task.killed
        ? `Background terminal ${id} was killed. (command: ${task.command})`
        : task.status === 'running'
          ? `Background terminal ${id} is running. (command: ${task.command}, ${elapsed}s elapsed)`
          : `Background terminal ${id} finished with exit code ${task.exitCode ?? 'unknown'}.`;
      const outLine = out ? `\nOutput:\n${out}` : '';
      return limitInline(`${statusLine}${outLine}`, 'check_background_terminal');
    },
  };
}

export function makeKillBackgroundTool(getRegistry: () => BackgroundRegistry | null): AgentTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'kill_background',
        description:
          'Kill a background terminal identified by its pid (returned by exec_command). The process tree is torn down. Returns a short confirmation. Use when a long-running command no longer needs to keep running.',
        parameters: {
          type: 'object',
          properties: {
            pid: { type: 'number', description: 'The background terminal id returned by exec_command.' },
          },
          required: ['pid'],
        },
      },
    },
    async execute(args, signal) {
      const registry = getRegistry();
      if (!registry) {
        return 'Error: background terminals are not available in this session.';
      }
      const id = Number(args.pid);
      if (!Number.isFinite(id)) {
        return 'Error: kill_background requires a numeric pid.';
      }
      const task = registry.get(id);
      if (!task) {
        return `Error: no background terminal with id ${id}.`;
      }
      if (task.status !== 'running') {
        return `Background terminal ${id} is not running (exit code ${task.exitCode ?? 'unknown'}).`;
      }
      registry.kill(id, { notifyAgent: false });
      return `Killed background terminal ${id} (command: ${task.command}).`;
    },
  };
}

export function makeJoinBackgroundTool(getRegistry: () => BackgroundRegistry | null): AgentTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'join_background',
        description:
          'Block until a background terminal (by pid) finishes, then return its final exit code and full accumulated output. Respects Stop. Use to wait for a command you moved to the background and collect its result.',
        parameters: {
          type: 'object',
          properties: {
            pid: { type: 'number', description: 'The background terminal id returned by exec_command.' },
          },
          required: ['pid'],
        },
      },
    },
    async execute(args, signal) {
      const registry = getRegistry();
      if (!registry) {
        return 'Error: background terminals are not available in this session.';
      }
      const id = Number(args.pid);
      if (!Number.isFinite(id)) {
        return 'Error: join_background requires a numeric pid.';
      }
      const task = registry.get(id);
      if (!task) {
        return `Error: no background terminal with id ${id}.`;
      }
      // Suppress the separate completion notification: the join result (or an
      // interruption) tells the agent. On interruption re-enable it so a later
      // natural finish still notifies.
      task.notifyAgent = false;
      try {
        await registry.waitFor(id, signal);
      } catch (err) {
        task.notifyAgent = true;
        if (signal?.aborted) {
          return '[command join was interrupted]';
        }
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
      const done = registry.get(id)!;
      const out = done.handle.getOutput().trim();
      const resultLine = done.killed
        ? `Background terminal ${id} was killed.`
        : `Background terminal ${id} finished with exit code ${done.exitCode ?? 'unknown'}.`;
      return limitInline(`${resultLine}${out ? `\nOutput:\n${out}` : ''}`, 'join_background');
    },
  };
}
