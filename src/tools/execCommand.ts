import * as vscode from 'vscode';
import { AgentTool } from '../agent/types';
import { BackgroundRegistry, CommandHandle, OUTPUT_CAP, spawnShellCommand } from './background';
import { getAgentRoot, limitInline, resolvePath } from './index';
import { getShell } from './shell';

/** Fallback when `agentHarness.commandTimeout` is absent or not a positive number. */
const DEFAULT_COMMAND_TIMEOUT_SEC = 600;

/**
 * The effective default timeout for `exec_command`, read live so a settings
 * change applies to the next command instead of needing a window reload. A tool
 * call that passes an explicit `timeout` always wins over this.
 */
function defaultCommandTimeoutSec(): number {
  const configured = vscode.workspace.getConfiguration('agentHarness').get<number>('commandTimeout');
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_COMMAND_TIMEOUT_SEC;
}

/**
 * Run a command in the foreground and resolve with a human-readable result
 * (mirroring the original exec_command contract). When `moveOnTimeout` is set
 * and the command is still running at `timeoutMs`, it is promoted to a
 * background terminal (registered in `registry`) instead of being killed, and
 * the resolved message tells the agent the background id to manage it with.
 */
function runForeground(
  handle: CommandHandle,
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  moveOnTimeout: boolean,
  registry: BackgroundRegistry | null,
): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (abortHandler && signal) signal.removeEventListener('abort', abortHandler);
    };

    const finish = (
      reason: 'close' | 'start' | 'timeout' | 'aborted',
      code?: number | null,
      message?: string,
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      const out = handle.getOutput().trim();
      let msg: string;
      if (reason === 'aborted') {
        msg = '[command was interrupted]';
      } else if (reason === 'start') {
        msg = `[command failed to start: ${message ?? 'unknown error'}]\n${out}`.trim();
      } else if (reason === 'timeout') {
        msg = `[command timed out after ${timeoutMs} ms]\n${out}`.trim();
      } else if (handle.isTruncated()) {
        msg = `[command output exceeded ${OUTPUT_CAP} bytes; truncated]\n${out}`.trim();
      } else if (code !== 0) {
        msg = `[command exited with code ${code ?? 'unknown'}]\n${out}`.trim();
      } else {
        msg = out || '(command completed with no output)';
      }
      resolve(msg);
    };

    handle.child.on('error', (err) => finish('start', null, err.message));
    handle.child.on('close', (code) => finish('close', code));

    timer = setTimeout(() => {
      if (settled) return;
      if (moveOnTimeout && registry) {
        settled = true;
        cleanup();
        const id = registry.register(handle, command, cwd);
        const soFar = handle.getOutput().trim();
        const out = soFar ? `\nOutput so far:\n${soFar}` : '';
        resolve(
          `[command moved to background: id ${id}]\n` +
          `Command: ${command}\n` +
          `Working directory: ${cwd}\n` +
          `Use check_background_terminal(${id}), join_background(${id}), or kill_background(${id}) to manage it.${out}`,
        );
        return;
      }
      handle.kill();
      finish('timeout');
    }, timeoutMs);

    if (signal) {
      abortHandler = () => {
        handle.kill();
        finish('aborted');
      };
      if (signal.aborted) {
        abortHandler();
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }
  });
}

export function makeExecCommandTool(getRegistry: () => BackgroundRegistry | null): AgentTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'exec_command',
        description:
          'Run a shell command in the harness root (the workspace folder, or the harness scratch folder when no folder is open) and return its combined stdout/stderr. Use for builds, tests, git, npm, etc. Optionally set cwd relative to the harness root. Set timeout (seconds; defaults to the agentHarness.commandTimeout setting, which is 600 = 10 minutes unless changed). timeout_behavior controls what happens when a command runs past timeout: "stop" (default) kills it, "move_to_background" promotes the still-running command to a background terminal (returns its id), and "start_in_background" launches it in the background immediately (returns its id and does not wait). Commands run through the detected shell (currently ' +
          getShell().label +
          ') and in that shell syntax (bash-style for Git Bash, PowerShell syntax otherwise).',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The shell command to run.' },
            cwd: { type: 'string', description: 'Working directory, relative to the harness root.' },
            timeout: {
              type: 'number',
              description: 'Timeout in seconds (defaults to agentHarness.commandTimeout, 600 = 10 minutes unless changed).',
            },
            timeout_behavior: {
              type: 'string',
              enum: ['stop', 'move_to_background', 'start_in_background'],
              description:
                'What to do on timeout: "stop" (kill, default), "move_to_background", or "start_in_background".',
            },
          },
          required: ['command'],
        },
      },
    },
    async execute(args, signal) {
      const command = String(args.command ?? '');
      if (!command) {
        throw new Error('exec_command requires a non-empty "command" string.');
      }
      const cwd = args.cwd ? resolvePath(String(args.cwd)) : getAgentRoot();
      const timeoutSec = typeof args.timeout === 'number' ? args.timeout : defaultCommandTimeoutSec();
      const timeoutMs = timeoutSec * 1000;
      const behavior = String(args.timeout_behavior ?? 'stop');
      if (behavior !== 'stop' && behavior !== 'move_to_background' && behavior !== 'start_in_background') {
        throw new Error(
          `Invalid timeout_behavior "${behavior}". Use "stop", "move_to_background", or "start_in_background".`,
        );
      }
      const registry = getRegistry();
      if ((behavior === 'move_to_background' || behavior === 'start_in_background') && !registry) {
        throw new Error('Background terminals are not available in this session.');
      }
      const handle = spawnShellCommand(command, cwd, { killOnTruncate: behavior === 'stop' });

      if (behavior === 'start_in_background') {
        const id = registry!.register(handle, command, cwd);
        return (
          `[command started in background: id ${id}]\n` +
          `Command: ${command}\n` +
          `Working directory: ${cwd}\n` +
          `Use check_background_terminal(${id}), join_background(${id}), or kill_background(${id}) to manage it.`
        );
      }

      return limitInline(
        await runForeground(handle, command, cwd, timeoutMs, signal, behavior === 'move_to_background', registry),
        'exec_command',
      );
    },
  };
}
