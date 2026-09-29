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

/** Fallback when `spinney.commandMaxForegroundDuration` is absent or not a positive number. */
export const DEFAULT_COMMAND_MAX_FOREGROUND_SEC = 300;

/**
 * How long anything may hold a turn, in seconds — read live, so a settings change
 * applies to the next call instead of needing a window reload.
 *
 * It is the single knob of the `exec_command` budget model: it caps the foreground
 * slice (`min(timeout, limit)`, i.e. how long this call may hold the turn) and it is
 * the number rule R2 is checked against ({@link timeoutTooLongError}). Exported
 * because `join_background` gates on the same limit (`src/tools/backgroundTools.ts`).
 */
export function commandMaxForegroundDurationSec(): number {
  const configured = vscode.workspace.getConfiguration('spinney').get<number>('commandMaxForegroundDuration');
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_COMMAND_MAX_FOREGROUND_SEC;
}

/**
 * The accepted `timeout_behavior` values, in the order the error message names
 * them. The value **is** the job's identity:
 *
 *  - `stop_when_timeout` (**the default**) — foreground, killed at the timeout,
 *    nothing registered, nothing locked, no notice;
 *  - `background_when_timeout` — foreground up to the limit, then promoted with
 *    `timeout − limit` as its deadline: a node job, it locks its node (Stop), and
 *    its completion notice comes back; without a `timeout` there is no deadline to
 *    carry, so it **needs** one exactly like the value below (see
 *    {@link needsTimeoutError});
 *  - `start_in_background` — a node job from the start: locks its node, notifies,
 *    joinable (bounded), and it **needs** a `timeout` (see {@link needsTimeoutError});
 *  - `start_detached` — session-wide and fire-and-forget: a detached job, it locks
 *    no node, never notifies and cannot be joined.
 */
const TIMEOUT_BEHAVIORS = [
  'stop_when_timeout',
  'background_when_timeout',
  'start_in_background',
  'start_detached',
] as const;

/** One of {@link TIMEOUT_BEHAVIORS}. */
type TimeoutBehavior = (typeof TIMEOUT_BEHAVIORS)[number];

/**
 * Heartbeat period for a foreground command. Slow enough never to matter, often
 * enough that a hang shows up within one line of the log.
 */
const COMMAND_HEARTBEAT_MS = 30_000;

/**
 * Rule R2: a `timeout` longer than the limit may not hold the turn, so it is refused
 * **before anything is spawned** unless the call explicitly asked for a background
 * behavior. The message has to be actionable on its own — the model that hit it
 * either wanted a long job (then it must say which kind of background job) or wanted
 * a short one (then it must lower the number) — and it must say that nothing was
 * started, or the model will look for an output that does not exist.
 */
function timeoutTooLongError(timeoutSec: number, limitSec: number): Error {
  return new Error(
    `timeout ${timeoutSec} s is longer than the ${limitSec} s a turn may hold ` +
      `(spinney.commandMaxForegroundDuration). A command that may run that long must not hold the turn: ` +
      `pass timeout_behavior "background_when_timeout" (${limitSec} s in the foreground, the rest of its ` +
      `${timeoutSec} s budget in the background) or "start_in_background" (the whole ${timeoutSec} s in ` +
      `the background), or pass a timeout of ${limitSec} s or less. Nothing was started.`,
  );
}

/**
 * The other side of the same coin: a **node-scoped** background value left
 * **unbounded** — `start_in_background` or `background_when_timeout` without a
 * `timeout` — is refused before the spawn too.
 *
 * Such a job has no deadline, so nothing ever ends it on its own: it holds a Stop
 * on its node (the composer's one button, the host's refusal of a send there and
 * the union kill behind it) until somebody kills it, and it can never be joined
 * either. `start_detached` exists for exactly that shape of work — a long,
 * unbounded command that must not tie a node up — so it is the one value that may
 * omit a `timeout`, and the refusal names the value that was asked for and both
 * ways out: give it a deadline, or give it the detached identity. Same rule as
 * {@link timeoutTooLongError}: say what was not started, or the model looks for an
 * output that does not exist.
 */
