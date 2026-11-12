import * as fs from 'fs';
import * as vscode from 'vscode';
import { AgentTool, TOOL_TITLE_DESCRIPTION } from '../agent/types';
import type { BackgroundAccess } from '../chat/backgroundHub';
import { formatDuration } from '../duration';
import { perf } from '../perf';
import { redactCommand } from '../redact';
import { CommandHandle, OUTPUT_CAP, spawnShellCommand, type KillOutcome } from './background';
import { getAgentRoot, limitInline, resolvePath } from './index';
import { getShell } from './shell';

/** Fallback when `spinney.execForegroundSeconds` is absent or not a usable number. */
export const DEFAULT_EXEC_FOREGROUND_SEC = 30;

/**
 * How long a `run_type: "foreground"` call holds the turn before the command is
 * **moved to the background** — in seconds, read live so a settings change applies
 * to the next call instead of needing a window reload.
 *
 * This is a slice, never a deadline: nothing kills a command at the end of it. A
 * call that is still running when it runs out is registered as a background job
 * and the result hands back its id, so no work is lost to a clock. A value that is
 * absent or not a positive number falls back to
 * {@link DEFAULT_EXEC_FOREGROUND_SEC}; the manifest carries the 10 /
 * 999999999999 bounds, and a hand-edited value is used as written (a small slice
 * only promotes sooner, which is never a loss).
 */
export function execForegroundSeconds(): number {
  const configured = vscode.workspace.getConfiguration('spinney').get<number>('execForegroundSeconds');
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_EXEC_FOREGROUND_SEC;
}

/**
 * The accepted `run_type` values, in the order the model is told about them. The
 * value decides **what the call is**, and nothing else does:
 *
 *  - `foreground` (**the default**) — run it in this turn and return its output; a
 *    command still running after {@link execForegroundSeconds} is moved to the
 *    background (never killed, never refused) and the result carries its id;
 *  - `background` — a **node** job from the start: it registers immediately, locks
 *    its node's composer on Stop, and sends a completion notice when it ends;
 *  - `detached` — a session-wide, fire-and-forget job: it locks no node, never
 *    notifies, and is read on demand (`check_command` / `wait_for_command`).
 *
 * No value carries a deadline. A job runs until its process ends or until
 * something kills it (`kill_command`, Stop, the card's kill button, or the
 * session going away).
 */
const RUN_TYPES = ['foreground', 'background', 'detached'] as const;

/** One of {@link RUN_TYPES}. */
type RunType = (typeof RUN_TYPES)[number];

/**
 * Heartbeat period for a foreground command. Slow enough never to matter, often
 * enough that a hang shows up within one line of the log.
 */
const COMMAND_HEARTBEAT_MS = 30_000;

/**
 * The two arguments this tool no longer has. They are answered with one sentence
 * **before anything is spawned**: a model that still sends `timeout` or
 * `timeout_behavior` learned that schema somewhere and will otherwise read a
 * silent fallback as "my timeout is in force", which is the opposite of what this
 * model promises. It names the replacement and says that nothing was started, so
 * the retry cannot go looking for an output.
 */
