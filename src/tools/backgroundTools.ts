import { AgentTool } from '../agent/types';
import type { BackgroundAccess } from '../chat/backgroundHub';
import { formatDuration } from '../duration';
import type { BackgroundTask } from './background';
import { limitInline } from './index';

/** What `wait_for_command` waits when the call states no `seconds` of its own. */
const DEFAULT_WAIT_SEC = 30;
/** The shortest and longest wait one call may ask for (clamped, never refused). */
const MIN_WAIT_SEC = 1;
const MAX_WAIT_SEC = 300;

/**
 * The wait length a `wait_for_command` call asks for, in seconds: `seconds` when it
 * is a usable number, else {@link DEFAULT_WAIT_SEC}, clamped to
 * [{@link MIN_WAIT_SEC}, {@link MAX_WAIT_SEC}].
 *
 * Clamped rather than refused on purpose: a wait is a bend of the turn, not a
 * malformed call, and a model that asked for 10 minutes can act on "you waited
 * 300 s" in the same answer instead of losing a round trip to an argument error.
 */
function waitSeconds(args: Record<string, unknown>): number {
  const raw = typeof args.seconds === 'number' && Number.isFinite(args.seconds) ? args.seconds : DEFAULT_WAIT_SEC;
  return Math.min(MAX_WAIT_SEC, Math.max(MIN_WAIT_SEC, raw));
}

/** A timer that never keeps the extension host alive on its own. */
function delay(ms: number): Promise<'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

/** One line of status, used by both tools so the two never disagree on a job's state. */
function statusLine(task: BackgroundTask): string {
  const dur = formatDuration((task.finishedAt ?? Date.now()) - task.startedAt);
  if (task.killed) {
    return task.killUnconfirmed
      ? `Command ${task.id} was killed after ${dur}, but the process tree did not report an exit. (command: ${task.command})`
      : `Command ${task.id} was killed after ${dur}. (command: ${task.command})`;
  }
  if (task.status === 'running') {
    return `Command ${task.id} is running. (command: ${task.command}, ${dur} elapsed)`;
  }
  return `Command ${task.id} finished with exit code ${task.exitCode ?? 'unknown'} after ${dur}.`;
}

/**
 * What `wait_for_command` answers when the command outlived the wait.
 *
 * It is a **plain result**, not an `Error:`: nothing was malformed — the command
 * simply is still running — and an `Error:` would invite a retry with the same id,
 * which is the only thing this text exists to steer away from. The wait itself
 * changed nothing, so the sentence says that too, then names the three moves that
 * are actually left: read the status, wait again, or end the command and run a
 * quieter one.
 */
function waitTimedOutText(task: BackgroundTask, waitedSec: number): string {
  const dur = formatDuration((task.finishedAt ?? Date.now()) - task.startedAt);
  const out = task.handle.getOutput().trim();
  const detached = task.detached
    ? ` This job is global (bound to this VS Code window), so no completion notice will arrive for it either: its result is read only by ` +
      `asking again (check_command(${task.id}) or another wait_for_command(${task.id})).`
    : '';
  return limitInline(
    `Command ${task.id} is still running after this ${waitedSec} s wait (command: ${task.command}, ${dur} elapsed); ` +
      `nothing changed and the command keeps running.${detached} ` +
      `This is not a failure: the command simply outlived the wait. ` +
      `check_command(${task.id}) is a status read, not a wait; wait_for_command(${task.id}) may be called again ` +
      `to wait longer; kill_command(${task.id}) stops it, and if it is noisier or slower than the work needs, ` +
      `killing it and running a quieter command is the other way out.` +
      (out ? `\nOutput so far:\n${out}` : ''),
    'wait_for_command',
  );
}

