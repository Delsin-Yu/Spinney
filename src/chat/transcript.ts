/**
 * Transcript dumps — the harness's on-disk record of what an agent did.
 *
 * Two kinds of transcript share one format and one folder layout:
 *
 *   <root>/<sessionId>/<nodeId>.jsonl
 *
 *   kind 'session'   one *main-agent turn* (the node's own API messages). The
 *                    main agent cannot see a previous session with any tool —
 *                    history lives in the Memento, which no tool can grep — so
 *                    each finished turn is also dumped here.
 *   kind 'subagent'  a finished sub-agent's whole conversation. Its history is
 *                    a display-only sidecar the caller only sees as a summary,
 *                    so the dump is the only way to audit it.
 *
 * Format: JSONL — one JSON object per line, no embedded newlines.
 *
 *   line 1        meta: ids, session title, status, prompt, summary, stats
 *   line 2..N+1   one API message per line (user / assistant / tool)
 *
 * JSONL is deliberate: `read_file` can page it by line number, `search_files` /
 * `search_transcripts` can grep it (e.g. every `read_file` call of a run), and
 * the line index maps 1:1 to a message. A single pretty-printed JSON blob makes
 * all three awkward. A rewrite overwrites the same file.
 *
 * A session transcript deliberately does NOT store the system prompt: it is
 * identical boilerplate (AGENTS.md included) and would make every transcript
 * match a search for any phrase in it. Sub-agent dumps keep it (a sub-agent's
 * prompt is genuinely per-run), and `renderTranscriptLine` hides it from search
 * results either way.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ChatMessage, Usage } from '../agent/types';

/**
 * Tool results that are a runtime denial rather than real output. Anchored and
 * length-capped on purpose: a `read_file` of the source that *defines* these
 * strings (e.g. `src/tools/index.ts`) must not be mistaken for a denial.
 */
const DENIED_RES: RegExp[] = [
  /^Error: "[A-Za-z_]+" is not permitted for this read-only sub-agent\.?$/,
  /^Error: this agent may not (?:spawn|message) sub-agents\b.*$/,
];

function isDenial(text: string): boolean {
  const t = text.trim();
  return t.length < 300 && DENIED_RES.some((re) => re.test(t));
}

export interface TranscriptStats {
  /** Assistant messages that carried tool calls. */
  rounds: number;
  /** Tool name -> number of calls. */
  toolCalls: Record<string, number>;
  /** Tool name -> number of calls refused by the read-only guard. */
  deniedToolCalls: Record<string, number>;
  /** Token totals across the run's rounds (absent when the API reported none). */
  usage?: Usage;
}

export interface SubAgentTranscriptInput {
  /** Absolute directory; created on demand. The file is `<nodeId>.jsonl`. */
  dir: string;
  nodeId: string;
  sessionId: string;
  depth: number;
  write: boolean;
  model: string;
  status: string;
  resumed: boolean;
  /** This run's dispatched instruction (a resume's follow-up, when resumed). */
  instruction: string;
  summary: string;
  startedAt: number;
  endedAt: number;
  /** The sub-agent's synthesized system prompt (stripped from `messages`). */
  systemPrompt: string;
  /** Conversation without the system message. */
  messages: ChatMessage[];
  usage?: Usage;
  /** True when this dump was reconstructed by the one-time backfill. */
  backfilled?: boolean;
}

/** One main-agent turn's dump input (see `writeSessionTranscript`). */
export interface SessionTranscriptInput {
  /** Absolute directory; created on demand. The file is `<nodeId>.jsonl`. */
  dir: string;
  nodeId: string;
  sessionId: string;
  sessionTitle: string;
  parentId: string | null;
  /** Ancestor node ids, root → this node (inclusive). */
  pathIds: string[];
  /** The node's card title (derived from the prompt). */
  title: string;
  model: string;
  /** TurnStatus: 'running' (a turn still open), 'done' | 'interrupted' | 'error'. */
  status: string;
  /** The user prompt that opened this turn (clipped). */
  prompt: string;
  /** First line of the turn's answer (clipped). */
  summary: string;
  startedAt: number;
  endedAt: number;
  /** The turn's own API messages (no system message). */
  messages: ChatMessage[];
  usage?: Usage;
  /** True when this dump was reconstructed by the one-time backfill. */
  backfilled?: boolean;
}

export interface TranscriptRef {
  file: string;
  lines: number;
  bytes: number;
}

/** Kept as an alias: the sub-agent call sites still use this name. */
export type SubAgentTranscriptRef = TranscriptRef;

