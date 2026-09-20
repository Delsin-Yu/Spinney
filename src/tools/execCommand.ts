import * as fs from 'fs';
import * as vscode from 'vscode';
import { AgentTool } from '../agent/types';
import type { BackgroundAccess } from '../chat/backgroundHub';
import { formatDuration } from '../duration';
import { perf } from '../perf';
import { redactCommand } from '../redact';
import { CommandHandle, OUTPUT_CAP, spawnShellCommand, type KillOutcome } from './background';
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
 * Ceiling for `exec_command`'s `timeout`, applied to the model's value **and** to
 * the `commandTimeout` setting. Without it a model that picks `timeout: 99999` (or
 * a workspace where the setting was fat-fingered to an hour) blocks the turn for
 * as long as it likes; with it the command is promoted to the background at the
 * ceiling instead (see the default `timeout_behavior`), so nothing is lost.
 */
const DEFAULT_COMMAND_TIMEOUT_MAX_SEC = 1800;

/** Fallback when `spinney.commandTimeoutMax` is absent or not a positive number. */
function commandTimeoutMaxSec(): number {
  const configured = vscode.workspace.getConfiguration('spinney').get<number>('commandTimeoutMax');
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_COMMAND_TIMEOUT_MAX_SEC;
}

/** The accepted `timeout_behavior` values, in the order the error message names them. */
const TIMEOUT_BEHAVIORS = ['stop', 'move_to_background', 'start_in_background'] as const;

/**
 * Heartbeat period for a foreground command. Slow enough never to matter, often
 * enough that a hang shows up within one line of the log.
 */
const COMMAND_HEARTBEAT_MS = 30_000;

/**
 * `pid=1234`, or `pid=none` before the spawn produced one (a spawn failure, or a
 * shell that has not been created yet). Every `exec …` diagnostics line carries it
 * so a log can be lined up with the OS process it talks about.
 */
function pidField(handle: CommandHandle): string {
  return `pid=${handle.child.pid ?? 'none'}`;
}

/** Keep a diagnostic timer (the still-running heartbeat) from holding the host open. */
function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  (timer as unknown as { unref?: () => void }).unref?.();
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
 * instead of being killed, and the resolved message names the background id, the
 * timeout that promoted it and the directory it is still running in — the agent
 * has to be able to keep managing a command the harness did not wait for.
 *
 * Every result leads with an elapsed-time line (`[exit 0 in 3.4s · cwd …]`, ...)
 * computed from `startedAt` (captured just before the process was spawned). It is
 * always the FIRST line so it survives `limitInline`'s spill, whose preview keeps
 * only the first 8 lines of a long result. That line also names the directory the
 * command ran in: every command starts in the harness root, and a model that can
 * see it does not prefix the same `cd … && …` to every command.
 *
 * Diagnostics (`[perf] exec …`) bracket the call: `exec end` here, `exec start` in
 * the caller, a 30 s `exec still-running` heartbeat while it runs, and `exec kill`
 * once a kill issued here has actually landed. `timeoutNote` is appended to the
 * two messages that name a timeout; it is empty unless the requested timeout was
 * clamped (see `commandTimeoutMaxSec`).
 */