function needsTimeoutError(behavior: 'background_when_timeout' | 'start_in_background'): Error {
  return new Error(
    `timeout_behavior "${behavior}" needs a timeout: without one the job has no deadline, so ` +
      `nothing ends it on its own and it locks this node (the composer shows Stop for it) until something ` +
      `kills it. Either pass a timeout — the job's whole budget in seconds, with no ceiling, and the job is ` +
      `killed when it runs out — or pass timeout_behavior "start_detached", which is session-wide and ` +
      `fire-and-forget: it locks no node, never sends a completion notice, and its result is read with ` +
      `check_background_terminal. Nothing was started.`,
  );
}

/**
 * `pid=1234`, or `pid=none` before the spawn produced one (a spawn failure, or a
 * shell that has not been created yet). Every `exec …` diagnostics line carries it
 * so a log can be lined up with the OS process it talks about.
 */
function pidField(handle: CommandHandle): string {
  return `pid=${handle.child.pid ?? 'none'}`;
}

/** `1500s`, `0s`, or `none` for a budget that does not exist — the `budget=` field. */
function budgetField(ms: number | undefined): string {
  return ms === undefined ? 'none' : `${ms / 1000}s`;
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
 * The result of a promotion — a message the agent has to be able to act on without
 * another look, because the command is now only visible through its id: which id,
 * where it ran, how long it held the turn, and what is left of its budget.
 *
 * The first line is frozen (acceptance scripts and the docs quote it byte for byte);
 * the rest names the budget that left the foreground. Every promotion now has one:
 * a node-scoped value with no `timeout` is refused before the spawn
 * ({@link needsTimeoutError}), so the no-deadline arm below is never taken — it
 * stays only so a promotion can never print a bare `ms` with no number before it.
 *
 * `budgetMs` is the *call's* budget — the number the agent asked for — and not the
 * rest the hub is handed at this moment: "the rest of its 1800 s budget" is the
 * phrasing rule R2 and this message share (see {@link timeoutTooLongError}), and the
 * background job's own deadline is what `join_background`/`check_background_terminal`
 * report live. The two only differ by the foreground slice that was just spent.
 *
 * The join line states the gate `join_background` enforces: waiting on a job that
 * still has more of its budget left than a turn may hold is refused, so the agent
 * must end its turn and let the completion notice come back instead of blocking.
 */
function promotionMessage(
  id: number,
  foregroundMs: number,
  dur: string,
  budgetMs: number | undefined,
  limitSec: number,
  command: string,
  cwd: string,
  output: string,
): string {
  const what =
    budgetMs === undefined
      ? `The command was still running after ${foregroundMs} ms (${dur}) in ${cwd}, so it was moved to ` +
        `the background with no deadline instead of a budget.`
      : `The command was still running after ${foregroundMs} ms (${dur}) in ${cwd}, so it was moved to ` +
        `the background with the rest of its ${budgetMs} ms budget; it will be killed when that budget ` +
        `runs out.`;
  const soFar = output.trim();
  return (
    `[command moved to background: id ${id}]\n` +
    `${what} Nothing was killed by the move and it keeps running.\n` +
    `Command: ${command}\n` +
    `Working directory: ${cwd}\n` +
    `check_background_terminal(${id}) looks at it, kill_background(${id}) stops it. Do not join it unless ` +
    `less than ${limitSec} s of its budget is left: end your turn and the completion notice for id ${id} ` +
    `will reach you.` +
    (soFar ? `\nOutput so far:\n${soFar}` : '')
  );
}

/** Everything {@link runForeground} needs; grouped because the call shape has no other reader. */
interface ForegroundRun {
  handle: CommandHandle;
  command: string;
  /** Captured just before the spawn; every elapsed number is measured from it. */
  startedAt: number;
  cwd: string;
  /** How long this call may hold the turn (ms) — the timer fires here. */
  foregroundMs: number;
  /**
   * The call's budget (ms) — what the promotion message quotes, not what the hub is
   * registered with (see {@link promotionMessage}). A promotion always has one, since
   * a node-scoped value without a `timeout` is refused before the spawn
   * ({@link needsTimeoutError}); the `undefined` arm only exists for a
   * `start_detached` call, which never runs in the foreground at all.
   */
  budgetMs: number | undefined;
  /** `spinney.commandMaxForegroundDuration`, in seconds (the join caveat quotes it). */
  limitSec: number;
  signal: AbortSignal | undefined;
  /** Register the still-running command with the hub; `null` = kill it at the slice. */
  promote: (() => number) | null;
}

/**
 * Run a command in the foreground and resolve with a human-readable result
 * (mirroring the original exec_command contract).
 *
 * "Foreground" is a **slice** of the call's budget, not the whole of it: the timer
 * fires at `foregroundMs`, and what happens there is this call's decision — with a
 * `promote` closure the command is handed to the background hub (registered under
 * its owning node with the rest of its budget as the job's own deadline) and the
 * result is the promotion message; without one its tree is killed and the result is
 * the ordinary `[command timed out after …]` line. A timeout at or below the limit
 * never reaches the promotion: it is spent exactly when the slice ends (matrix
 * row 5).
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
 * once a kill issued here has actually landed.
 */
function runForeground(run: ForegroundRun): Promise<string> {
  const { handle, command, startedAt, cwd, foregroundMs, budgetMs, limitSec, signal, promote } = run;
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
        // The number named is the slice this call was allowed to hold the turn for
        // (`min(timeout, limit)`), which is what actually elapsed — the call's whole
        // budget is only reachable through a background job (see `exec start`).
        msg = `[command timed out after ${foregroundMs} ms (ran ${dur})${at}]\n${out}`.trim();
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
      if (promote) {
        settled = true;
        cleanup();
        const id = promote();
        // The promotion ends the *foreground* call, so it gets the same one-line
        // ending as any other settle — with its own outcome word: neither `exit`
        // nor `timeout` is true, because the command is still running and now
        // belongs to the background hub (whose own card and notice take over).
        perf(`exec end ${pidField(handle)} outcome=promoted code=none ms=${Date.now() - startedAt}`);
        // How long it ran in the foreground before the promotion (i.e. ~foregroundMs,
        // plus the time the shell took to report the promotion), useful when deciding
        // whether to keep waiting on it via join_background.
        const dur = formatDuration(Date.now() - startedAt);
        resolve(
          promotionMessage(id, foregroundMs, dur, budgetMs, limitSec, command, cwd, handle.getOutput()),
        );
        return;
      }
      killAndLog();
      finish('timeout');
    }, foregroundMs);

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
          'Run a shell command and return its combined stdout/stderr; the first line of the result names the directory the command ran in. Use for builds, tests, git, npm, etc. Prefer the tool that names the work for reading, listing, searching and session history; the shell is for what no tool covers. Every command starts in the harness root (the workspace folder, or the harness scratch folder when no folder is open), which is the default cwd — pass cwd (relative to the harness root, or an absolute path) to run somewhere else, instead of prefixing the command with "cd <dir> && ". Never put the command in the background yourself ("&", "nohup", "disown", "Start-Process"): a process the harness did not spawn cannot be tracked, joined or stopped. Nothing may hold a turn for longer than spinney.commandMaxForegroundDuration (300 seconds, i.e. 5 minutes, unless changed), and the default timeout_behavior is "stop_when_timeout": a command still running when its foreground time is up is killed, and you get its output so far. Long work must say so — a timeout longer than that limit has to ask for a background mode: pass it with timeout_behavior "background_when_timeout" (it runs in the foreground up to the limit, then moves to the background with the rest of its budget as that job\'s own deadline and its id comes back in the result; it is killed when that budget runs out) or "start_in_background" (the whole budget runs in the background from the start and its id comes back immediately). Both node-scoped values — "background_when_timeout" and "start_in_background" — need a timeout: asked without one they are refused before anything starts, because a node job with no deadline never ends on its own and locks this node\'s composer on Stop until it is killed. The third background value is "start_detached": a session-wide, fire-and-forget job that never locks this node — the composer keeps offering Send, never Stop — never sends a completion notice, and cannot be joined; its result is read with check_background_terminal(<id>), so poll it if you need the outcome, and start_detached is the right value for a job whose lifetime is genuinely unbounded — it is the only value that may omit timeout. With no timeout_behavior, or with "stop_when_timeout", a timeout that long is refused before anything is started. timeout itself is the command\'s total budget in seconds — foreground plus background, with no ceiling — and omitting it is legal only for "start_detached", which then has no deadline at all. Do not join_background a job that has more of its budget left than a turn may wait: end your turn and the completion notice will reach you. Commands run through the detected shell (currently ' +
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
                'The command\'s total budget in seconds — foreground plus background — with no ceiling. Omitted: a foreground call may hold the turn up to spinney.commandMaxForegroundDuration (300 unless changed) and is then killed, and the two node-scoped background behaviors are refused ("background_when_timeout" and "start_in_background" need one — a node job with no deadline locks its node until it is killed); only "start_detached" may omit it, and then the job has no deadline at all. A value longer than that limit is refused unless timeout_behavior asks for a background mode: "background_when_timeout" (the rest of the budget runs in the background), "start_in_background" (the whole budget runs in the background) or "start_detached" (the whole budget runs detached, session-wide).',
            },
            timeout_behavior: {
              type: 'string',
              enum: ['stop_when_timeout', 'background_when_timeout', 'start_in_background', 'start_detached'],
              description:
                'The job\'s identity. "stop_when_timeout" (the default, and what omitting it means) kills the command at its foreground deadline (the timeout, capped at spinney.commandMaxForegroundDuration) and returns its output so far. "background_when_timeout" runs it in the foreground up to that deadline and then promotes it to a background job of this node with the rest of its timeout as the job\'s budget, returning its id (it is killed when that budget runs out; it needs a timeout — only a timeout longer than the limit promotes it instead of killing it at the limit). "start_in_background" launches a node job immediately, returning its id without waiting; it needs a timeout — asked without one it is refused before the spawn, because a node job with no deadline would lock this node until it is killed. "start_detached" launches a session-wide, fire-and-forget job: it locks no node (the composer keeps offering Send), sends no completion notice and cannot be joined — read it with check_background_terminal(<id>) or stop it with kill_background(<id>) — and it is the only value that may legally omit timeout.',
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
      const explicit =
        args.timeout_behavior === undefined || args.timeout_behavior === null ? null : String(args.timeout_behavior);
      if (explicit !== null && !(TIMEOUT_BEHAVIORS as readonly string[]).includes(explicit)) {
        throw new Error(
          `Invalid timeout_behavior "${explicit}". Use "stop_when_timeout", "background_when_timeout", ` +
            `"start_in_background", or "start_detached".`,
        );
      }
      // The default is `stop_when_timeout`: a still-running command is killed at its
      // foreground deadline instead of being quietly promoted, because a promotion
      // is only meaningful when the call asked for one (and R2 says a budget longer
      // than the limit has to be asked for anyway).
      const behavior: TimeoutBehavior = (explicit ?? 'stop_when_timeout') as TimeoutBehavior;
      // Did the call ask for work to leave the turn? `start_detached` counts: its
      // budget is spent in a background job too (one that locks nothing), so R2 has
      // nothing to refuse — no `timeout` of it ever holds the turn.
      const backgroundBehavior = behavior !== 'stop_when_timeout';
      /** The two values that never wait in the foreground at all. */
      const startsInBackground = behavior === 'start_in_background' || behavior === 'start_detached';
      const limitSec = commandMaxForegroundDurationSec();
      const limitMs = limitSec * 1000;
      // The call's timeout, in seconds. Absent — and, defensively, non-finite or
      // non-positive — means the call did not ask for a budget of its own.
      const timeoutSec =
        typeof args.timeout === 'number' && Number.isFinite(args.timeout) && args.timeout > 0 ? args.timeout : null;
      // Rule R2, before the spawn: a `timeout` that would hold the turn longer than
      // anything may must ask for a background behavior explicitly.
      if (timeoutSec !== null && timeoutSec > limitSec && !backgroundBehavior) {
        throw timeoutTooLongError(timeoutSec, limitSec);
      }
      // The node jobs that need a deadline, refused before the spawn as well: with no
      // `timeout` such a job never ends on its own and holds a Stop on this node until
      // somebody kills it — the unbounded lifetime `start_detached` is for, and it is
      // the only value that may omit a `timeout` (it locks nothing). Both node-scoped
      // values are covered: without one, `background_when_timeout` would run its
      // foreground slice only to be promoted into exactly that no-deadline node job.
      if ((behavior === 'background_when_timeout' || behavior === 'start_in_background') && timeoutSec === null) {
        throw needsTimeoutError(behavior);
      }
      const access = getAccess();
      const owner = access?.currentOwner() ?? null;
      const canBackground = !!(access && owner);
      if (backgroundBehavior && !canBackground) {
        throw new Error('Background terminals are not available in this session.');
      }
      // The foreground slice: what this call may hold the turn for. The two
      // background starts hold it for nothing (the job is registered before any
      // waiting); everything else is capped by the limit, which is what makes R2's
      // refusal coherent.
      const foregroundMs =
        startsInBackground ? 0 : timeoutSec === null ? limitMs : Math.min(timeoutSec * 1000, limitMs);
      // The call's budget, in ms: the `timeout` it asked for, or the limit it falls
      // back to when it asked for none — and `undefined` only for `start_detached`
      // with no `timeout` at all, which is a job with no deadline. After the refusal
      // above, no *node* job can be registered without one.
      const budgetMs = timeoutSec !== null ? timeoutSec * 1000 : behavior === 'start_detached' ? undefined : limitMs;
      // What the hub is handed when the job leaves the foreground: the rest of that
      // budget after the slice — the whole of it for a background start (which has
      // no slice), `timeout − limit` for a promotion. The hub measures the job's
      // deadline from the registration it performs now, so it must be given the rest,
      // never the whole budget a second time. This is also the number the promotion
      // message quotes as "the rest of its <ms> budget", so the text and the deadline
      // the hub will enforce are the same number.
      const jobBudgetMs = budgetMs === undefined ? undefined : budgetMs - foregroundMs;
      // Promote only when there is something left to hand over: with `timeout ≤ limit`
      // the budget is spent exactly when the slice ends, so the command is killed at
      // its timeout instead of being promoted into a job that may not run at all. A
      // promotion therefore always has a `timeout` behind it — a node value without
      // one never gets this far (see {@link needsTimeoutError}).
      const willPromote = behavior === 'background_when_timeout' && timeoutSec !== null && timeoutSec > limitSec;
      // A command that becomes a background job must keep draining its pipes (the hub
      // owns it from then on), so it is never killed on a truncation flood; one this
      // call will kill — the default `stop_when_timeout`, or a
      // `background_when_timeout` whose budget is spent at the slice — is, so a
      // runaway output cannot balloon memory while it holds the turn.
      const killOnTruncate = !startsInBackground && !willPromote;
      const startedAt = Date.now();
      const handle = spawnShellCommand(command, cwd, { killOnTruncate });
      perf(
        `exec start ${pidField(handle)} timeout=${foregroundMs / 1000}s budget=${budgetField(budgetMs)} ` +
          `behavior=${behavior} cwd=${cwd} cmd=${redactCommand(command)}`,
      );
      // A promoted job is registered under the node whose turn spawned it, so it
      // renders in that node's dock and its completion notice returns to that branch
      // even if the user has moved the view elsewhere meanwhile. A detached job is
      // registered under the same owner — its card belongs there — and only its
      // `detached` flag makes it lock nothing and notify nobody.
      const promote =
        access && owner
          ? () => access.hub.register(owner, handle, command, cwd, jobBudgetMs, behavior === 'start_detached')
          : null;

      if (behavior === 'start_in_background') {
        const id = promote!();
        return (
          `[command started in background: id ${id}]\n` +
          `Command: ${command}\n` +
          `Working directory: ${cwd}\n` +
          `check_background_terminal(${id}) looks at it and kill_background(${id}) stops it. Do not join it ` +
          `unless less than ${limitSec} s of its budget is left: end your turn and the completion notice for ` +
          `id ${id} will reach you.`
        );
      }

      if (behavior === 'start_detached') {
        const id = promote!();
        return (
          `[command started detached: id ${id}]\n` +
          `Command: ${command}\n` +
          `Working directory: ${cwd}\n` +
          `This job is session-wide and fire-and-forget: it locks no node (the composer stays on Send for ` +
          `it) and no completion notice will be sent, so check_background_terminal(${id}) is how its result ` +
          `is read. kill_background(${id}) stops it; join_background(${id}) is refused, because there is no ` +
          `notice and no bounded wait for it.` +
          (jobBudgetMs === undefined
            ? ' It has no deadline and runs until it ends or is killed.'
            : ` It is killed when its ${jobBudgetMs} ms budget runs out.`)
        );
      }

      return limitInline(
        await runForeground({
          handle,
          command,
          startedAt,
          cwd,
          foregroundMs,
          budgetMs: jobBudgetMs,
          limitSec,
          signal,
          promote: willPromote ? promote : null,
        }),
        'exec_command',
      );
    },
  };
}
