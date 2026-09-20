import * as fs from 'fs';
import * as vscode from 'vscode';
import { AgentTool } from '../agent/types';
import type { BackgroundAccess } from '../chat/backgroundHub';
import { formatDuration } from '../duration';
import { CommandHandle, OUTPUT_CAP, spawnShellCommand } from './background';
import { getAgentRoot, limitInline, resolvePath } from './index';
import { getShell } from './shell';

/** Fallback when `spinney.commandTimeout` is absent or not a positive number. */
const DEFAULT_COMMAND_TIMEOUT_SEC = 600;

/**
 * The effective default timeout for `exec_command`, read live so a settings
 * change applies to the next command instead of needing a window reload. A tool
 * call that passes an explicit `timeout` always wins over this.
 */
function defaultCommandTimeoutSec(): number {
  const configured = vscode.workspace.getConfiguration('spinney').get<number>('commandTimeout');
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_COMMAND_TIMEOUT_SEC;
}

/**
 * The working directory is handed to the shell, so a path that does not exist
 * makes the *spawn* fail: Node reports `spawn <shell.exe> ENOENT`, naming the
 * shell binary and hiding the real cause. The model reads that as "the shell is
 * missing", stops using the `cwd` argument and defends itself with a `cd … && …`
 * prefix on every command instead. Fail before spawning, and name the path.
 */
function assertUsableCwd(cwd: string, requested: string | null): void {
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(cwd);
  } catch {
    stat = null;
  }
  if (stat?.isDirectory()) {
    return;
  }
  const resolved = requested && requested !== cwd ? `"${requested}" → ${cwd}` : cwd;
  throw new Error(
    `the working directory ${resolved} ${stat ? 'is not a directory' : 'does not exist'}. ` +
      `Pass cwd relative to the harness root (${getAgentRoot()}), or omit cwd to run in the root.`,
  );
}

/**
 * Run a command in the foreground and resolve with a human-readable result
 * (mirroring the original exec_command contract). When `moveOnTimeout` is set
 * and the command is still running at `timeoutMs`, it is promoted to a background
 * terminal via `promote` (which registers it with the hub under its owning node)
 * instead of being killed, and the resolved message tells the agent the
 * background id to manage it with.
 *
 * Every result leads with an elapsed-time line (`[exit 0 in 3.4s · cwd …]`, ...)
 * computed from `startedAt` (captured just before the process was spawned). It is
 * always the FIRST line so it survives `limitInline`'s spill, whose preview keeps
 * only the first 8 lines of a long result. That line also names the directory the
 * command ran in: every command starts in the harness root, and a model that can
 * see it does not prefix the same `cd … && …` to every command.
 */