export function makeCheckCommandTool(getAccess: () => BackgroundAccess | null): AgentTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'check_command',
        description:
          'Report the status of a command started by exec_command (its id is returned by the call). Answers whether it is running or finished, its exit code (when finished) and the output accumulated so far. This is a status read, not a wait: a command that has not finished answers the same thing however often it is asked. Do not poll a running command. A node job (run_type "background", or a foreground call moved to the background) notifies you by itself when it ends, so continue other work or end your turn; a detached job (run_type "detached") never notifies, so read it once when you actually need its result. Use wait_for_command to wait for a command instead of checking it repeatedly.',
        parameters: {
          type: 'object',
          properties: {
            pid: { type: 'number', description: 'The command id returned by exec_command.' },
          },
          required: ['pid'],
        },
      },
    },
    async execute(args) {
      const access = getAccess();
      const sessionId = access?.currentOwner()?.sessionId ?? null;
      if (!access || !sessionId) {
        return 'Error: commands are not available in this session.';
      }
      const id = Number(args.pid);
      if (!Number.isFinite(id)) {
        return 'Error: check_command requires a numeric pid.';
      }
      // Ids are session-local, so a job spawned from another branch of the same
      // session still resolves: the hub maps the id back to its owning node.
      const task = access.hub.lookup(sessionId, id)?.task;
      if (!task) {
        return `Error: no command with id ${id}.`;
      }
      const out = task.handle.getOutput().trim();
      const outLine = out ? `\nOutput:\n${out}` : '';
      // A running command answers the same thing however often it is asked, and in
      // the field an agent answered that with 46 checks back to back — so the status
      // line carries what to do instead, at the moment the model is looking at it. A
      // node job wakes the turn on its own; a detached one never will, and its reader
      // is told the difference rather than promised a notice that cannot come.
      const hint =
        task.status !== 'running'
          ? ''
          : task.detached
            ? `\nThis job never notifies: read it once when you actually need the result, not in a loop. ` +
              `wait_for_command(${id}) waits for it up to the seconds you give.`
            : `\nYou may continue with other work or end your turn: the completion notice for id ${id} will ` +
              `reach you when it finishes. Do not poll it — this is a status read, not a wait; ` +
              `wait_for_command(${id}) waits for it and returns the moment it ends.`;
      return limitInline(`${statusLine(task)}${hint}${outLine}`, 'check_command');
    },
  };
}

export function makeWaitForCommandTool(getAccess: () => BackgroundAccess | null): AgentTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'wait_for_command',
        description:
          'Wait for a command started by exec_command, up to `seconds` (default 30, clamped to 1–300), and return its result. It returns the moment the command ends — if it ends inside the wait, the answer is its exit code and full output and no separate completion notice is sent. If the wait runs out first, the answer is a normal result saying the command is still running: you may call wait_for_command again, read it with check_command, or kill it with kill_command and run a quieter command instead. Respects Stop. Use it instead of sleeping or polling: it is the one way to wait. It works on a detached job too, but no notice will arrive after that wait.',
        parameters: {
          type: 'object',
          properties: {
            pid: { type: 'number', description: 'The command id returned by exec_command.' },
            seconds: {
              type: 'number',
              description: 'How long to wait, in seconds (default 30, clamped to 1–300).',
            },
          },
          required: ['pid'],
        },
      },
    },
    async execute(args, signal) {
      const access = getAccess();
      const sessionId = access?.currentOwner()?.sessionId ?? null;
      if (!access || !sessionId) {
        return 'Error: commands are not available in this session.';
      }
      const id = Number(args.pid);
      if (!Number.isFinite(id)) {
        return 'Error: wait_for_command requires a numeric pid.';
      }
      const task = access.hub.lookup(sessionId, id)?.task;
      if (!task) {
        return `Error: no command with id ${id}.`;
      }
      const waitedSec = waitSeconds(args);
      // A command that already ended returns its result at once: there is no wait to
      // bound, and a refusal or a timeout sentence would tell the agent to expect
      // something for a job that is already over.
      if (task.status !== 'running') {
        const out = task.handle.getOutput().trim();
        const dur = formatDuration((task.finishedAt ?? Date.now()) - task.startedAt);
        const resultLine = task.killed
          ? `Command ${id} was killed after ${dur}.`
          : `Command ${id} finished with exit code ${task.exitCode ?? 'unknown'} after ${dur}.`;
        return limitInline(`${resultLine}${out ? `\nOutput:\n${out}` : ''}`, 'wait_for_command');
      }
      // Suppress the completion notice for the duration of the wait: the wait's own
      // result is what tells the agent, exactly as the old join tool did. A detached
      // job keeps `notifyAgent` false whatever happens — that flag is its identity.
      task.notifyAgent = false;
      // A wait has to be cancellable on three sides: the turn's Stop, the timeout,
      // and the command ending. The hub's own wait resolves on the command and
      // rejects on an abort, so the timeout aborts a local controller — which also
      // takes the waiter back out of the task, so a timed-out wait leaves no trace.
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      if (signal) {
        if (signal.aborted) {
          task.notifyAgent = !task.detached;
          return '[command wait was interrupted]';
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        const outcome = await Promise.race([
          access.hub.waitFor(sessionId, id, controller.signal).then(
            () => 'done' as const,
            // The hub rejects on an abort, and only on an abort (an unknown id was
            // answered above) — but a Stop and a vanished job are different news.
            () => (signal?.aborted ? ('aborted' as const) : ('gone' as const)),
          ),
          delay(waitedSec * 1000),
        ]);
        if (outcome === 'aborted') {
          // The wait itself was interrupted (Stop): the command keeps running, so it
          // must be able to notify again when it ends.
          controller.abort();
          task.notifyAgent = !task.detached;
          return '[command wait was interrupted]';
        }
        if (outcome === 'gone') {
          controller.abort();
          task.notifyAgent = !task.detached;
          return `Error: command ${id} disappeared while waiting for it.`;
        }
        if (outcome === 'timeout') {
          controller.abort();
          task.notifyAgent = !task.detached;
          return waitTimedOutText(task, waitedSec);
        }
      } finally {
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
      }
      const done = access.hub.lookup(sessionId, id)?.task;
      if (!done) {
        return `Error: command ${id} disappeared.`;
      }
      // The wait carried the outcome, so the job's own notice is not sent for it.
      const out = done.handle.getOutput().trim();
      const dur = formatDuration((done.finishedAt ?? Date.now()) - done.startedAt);
      const resultLine = done.killed
        ? `Command ${id} was killed after ${dur}.`
        : `Command ${id} finished with exit code ${done.exitCode ?? 'unknown'} after ${dur}.`;
      return limitInline(`${resultLine}${out ? `\nOutput:\n${out}` : ''}`, 'wait_for_command');
    },
  };
}