export type TranscriptKind = 'session' | 'subagent';

/** Tool usage derived from a conversation — the "how did it use the tools" view. */
export function summarizeTranscript(messages: ChatMessage[]): TranscriptStats {
  const stats: TranscriptStats = { rounds: 0, toolCalls: {}, deniedToolCalls: {} };
  const namesById = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      stats.rounds += 1;
      for (const call of msg.tool_calls) {
        const name = call.function?.name || '?';
        stats.toolCalls[name] = (stats.toolCalls[name] ?? 0) + 1;
        if (call.id) {
          namesById.set(call.id, name);
        }
      }
      continue;
    }
    if (msg.role === 'tool' && typeof msg.content === 'string' && isDenial(msg.content)) {
      const name = (msg.tool_call_id ? namesById.get(msg.tool_call_id) : undefined) ?? msg.name ?? '?';
      stats.deniedToolCalls[name] = (stats.deniedToolCalls[name] ?? 0) + 1;
    }
  }
  return stats;
}

/** Sum per-round usage into one total (cache counters included). */
export function sumUsage(usages: Array<Usage | undefined>): Usage | undefined {
  let total: Usage | undefined;
  for (const usage of usages) {
    if (!usage) {
      continue;
    }
    total = total ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    total.prompt_tokens += usage.prompt_tokens ?? 0;
    total.completion_tokens += usage.completion_tokens ?? 0;
    total.total_tokens += usage.total_tokens ?? 0;
    if (usage.prompt_cache_hit_tokens != null) {
      total.prompt_cache_hit_tokens = (total.prompt_cache_hit_tokens ?? 0) + usage.prompt_cache_hit_tokens;
    }
    if (usage.prompt_cache_miss_tokens != null) {
      total.prompt_cache_miss_tokens = (total.prompt_cache_miss_tokens ?? 0) + usage.prompt_cache_miss_tokens;
    }
  }
  return total;
}

