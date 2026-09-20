import { spawn, execFile, type ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { perf } from '../perf';
import { getShell } from './shell';

/** Cap for captured command output. Large output is truncated (not kept in memory). */
export const OUTPUT_CAP = 16 * 1024 * 1024;

/**
 * How long Windows waits for `exit` after `taskkill /T /F`. The tree is already
 * gone or on its way out; the deadline only bounds the *confirmation*, so a
 * stuck or unkillable process cannot hold a tool result (or a Stop) open.
 */
const KILL_CONFIRM_MS = 800;
/** How long a POSIX process group gets to honour SIGTERM before SIGKILL. */
const SIGTERM_GRACE_MS = 300;
/** How long POSIX waits for `exit` after the SIGKILL escalation. */
const SIGKILL_CONFIRM_MS = 500;

/**
 * What a kill achieved: `exited` — the child's own `exit` event arrived (or it
 * had already exited); `no-exit` — the kill was issued but no exit was observed
 * before the deadline, so the process tree may still be alive; `no-pid` — there
 * was no pid to signal (the spawn never succeeded).
 */
export type KillOutcome = 'exited' | 'no-exit' | 'no-pid';

/** True once node has reported the child's end (code, or the signal that killed it). */
function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Resolve once the child's **`exit`** event arrives, or `false` when `ms`
 * elapses first. `exit` is deliberately used instead of `close`: `close` also
 * waits for the stdio pipes, and a leftover grandchild that inherited them
 * (exactly the case a tree kill produces) keeps them open indefinitely, so
 * `close` would never fire and a "the tree is dead" verdict would hang forever.
 *
 * The deadline timer is NOT unref'd on purpose: it must fire even when the
 * confirmation is the only thing left on the event loop, so that a kill always
 * settles with an honest outcome.
 */
function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (hasExited(child)) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (exited: boolean): void => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      child.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = (): void => settle(true);
    child.once('exit', onExit);
    timer = setTimeout(() => settle(hasExited(child)), ms);
  });
}

/**
 * Kill a running command and report what the kill actually achieved.
 *
 * Two things changed here, both consequences of a report that a command "did not
 * end properly":
 *
 *  1. The kill **reports its result** instead of being fire-and-forget. The old
 *     shape returned as soon as the signal had been *sent* (or the `taskkill`
 *     callback fired, which only says taskkill ran), so Stop, the terminal card
 *     and the tool result all claimed a clean ending while the tree could still
 *     be alive. Callers now get `KillOutcome` and can say so.
 *  2. Confirmation waits for the child's `exit` event — never `close`. `close`
 *     additionally waits for the stdio pipes to drain, and a grandchild that
 *     survived the kill (or a shell that already left one behind) holds those
 *     pipes open forever: the wait would never finish, which is the very bug
 *     being fixed. `exit` is the process's own end and always arrives (or the
 *     deadline expires and we admit it with `no-exit`).
 *
 * This never rejects: it resolves `'no-pid'` when there is nothing to signal and
 * `'no-exit'` when the deadline passes without an exit. Calling it twice is safe.
 *
 * On Windows, `child.kill()` only terminates the shell (cmd.exe) and leaves any
 * grandchildren running, so we use `taskkill /T /F` to tear down the entire
 * process tree (passed as an argument array — never a shell string, where a path
 * or an exotic pid could be reinterpreted). On POSIX the child is spawned as its
 * own process-group leader (see `spawnShellCommand`), so a negative pid signals
 * the whole group — the same "tear down the tree" semantics as `taskkill /T`.
 */
