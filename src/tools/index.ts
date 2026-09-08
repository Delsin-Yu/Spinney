import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentTool, ToolDefinition } from '../agent/types';
import { getShell } from './shell';
import { BackgroundRegistry, CommandHandle, OUTPUT_CAP, spawnShellCommand } from './background';

/** Resolve the first workspace folder root. */
export function getWorkspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error('No workspace folder is open.');
  }
  return folders[0].uri.fsPath;
}

/** Resolve a possibly-relative path against the workspace root. */
export function resolvePath(input: string): string {
  if (path.isAbsolute(input)) {
    return input;
  }
  return path.resolve(getWorkspaceRoot(), input);
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Operation aborted.');
  }
}

// ---- Line-ending helpers ----
function detectEol(content: string): string {
  if (content.indexOf('\r\n') !== -1) return '\r\n';
  if (content.indexOf('\n') !== -1) return '\n';
  if (content.indexOf('\r') !== -1) return '\r';
  return '\n';
}

function toLf(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function applyEol(content: string, eol: string): string {
  if (eol === '\n') return content;
  if (eol === '\r') return content.replace(/\n/g, '\r');
  return content.replace(/\n/g, '\r\n');
}

function eolLabelOf(content: string): string {
  const eol = detectEol(content);
  return eol === '\r\n' ? 'CRLF' : eol === '\r' ? 'CR' : 'LF';
}

const RAW_TOKEN_RE = /<<<RAW:([A-Za-z0-9_]+)>>>|<<<END_RAW:([A-Za-z0-9_]+)>>>/g;

function truncate(s: string, n = 200): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * Parse tool-call arguments. Accepts either:
 *  - strict JSON (the classic OpenAI-compatible contract), or
 *  - the "verbatim frame" form used to avoid escaping large/multi-line content:
 *      { "path": "a.ts" }\n<<<RAW:content>>>\n…\n<<<END_RAW:content>>>\n
 *    A short JSON header holds the small fields; each labeled RAW payload is
 *    captured verbatim (one framing newline after the open tag is skipped; a
 *    trailing newline before END_RAW is preserved), then merged into the args.
 */
function parseArgs(argsJson: string): Record<string, unknown> {
  if (argsJson && argsJson.trim()) {
    try {
      const parsed = JSON.parse(argsJson);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not strict JSON; try the frame form below.
    }
  }

  const result: Record<string, unknown> = {};
  RAW_TOKEN_RE.lastIndex = 0;
  const first = RAW_TOKEN_RE.exec(argsJson);
  if (!first) {
    throw new Error(`Could not parse tool arguments as JSON: ${truncate(argsJson)}`);
  }

  const header = argsJson.slice(0, first.index).trim();
  if (header) {
    try {
      const headerObj = JSON.parse(header) as Record<string, unknown>;
      if (headerObj && typeof headerObj === 'object' && !Array.isArray(headerObj)) {
        for (const [key, value] of Object.entries(headerObj)) {
          result[key] = value;
        }
      }
    } catch {
      throw new Error(`Tool-arguments JSON header is not valid JSON: ${truncate(header)}`);
    }
  }

  const stack: Array<{ label: string; start: number }> = [];
  RAW_TOKEN_RE.lastIndex = first.index;
  let match: RegExpExecArray | null;
  while ((match = RAW_TOKEN_RE.exec(argsJson))) {
    if (match[1]) {
      let start = RAW_TOKEN_RE.lastIndex;
      if (argsJson[start] === '\r' && argsJson[start + 1] === '\n') start += 2;
      else if (argsJson[start] === '\n') start += 1;
      stack.push({ label: match[1], start });
    } else if (match[2]) {
      const open = stack.pop();
      if (!open || open.label !== match[2]) {
        throw new Error(`Mismatched RAW/END_RAW markers in tool arguments (END_RAW:${match[2]}).`);
      }
      result[open.label] = argsJson.slice(open.start, match.index);
    }
  }
  if (stack.length > 0) {
    throw new Error(`Unclosed RAW marker(s): ${stack.map((s) => s.label).join(', ')}.`);
  }
  return result;
}

const readFileTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read the contents of a text file. Path may be absolute or relative to the workspace root. Optionally read a specific 1-based line range. Content is returned with LF line endings (the header reports the on-disk line ending, e.g. CRLF); use read_file output verbatim as replace_in_file oldText.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path.' },
          startLine: { type: 'number', description: 'Inclusive 1-based start line.' },
          endLine: { type: 'number', description: 'Inclusive 1-based end line.' },
        },
        required: ['path'],
      },
    },
  },
  async execute(args, signal) {
    ensureNotAborted(signal);
    const filePath = resolvePath(String(args.path ?? ''));
    const content = await fs.promises.readFile(filePath, 'utf8');
    // Report the on-disk line ending but always present content in a canonical
    // LF form so the model sees a stable representation; its future oldText/
    // newText then lines up regardless of CRLF vs LF.
    const label = eolLabelOf(content);
    const normalized = toLf(content);
    const lines = normalized.split('\n');
    const startLine = typeof args.startLine === 'number' ? args.startLine : 1;
    const endLine = typeof args.endLine === 'number' ? args.endLine : lines.length;
    const slice = lines.slice(Math.max(1, startLine) - 1, Math.min(endLine, lines.length));
    const header = `File: ${filePath}`;
    if (startLine === 1 && endLine >= lines.length) {
      return `${header} (${lines.length} lines, ${label})\n${normalized}`;
    }
    const numbered = slice.map((line, i) => `${startLine + i}: ${line}`).join('\n');
    return `${header} (lines ${startLine}-${Math.min(endLine, lines.length)} of ${lines.length}, ${label})\n${numbered}`;
  },
};

const writeFileTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Write content to a file, creating parent directories as needed. Fully overwrites the file. Path may be absolute or relative to the workspace root. When overwriting an existing file, its line-ending style (CRLF/LF) is preserved. Content may be supplied either as a normal JSON string (escaped) or, for large/multi-line content, as a verbatim frame: set frame:true, put a short JSON header for the path, then frame the content between <<<RAW:content>>> and <<<END_RAW:content>>>.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to write.' },
          content: { type: 'string', description: 'Full file content to write.' },
          frame: { type: 'boolean', description: 'Optional. Set true for large/multi-line content; the harness treats the big fields as a verbatim frame (RAW markers) instead of an escaped JSON string.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  async execute(args, signal) {
    ensureNotAborted(signal);
    const filePath = resolvePath(String(args.path ?? ''));
    const content = String(args.content ?? '');
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    // Preserve the line-ending style of an existing file so rewriting a CRLF
    // file with LF content does not flip the whole file. New files are written
    // exactly as supplied.
    let finalContent = content;
    let label = eolLabelOf(content);
    if (fs.existsSync(filePath)) {
      const existing = await fs.promises.readFile(filePath, 'utf8');
      label = eolLabelOf(existing);
      finalContent = applyEol(toLf(content), detectEol(existing));
    }
    await fs.promises.writeFile(filePath, finalContent, 'utf8');
    const lines = toLf(finalContent).split('\n').length;
    return `Wrote ${filePath} (${lines} lines, ${label}).`;
  },
};

const replaceInFileTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'replace_in_file',
      description:
        'Replace an exact substring in a file with new text. The oldText must appear exactly once, otherwise an error is returned. Use for surgical edits. Matching is done in normalized LF, so CRLF vs LF never breaks a match; the file is written back with its original line endings. Old and new text may be normal JSON strings or, for large/multi-line snippets, verbatim frames: set frame:true, put a JSON header for the path, then <<<RAW:oldText>>>...<<<END_RAW:oldText>>> and <<<RAW:newText>>>...<<<END_RAW:newText>>>.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to edit.' },
          oldText: { type: 'string', description: 'Exact text to find.' },
          newText: { type: 'string', description: 'Replacement text.' },
          frame: { type: 'boolean', description: 'Optional. Set true for large/multi-line oldText/newText; the harness treats them as verbatim frames (RAW markers) instead of escaped JSON strings.' },
        },
        required: ['path', 'oldText', 'newText'],
      },
    },
  },
  async execute(args, signal) {
    ensureNotAborted(signal);
    const filePath = resolvePath(String(args.path ?? ''));
    const oldText = String(args.oldText ?? '');
    const newText = String(args.newText ?? '');
    if (!oldText) {
      throw new Error('oldText must not be empty.');
    }
    const content = await fs.promises.readFile(filePath, 'utf8');
    const eol = detectEol(content);
    // Match and replace in canonical LF, then write back in the original style.
    const matchContent = toLf(content);
    const matchOld = toLf(oldText);
    const matchNew = toLf(newText);
    const count = matchContent.split(matchOld).length - 1;
    if (count === 0) {
      throw new Error(
        `Could not find oldText in ${filePath}. The file uses ${eolLabelOf(content)} line endings; ` +
        'verify the exact text (including indentation) against read_file output.',
      );
    }
    if (count > 1) {
      throw new Error(
        `oldText is ambiguous in ${filePath}: found ${count} occurrences. Provide more context.`,
      );
    }
    const result = matchContent.replace(matchOld, matchNew);
    await fs.promises.writeFile(filePath, applyEol(result, eol), 'utf8');
    return `Replaced one occurrence in ${filePath}.`;
  },
};

const listDirTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'list_dir',
      description:
        'List the entries of a directory. Path may be absolute or relative to the workspace root. Directories are suffixed with "/".',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path.' },
        },
        required: ['path'],
      },
    },
  },
  async execute(args, signal) {
    ensureNotAborted(signal);
    const dirPath = resolvePath(String(args.path ?? '.'));
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const names = entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .join('\n');
    return `Directory: ${dirPath}\n${names || '(empty)'}`;
  },
};

// ---- search_files (grep) ----
const MAX_SEARCH_FILE = 1_000_000;
const MAX_SEARCH_FILES = 4000;
const MAX_SEARCH_MATCHES = 300;
const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'build']);

function globToRegex(glob: string): RegExp {
  const s = glob
    .replace(/\./g, '\\.')
    // **/ = zero or more directory segments, so **/*.ts also matches top-level files.
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*');
  return new RegExp('^' + s + '$');
}

const searchFilesTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'search_files',
      description:
        'Search files in the workspace for a regex pattern and return matching "file:line: text" lines. Path may be absolute or relative to the workspace root (default = root). An optional glob (e.g. "**/*.ts") filters the files; caseSensitive defaults to false; maxResults caps the matches (default 200, hard cap 300). Heavy dirs (node_modules/.git/out...) are skipped automatically.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex to search for (JS regex syntax).' },
          path: { type: 'string', description: 'File or directory to search (default = workspace root).' },
          glob: { type: 'string', description: 'Optional glob filter, e.g. "**/*.ts".' },
          caseSensitive: { type: 'boolean', description: 'Default false.' },
          maxResults: { type: 'number', description: 'Default 200 (capped at 300).' },
        },
        required: ['pattern'],
      },
    },
  },
  async execute(args, signal) {
    ensureNotAborted(signal);
    const pattern = String(args.pattern ?? '');
    if (!pattern) {
      return 'Error: search_files requires a "pattern".';
    }
    let re: RegExp;
    try {
      re = new RegExp(pattern, args.caseSensitive ? '' : 'i');
    } catch (err) {
      return `Error: invalid regex: ${err instanceof Error ? err.message : String(err)}`;
    }
    const root = args.path ? resolvePath(String(args.path)) : getWorkspaceRoot();
    const glob = args.glob ? globToRegex(String(args.glob)) : null;
    const maxResults =
      typeof args.maxResults === 'number' ? Math.min(Math.max(1, args.maxResults), MAX_SEARCH_MATCHES) : 200;
    const results: string[] = [];
    let files = 0;

    async function walk(dir: string, rel: string): Promise<void> {
      if (signal?.aborted) throw new Error('Operation aborted.');
      if (files > MAX_SEARCH_FILES || results.length >= maxResults) return;
      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (signal?.aborted) throw new Error('Operation aborted.');
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        const relPath = rel ? path.join(rel, entry.name).split(path.sep).join('/') : entry.name;
        if (entry.isDirectory()) {
          await walk(full, relPath);
          continue;
        }
        if (glob && !glob.test(relPath)) continue;
        files++;
        let text: string;
        try {
          const stat = await fs.promises.stat(full);
          if (stat.size > MAX_SEARCH_FILE) continue;
          text = await fs.promises.readFile(full, 'utf8');
        } catch {
          continue;
        }
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= maxResults) break;
          if (re.test(lines[i])) {
            results.push(`${relPath}:${i + 1}: ${lines[i].trim().slice(0, 160)}`);
          }
        }
      }
    }

    await walk(root, '');
    return results.length ? results.join('\n') : '(no matches)';
  },
};

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