function removedArgumentError(): Error {
  return new Error(
    'timeout_behavior was removed; pass run_type "foreground" | "background" | "detached". ' +
      'There is no per-call timeout any more. Nothing was started.',
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
 * The one closing line every result that hands a job back carries: what to do
 * instead of waiting, what will come back by itself, and why asking again is not
 * that. A session in the field answered a silent promotion with 46 back-to-back
 * status reads, which is exactly what this sentence exists to prevent.
 */
function nodeJobGuidance(id: number): string {
  return (
    `You may continue with other work or end your turn: the completion notice for id ${id} will reach you ` +
    `when it finishes. Do not poll it — check_command(${id}) is a status read, not a wait; ` +
    `wait_for_command(${id}) waits for it and returns the moment it ends; kill_command(${id}) stops it.`
  );
}

/**
 * The result of a promotion — a message the agent has to be able to act on without
 * another look, because the command is now only visible through its id: which id,
 * where it ran, how long it held the turn, and what to do next.
 *
 * The first line is frozen (guards and the docs quote it byte for byte). The second
 * names the **foreground slice** the command outlived — `spinney.execForegroundSeconds`
 * — and not some budget: there is no budget any more, and a promotion happens
 * because the slice ran out, not because anything is about to end the command.
 */
function promotionMessage(
  id: number,
  foregroundMs: number,
  dur: string,
  sliceSec: number,
  command: string,
  cwd: string,
  output: string,
): string {
  const soFar = output.trim();
  return (
    `[command moved to background: id ${id}]\n` +
    `The command was still running after ${foregroundMs} ms (${dur}) in ${cwd}, so it was moved to the ` +
    `background when the ${sliceSec} s foreground slice (spinney.execForegroundSeconds) ran out. ` +
    `Nothing was killed by the move and it keeps running.\n` +
    `Command: ${command}\n` +
    `Working directory: ${cwd}\n` +
    nodeJobGuidance(id) +
    (soFar ? `\nOutput so far:\n${soFar}` : '')
  );
}

/** The result of `run_type: "background"`: the job exists and owns this node now. */
function backgroundStartMessage(id: number, command: string, cwd: string): string {
  return (
    `[command started in background: id ${id}]\n` +
    `Command: ${command}\n` +
    `Working directory: ${cwd}\n` +
    nodeJobGuidance(id)
  );
}

/** The result of `run_type: "detached"`: nothing locks, nothing notifies. */
function detachedStartMessage(id: number, command: string, cwd: string): string {
  return (
    `[command started detached: id ${id}]\n` +
    `Command: ${command}\n` +
    `Working directory: ${cwd}\n` +
    `This job is session-wide and fire-and-forget: it locks no node (the composer stays on Send for it) ` +
    `and no completion notice will be sent, so check_command(${id}) is how its result is read. ` +
    `wait_for_command(${id}) waits for it up to the seconds you give and returns the moment it ends — ` +
    `no notice follows that wait. kill_command(${id}) stops it. ` +
    `It has no deadline and runs until it ends or is killed.`
  );
}

/** Everything {@link runForeground} needs; grouped because the call shape has no other reader. */
interface ForegroundRun {
  handle: CommandHandle;
  command: string;
  /** Captured just before the spawn; every elapsed number is measured from it. */
  startedAt: number;
  cwd: string;
  /** How long this call may hold the turn (ms) — the promotion fires here. */
  foregroundMs: number;
  /** `spinney.execForegroundSeconds`, in seconds (the promotion message quotes it). */
  sliceSec: number;
  signal: AbortSignal | undefined;
  /**
   * Register the still-running command with the hub and return its id. `null` =
   * there is no hub in this session, so the call simply keeps waiting: a foreground
   * command is **never** killed or refused, and the only reason to bound the hold
   * at all is to hand the work to the background.
   */
  promote: (() => number) | null;
}

/**
 * Run a command in the foreground and resolve with a human-readable result.
 *
 * "Foreground" is a **slice** of the call, not a deadline: the timer fires at
 * `foregroundMs` and the command is handed to the background hub (registered under
 * its owning node) — the result is the promotion message. Nothing is killed and
 * nothing is refused. Without a hub (`promote === null`) no timer is armed at all
 * and the call waits for the command, because there is nowhere to hand it to.
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
  const { handle, command, startedAt, cwd, foregroundMs, sliceSec, signal, promote } = run;
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
      reason: 'close' | 'start' | 'aborted',
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
        reason === 'start' ? 'start-fail' : reason === 'aborted' ? 'aborted' : handle.isTruncated() ? 'truncated' : 'exit';
      perf(
        `exec end ${pidField(handle)} run_type=foreground outcome=${outcome} code=${code ?? 'none'} ` +
          `ms=${Date.now() - startedAt}`,
      );
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

    // The slice timer exists only to hand the work over — with no hub there is no
    // promotion to make, so there is nothing to time either.
    if (promote) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        const id = promote();
        // The promotion ends the *foreground* call, so it gets the same one-line
        // ending as any other settle — with its own outcome word: neither `exit`
        // nor anything else is true, because the command is still running and now
        // belongs to the hub (whose own card and notice take over).
        perf(
          `exec end ${pidField(handle)} run_type=foreground outcome=promoted code=none ` +
            `ms=${Date.now() - startedAt}`,
        );
        const dur = formatDuration(Date.now() - startedAt);
        resolve(promotionMessage(id, foregroundMs, dur, sliceSec, command, cwd, handle.getOutput()));
      }, foregroundMs);
    }

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
          'Run a shell command and return its combined stdout/stderr; the first line of the result names the directory the command ran in. Every call must carry a short human title (for example "Running the test suite"), because the folded step row displays it instead of the command. Use for builds, tests, git, npm, etc. Prefer the tool that names the work for reading, listing, searching and session history; the shell is for what no tool covers. Do not use the shell for search: no grep, rg, findstr, Select-String, find or locate — search_files (with its own hard time budget, exclusions, binary skipping and scope echo) and search_transcripts answer those, and a shell search has no budget behind it, so one wide pattern can hold the turn. The one case that belongs here is a genuinely large search that needs a long-running job (a whole-drive or multi-repository sweep): that is a background job, not a foreground grep. Every command starts in the harness root (the workspace folder, or the harness scratch folder when no folder is open), which is the default cwd — pass cwd (relative to the harness root, or an absolute path) to run somewhere else, instead of prefixing the command with "cd <dir> && ". Never put the command in the background yourself ("&", "nohup", "disown", "Start-Process"): a process the harness did not spawn cannot be tracked, waited for or stopped. There is no per-call timeout: run_type says what the call is, and every job lives until its process ends or something kills it. run_type "foreground" (the default) runs the command in this turn and returns its output; when the command is still running after spinney.execForegroundSeconds (30 seconds unless changed), it is moved to the background instead of being killed — nothing is lost — and the result carries its id and what to do next. Use the foreground for anything that finishes quickly (a build, a test run, a git command) and never add your own shell timeout. run_type "background" starts a job on this node immediately and returns its id: it belongs to this node, so the composer shows Stop until it ends, and its completion notice reaches you when it finishes; use it for work that is known to be long but still belongs to this turn. run_type "detached" starts a session-wide, fire-and-forget job: it locks no node (the composer keeps offering Send), never sends a completion notice, and is read by asking — use it for a long-lived thing (a dev server, an emulator, a watcher) whose result you collect later. Never sleep to wait for a command and never poll a running one: wait_for_command(id) waits up to the seconds you give and returns the moment the command ends, while check_command(id) is only a status read. A job that notifies you will wake you by itself, so continue other work or end your turn instead of watching it; kill_command(id) stops a job you no longer need. Commands run through the detected shell (currently ' +
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
            run_type: {
              type: 'string',
              enum: ['foreground', 'background', 'detached'],
              description:
                'What the call is, and the only thing that decides it. "foreground" (the default) runs the command in this turn and returns its output; a command still running after spinney.execForegroundSeconds (30 seconds unless changed) is moved to the background and its id comes back in the result. "background" starts a job on this node immediately (its id comes back at once): it locks this node — the composer shows Stop until it ends — and its completion notice reaches you when it finishes. "detached" starts a session-wide, fire-and-forget job: it locks no node, never sends a completion notice, and is read with check_command or wait_for_command. No run_type carries a timeout or a deadline.',
            },
            title: { type: 'string', description: TOOL_TITLE_DESCRIPTION },
          },
          required: ['command', 'title'],
        },
      },
    },
    async execute(args, signal) {
      // Before anything else, and before anything is spawned: the two arguments this
      // tool no longer has. A silent fallback would read as "my timeout is in force".
      if (args.timeout !== undefined || args.timeout_behavior !== undefined) {
        throw removedArgumentError();
      }
      const command = String(args.command ?? '');
      if (!command) {
        throw new Error('exec_command requires a non-empty "command" string.');
      }
      const cwdArg = args.cwd ? String(args.cwd) : null;
      const cwd = cwdArg ? resolvePath(cwdArg) : getAgentRoot();
      assertUsableCwd(cwd, cwdArg);
      const explicit = args.run_type === undefined || args.run_type === null ? null : String(args.run_type);
      if (explicit !== null && !(RUN_TYPES as readonly string[]).includes(explicit)) {
        throw new Error(`Invalid run_type "${explicit}". Use "foreground", "background", or "detached".`);
      }
      const runType: RunType = (explicit ?? 'foreground') as RunType;
      /** The two values that never wait in the foreground at all. */
      const startsInBackground = runType === 'background' || runType === 'detached';
      const sliceSec = execForegroundSeconds();
      const sliceMs = sliceSec * 1000;
      const access = getAccess();
      const owner = access?.currentOwner() ?? null;
      const canBackground = !!(access && owner);
      if (startsInBackground && !canBackground) {
        throw new Error('Background terminals are not available in this session.');
      }
      // A command that becomes a background job must keep draining its pipes (the hub
      // owns it from then on), so it is never killed on a truncation flood; one that
      // cannot be promoted — there is no hub in this session — is, so a runaway output
      // cannot balloon memory while it holds the turn.
      const killOnTruncate = !canBackground;
      const startedAt = Date.now();
      const handle = spawnShellCommand(command, cwd, { killOnTruncate });
      perf(`exec start ${pidField(handle)} run_type=${runType} cwd=${cwd} cmd=${redactCommand(command)}`);
      // A promoted job is registered under the node whose turn spawned it, so it
      // renders in that node's card and its completion notice returns to that branch
      // even if the user has moved the view elsewhere meanwhile.
      const register = (detached: boolean) => access!.hub.register(owner!, handle, command, cwd, detached);

      if (runType === 'background') {
        return backgroundStartMessage(register(false), command, cwd);
      }

      if (runType === 'detached') {
        return detachedStartMessage(register(true), command, cwd);
      }

      return limitInline(
        await runForeground({
          handle,
          command,
          startedAt,
          cwd,
          foregroundMs: sliceMs,
          sliceSec,
          signal,
          // The default run type promotes, and only promotes: a foreground command
          // is never killed or refused at the end of its slice.
          promote: canBackground ? () => register(false) : null,
        }),
        'exec_command',
      );
    },
  };
}
