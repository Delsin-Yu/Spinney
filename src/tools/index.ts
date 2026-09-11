import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentTool, ToolDefinition } from '../agent/types';
import type { BackgroundAccess } from '../chat/backgroundHub';
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

/**
 * The harness's own storage dir (VS Code global storage), injected once at
 * activation by {@link setHarnessStorageDir}. It is the parent of the
 * no-workspace root below, and the only way a tool can learn about it (tools
 * have no `ExtensionContext`).
 */
let harnessStorageDir: string | null = null;
/** The no-workspace root is created at most once per storage dir. */
let noWorkspaceRootReady = false;

/** Point the harness at its global storage dir (see `docs/agents/no-repo-mode.md`). */
export function setHarnessStorageDir(dir: string | null): void {
  harnessStorageDir = dir;
  noWorkspaceRootReady = false;
}

/** Is a workspace folder open? */
export function hasWorkspaceFolder(): boolean {
  return (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
}

/**
 * Resolve the first workspace folder root. **Throws** when no folder is open —
 * it answers "which folder is the workspace", let {@link getAgentRoot} answer
 * "where do relative paths go" instead.
 */
export function getWorkspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error('No workspace folder is open.');
  }
  return folders[0].uri.fsPath;
}

/** The scratch root that stands in for a workspace folder in no-repo mode. */
function noWorkspaceRoot(): string {
  const base = harnessStorageDir ?? path.join(os.tmpdir(), 'agent-harness-storage');
  return path.join(base, 'no-workspace');
}

export type AgentRootKind = 'workspace' | 'scratch';

/**
 * The one base every relative path and every default `cwd` resolves against:
 * the workspace folder when one is open, otherwise a dedicated scratch root
 * under global storage ("no-repo mode") so the whole tool surface stays usable
 * instead of failing on "No workspace folder is open.".
 *
 * The scratch root is created on demand — the first call may touch the disk.
 */
export function agentRootInfo(): { root: string; kind: AgentRootKind } {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return { root: folders[0].uri.fsPath, kind: 'workspace' };
  }
  const root = noWorkspaceRoot();
  if (!noWorkspaceRootReady) {
    try {
      fs.mkdirSync(root, { recursive: true });
      noWorkspaceRootReady = true;
    } catch {
      // Leave the flag unset so a transient failure is retried on the next call.
    }
  }
  return { root, kind: 'scratch' };
}

/** Shorthand for {@link agentRootInfo}`().root`. */
export function getAgentRoot(): string {
  return agentRootInfo().root;
}

/** Resolve a possibly-relative path against the agent root (workspace folder, or scratch). */
export function resolvePath(input: string): string {
  if (path.isAbsolute(input)) {
    return input;
  }
  return path.resolve(getAgentRoot(), input);
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
 * Where oversized tool results are spilled. Under the agent root, so a
 * workspace-local `.agent-harness/` keeps every agent-produced artifact in one
 * place and no-repo mode gets the same layout inside its scratch root (global
 * storage). `.agent-harness` is in `SKIP_DIRS`, so a repo-wide search never
 * returns the agent's own scratch — grep a spilled file by passing its exact
 * path instead (single-file search still works).
 */
function spillDir(): string {
  try {
    return path.join(getAgentRoot(), '.agent-harness', 'tool-output');
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

/**
 * Catch the one malformed shape the frame contract keeps producing: a payload
 * whose RAW markers sit *inside* the JSON string, e.g.
 * `{ "path": "a.ts", "content": "<<<RAW:content>>>…<<<END_RAW:content>>>" }`.
 * That is **valid JSON**, so {@link parseArgs} returns it untouched and the
 * markers would be written into the file verbatim — silently, because the tool
 * result still reads "Wrote …". Two independent sweeps of this machine's
 * transcripts found 28 such calls out of 962 `frame: true` calls (~2%), which
 * polluted at least six files across three workspaces (one of them a `.mjs` that
 * then died with `SyntaxError: Unexpected token '<<'`).
 *
 * The check is deliberately anchored on **both** boundaries: markers in the
 * middle of a payload are legitimate file text (a fixture, or a document about
 * this very syntax), and only a payload that is *entirely* wrapped in
 * `<<<RAW:key>>>…<<<END_RAW:key>>>` can be nothing but the frame form gone wrong.
 * Rejecting beats silently stripping the markers: a rewrite would be unrecoverable
 * (there is no way to tell a mistake from an intended payload at that point) and
 * would mask the mistake instead of teaching the correct shape.
 */
export function embeddedFrameError(tool: string, key: string, value: string): string | undefined {
  const wrapped = new RegExp(`^\\s*<<<RAW:${key}>>>[\\s\\S]*<<<END_RAW:${key}>>>\\s*$`).test(value);
  if (!wrapped) {
    return undefined;
  }
  return (
    `${tool}: "${key}" is wrapped in RAW markers *inside* the JSON string, so the markers ` +
    `themselves would be written into the file. The frame form puts them outside the JSON — a ` +
    `short header line holding the small fields, then the payload on its own lines:\n` +
    `{ "path": "…" }\n<<<RAW:${key}>>>\n…verbatim text…\n<<<END_RAW:${key}>>>`
  );
}

// ---- Tolerant parameter names + required-argument validation ----

/**
 * Names the model reaches for instead of the schema's own. The schema stays the
 * contract (it is what the API advertises, and the prompt never restates it), so
 * an alias is folded in **only** when the canonical key is absent — a call that
 * already spells the parameter correctly is never touched, and a stray alias key
 * is not left behind for the tool to trip over.
 *
 * `cmd` is not hypothetical: in one machine's transcripts ~100 `exec_command`
 * calls sent it, and every one died on "Command must not be empty." — an error
 * that names neither the missing parameter nor the wrong one, so the agent
 * retried blind instead of renaming the argument.
 */
const ARG_ALIASES: Record<string, Record<string, string>> = {
  exec_command: { cmd: 'command' },
};

/** Fold a tool's aliases into its parsed arguments (see {@link ARG_ALIASES}). */
function applyArgAliases(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const aliases = ARG_ALIASES[tool];
  if (!aliases) {
    return args;
  }
  let out: Record<string, unknown> | undefined;
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (!(alias in args)) {
      continue;
    }
    out = out ?? { ...args };
    const value = out[alias];
    delete out[alias];
    if (out[canonical] === undefined) {
      out[canonical] = value;
    }
  }
  return out ?? args;
}

/** Levenshtein distance — only used to spot a mistyped parameter name. */
function editDistance(a: string, b: string): number {
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    rows.push([i]);
  }
  for (let j = 0; j <= b.length; j++) {
    rows[0][j] = j;
  }
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return rows[a.length][b.length];
}

/** Does `sent` look like a mistyped `required` (`cmd`/`command`, `file`/`path`)? */
function isNearMiss(sent: string, required: string): boolean {
  const a = sent.toLowerCase();
  const b = required.toLowerCase();
  if (a === b) {
    return true; // case-only difference
  }
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 2 && long.startsWith(short)) {
    return true;
  }
  if (short.length >= 3 && long.includes(short)) {
    return true;
  }
  return Math.max(a.length, b.length) >= 5 && editDistance(a, b) <= 2;
}