function runForeground(
  handle: CommandHandle,
  command: string,
  startedAt: number,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  moveOnTimeout: boolean,
  promote: (() => number) | null,
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
      const dur = formatDuration(Date.now() - startedAt);
      const at = ` · cwd ${cwd}`;
      let msg: string;
      if (reason === 'aborted') {
        msg = `[command was interrupted after ${dur}${at}]`;
      } else if (reason === 'start') {
        // The cwd was checked before the spawn, so what is left is the shell
        // itself: name both, or the message points at neither.
        msg = `[command failed to start after ${dur}: ${message ?? 'unknown error'} (shell ${getShell().file})${at}]\n${out}`.trim();
      } else if (reason === 'timeout') {
        msg = `[command timed out after ${timeoutMs} ms (ran ${dur})${at}]\n${out}`.trim();
      } else if (handle.isTruncated()) {
        msg = `[command output exceeded ${OUTPUT_CAP} bytes; truncated after ${dur}${at}]\n${out}`.trim();
      } else if (code !== 0) {
        msg = `[command exited with code ${code ?? 'unknown'} in ${dur}${at}]\n${out}`.trim();
      } else {
        // The elapsed line stays even on success with no output, so the agent can
        // always tell how long a command took and where it ran.
        msg = `[exit 0 in ${dur}${at}]\n${out || '(command completed with no output)'}`;
      }
      resolve(msg);
    };

    handle.child.on('error', (err) => finish('start', null, err.message));
    handle.child.on('close', (code) => finish('close', code));

    timer = setTimeout(() => {
      if (settled) return;
      if (moveOnTimeout && promote) {
        settled = true;
        cleanup();
        const id = promote();
        // How long it ran in the foreground before the promotion (i.e. ~timeoutMs,
        // plus time the shell took to report the promotion), useful when deciding
        // whether to keep waiting on it via join_background.
        const dur = formatDuration(Date.now() - startedAt);
        const soFar = handle.getOutput().trim();
        const out = soFar ? `\nOutput so far:\n${soFar}` : '';
        resolve(
          `[command moved to background: id ${id}]\n` +
          `Command: ${command}\n` +
          `Working directory: ${cwd}\n` +
          `Ran ${dur} in the foreground before it was promoted.\n` +
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

export function makeExecCommandTool(getAccess: () => BackgroundAccess | null): AgentTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'exec_command',
        description:
          'Run a shell command and return its combined stdout/stderr; the first line of the result names the directory the command ran in. Use for builds, tests, git, npm, etc. Every command starts in the harness root (the workspace folder, or the harness scratch folder when no folder is open), which is the default cwd — pass cwd (relative to the harness root, or an absolute path) to run somewhere else, instead of prefixing the command with "cd <dir> && ". Never put the command in the background yourself ("&", "nohup", "disown", "Start-Process"): a process the harness did not spawn cannot be tracked, joined or stopped — use timeout_behavior for work that must outlive the call. Set timeout (seconds; defaults to the spinney.commandTimeout setting, which is 600 = 10 minutes unless changed). timeout_behavior controls what happens when a command runs past timeout: "stop" (default) kills it, "move_to_background" promotes the still-running command to a background terminal (returns its id), and "start_in_background" launches it in the background immediately (returns its id and does not wait). Commands run through the detected shell (currently ' +
          getShell().label +
          ') and in that shell syntax (bash-style for bash/sh, PowerShell syntax otherwise).',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The shell command to run.' },
            cwd: {
              type: 'string',
              description:
                'Working directory: relative to the harness root, or an absolute path. Omit it to run in the harness root.',
            },
            timeout: {
              type: 'number',
              description: 'Timeout in seconds (defaults to spinney.commandTimeout, 600 = 10 minutes unless changed).',
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
      const cwdArg = args.cwd ? String(args.cwd) : null;
      const cwd = cwdArg ? resolvePath(cwdArg) : getAgentRoot();
      assertUsableCwd(cwd, cwdArg);
      const timeoutSec = typeof args.timeout === 'number' ? args.timeout : defaultCommandTimeoutSec();
      const timeoutMs = timeoutSec * 1000;
      const behavior = String(args.timeout_behavior ?? 'stop');
      if (behavior !== 'stop' && behavior !== 'move_to_background' && behavior !== 'start_in_background') {
        throw new Error(
          `Invalid timeout_behavior "${behavior}". Use "stop", "move_to_background", or "start_in_background".`,
        );
      }
      const access = getAccess();
      const owner = access?.currentOwner() ?? null;
      const wantsBackground = behavior === 'move_to_background' || behavior === 'start_in_background';
      if (wantsBackground && !(access && owner)) {
        throw new Error('Background terminals are not available in this session.');
      }
      const startedAt = Date.now();
      const handle = spawnShellCommand(command, cwd, { killOnTruncate: behavior === 'stop' });
      // A promoted job is registered under the node whose turn spawned it, so it
      // renders in that node's dock and its completion notice returns to that
      // branch even if the user has moved the view elsewhere meanwhile.
      const promote = access && owner ? () => access.hub.register(owner, handle, command, cwd) : null;

      if (behavior === 'start_in_background') {
        const id = promote!();
        return (
          `[command started in background: id ${id}]\n` +
          `Command: ${command}\n` +
          `Working directory: ${cwd}\n` +
          `Use check_background_terminal(${id}), join_background(${id}), or kill_background(${id}) to manage it.`
        );
      }

      return limitInline(
        await runForeground(
          handle,
          command,
          startedAt,
          cwd,
          timeoutMs,
          signal,
          behavior === 'move_to_background',
          promote,
        ),
        'exec_command',
      );
    },
  };
}
