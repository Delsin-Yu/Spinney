import { AgentTool } from '../agent/types';
import type { BackgroundAccess } from '../chat/backgroundHub';
import { formatDuration } from '../duration';
import { remainingBudgetMs, type BackgroundTask } from './background';
import { commandMaxForegroundDurationSec } from './execCommand';
import { limitInline } from './index';

/**
 * The budget a task was started with, or `null` when it has none. Kept as a tiny
 * helper because both tools quote it and both need the same answer: a job without
 * a budget keeps the wording it had before budgets existed.
 */
function budgetMsOf(task: BackgroundTask): number | null {
  return typeof task.timeoutMs === 'number' ? task.timeoutMs : null;
}

/**
 * The refusal a `join_background` returns when the job is **detached**
 * (`start_detached`): session-wide and fire-and-forget. Whether or not the call
 * gave it a deadline, no completion notice ever comes back for it and no turn ever
 * waits for it, so there is nothing for a join to return — and nothing a refusal
 * takes away from the agent either.
 *
 * It is refused *outright*, finished or still running. The status does not matter:
 * the two reasons a join could ever be useful — a bounded wait, or a notice to
 * come back on — do not exist for this job, and `check_background_terminal` answers
 * exactly what a join would have (the accumulated output, and the exit code once
 * there is one). Same voice as the two refusals below: name the id, say nothing
 * changed, and name both tools that *do* work.
 */
function refuseJoinDetached(id: number): string {
  return (
    `Background terminal ${id} is a detached job (timeout_behavior "start_detached"): it is session-wide and ` +
    `fire-and-forget, so it never sends a completion notice and no turn ever waits for it — joining it is ` +
    `meaningless and this join was refused; nothing changed. ` +
    `Read it with check_background_terminal(${id}) instead: it reports the job's accumulated output, and its ` +
    `exit code once the job has ended. ` +
    `If you want to end the command rather than let it run, call kill_background(${id}).`
  );
}

/**
 * The refusal a gated `join_background` returns when the job has **no deadline**:
 * nothing bounds it, so waiting on it could hold the turn for as long as it likes.
 *
 * This is guidance, not a malformed call, so it is a plain tool result (an
 * `Error:` prefix would tell the model its arguments were wrong and invite a
 * retry with the same pid). It is also deliberately imperative — the *action* the
 * agent is asked to take is to end its turn, because the completion notice is
 * what will reach it: the refusal itself changed nothing.
 */
function refuseJoinNoDeadline(id: number, limitSec: number): string {
  return (
    `Background terminal ${id} has no deadline, so it can run longer than the ${limitSec} s a turn may wait, ` +
    `and this join was refused — nothing changed. ` +
    `End your turn instead: the completion notice for id ${id} will reach you when it finishes ` +
    `(check_background_terminal(${id}) reports it sooner). ` +
    `If you want to end the command rather than wait for it, call kill_background(${id}).`
  );
}

/**
 * The refusal a gated `join_background` returns when the job *has* a budget but
 * more of it is left than a turn may wait. Names the remaining budget and the
 * budget it was started with, so the model can tell "wait a little longer" from
 * "this job is still 25 minutes away".
 */
function refuseJoinOverBudget(id: number, limitSec: number, remainingMs: number, budgetMs: number): string {
  return (
    `Background terminal ${id} has ${formatDuration(remainingMs)} of its ${formatDuration(budgetMs)} budget left, ` +
    `which is longer than the ${limitSec} s a turn may wait, so this join was refused and nothing changed. ` +
    `End your turn instead: the completion notice for id ${id} will reach you when it finishes ` +
    `(check_background_terminal(${id}) reports it sooner). ` +
    `If you want to end the command rather than wait for it, call kill_background(${id}).`
  );
}

export function makeCheckBackgroundTool(getAccess: () => BackgroundAccess | null): AgentTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'check_background_terminal',
        description:
          'Check the status of a background terminal started by exec_command (timeout_behavior = background_when_timeout / start_in_background / start_detached). Returns whether it is running or finished, its exit code (when finished), and the output accumulated so far. This is how a detached job (start_detached) is read at all: it never sends a completion notice.',
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
      const access = getAccess();
      const sessionId = access?.currentOwner()?.sessionId ?? null;
      if (!access || !sessionId) {
        return 'Error: background terminals are not available in this session.';
      }
      const id = Number(args.pid);
      if (!Number.isFinite(id)) {
        return 'Error: check_background_terminal requires a numeric pid.';
      }
      // Ids are session-local, so a job spawned from another branch of the same
      // session still resolves: the hub maps the id back to its owning node.
      const task = access.hub.lookup(sessionId, id)?.task;
      if (!task) {
        return `Error: no background terminal with id ${id}.`;
      }
      // Elapsed time of the job the agent is asking about: a running task is
      // measured to now, a finished (or killed) one to its recorded finish time so
      // the number is stable across repeated checks.
      const dur = formatDuration((task.finishedAt ?? Date.now()) - task.startedAt);
      const out = task.handle.getOutput().trim();
      // The budget a job was given, when it has one. It is quoted next to the
      // elapsed time so one line answers both halves of "how long has this been
      // going, and how long may it go": without it a model cannot tell a job that
      // is nearly out of time from one that has barely started.
      const budget = budgetMsOf(task);
      // "Killed" alone would claim a clean end. A kill that could not be confirmed
      // (no exit observed before the deadline) is said out loud, so the model does
      // not treat a process tree that may still be alive as gone. A kill the budget
      // caused outranks both: it is the one ending the agent should expect, and the
      // one where "killed" alone would look like the user's doing.
      const statusLine = task.killed
        ? task.killReason === 'timeout' && budget !== null
          ? `Background terminal ${id} was killed after ${dur} — its ${formatDuration(budget)} budget ran out. (command: ${task.command})`
          : task.killUnconfirmed
            ? `Background terminal ${id} was killed after ${dur}, but the process tree did not report an exit. (command: ${task.command})`
            : `Background terminal ${id} was killed after ${dur}. (command: ${task.command})`
        : task.status === 'running'
          ? budget !== null
            ? `Background terminal ${id} is running. (command: ${task.command}, ${dur} of its ${formatDuration(budget)} budget elapsed)`
            : `Background terminal ${id} is running. (command: ${task.command}, ${dur} elapsed)`
          : `Background terminal ${id} finished with exit code ${task.exitCode ?? 'unknown'} after ${dur}.`;
      const outLine = out ? `\nOutput:\n${out}` : '';
      return limitInline(`${statusLine}${outLine}`, 'check_background_terminal');
    },
  };
}