/**
 * Explain a missing required argument so the model can repair the call instead
 * of retrying it: which argument is absent, the keys it actually sent, the
 * schema's own names, and a "did you mean" when one of them is a near-miss.
 */
function missingArgumentError(
  tool: string,
  missing: string[],
  known: string[],
  received: string[],
): string {
  const hints = missing
    .map((name) => {
      const near = received.find((key) => isNearMiss(key, name));
      return near ? `Did you mean "${name}" instead of "${near}"?` : '';
    })
    .filter(Boolean);
  const plural = missing.length > 1 ? 's' : '';
  return (
    `${tool} is missing required argument${plural} ${missing.map((m) => `"${m}"`).join(', ')}. ` +
    `It sent: ${received.length > 0 ? received.join(', ') : '(nothing)'}. ` +
    hints.join(' ') +
    (hints.length > 0 ? ' ' : '') +
    `Parameters: ${known.join(', ')}.`
  );
}

export const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'build', '.agent-harness']);

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();
  /** Tools kept registered (so a call still hits their guard) but not advertised. */
  private hidden = new Set<string>();
  /**
   * The background-terminal access of the session this registry belongs to: the
   * tools mint jobs under `currentOwner()` (the live run's node, else the view
   * focus) and resolve session-local ids through the shared hub.
   */
  private backgroundAccess: BackgroundAccess | null = null;
  /**
   * Transcript roots for `search_transcripts`, resolved at call time (they
   * depend on `agentHarness.subAgentTranscriptDir` and the global-storage path,
   * so a settings change needs no rebuild).
   */
  private transcriptRoots: (() => string[]) | null = null;

  constructor() {
    this.buildTools();
  }

  /** (Re)build the tool set, wiring the background-aware tools to this session. */
  private buildTools(): void {
    this.tools.clear();
    const getAccess = () => this.backgroundAccess;
    for (const tool of [
      readFileTool,
      writeFileTool,
      replaceInFileTool,
      listDirTool,
      searchFilesTool,
      makeSearchTranscriptsTool(() => this.transcriptRoots?.() ?? []),
      makeExecCommandTool(getAccess),
      makeCheckBackgroundTool(getAccess),
      makeKillBackgroundTool(getAccess),
      makeJoinBackgroundTool(getAccess),
    ]) {
      this.tools.set(tool.definition.function.name, tool);
    }
  }

  /**
   * Point the background-aware tools at this session's access object (one per
   * session runtime). Registries are per (session, node) inside the hub, so a job
   * belongs to the branch that spawned it.
   */
  setBackgroundAccess(access: BackgroundAccess | null): void {
    this.backgroundAccess = access;
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
    // Background-aware sub-agents share the parent's session access: a job a
    // sub-agent spawns belongs to the node whose turn is running.
    sub.backgroundAccess = this.backgroundAccess;
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
    sub.backgroundAccess = this.backgroundAccess;
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
      args = applyArgAliases(name, parseArgs(argsJson || '{}'));
    } catch (err) {
      return `Error: could not parse tool arguments: ${err instanceof Error ? err.message : String(err)}`;
    }
    // Validate the schema's `required` list here, before the tool body runs, so
    // a missing/renamed argument reports *that* instead of whatever the tool
    // happens to make of an absent value (e.g. exec_command's misleading
    // "Command must not be empty.").
    const schema = tool.definition.function.parameters;
    const missing = (schema.required ?? []).filter(
      (key) => args[key] === undefined || args[key] === null,
    );
    if (missing.length > 0) {
      return `Error: ${missingArgumentError(name, missing, Object.keys(schema.properties), Object.keys(args))}`;
    }
    try {
      return await tool.execute(args, signal);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