export async function killChildProcess(child: ChildProcess): Promise<KillOutcome> {
  const pid = child.pid;
  if (!pid) {
    return 'no-pid';
  }
  // Already gone (a natural finish, or an earlier kill): nothing to signal, and
  // this is what makes a second call idempotent.
  if (hasExited(child)) {
    return 'exited';
  }
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      try {
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve());
      } catch {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        resolve();
      }
    });
    return (await waitForExit(child, KILL_CONFIRM_MS)) ? 'exited' : 'no-exit';
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch (err) {
    // ESRCH: the whole group is already gone, which *is* a confirmed exit.
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
      return 'exited';
    }
    // EPERM and friends: the group signal was refused, so fall back to the child
    // itself and let the deadline below decide whether it truly ended.
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  if (await waitForExit(child, SIGTERM_GRACE_MS)) {
    return 'exited';
  }
  // Escalate: a process (or a grandchild) that ignored SIGTERM gets SIGKILL.
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* ignore: the group may be gone, or already reaped */
  }
  return (await waitForExit(child, SIGKILL_CONFIRM_MS)) ? 'exited' : 'no-exit';
}

/**
 * A spawned shell command plus the plumbing needed to observe it over time:
 * accumulated combined output, a process-tree kill, and a truncation flag. The
 * shell decision lives in `getShell()`; the caller passes a command string that
 * the selected shell interprets.
 */
export interface CommandHandle {
  child: ChildProcess;
  /** Tear down the process tree and report whether the child's exit was observed. */
  kill: () => Promise<KillOutcome>;
  getOutput: () => string;
  isTruncated: () => boolean;
}

/**
 * Spawn the shell for a command and return a handle that keeps observing output
 * even after the caller returns (needed for background terminals, whose output
 * is captured for the lifetime of the process).
 *
 * When `killOnTruncate` is true (foreground `stop` behavior), a command that
 * floods output past `OUTPUT_CAP` is killed so it cannot balloon memory; when
 * false (background behavior), the output is truncated/dropped but the process
 * keeps running — it must keep draining the pipe or the child would block.
 */
export function spawnShellCommand(command: string, cwd: string, opts: { killOnTruncate: boolean }): CommandHandle {
  const shell = getShell();
  const child = spawn(shell.file, shell.buildArgs(command), {
    cwd,
    env: shell.env,
    windowsHide: true,
    // POSIX: lead a new process group so killChildProcess can signal the whole
    // tree (`process.kill(-pid)`). Windows uses taskkill /T instead.
    detached: process.platform !== 'win32',
  });

  let stdout = '';
  let stderr = '';
  let total = 0;
  let truncated = false;
  const kill = (): Promise<KillOutcome> => killChildProcess(child);
  // Decode incrementally: a 'data' chunk boundary is a pipe-read boundary, not a
  // UTF-8 character boundary, so `chunk.toString('utf8')` would turn a split
  // multi-byte character into U+FFFD. StringDecoder carries the partial bytes over.
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');

  const onData = (d: Buffer, isErr: boolean) => {
    total += d.length;
    if (truncated) {
      // Already over the cap: keep draining so the child never blocks on a full
      // pipe, but drop the content to bound memory.
      return;
    }
    if (total > OUTPUT_CAP) {
      truncated = true;
      if (opts.killOnTruncate) {
        kill();
      }
      return;
    }
    const s = (isErr ? stderrDecoder : stdoutDecoder).write(d);
    if (isErr) stderr += s;
    else stdout += s;
  };
  child.stdout?.on('data', (d: Buffer) => onData(d, false));
  child.stderr?.on('data', (d: Buffer) => onData(d, true));
  // Flush any bytes still buffered by the decoders when the streams end.
  child.stdout?.on('end', () => {
    stdout += stdoutDecoder.end();
  });
  child.stderr?.on('end', () => {
    stderr += stderrDecoder.end();
  });

  return {
    child,
    kill,
    getOutput: () => `${stdout}${stderr}`,
    isTruncated: () => truncated,
  };
}

/**
 * A single background terminal. `id` is the opaque token handed to the agent
 * (not a real OS pid) — it is what `check_background_terminal` /
 * `kill_background` / `join_background` accept.
 */
