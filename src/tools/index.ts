import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentTool, ToolDefinition } from '../agent/types';
import { BackgroundRegistry } from './background';
import { makeCheckBackgroundTool, makeJoinBackgroundTool, makeKillBackgroundTool } from './backgroundTools';
import { makeExecCommandTool } from './execCommand';
import { listDirTool } from './listDir';
import { readFileTool } from './readFile';
import { replaceInFileTool } from './replaceInFile';
import { searchFilesTool } from './searchFiles';
import { makeSearchTranscriptsTool } from './searchTranscripts';
import { writeFileTool } from './writeFile';

/**
 * The tool registry and the helpers every tool shares. Each tool's schema and
 * its implementation live together in its own module (`readFile.ts`,
 * `writeFile.ts`, …); this file only wires them into a `ToolRegistry` and holds
 * the cross-cutting helpers (path resolution, line endings, argument parsing,
 * the inline-result cap).
 *
 * The tool modules import these helpers back from here. That import cycle is
 * safe because every use happens inside `execute()` (call time), long after
 * both modules have finished loading — never at module-init time.
 */

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

export function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Operation aborted.');
  }
}

// ---- Line-ending helpers ----
export function detectEol(content: string): string {
  if (content.indexOf('\r\n') !== -1) return '\r\n';
  if (content.indexOf('\n') !== -1) return '\n';
  if (content.indexOf('\r') !== -1) return '\r';
  return '\n';
}

export function toLf(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function applyEol(content: string, eol: string): string {
  if (eol === '\n') return content;
  if (eol === '\r') return content.replace(/\n/g, '\r');
  return content.replace(/\n/g, '\r\n');
}

export function eolLabelOf(content: string): string {
  const eol = detectEol(content);
  return eol === '\r\n' ? 'CRLF' : eol === '\r' ? 'CR' : 'LF';
}

/** Compile a glob (supporting `*` and a recursive `**`) into a regex over slash-joined paths. */
export function globToRegex(glob: string): RegExp {
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

const RAW_TOKEN_RE = /<<<RAW:([A-Za-z0-9_]+)>>>|<<<END_RAW:([A-Za-z0-9_]+)>>>/g;

function truncate(s: string, n = 200): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * Where oversized tool results are spilled. Workspace-local `.agent-harness/`
 * keeps every agent-produced artifact in one place; it falls back to the system
 * temp dir when no workspace folder is open. `.agent-harness` is in `SKIP_DIRS`,
 * so a repo-wide search never returns the agent's own scratch — grep a spilled
 * file by passing its exact path instead (single-file search still works).
 */
function spillDir(): string {
  try {
    return path.join(getWorkspaceRoot(), '.agent-harness', 'tool-output');
  } catch {
    return path.join(os.tmpdir(), 'agent-harness-tool-output');
  }
}

/** Fallback inline cap when `agentHarness.maxInlineToolOutput` is absent. */
const DEFAULT_INLINE_LIMIT = 32 * 1024;

/**
 * Keep a tool result inline when it is small; otherwise write it to a temp file
 * and return a short pointer (path + size + a preview) so a huge result cannot
 * flood the model's context. On any failure the original text is returned, so a
 * result is never lost.
 */
export function limitInline(text: string, tool: string): string {
  const configured = vscode.workspace
    .getConfiguration('agentHarness')
    .get<number>('maxInlineToolOutput');
  const limit = typeof configured === 'number' && configured >= 0 ? configured : DEFAULT_INLINE_LIMIT;
  if (!limit || Buffer.byteLength(text, 'utf8') <= limit) {
    return text;
  }
  try {
    const dir = spillDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(
      dir,
      `${tool}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.txt`,
    );
    fs.writeFileSync(file, text, 'utf8');
    const bytes = Buffer.byteLength(text, 'utf8');
    const lines = text.split('\n');
    const preview = lines.slice(0, 8).join('\n');
    return (
      `[${tool}: result is ${bytes} bytes / ${lines.length} lines — too large to inline.\n` +
      `Full result written to: ${file}\n` +
      `Read it with read_file (line ranges) or grep it with search_files. First lines:]\n${preview}\n…`
    );
  } catch {
    return text;
  }
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

export const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'build', '.agent-harness']);

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();
  /** Tools kept registered (so a call still hits their guard) but not advertised. */
  private hidden = new Set<string>();
  private backgroundRegistry: BackgroundRegistry | null = null;
  /**
   * Transcript roots for `search_transcripts`, resolved at call time (they
   * depend on `agentHarness.subAgentTranscriptDir` and the global-storage path,
   * so a settings change needs no rebuild).
   */
  private transcriptRoots: (() => string[]) | null = null;

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
      makeSearchTranscriptsTool(() => this.transcriptRoots?.() ?? []),
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

  /**
   * Point `search_transcripts` at the transcript roots (the provider owns the
   * config + global-storage path). Passing `null` disables the tool's search
   * (it returns an explicit error instead of silently finding nothing).
   */
  setTranscriptRoots(provider: (() => string[]) | null): void {
    this.transcriptRoots = provider;
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
    sub.hidden = new Set(this.hidden);
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

  /**
   * Hide the named tools from `definitions` (the model never sees them in the
   * tool list) while keeping them registered, so a hallucinated call still hits
   * the runtime guard instead of silently becoming "unknown tool".
   */
  withHidden(names: string[]): ToolRegistry {
    for (const name of names) {
      if (this.tools.has(name)) {
        this.hidden.add(name);
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
    return [...this.tools.entries()]
      .filter(([name]) => !this.hidden.has(name))
      .map(([, t]) => t.definition);
  }

  get names(): string[] {
    return [...this.tools.keys()].filter((name) => !this.hidden.has(name));
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
