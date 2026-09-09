import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentTool, ToolDefinition } from '../agent/types';
import { listTranscriptSessions, searchTranscripts, TranscriptKind } from '../chat/transcript';
import { getShell } from './shell';
import { BackgroundRegistry, CommandHandle, OUTPUT_CAP, spawnShellCommand } from './background';
import { ADVANCED_TOOL_NAMES, makeListAdvancedTool } from './advancedDocs';

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
function limitInline(text: string, tool: string): string {
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

const readFileTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read the contents of a text file. Path may be absolute or relative to the workspace root. Optionally read a specific 1-based line range. Content is returned with LF line endings. The header reports the total line count (wc -l convention: a trailing newline does not add a line) and the on-disk line ending (e.g. CRLF); read a one-line range (startLine 1, endLine 1) when you only need the count. Use read_file output verbatim as replace_in_file oldText.',
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
    // `split` yields a trailing empty element for a newline-terminated file; the
    // real line count (what `wc -l` reports) excludes it, so the header must too.
    const lineCount = normalized === '' ? 0 : normalized.endsWith('\n') ? lines.length - 1 : lines.length;
    const startLine = typeof args.startLine === 'number' ? args.startLine : 1;
    const endLine = typeof args.endLine === 'number' ? args.endLine : lineCount;
    const last = Math.min(endLine, lineCount);
    const slice = lines.slice(Math.max(1, startLine) - 1, Math.max(0, last));
    const header = `File: ${filePath}`;
    if (startLine === 1 && endLine >= lineCount) {
      return `${header} (${lineCount} lines, ${label})\n${normalized}`;
    }
    const numbered = slice.map((line, i) => `${startLine + i}: ${line}`).join('\n');
    return `${header} (lines ${startLine}-${last} of ${lineCount}, ${label})\n${numbered}`;
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
    // A *string* replacement would interpret dollar-ampersand, dollar-backtick,
    // dollar-quote and double-dollar patterns (String.replace semantics), silently
    // mangling the file; the function form inserts newText verbatim.
    const result = matchContent.replace(matchOld, () => matchNew);
    await fs.promises.writeFile(filePath, applyEol(result, eol), 'utf8');
    return `Replaced one occurrence in ${filePath}.`;
  },
};

/** Cap a recursive listing so one call cannot dump an unbounded tree. */
const MAX_LIST_ENTRIES = 2000;

const listDirTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'list_dir',
      description:
        'List the entries of a directory. Path may be absolute or relative to the workspace root. Directories are suffixed with "/". An optional glob filters entries against their path relative to the listed directory (e.g. "*.ts" for top-level, "**/*.ts" for any depth); recursive:true walks subdirectories (heavy dirs node_modules/.git/out/dist/build are skipped) and prints each entry\'s relative path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path.' },
          glob: { type: 'string', description: 'Optional glob filter, e.g. "*.ts" or "**/*.ts".' },
          recursive: { type: 'boolean', description: 'Walk subdirectories (default false).' },
        },
        required: ['path'],
      },
    },
  },
  async execute(args, signal) {
    ensureNotAborted(signal);
    const dirPath = resolvePath(String(args.path ?? '.'));
    const glob = args.glob ? globToRegex(String(args.glob)) : null;
    const recursive = args.recursive === true;
    const out: string[] = [];
    let capped = false;

    const walk = async (dir: string, rel: string): Promise<void> => {
      ensureNotAborted(signal);
      if (out.length >= MAX_LIST_ENTRIES) {
        capped = true;
        return;
      }
      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (out.length >= MAX_LIST_ENTRIES) {
          capped = true;
          return;
        }
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (recursive && !SKIP_DIRS.has(entry.name)) {
            if (!glob || glob.test(relPath)) {
              out.push(`${relPath}/`);
            }
            await walk(path.join(dir, entry.name), relPath);
            continue;
          }
          if (!glob || glob.test(relPath)) {
            out.push(`${relPath}/`);
          }
          continue;
        }
        if (!glob || glob.test(relPath)) {
          out.push(relPath);
        }
      }
    };

    await walk(dirPath, '');
    const names = out.sort().join('\n');
    const suffix = capped ? `\n…[listing stopped at ${MAX_LIST_ENTRIES} entries; narrow it with a glob.]` : '';
    return limitInline(`Directory: ${dirPath}${recursive ? ' (recursive)' : ''}\n${names || '(empty)'}${suffix}`, 'list_dir');
  },
};

// ---- search_files (grep) ----
const MAX_SEARCH_FILE = 1_000_000;
const MAX_SEARCH_FILES = 4000;
const MAX_SEARCH_MATCHES = 300;
const MAX_CONTEXT_LINES = 10;
const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'build', '.agent-harness']);

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