export interface BackgroundTask {
  /** Opaque token given to the agent (a monotonic counter per registry). */
  id: number;
  command: string;
  cwd: string;
  startedAt: number;
  /** Host clock (ms) when the process ended; null while it still runs. */
  finishedAt: number | null;
  status: 'running' | 'finished';
  exitCode: number | null;
  /** True when the process was killed (by the user or via kill_background). */
  killed: boolean;
  /**
   * True when a kill could not be confirmed within its deadline (the kill was
   * issued, but no `exit` was observed — see {@link KillOutcome}). Optional so a
   * task that was never killed keeps the old, unqualified wording: it is set only
   * by the detached confirmation the registry fires after `kill` / `killAll`.
   */
  killUnconfirmed?: boolean;
  /**
   * The in-flight kill confirmation, set by the registry the moment a kill is
   * issued. The registry does not wait for it (Stop and the terminal card must
   * stay instantaneous); a caller that must report the kill honestly — the
   * `kill_background` tool — awaits it and then reads {@link killUnconfirmed}.
   */
  killConfirm?: Promise<KillOutcome>;
  /** True when captured output hit OUTPUT_CAP and was truncated. */
  truncated: boolean;
  handle: CommandHandle;
  /**
   * When false, the harness should not emit a completion notification to the
   * agent — used when the agent caused the transition itself (kill_background /
   * join_background), where the tool result already informs it.
   */
  notifyAgent: boolean;
  /**
   * True once the completion notice has been delivered to the agent (or the
   * agent was already informed via a join/kill tool result). A finished task
   * stays in the "pending delivery" panel state until this flips true.
   */
  delivered: boolean;
  /** Pending waiters (join_background) awaiting this task's completion. */
  waiters: Array<(task: BackgroundTask) => void>;
}

/**
 * Per-session registry of background terminals. Each `AgentSession` owns one so
 * background jobs are scoped to a conversation; the active registry is swapped
 * onto the tool registry when the session is activated.
 */
export class BackgroundRegistry {
  private tasks = new Map<number, BackgroundTask>();
  private counter = 0;
  private onFinish: ((task: BackgroundTask) => void) | null = null;
  private onUpdated: (() => void) | null = null;

  setOnFinish(cb: (task: BackgroundTask) => void): void {
    this.onFinish = cb;
  }

  setOnUpdated(cb: () => void): void {
    this.onUpdated = cb;
  }

  /**
   * Register a command as a background terminal. `id` is normally minted by the
   * caller (`BackgroundHub`, which needs session-local ids that are unique across
   * every node of a session); without it the registry's own counter is used.
   */
  register(handle: CommandHandle, command: string, cwd: string, notifyAgent = true, id?: number): number {
    const taskId = id ?? ++this.counter;
    const task: BackgroundTask = {
      id: taskId,
      command,
      cwd,
      startedAt: Date.now(),
      finishedAt: null,
      status: 'running',
      exitCode: null,
      killed: false,
      truncated: handle.isTruncated(),
      handle,
      notifyAgent,
      delivered: false,
      waiters: [],
    };
    this.tasks.set(taskId, task);

    handle.child.on('close', (code) => this.complete(task, code));
    handle.child.on('error', () => this.complete(task, null));

    this.onUpdated?.();
    return taskId;
  }

  /**
   * Mark a task as finished exactly once: capture the exit code, resolve any
   * waiting joiners, fire the completion hook, and refresh the UI. Also called
   * synchronously by `kill` so a killed task reads as finished immediately
   * (rather than waiting for the OS to deliver the close event).
   */
  private complete(task: BackgroundTask, code: number | null): void {
    if (task.status === 'finished') {
      return;
    }
    task.status = 'finished';
    // Stamped before the hook so an observer (the finish notice / the panel) can
    // already read the elapsed time off the task.
    task.finishedAt = Date.now();
    task.exitCode = code;
    task.truncated = task.handle.isTruncated();
    for (const w of task.waiters.splice(0)) {
      w(task);
    }
    this.onFinish?.(task);
    this.onUpdated?.();
  }

  get(id: number): BackgroundTask | undefined {
    return this.tasks.get(id);
  }

  list(): BackgroundTask[] {
    return [...this.tasks.values()];
  }

  hasRunning(): boolean {
    for (const t of this.tasks.values()) {
      if (t.status === 'running') {
        return true;
      }
    }
    return false;
  }

  runningCount(): number {
    let n = 0;
    for (const t of this.tasks.values()) {
      if (t.status === 'running') {
        n++;
      }
    }
    return n;
  }

