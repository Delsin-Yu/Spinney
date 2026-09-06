import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import * as vscode from 'vscode';
import { AgentTool, ToolDefinition } from '../agent/types';

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

const readFileTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read the contents of a text file. Path may be absolute or relative to the workspace root. Optionally read a specific 1-based line range.',
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
    const lines = content.split('\n');
    const startLine = typeof args.startLine === 'number' ? args.startLine : 1;
    const endLine = typeof args.endLine === 'number' ? args.endLine : lines.length;
    const slice = lines.slice(Math.max(1, startLine) - 1, Math.min(endLine, lines.length));
    const header = `File: ${filePath}`;
    if (startLine === 1 && endLine >= lines.length) {
      return `${header} (${lines.length} lines)\n${content}`;
    }
    const numbered = slice.map((line, i) => `${startLine + i}: ${line}`).join('\n');
    return `${header} (lines ${startLine}-${Math.min(endLine, lines.length)} of ${lines.length})\n${numbered}`;
  },
};

const writeFileTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Write content to a file, creating parent directories as needed. Fully overwrites the file. Path may be absolute or relative to the workspace root.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to write.' },
          content: { type: 'string', description: 'Full file content to write.' },
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
    await fs.promises.writeFile(filePath, content, 'utf8');
    return `Wrote ${filePath} (${content.length} characters).`;
  },
};

const replaceInFileTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'replace_in_file',
      description:
        'Replace an exact substring in a file with new text. The oldText must appear exactly once, otherwise an error is returned. Use for surgical edits.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to edit.' },
          oldText: { type: 'string', description: 'Exact text to find.' },
          newText: { type: 'string', description: 'Replacement text.' },
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
    const count = content.split(oldText).length - 1;
    if (count === 0) {
      throw new Error(`Could not find oldText in ${filePath}.`);
    }
    if (count > 1) {
      throw new Error(
        `oldText is ambiguous in ${filePath}: found ${count} occurrences. Provide more context.`,
      );
    }
    await fs.promises.writeFile(filePath, content.replace(oldText, newText), 'utf8');
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

function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve) => {
    const child = exec(
      command,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const out = `${stdout || ''}${stderr || ''}`.trim();
        if (error) {
          const code = typeof error.code === 'number' ? error.code : 'unknown';
          resolve(
            `[command exited with code ${code}]\n${out}\n${error.message}`.trim(),
          );
        } else {
          resolve(out || '(command completed with no output)');
        }
      },
    );

    if (signal) {
      if (signal.aborted) {
        child.kill();
        resolve('[command was interrupted]');
        return;
      }
      signal.addEventListener(
        'abort',
        () => {
          child.kill();
          resolve('[command was interrupted]');
        },
        { once: true },
      );
    }
  });
}

const execCommandTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'exec_command',
      description:
        'Run a shell command in the workspace root and return its combined stdout/stderr. Use for builds, tests, git, npm, etc. Optionally set cwd relative to the workspace root.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run.' },
          cwd: { type: 'string', description: 'Working directory, relative to workspace root.' },
          timeout: { type: 'number', description: 'Timeout in seconds (default 120).' },
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
    const timeoutMs = (typeof args.timeout === 'number' ? args.timeout : 120) * 1000;
    return runCommand(command, cwd, timeoutMs, signal);
  },
};

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  constructor() {
    for (const tool of [
      readFileTool,
      writeFileTool,
      replaceInFileTool,
      listDirTool,
      execCommandTool,
    ]) {
      this.tools.set(tool.definition.function.name, tool);
    }
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
      args = JSON.parse(argsJson || '{}');
    } catch {
      return `Error: could not parse tool arguments as JSON: ${argsJson}`;
    }
    try {
      return await tool.execute(args, signal);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