function makeExecCommandTool(getRegistry: () => BackgroundRegistry | null): AgentTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'exec_command',
        description:
          'Run a shell command in the workspace root and return its combined stdout/stderr. Use for builds, tests, git, npm, etc. Optionally set cwd relative to the workspace root. Set timeout (seconds, default 120). timeout_behavior controls what happens when a command runs past timeout: "stop" (default) kills it, "move_to_background" promotes the still-running command to a background terminal (returns its id), and "start_in_background" launches it in the background immediately (returns its id and does not wait). Commands run through the detected shell (currently ' +
          getShell().label +
          ') and in that shell syntax (bash-style for Git Bash, PowerShell syntax otherwise).',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The shell command to run.' },
            cwd: { type: 'string', description: 'Working directory, relative to workspace root.' },
            timeout: { type: 'number', description: 'Timeout in seconds (default 120).' },
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
        throw new Error('Command must not be empty.');
      }
      const cwd = args.cwd ? resolvePath(String(args.cwd)) : getWorkspaceRoot();
      const timeoutSec = typeof args.timeout === 'number' ? args.timeout : 120;
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

      return runForeground(handle, command, cwd, timeoutMs, signal, behavior === 'move_to_background', registry);
    },
  };
}

function makeCheckBackgroundTool(getRegistry: () => BackgroundRegistry | null): AgentTool {
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
      return `${statusLine}${outLine}`;
    },
  };
}

function makeKillBackgroundTool(getRegistry: () => BackgroundRegistry | null): AgentTool {
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

function makeJoinBackgroundTool(getRegistry: () => BackgroundRegistry | null): AgentTool {
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
      return `${resultLine}${out ? `\nOutput:\n${out}` : ''}`;
    },
  };
}

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();
  private backgroundRegistry: BackgroundRegistry | null = null;

  constructor() {
    this.buildTools();
  }

  /** (Re)build the tool set, wiring the background-aware tools to the active registry. */
  private buildTools(): void {
    this.tools.clear();
    const getRegistry = () => this.backgroundRegistry;
    for (const tool of [
      readFileTool,
      writeFileTool,
      replaceInFileTool,
      listDirTool,
      searchFilesTool,
      makeExecCommandTool(getRegistry),
      makeCheckBackgroundTool(getRegistry),
      makeKillBackgroundTool(getRegistry),
      makeJoinBackgroundTool(getRegistry),
    ]) {
      this.tools.set(tool.definition.function.name, tool);
    }
  }

  /**
   * Point the background-aware tools at a session's registry (one per session).
   * Called on session activation so exec_command and the background tools read
   * the active session's registry.
   */
  setBackgroundRegistry(registry: BackgroundRegistry | null): void {
    this.backgroundRegistry = registry;
    this.buildTools();
  }

  /** A registry with only the named tools (scopes a sub-agent's surface). */
  subset(names: string[]): ToolRegistry {
    const sub = new ToolRegistry();
    sub.tools.clear();
    for (const name of names) {
      const tool = this.tools.get(name);
      if (tool) {
        sub.tools.set(name, tool);
      }
    }
    // Background-aware sub-agents share the same session registry as the parent.
    sub.backgroundRegistry = this.backgroundRegistry;
    return sub;
  }

  /**
   * Expose the named tools' *definitions* alongside whatever is already present
   * (so a read-only sub-agent's model sees them and may propose them) but make
   * their execution return a clear denial. Defense-in-depth: the tool is visible
   * on the API surface yet denied at the runtime layer.
   */
  withBlocked(names: string[]): ToolRegistry {
    for (const name of names) {
      const tool = this.tools.get(name);
      if (tool) {
        this.tools.set(name, {
          definition: tool.definition,
          execute: async () => `Error: "${name}" is not permitted for this read-only sub-agent.`,
        });
      }
    }
    return this;
  }

  /** Declare tools with their real *definitions* but a rejecting execution. */
  blocked(names: string[]): ToolRegistry {
    const sub = new ToolRegistry();
    sub.tools.clear();
    for (const name of names) {
      const tool = this.tools.get(name);
      if (tool) {
        sub.tools.set(name, {
          definition: tool.definition,
          execute: async () => `Error: "${name}" is not permitted for this read-only sub-agent.`,
        });
      }
    }
    sub.backgroundRegistry = this.backgroundRegistry;
    return sub;
  }

  get definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }

  get names(): string[] {
    return [...this.tools.keys()];
  }

  async execute(name: string, argsJson: string, signal?: AbortSignal): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return `Error: unknown tool "${name}". Available: ${this.names.join(', ')}`;
    }
    let args: Record<string, unknown>;
    try {
      args = parseArgs(argsJson || '{}');
    } catch (err) {
      return `Error: could not parse tool arguments: ${err instanceof Error ? err.message : String(err)}`;
    }
    try {
      return await tool.execute(args, signal);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