export function makeKillBackgroundTool(getAccess: () => BackgroundAccess | null): AgentTool {
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
      const access = getAccess();
      const sessionId = access?.currentOwner()?.sessionId ?? null;
      if (!access || !sessionId) {
        return 'Error: background terminals are not available in this session.';
      }
      const id = Number(args.pid);
      if (!Number.isFinite(id)) {
        return 'Error: kill_background requires a numeric pid.';
      }
      const task = access.hub.lookup(sessionId, id)?.task;
      if (!task) {
        return `Error: no background terminal with id ${id}.`;
      }
      if (task.status !== 'running') {
        return `Background terminal ${id} is not running (exit code ${task.exitCode ?? 'unknown'}).`;
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
        return `Killed background terminal ${id} after ${dur}, but the process tree did not report an exit (command: ${killed.command}).`;
      }
      return `Killed background terminal ${id} after ${dur} (command: ${killed.command}).`;
    },
  };
}

export function makeJoinBackgroundTool(getAccess: () => BackgroundAccess | null): AgentTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'join_background',
        description:
          'Block until a background terminal (by pid) finishes, then return its final exit code and full accumulated output. Respects Stop. Use to wait for a command you moved to the background and collect its result. A join is refused while the job still has more than the foreground limit of its budget left (spinney.commandMaxForegroundDuration, 300 s unless changed), because a turn must never wait longer than that — end your turn instead and let the completion notice arrive. A detached job (start_detached) is refused outright: it never notifies, so check_background_terminal is how its result is read.',
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
      const access = getAccess();
      const sessionId = access?.currentOwner()?.sessionId ?? null;
      if (!access || !sessionId) {
        return 'Error: background terminals are not available in this session.';
      }
      const id = Number(args.pid);
      if (!Number.isFinite(id)) {
        return 'Error: join_background requires a numeric pid.';
      }
      const task = access.hub.lookup(sessionId, id)?.task;
      if (!task) {
        return `Error: no background terminal with id ${id}.`;
      }
      // A detached job is refused outright — before the finished check, and
      // regardless of status. The two things a join ever gives back are a *bounded
      // wait* and the *result*: a detached job has no notice to come back on and is
      // explicitly not something a turn waits for, while `check_background_terminal`
      // returns its output (and its exit code, once there is one) at once. Refusing
      // it also cannot mislead: the refusal says there is no notice, so nothing here
      // tells the agent to expect one.
      if (task.detached) {
        return refuseJoinDetached(id);
      }
      // The join gate, and the reason it exists: `join_background` used to block
      // until the job finished, so a job with hours to go held the turn for hours.
      // A turn may not wait longer than the foreground limit, so a join is only
      // allowed once the *remaining* budget fits inside it — by then the wait is
      // bounded, and returning the final result in the same turn is worth it.
      // Everything longer ends the turn instead: the completion notice brings the
      // agent back, which is the same wake-up without the stall.
      //
      // A job that already finished is not gated: waiting on it returns at once, so
      // there is no wait to bound (and refusing would tell the agent to expect a
      // notice for a job that already ended). The gate is evaluated *before* the
      // task is touched, because a refused join must leave everything as it was.
      if (task.status !== 'finished') {
        const limitSec = commandMaxForegroundDurationSec();
        const remaining = remainingBudgetMs(task);
        const budget = budgetMsOf(task);
        // `remaining === null` is the frozen contract's "no deadline"; the budget is
        // checked alongside it because it is what the over-budget message quotes.
        if (remaining === null || budget === null) {
          return refuseJoinNoDeadline(id, limitSec);
        }
        if (remaining > limitSec * 1000) {
          return refuseJoinOverBudget(id, limitSec, remaining, budget);
        }
      }
      // Suppress the separate completion notification: the join result (or an
      // interruption) tells the agent. On interruption re-enable it so a later
      // natural finish still notifies.
      task.notifyAgent = false;
      try {
        await access.hub.waitFor(sessionId, id, signal);
      } catch (err) {
        task.notifyAgent = true;
        if (signal?.aborted) {
          return '[command join was interrupted]';
        }
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
      const done = access.hub.lookup(sessionId, id)?.task;
      if (!done) {
        return `Error: background terminal ${id} disappeared.`;
      }
      const out = done.handle.getOutput().trim();
      const dur = formatDuration((done.finishedAt ?? Date.now()) - done.startedAt);
      const resultLine = done.killed
        ? `Background terminal ${id} was killed after ${dur}.`
        : `Background terminal ${id} finished with exit code ${done.exitCode ?? 'unknown'} after ${dur}.`;
      return limitInline(`${resultLine}${out ? `\nOutput:\n${out}` : ''}`, 'join_background');
    },
  };
}