export function makeKillCommandTool(getAccess: () => BackgroundAccess | null): AgentTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'kill_command',
        description:
          'Kill a command started by exec_command, by its id. The process tree is torn down and a short confirmation is returned. Use it when a long-running command is no longer needed, or when a command is noisier or slower than the work requires and a quieter one would do.',
        parameters: {
          type: 'object',
          properties: {
            pid: { type: 'number', description: 'The command id returned by exec_command.' },
          },
          required: ['pid'],
        },
      },
    },
    async execute(args) {
      const access = getAccess();
      const sessionId = access?.currentOwner()?.sessionId ?? null;
      if (!access || !sessionId) {
        return 'Error: commands are not available in this session.';
      }
      const id = Number(args.pid);
      if (!Number.isFinite(id)) {
        return 'Error: kill_command requires a numeric pid.';
      }
      const task = access.hub.lookup(sessionId, id)?.task;
      if (!task) {
        return `Error: no command with id ${id}.`;
      }
      if (task.status !== 'running') {
        return `Command ${id} is not running (exit code ${task.exitCode ?? 'unknown'}).`;
      }
      // Tool-initiated kill: the tool result is the signal the agent sees, so the
      // separate completion notice is suppressed (`notifyAgent: false`). The kill
      // is what sets `finishedAt`, so the elapsed time is read AFTER it.
      const killed = access.hub.kill(sessionId, id, { notifyAgent: false }) ?? task;
      // The registry fired the kill's confirmation detached (Stop and the card must
      // stay instant); this tool awaits it, because its result must not claim a
      // clean end the OS never reported. A task with no confirmation at all behaves
      // exactly as before.
      if (killed.killConfirm) {
        try {
          await killed.killConfirm;
        } catch {
          /* killChildProcess never rejects; an escalation that does counts as unconfirmed */
        }
      }
      const dur = formatDuration((killed.finishedAt ?? Date.now()) - killed.startedAt);
      if (killed.killUnconfirmed) {
        return `Killed command ${id} after ${dur}, but the process tree did not report an exit (command: ${killed.command}).`;
      }
      return `Killed command ${id} after ${dur} (command: ${killed.command}).`;
    },
  };
}