/** Shared writer: meta on line 1, then one API message per line. */
function writeTranscriptFile(
  dir: string,
  nodeId: string,
  meta: Record<string, unknown>,
  messages: ChatMessage[],
): TranscriptRef {
  const lines: string[] = [JSON.stringify(meta)];
  messages.forEach((msg, index) => {
    lines.push(JSON.stringify({ type: 'message', index, ...msg }));
  });
  const body = lines.join('\n') + '\n';
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${nodeId}.jsonl`);
  fs.writeFileSync(file, body, 'utf8');
  return { file, lines: lines.length, bytes: Buffer.byteLength(body, 'utf8') };
}

/** Write (or overwrite) a sub-agent's transcript and return its path + size. */
export function writeSubAgentTranscript(input: SubAgentTranscriptInput): TranscriptRef {
  const stats = summarizeTranscript(input.messages);
  if (input.usage) {
    stats.usage = input.usage;
  }
  const meta = {
    type: 'meta',
    kind: 'subagent' as TranscriptKind,
    nodeId: input.nodeId,
    sessionId: input.sessionId,
    depth: input.depth,
    write: input.write,
    model: input.model,
    status: input.status,
    resumed: input.resumed,
    instruction: input.instruction,
    summary: input.summary,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: input.endedAt - input.startedAt,
    messageCount: input.messages.length,
    systemPrompt: input.systemPrompt,
    backfilled: input.backfilled || undefined,
    stats,
  };
  return writeTranscriptFile(input.dir, input.nodeId, meta, input.messages);
}

/**
 * Write (or overwrite) one main-agent turn's transcript. Called from
 * `finishTurn`, so the file always mirrors the node's stored messages — a turn
 * that is later extended (an injected background / sub-agent notice turn reuses
 * its node) is rewritten, exactly like the node itself.
 */
export function writeSessionTranscript(input: SessionTranscriptInput): TranscriptRef {
  const stats = summarizeTranscript(input.messages);
  if (input.usage) {
    stats.usage = input.usage;
  }
  const meta = {
    type: 'meta',
    kind: 'session' as TranscriptKind,
    nodeId: input.nodeId,
    sessionId: input.sessionId,
    sessionTitle: input.sessionTitle,
    parentId: input.parentId,
    pathIds: input.pathIds,
    title: input.title,
    model: input.model,
    status: input.status,
    prompt: input.prompt,
    summary: input.summary,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: input.endedAt - input.startedAt,
    messageCount: input.messages.length,
    backfilled: input.backfilled || undefined,
    stats,
  };
  return writeTranscriptFile(input.dir, input.nodeId, meta, input.messages);
}

/** Remove a session's transcript folder (best effort — never throws). */
export function removeTranscriptDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Nothing to clean up, or the folder is in use; ignore.
  }
}

/** Node ids are generated (`newId`), so anything else is not a transcript name. */
const SAFE_NODE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Remove the dumps of specific nodes — `<dir>/<nodeId>.jsonl` each — and return
 * how many files actually existed. Used when a branch is deleted, so the on-disk
 * record matches the history that is kept. Best effort (never throws).
 */
export function removeTranscripts(dir: string, nodeIds: string[]): number {
  let removed = 0;
  for (const nodeId of nodeIds) {
    if (!SAFE_NODE_ID.test(nodeId)) {
      continue;
    }
    const file = path.join(dir, `${nodeId}.jsonl`);
    try {
      if (fs.existsSync(file)) {
        fs.rmSync(file, { force: true });
        removed++;
      }
    } catch {
      // In use / permissions: leave it rather than breaking the deletion.
    }
  }
  return removed;
}

/**
 * Remove one transcript file by its recorded absolute path (a sub-agent node
 * keeps `agentTranscript`, which may point at a transcript root the setting has
 * since changed). Only `*.jsonl` absolute paths are touched. Best effort.
 */
export function removeTranscriptFile(file: string): boolean {
  if (!file || !file.endsWith('.jsonl') || !path.isAbsolute(file)) {
    return false;
  }
  try {
    if (!fs.existsSync(file)) {
      return false;
    }
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

// ---- Reading / searching ----

const MAX_TRANSCRIPT_MATCHES = 300;
const MAX_TRANSCRIPT_FILE = 8 * 1024 * 1024;
const MAX_TRANSCRIPT_FILES = 20000;
const MAX_CONTEXT_LINES = 10;

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) + '…' : one;
}

/** Flatten a message's content (string or content-part array) to plain text. */
function contentText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') {
      continue;
    }
    const p = part as Record<string, unknown>;
    if (p.type === 'text') {
      parts.push(String(p.text ?? ''));
    } else if (p.type === 'file') {
      parts.push(`[image ${String(p.file_id ?? '')}]`);
    } else if (p.type === 'image_url') {
      parts.push('[image]');
    }
  }
  return parts.join(' ');
}

/**
 * Render one transcript line (a JSON object) as a single searchable line:
 * a meta record as `[meta] key=value …`, a message as `[role] text → tool(args)`.
 * A line that is not JSON is returned as-is. The system prompt is never
 * rendered, so boilerplate cannot drown a real hit.
 */
export function renderTranscriptLine(raw: string): string {
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return raw;
    }
    obj = parsed as Record<string, unknown>;
  } catch {
    return raw;
  }
  if (obj.type === 'meta') {
    const parts: string[] = ['[meta]'];
    const add = (key: string, value: unknown): void => {
      if (value === undefined || value === null || value === '') {
        return;
      }
      parts.push(`${key}=${clip(String(value), 400)}`);
    };
    add('kind', obj.kind ?? 'subagent');
    // Right after `kind`: the preview is clipped to 200 chars, so a marker at
    // the end of the line would be invisible exactly when it matters most.
    if (obj.backfilled) {
      parts.push('backfilled=true');
    }
    add('session', obj.sessionId);
    add('title', obj.sessionTitle ?? obj.title);
    add('node', obj.nodeId);
    add('status', obj.status);
    add('model', obj.model);
    add('prompt', obj.prompt ?? obj.instruction);
    add('summary', obj.summary);
    const stats = obj.stats as TranscriptStats | undefined;
    if (stats && stats.toolCalls) {
      const calls = Object.entries(stats.toolCalls)
        .map(([name, count]) => `${name}×${count}`)
        .join(',');
      if (calls) {
        parts.push(`tools=${calls}`);
      }
    }
    return parts.join(' ');
  }
  const role = typeof obj.role === 'string' ? obj.role : '?';
  const parts: string[] = [`[${role}]`];
  if (typeof obj.name === 'string' && obj.name) {
    parts.push(`(${obj.name})`);
  }
  const text = contentText(obj.content);
  if (text) {
    parts.push(clip(text, 400));
  }
  if (Array.isArray(obj.tool_calls)) {
    for (const call of obj.tool_calls as Array<Record<string, unknown>>) {
      const fn = (call?.function ?? {}) as Record<string, unknown>;
      parts.push(`→ ${String(fn.name ?? '?')}(${clip(String(fn.arguments ?? ''), 200)})`);
    }
  }
  const reasoning = typeof obj.reasoning_content === 'string' ? obj.reasoning_content : '';
  if (reasoning) {
    parts.push(`<thinking> ${clip(reasoning, 200)}`);
  }
  return parts.join(' ');
}

/** Read a transcript's first line without loading the whole file. */
function readFirstLine(file: string): string {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(65536);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, read).toString('utf8');
    const nl = text.indexOf('\n');
    return nl === -1 ? text : text.slice(0, nl);
  } finally {
    fs.closeSync(fd);
  }
}

/** Extract a string field from a meta line (tolerates a truncated line). */
function metaField(metaLine: string, key: string): string | undefined {
  const match = new RegExp(`"${key}":("(?:[^"\\\\]|\\\\.)*")`).exec(metaLine);
  if (!match) {
    return undefined;
  }
  try {
    return JSON.parse(match[1]) as string;
  } catch {
    return undefined;
  }
}