function runForeground(
  handle: CommandHandle,
  command: string,
  startedAt: number,
  cwd: string,
  timeoutMs: number,
  timeoutNote: string,
  signal: AbortSignal | undefined,
  moveOnTimeout: boolean,
  promote: (() => number) | null,
): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let abortHandler: (() => void) | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      if (abortHandler && signal) signal.removeEventListener('abort', abortHandler);
    };

    /**
     * Kill the process tree and log the outcome once `kill()` has settled — the
     * frozen `CommandHandle` contract makes it asynchronous and resolves with a
     * `KillOutcome`. The line therefore records what actually happened rather than
     * the request: `no-exit` here is the difference between "the log went quiet
     * because it died" and "it may still be out there".
     */
    const killAndLog = () => {
      const line = (outcome: KillOutcome | 'unknown') =>
        perf(`exec kill ${pidField(handle)} outcome=${outcome} ms=${Date.now() - startedAt}`);
      void handle.kill().then(
        (outcome) => line(outcome),
        // A rejected kill is neither of the three outcomes; say so rather than
        // claiming one (the request itself is already in `exec start`).
        () => line('unknown'),
      );
    };

    const finish = (
      reason: 'close' | 'start' | 'timeout' | 'aborted',
      code?: number | null,
      message?: string,
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      // One line per foreground call, whatever ended it. `truncated` outranks
      // `exit` because the cap is what killed the command, and a reader otherwise
      // sees a nonzero code with no mention of the flood (see OUTPUT_CAP).
      const outcome =
        reason === 'start'
          ? 'start-fail'
          : reason === 'aborted'
            ? 'aborted'
            : reason === 'timeout'
              ? 'timeout'
              : handle.isTruncated()
                ? 'truncated'
                : 'exit';
      perf(`exec end ${pidField(handle)} outcome=${outcome} code=${code ?? 'none'} ms=${Date.now() - startedAt}`);
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
        msg = `[command timed out after ${timeoutMs} ms${timeoutNote} (ran ${dur})${at}]\n${out}`.trim();
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

    // A foreground command used to write nothing between `exec start` and whatever
    // ended it, so a command that hung (a shell waiting for input, a network call
    // with no deadline) was invisible in the log: the session looked idle while it
    // was blocked. The heartbeat keeps the command's identity and progress in the
    // log for as long as it holds the turn.
    heartbeat = setInterval(() => {
      perf(
        () =>
          `exec still-running ${pidField(handle)} ms=${Date.now() - startedAt} ` +
          `out=${handle.getOutput().length} cmd=${redactCommand(command)}`,
      );
    }, COMMAND_HEARTBEAT_MS);
    unrefTimer(heartbeat);

    timer = setTimeout(() => {
      if (settled) return;
      if (moveOnTimeout && promote) {
        settled = true;
        cleanup();
        const id = promote();
        // The promotion ends the *foreground* call, so it gets the same one-line
        // ending as any other settle — with its own outcome word: neither `exit`
        // nor `timeout` is true, because the command is still running and now
        // belongs to the background hub (whose own card and notice take over).
        perf(`exec end ${pidField(handle)} outcome=promoted code=none ms=${Date.now() - startedAt}`);
        // How long it ran in the foreground before the promotion (i.e. ~timeoutMs,
        // plus time the shell took to report the promotion), useful when deciding
        // whether to keep waiting on it via join_background.
        const dur = formatDuration(Date.now() - startedAt);
        const soFar = handle.getOutput().trim();
        const out = soFar ? `\nOutput so far:\n${soFar}` : '';
        resolve(
          `[command moved to background: id ${id}]\n` +
            `The command was still running after ${timeoutMs} ms (${dur}) in ${cwd}${timeoutNote}, so it was ` +
            `moved to the background. Nothing was killed and it keeps running.\n` +
            `Command: ${command}\n` +
            `Working directory: ${cwd}\n` +
            `Use check_background_terminal(${id}) to look at it, join_background(${id}) to wait for it, or ` +
            `kill_background(${id}) to stop it.${out}`,
        );
        return;
      }
      killAndLog();
      finish('timeout');
    }, timeoutMs);

    if (signal) {
      abortHandler = () => {
        killAndLog();
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
          'Run a shell command and return its combined stdout/stderr; the first line of the result names the directory the command ran in. Use for builds, tests, git, npm, etc. Every command starts in the harness root (the workspace folder, or the harness scratch folder when no folder is open), which is the default cwd — pass cwd (relative to the harness root, or an absolute path) to run somewhere else, instead of prefixing the command with "cd <dir> && ". Never put the command in the background yourself ("&", "nohup", "disown", "Start-Process"): a process the harness did not spawn cannot be tracked, joined or stopped — use timeout_behavior for work that must outlive the call. By default (no timeout_behavior) the command runs in the foreground and, if it is still running when timeout is reached, it is moved to the background and the result gives you its id: nothing is killed and it keeps running, so check it with check_background_terminal(id), wait for it with join_background(id), or stop it with kill_background(id). timeout_behavior "stop" kills it at the timeout instead, "start_in_background" launches it in the background immediately and returns its id without waiting, and "move_to_background" is the same behaviour as the default, stated explicitly. timeout is in seconds (defaults to the spinney.commandTimeout setting, 600 = 10 minutes unless changed) and is clamped to the spinney.commandTimeoutMax ceiling (1800 seconds unless changed). Commands run through the detected shell (currently ' +
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
              description:
                'Timeout in seconds (defaults to spinney.commandTimeout, 600 = 10 minutes unless changed; clamped to the spinney.commandTimeoutMax ceiling, 1800 seconds unless changed).',
            },
            timeout_behavior: {
              type: 'string',
              enum: ['stop', 'move_to_background', 'start_in_background'],
              description:
                'What to do at the timeout: omit it (or "move_to_background") to move the still-running command to the background and get its id — nothing is killed; "stop" to kill it; "start_in_background" to launch it in the background immediately.',
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
      // The clamp applies to the model's timeout and to the `commandTimeout` default
      // alike: the ceiling exists to bound how long a tool call can hold the turn,
      // and a setting that ignores it would not bound anything.
      const requestedSec =
        typeof args.timeout === 'number' && Number.isFinite(args.timeout) ? args.timeout : defaultCommandTimeoutSec();
      const maxSec = commandTimeoutMaxSec();
      const timeoutSec = Math.min(Math.max(requestedSec, 1), maxSec);
      const timeoutMs = timeoutSec * 1000;
      // Name the effective seconds wherever the clamp changed the request: a model
      // that asked for 9999 s and reads "timed out after 2000 ms" otherwise learns
      // that `timeout` is ignored (the very belief the ceiling is meant to avoid).
      const timeoutNote =
        timeoutSec === requestedSec
          ? ''
          : ` (the requested timeout ${requestedSec}s was clamped to ${timeoutSec}s; spinney.commandTimeoutMax=${maxSec}s)`;
      const explicit =
        args.timeout_behavior === undefined || args.timeout_behavior === null ? null : String(args.timeout_behavior);
      if (explicit !== null && !(TIMEOUT_BEHAVIORS as readonly string[]).includes(explicit)) {
        throw new Error(
          `Invalid timeout_behavior "${explicit}". Use "stop", "move_to_background", or "start_in_background".`,
        );
      }
      const access = getAccess();
      const owner = access?.currentOwner() ?? null;
      const canBackground = !!(access && owner);
      // The default is to move a still-running command to the background rather than
      // kill it: the work is usually worth keeping, and losing it at an arbitrary
      // timeout is the failure the agent cannot undo. Without background access
      // (a bare `ToolRegistry`, e.g. the acceptance drivers) the only truthful
      // behaviour left is the old one — kill at the timeout.
      const behavior = explicit ?? (canBackground ? 'move_to_background' : 'stop');
      if (explicit !== null && explicit !== 'stop' && !canBackground) {
        throw new Error('Background terminals are not available in this session.');
      }
      const startedAt = Date.now();
      const handle = spawnShellCommand(command, cwd, { killOnTruncate: behavior === 'stop' });
      perf(
        `exec start ${pidField(handle)} timeout=${timeoutSec}s behavior=${behavior} cwd=${cwd} cmd=${redactCommand(command)}`,
      );
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
          timeoutNote,
          signal,
          behavior === 'move_to_background',
          promote,
        ),
        'exec_command',
      );
    },
  };
}
