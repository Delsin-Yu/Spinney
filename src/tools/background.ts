import { spawn, exec, type ChildProcess } from 'child_process';
import { getShell } from './shell';

/** Cap for captured command output. Large output is truncated (not kept in memory). */
export const OUTPUT_CAP = 16 * 1024 * 1024;

/**
 * A spawned shell command plus the plumbing needed to observe it over time:
 * accumulated combined output, a process-tree kill, and a truncation flag. The
 * shell decision lives in `getShell()`; the caller passes a command string that
 * the selected shell interprets.
 */
export interface CommandHandle {
  child: ChildProcess;
  kill: () => void;
  getOutput: () => string;
  isTruncated: () => boolean;
}

/**
 * Kill a running command promptly. On Windows, `child.kill()` only terminates
 * the shell (cmd.exe) and leaves any grandchildren running, so we use `taskkill
 * /T /F` to tear down the entire process tree. This ensures a Stop aborts the
 * command immediately rather than leaving orphaned processes behind.
 */
function killChildProcess(child: ChildProcess): void {
  if (!child.pid) {
    return;
  }
  if (process.platform === 'win32') {
    try {
      exec(`taskkill /pid ${child.pid} /T /F`, () => {
        /* best-effort; ignore failures */
      });
    } catch {
      child.kill();
    }
  } else {
    child.kill('SIGTERM');
  }
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
  });

  let stdout = '';
  let stderr = '';
  let total = 0;
  let truncated = false;
  const kill = () => killChildProcess(child);

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
    const s = d.toString('utf8');
    if (isErr) stderr += s;
    else stdout += s;
  };
  child.stdout?.on('data', (d: Buffer) => onData(d, false));
  child.stderr?.on('data', (d: Buffer) => onData(d, true));

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
  status: 'running' | 'finished';
  exitCode: number | null;
  /** True when the process was killed (by the user or via kill_background). */
  killed: boolean;
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

  /** Register a (still-running) spawned command as a background terminal. */
  register(handle: CommandHandle, command: string, cwd: string, notifyAgent = true): number {
    const id = ++this.counter;
    const task: BackgroundTask = {
      id,
      command,
      cwd,
      startedAt: Date.now(),
      status: 'running',
      exitCode: null,
      killed: false,
      truncated: handle.isTruncated(),
      handle,
      notifyAgent,
      delivered: false,
      waiters: [],
    };
    this.tasks.set(id, task);

    handle.child.on('close', (code) => this.complete(task, code));
    handle.child.on('error', () => this.complete(task, null));

    this.onUpdated?.();
    return id;
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
    task.handle.kill();
    // Transition immediately so a subsequent check_background_terminal reads
    // "finished" and the completion notice is delivered without waiting for the
    // OS close event.
    this.complete(task, null);
    return task;
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

  /** Kill every running background terminal (used on session delete / dispose). */
  killAll(): void {
    for (const t of this.tasks.values()) {
      if (t.status === 'running') {
        t.killed = true;
        t.handle.kill();
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