function metaKind(metaLine: string): TranscriptKind {
  return metaField(metaLine, 'kind') === 'session' ? 'session' : 'subagent';
}

interface TranscriptFileRef {
  file: string;
  session: string;
}

/**
 * Every `<sessionId>/*.jsonl` under the roots (also tolerating `.jsonl` files
 * directly in a root). `sessionId` restricts the walk to that one folder.
 */
function listTranscriptFiles(roots: string[], sessionId?: string): { files: TranscriptFileRef[]; capped: boolean } {
  const out: TranscriptFileRef[] = [];
  let capped = false;
  const walk = (dir: string, session: string, depth: number): void => {
    if (out.length >= MAX_TRANSCRIPT_FILES) {
      capped = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_TRANSCRIPT_FILES) {
        capped = true;
        return;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth >= 2) {
          continue;
        }
        if (sessionId && depth === 0 && entry.name !== sessionId) {
          continue;
        }
        walk(full, session || entry.name, depth + 1);
        continue;
      }
      if (!entry.name.endsWith('.jsonl')) {
        continue;
      }
      out.push({ file: full, session: session || path.basename(path.dirname(full)) });
    }
  };
  for (const root of roots) {
    if (sessionId) {
      const dir = path.join(root, sessionId);
      if (fs.existsSync(dir)) {
        walk(dir, sessionId, 0);
      }
      continue;
    }
    walk(root, '', 0);
  }
  return { files: out, capped };
}

export interface TranscriptSearchOptions {
  /** Transcript roots; each holds one folder per session. */
  roots: string[];
  /** Regex (JS syntax). Required for a search. */
  pattern: string;
  /** Restrict to one session folder. */
  sessionId?: string;
  /** Restrict to main-agent turns or sub-agent runs. */
  kind?: TranscriptKind;
  caseSensitive?: boolean;
  /** Default 50, hard cap 300. */
  maxResults?: number;
  /** Neighbouring lines per hit (0–10, default 0). */
  context?: number;
}

export interface TranscriptSearchResult {
  text: string;
  matches: number;
  files: number;
  scanned: number;
  capped: boolean;
}

/**
 * Grep every transcript line for `pattern` and return `file:line: text` hits
 * (context lines use `-` separators, like `search_files`). Invalid regex throws.
 */