  /**
   * Kill a background terminal's process tree. When `opts.notifyAgent` is false
   * (tool-initiated kill) the completion notification is suppressed because the
   * tool result already tells the agent. Returns the task, or undefined if the
   * id is unknown.
   *
   * Stays synchronous: Stop and the terminal card must react instantly, so the
   * state transition happens here and the kill's *confirmation* runs detached
   * (see {@link confirmKill}) — a caller that must be honest about the outcome
   * awaits `task.killConfirm` and then reads `task.killUnconfirmed`.
   */
  kill(id: number, opts?: { notifyAgent?: boolean }): BackgroundTask | undefined {
    const task = this.tasks.get(id);
    if (!task) {
      return undefined;
    }
    if (task.status !== 'running') {
      return task;
    }
    if (opts && opts.notifyAgent === false) {
      task.notifyAgent = false;
    }
    task.killed = true;
    task.killConfirm = task.handle.kill();
    void this.confirmKill(task, task.killConfirm);
    // Transition immediately so a subsequent check_background_terminal reads
    // "finished" and the completion notice is delivered without waiting for the
    // OS close event.
    this.complete(task, null);
    return task;
  }

  /**
   * Watch a kill to its outcome, detached from the caller. When the child's exit
   * was not confirmed, the task is flagged (`killUnconfirmed`) and one diagnostic
   * line records what happened, so "the command did not end properly" is
   * attributable instead of silent. Never rejects.
   */
  private async confirmKill(task: BackgroundTask, confirm: Promise<KillOutcome>): Promise<void> {
    const t0 = Date.now();
    let outcome: KillOutcome;
    try {
      outcome = await confirm;
    } catch {
      // killChildProcess never rejects; anything that slips through is unconfirmed.
      outcome = 'no-exit';
    }
    // Only a real outcome is actionable. A handle that does not honour the
    // interface (the plain objects the smoke tests register) answers nothing, and
    // nothing is what we then claim: such a task keeps the plain wording it had
    // before this change.
    const known: unknown = outcome;
    if (known !== 'no-exit' && known !== 'no-pid') {
      return;
    }
    task.killUnconfirmed = true;
    perf(`bg kill id=${task.id} pid=${task.handle.child.pid ?? 'none'} outcome=${outcome} ms=${Date.now() - t0}`);
  }

  /**
   * Resolve when a background terminal finishes. Rejects with `interrupted` if
   * the supplied signal aborts first (so `join_background` honours Stop).
   */
  waitFor(id: number, signal?: AbortSignal): Promise<BackgroundTask> {
    const task = this.tasks.get(id);
    if (!task) {
      return Promise.reject(new Error(`No background terminal with id ${id}.`));
    }
    if (task.status === 'finished') {
      return Promise.resolve(task);
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const i = task.waiters.indexOf(waiter);
        if (i >= 0) {
          task.waiters.splice(i, 1);
        }
        reject(new Error('interrupted'));
      };
      const waiter = (t: BackgroundTask) => {
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        resolve(t);
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      task.waiters.push(waiter);
      // Close the race between the status check above and pushing the waiter.
      if (task.status === 'finished') {
        const i = task.waiters.indexOf(waiter);
        if (i >= 0) {
          task.waiters.splice(i, 1);
        }
        resolve(task);
      }
    });
  }

  /**
   * Kill every running background terminal (used on session delete / dispose).
   * Synchronous and immediate like {@link kill}; each kill is confirmed detached
   * so a session can be torn down without waiting on the OS.
   */
  killAll(): void {
    for (const t of this.tasks.values()) {
      if (t.status === 'running') {
        t.killed = true;
        t.killConfirm = t.handle.kill();
        void this.confirmKill(t, t.killConfirm);
        this.complete(t, null);
      }
    }
    this.onUpdated?.();
  }

  remove(id: number): void {
    this.tasks.delete(id);
  }

  /** Drop every tracked task (finished or not); used when a session is cleared. */
  clearAll(): void {
    this.tasks.clear();
    this.onUpdated?.();
  }
}