/** Trailing note appended to a search result that stopped before scanning everything. */
function searchCapNote(capped: boolean, maxResults: number, skippedLarge: number): string {
  const notes: string[] = [];
  if (capped) {
    notes.push(
      `reached the ${maxResults}-match cap (hard cap ${MAX_SEARCH_MATCHES}) — results may be incomplete; ` +
        'narrow the pattern, add a glob, or raise maxResults',
    );
  }
  if (skippedLarge > 0) {
    notes.push(`skipped ${skippedLarge} file(s) larger than ${MAX_SEARCH_FILE} bytes`);
  }
  return notes.length ? `\n…[search stopped early: ${notes.join('; ')}.]` : '';
}

const searchFilesTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'search_files',
      description:
        'Search files in the workspace for a regex pattern and return matching "file:line: text" lines (paths are relative to the workspace root). `path` may be a file or a directory (default = workspace root). An optional glob (e.g. "**/*.ts") filters which files are searched; caseSensitive defaults to false; maxResults caps the matches (default 200, hard cap 300); context adds up to 10 surrounding lines per match (context lines use "-" separators, e.g. "src/a.ts-11- text"). Heavy dirs (node_modules/.git/out...) are skipped automatically. When the search stops before scanning everything (match cap / oversized files) the result ends with an explicit note — never treat a capped result as complete.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex to search for (JS regex syntax).' },
          path: { type: 'string', description: 'File or directory to search (default = workspace root).' },
          glob: { type: 'string', description: 'Optional glob filter, e.g. "**/*.ts".' },
          caseSensitive: { type: 'boolean', description: 'Default false.' },
          maxResults: { type: 'number', description: 'Default 200 (capped at 300).' },
          context: { type: 'number', description: 'Lines of context around each match (0-10, default 0).' },
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
    const context =
      typeof args.context === 'number' ? Math.min(Math.max(0, Math.floor(args.context)), MAX_CONTEXT_LINES) : 0;
    let wsRoot: string | null = null;
    try {
      wsRoot = getWorkspaceRoot();
    } catch {
      // No workspace folder: results fall back to absolute paths.
    }

    /** Path shown in a hit: workspace-relative when inside it, else absolute. */
    const display = (full: string): string => {
      if (wsRoot) {
        const rel = path.relative(wsRoot, full).split(path.sep).join('/');
        if (rel && !rel.startsWith('..')) {
          return rel;
        }
      }
      return full.split(path.sep).join('/');
    };

    const results: string[] = [];
    let matches = 0;
    let files = 0;
    let skippedLarge = 0;
    let capped = false;

    /** Append every hit in one file's text (plus optional context lines). */
    const searchText = (text: string, label: string): void => {
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) {
          continue;
        }
        if (matches >= maxResults) {
          capped = true;
          return;
        }
        matches++;
        if (context > 0) {
          const from = Math.max(0, i - context);
          const to = Math.min(lines.length - 1, i + context);
          for (let j = from; j <= to; j++) {
            const sep = j === i ? ':' : '-';
            results.push(`${label}${sep}${j + 1}${sep} ${lines[j].trim().slice(0, 160)}`);
          }
        } else {
          results.push(`${label}:${i + 1}: ${lines[i].trim().slice(0, 160)}`);
        }
      }
    };

    let rootStat;
    try {
      rootStat = await fs.promises.stat(root);
    } catch {
      return `Error: no such file or directory: ${root}`;
    }
    // `path` may name a single file (the parameter says so) — search just it.
    if (rootStat.isFile()) {
      searchText(await fs.promises.readFile(root, 'utf8'), display(root));
      return results.length
        ? limitInline(results.join('\n') + searchCapNote(capped, maxResults, 0), 'search_files')
        : '(no matches)';
    }

    const walk = async (dir: string, rel: string): Promise<void> => {
      if (signal?.aborted) throw new Error('Operation aborted.');
      if (matches >= maxResults || files >= MAX_SEARCH_FILES) {
        capped = true;
        return;
      }
      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (signal?.aborted) throw new Error('Operation aborted.');
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) {
            continue;
          }
          await walk(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
          continue;
        }
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (glob && !glob.test(relPath)) {
          continue;
        }
        files++;
        const full = path.join(dir, entry.name);
        let text: string;
        try {
          const stat = await fs.promises.stat(full);
          if (stat.size > MAX_SEARCH_FILE) {
            skippedLarge++;
            continue;
          }
          text = await fs.promises.readFile(full, 'utf8');
        } catch {
          continue;
        }
        searchText(text, display(full));
        if (matches >= maxResults) {
          capped = true;
          return;
        }
      }
    };

    await walk(root, '');
    return results.length
      ? limitInline(results.join('\n') + searchCapNote(capped, maxResults, skippedLarge), 'search_files')
      : '(no matches)';
  },
};