export function searchTranscripts(opts: TranscriptSearchOptions): TranscriptSearchResult {
  const re = new RegExp(opts.pattern, opts.caseSensitive ? '' : 'i');
  const maxResults = Math.min(Math.max(1, opts.maxResults ?? 50), MAX_TRANSCRIPT_MATCHES);
  const context = Math.min(Math.max(0, Math.floor(opts.context ?? 0)), MAX_CONTEXT_LINES);
  const { files, capped: listCapped } = listTranscriptFiles(opts.roots, opts.sessionId);
  const results: string[] = [];
  let matches = 0;
  let scanned = 0;
  let skippedLarge = 0;
  let capped = listCapped;

  for (const ref of files) {
    if (matches >= maxResults) {
      capped = true;
      break;
    }
    let raw: string;
    try {
      if (fs.statSync(ref.file).size > MAX_TRANSCRIPT_FILE) {
        skippedLarge++;
        continue;
      }
      raw = fs.readFileSync(ref.file, 'utf8');
    } catch {
      continue;
    }
    const rawLines = raw.split('\n');
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
      rawLines.pop();
    }
    if (rawLines.length === 0) {
      continue;
    }
    if (opts.kind && metaKind(rawLines[0]) !== opts.kind) {
      continue;
    }
    scanned++;
    const rendered = rawLines.map(renderTranscriptLine);
    for (let i = 0; i < rendered.length; i++) {
      if (!re.test(rendered[i])) {
        continue;
      }
      if (matches >= maxResults) {
        capped = true;
        break;
      }
      matches++;
      if (context > 0) {
        const from = Math.max(0, i - context);
        const to = Math.min(rendered.length - 1, i + context);
        for (let j = from; j <= to; j++) {
          const sep = j === i ? ':' : '-';
          results.push(`${ref.file}${sep}${j + 1}${sep} ${clip(rendered[j], 200)}`);
        }
      } else {
        results.push(`${ref.file}:${i + 1}: ${clip(rendered[i], 200)}`);
      }
    }
  }

  const notes: string[] = [];
  if (capped) {
    notes.push(
      `reached the ${maxResults}-match cap (hard cap ${MAX_TRANSCRIPT_MATCHES}) — narrow the pattern or pass sessionId`,
    );
  }
  if (skippedLarge > 0) {
    notes.push(`skipped ${skippedLarge} file(s) larger than ${MAX_TRANSCRIPT_FILE} bytes`);
  }
  const note = notes.length ? `\n…[search stopped early: ${notes.join('; ')}.]` : '';
  const text = results.length
    ? results.join('\n') + note
    : `(no matches in ${scanned} transcript file(s)${
        opts.sessionId ? ` for session ${opts.sessionId}` : ''
      }${opts.kind ? ` of kind ${opts.kind}` : ''})${note}`;
  return { text, matches, files: files.length, scanned, capped };
}

export interface TranscriptSessionInfo {
  sessionId: string;
  files: number;
  bytes: number;
  updatedAt: number;
  kinds: Record<string, number>;
  titles: string[];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Index of what is on disk: one line per session (file count, size, last write,
 * kind mix, titles), newest first. With `sessionId` the files of that session
 * are listed instead — the cheap way to answer "what sessions / turns exist?".
 */
export function listTranscriptSessions(
  roots: string[],
  sessionId?: string,
): { sessions: TranscriptSessionInfo[]; text: string } {
  const { files } = listTranscriptFiles(roots, sessionId);
  const bySession = new Map<string, TranscriptSessionInfo>();
  const perFile: string[] = [];
  for (const ref of files) {
    let stat: fs.Stats;
    let firstLine = '';
    try {
      stat = fs.statSync(ref.file);
      firstLine = readFirstLine(ref.file);
    } catch {
      continue;
    }
    const kind = metaKind(firstLine);
    let info = bySession.get(ref.session);
    if (!info) {
      info = { sessionId: ref.session, files: 0, bytes: 0, updatedAt: 0, kinds: {}, titles: [] };
      bySession.set(ref.session, info);
    }
    info.files++;
    info.bytes += stat.size;
    info.updatedAt = Math.max(info.updatedAt, stat.mtimeMs);
    info.kinds[kind] = (info.kinds[kind] ?? 0) + 1;
    const title = metaField(firstLine, 'sessionTitle') ?? metaField(firstLine, 'title');
    if (title && !info.titles.includes(title) && info.titles.length < 4) {
      info.titles.push(title);
    }
    if (sessionId) {
      const label = metaField(firstLine, 'title') ?? metaField(firstLine, 'summary') ?? '';
      perFile.push(
        `${path.basename(ref.file)}  ${kind}  ${formatBytes(stat.size)}  ${formatTime(stat.mtimeMs)}  ${clip(label, 100)}`,
      );
    }
  }
  const sessions = [...bySession.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  const head = `transcript root(s): ${roots.join(', ')}`;
  if (sessionId) {
    if (sessions.length === 0) {
      return { sessions, text: `${head}\n(no transcript files for session ${sessionId})` };
    }
    return {
      sessions,
      text: `${head}\nsession ${sessionId}: ${sessions[0].files} file(s), ${formatBytes(sessions[0].bytes)}\n${perFile
        .sort()
        .join('\n')}`,
    };
  }
  if (sessions.length === 0) {
    return { sessions, text: `${head}\n(no transcripts yet)` };
  }
  const lines = sessions.map((info) => {
    const kinds = Object.entries(info.kinds)
      .map(([kind, count]) => `${kind}×${count}`)
      .join(' ');
    const titles = info.titles.length ? `  ${info.titles.map((t) => `"${clip(t, 60)}"`).join(' | ')}` : '';
    return `${info.sessionId}  ${info.files} file(s)  ${formatBytes(info.bytes)}  ${formatTime(
      info.updatedAt,
    )}  ${kinds}${titles}`;
  });
  return { sessions, text: `${head}\n${lines.join('\n')}` };
}