// ---- search_transcripts (grep the harness's own transcript dumps) ----

/**
 * `search_transcripts` reads the JSONL dumps written by `src/chat/transcript.ts`
 * — one file per main-agent turn (`kind: 'session'`) and per sub-agent run
 * (`kind: 'subagent'`) under `<root>/<sessionId>/<nodeId>.jsonl`. Those folders
 * normally live in the extension's global storage, i.e. **outside** the
 * workspace, so `search_files` cannot reach them.
 *
 * The roots are supplied by the provider (they depend on
 * `agentHarness.subAgentTranscriptDir` and the global-storage path), resolved at
 * call time so a settings change needs no tool rebuild.
 */
function makeSearchTranscriptsTool(getRoots: () => string[]): AgentTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'search_transcripts',
        description:
          'Search the on-disk transcripts of every session (and sub-agent run) for a regex pattern — use this to recall what happened in a previous conversation. Transcripts are JSONL files at <root>/<sessionId>/<nodeId>.jsonl: line 1 is a meta record (kind, session title, node, status, prompt, summary, tool stats) and each following line is one API message rendered as "[role] text → tool(args)". Returns "file:line: text" hits with the ABSOLUTE path, so `read_file <path>` with those line numbers shows the full untruncated record. These folders normally live outside the workspace (extension global storage), so search_files cannot reach them. Omit `query` to get an index of sessions (id, file count, size, last write, titles) — with `sessionId` it lists that session\'s files instead. Optional: sessionId (limit to one session), kind ("session" = main-agent turns, "subagent" = sub-agent runs), caseSensitive (default false), maxResults (default 50, cap 300), context (0-10 neighbouring lines, "-" separators).',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Regex to search for (JS regex syntax). Omit to list sessions instead.' },
            sessionId: { type: 'string', description: 'Limit the search to one session id.' },
            kind: { type: 'string', enum: ['session', 'subagent'], description: 'Limit to main-agent turns or sub-agent runs.' },
            caseSensitive: { type: 'boolean', description: 'Default false.' },
            maxResults: { type: 'number', description: 'Default 50 (capped at 300).' },
            context: { type: 'number', description: 'Lines of context around each hit (0-10, default 0).' },
          },
          required: [],
        },
      },
    },
    async execute(args, signal) {
      ensureNotAborted(signal);
      const roots = getRoots();
      if (roots.length === 0) {
        return 'Error: transcript search is unavailable (no transcript folder).';
      }
      const sessionId = args.sessionId ? String(args.sessionId).trim() : undefined;
      const kindArg = args.kind ? String(args.kind).trim() : '';
      if (kindArg && kindArg !== 'session' && kindArg !== 'subagent') {
        return 'Error: "kind" must be "session" or "subagent".';
      }
      const query = args.query == null ? '' : String(args.query);
      if (!query.trim()) {
        return limitInline(listTranscriptSessions(roots, sessionId).text, 'search_transcripts');
      }
      let result;
      try {
        result = searchTranscripts({
          roots,
          pattern: query,
          sessionId,
          kind: kindArg ? (kindArg as TranscriptKind) : undefined,
          caseSensitive: args.caseSensitive === true,
          maxResults: typeof args.maxResults === 'number' ? args.maxResults : undefined,
          context: typeof args.context === 'number' ? args.context : undefined,
        });
      } catch (err) {
        return `Error: invalid regex: ${err instanceof Error ? err.message : String(err)}`;
      }
      return limitInline(result.text, 'search_transcripts');
    },
  };
}

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

      return limitInline(
        await runForeground(handle, command, cwd, timeoutMs, signal, behavior === 'move_to_background', registry),
        'exec_command',
      );
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
      return limitInline(`${statusLine}${outLine}`, 'check_background_terminal');
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
      return limitInline(`${resultLine}${out ? `\nOutput:\n${out}` : ''}`, 'join_background');
    },
  };
}

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
      makeListAdvancedTool(),
    ]) {
      this.tools.set(tool.definition.function.name, tool);
    }
    // Gradual reveal: the advanced tools stay registered (a call still executes)
    // but are not advertised in the tool list — the model reads the topic doc via
    // `list_advanced_tool` first. `buildTools` never clears `hidden`, so a
    // re-build (setBackgroundRegistry / setTranscriptRoots) keeps them folded.
    for (const name of ADVANCED_TOOL_NAMES) {
      if (this.tools.has(name)) {
        this.hidden.add(name);
      }
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
