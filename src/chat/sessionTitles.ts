/**
 * Automatic session titles — pure prompt/data helpers (no VS Code APIs).
 *
 * A session title used to be the first 40 characters of the first user message
 * and never changed again. Here a title is derived from the *conversation*: a
 * short model-generated name after the first turn, refreshed when the
 * conversation has grown enough, with a zero-cost heuristic fallback (the first
 * prompt) whenever the model call fails or is unavailable. An explicit rename
 * (sidebar command or the `rename_session` tool) locks the title, so the
 * automatic namer never overwrites a name a human or the agent chose.
 *
 * Kept free of VS Code imports so it can be exercised outside the Extension
 * Host by a plain node script (require the compiled `out/chat/sessionTitles.js`).
 */
import { ChatMessage } from '../agent/types';
import { AgentSession, TitleSource, TreeNode, isSidecar, messageText } from './tree';

/** Hard cap on a stored title (the sidebar / panel budget). */
export const AUTO_TITLE_MAX_CHARS = 40;
/** Don't re-title a session more often than this. */
export const AUTO_TITLE_COOLDOWN_MS = 2 * 60 * 1000;
/** Re-title only after this many further turns landed since the last auto title. */
export const AUTO_TITLE_GROWTH_NODES = 2;
/** Completion budget for a single title. */
export const TITLE_MAX_TOKENS = 40;
/** Completion budget for one backfill batch (one line per session). */
export const TITLE_BATCH_MAX_TOKENS = 512;
/** How many sessions one backfill request may cover. */
export const TITLE_BATCH_SIZE = 6;

export const TITLE_SYSTEM_PROMPT = [
  'You name chat sessions. From the conversation digest you are given, produce a short title for the session.',
  'Rules:',
  '- Output the title alone: no explanation, no quotes, no trailing punctuation, no line breaks, no markdown.',
  '- Use the language the conversation is mostly written in; keep technical terms (identifiers, file names, API names) as they are.',
  '- Short — about 6–20 characters (a few words) — capturing the subject and where the work stands (what is being done, not how the user asked).',
].join('\n');

export const TITLE_BATCH_SYSTEM_PROMPT = [
  'You name chat sessions. Below are several sessions, each with an index (S1, S2, …), its current title and a digest of its conversation.',
  'For each session output exactly one line, strictly in the form: S<index>|<title>',
  'Title rules: use the language the conversation is mostly written in; about 6–20 characters; one line; no quotes, trailing punctuation, line breaks or markdown; capture the subject and where the work stands.',
  'Output only those lines: no explanation, no headings, no blank lines.',
].join('\n');

/** Main-agent turns that carry a conversation (sidecar cards excluded). */
export function turnCount(session: AgentSession): number {
  return Object.values(session.nodes).filter((n) => !isSidecar(n) && n.messages.length > 0).length;
}

/** True when at least one main turn has a non-empty user prompt to name from. */
export function hasNameableContent(session: AgentSession): boolean {
  return Object.values(session.nodes).some(
    (n) => !isSidecar(n) && n.messages.some((m) => m.role === 'user' && !!messageText(m.content).trim()),
  );
}

/**
 * Whether the automatic namer should (re)title this session now: never for a
 * locked title, only once there is something to name, and — for a session it
 * already named — only after the conversation grew by `AUTO_TITLE_GROWTH_NODES`
 * turns and the cooldown elapsed. Sessions from before automatic naming have no
 * `titleAutoAt`, so they are eligible immediately (that is the backfill).
 */
export function shouldAutoTitle(session: AgentSession, now = Date.now()): boolean {
  if (session.titleLocked) {
    return false;
  }
  if (!hasNameableContent(session)) {
    return false;
  }
  const lastAt = session.titleAutoAt ?? 0;
  if (!lastAt) {
    return true;
  }
  if (turnCount(session) < (session.titleAutoNodes ?? 0) + AUTO_TITLE_GROWTH_NODES) {
    return false;
  }
  return now - lastAt >= AUTO_TITLE_COOLDOWN_MS;
}

/** First non-empty user text of a turn node ('' when the prompt was image-only). */
function firstUserText(node: TreeNode): string {
  for (const message of node.messages) {
    if (message.role === 'user') {
      const text = messageText(message.content).trim();
      if (text) {
        return text;
      }
    }
  }
  return '';
}

/** Last non-empty assistant text of a turn node ('' for a tool-only turn). */
function lastAssistantText(node: TreeNode): string {
  for (let i = node.messages.length - 1; i >= 0; i--) {
    const message = node.messages[i];
    if (message.role !== 'assistant') {
      continue;
    }
    const text = messageText(message.content).trim();
    if (text) {
      return text;
    }
  }
  return '';
}

/** Distinct tool names a turn called, in first-use order. */
function toolNames(node: TreeNode): string[] {
  const out: string[] = [];
  for (const message of node.messages) {
    for (const call of message.tool_calls ?? []) {
      const name = call.function?.name;
      if (name && !out.includes(name)) {
        out.push(name);
      }
    }
  }
  return out;
}

/** Collapse to one line and clip (a digest line must stay a single line). */
function clipLine(text: string, limit: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > limit ? `${one.slice(0, limit)}…` : one;
}

/** Main-agent turns in creation order (sidecar cards excluded). */
function orderedTurns(session: AgentSession): TreeNode[] {
  return Object.values(session.nodes)
    .filter((n) => !isSidecar(n) && n.messages.length > 0)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * A compact, model-friendly digest of the conversation: the first turn plus the
 * most recent ones (older middles are elided), each as prompt → answer → tools.
 * Returns '' when the session has nothing to name.
 */
export function buildTitleDigest(session: AgentSession, maxChars = 4000): string {
  const turns = orderedTurns(session);
  if (turns.length === 0) {
    return '';
  }
  const picked = turns.length <= 8 ? turns : [turns[0], ...turns.slice(-7)];
  const lines: string[] = [];
  for (let i = 0; i < picked.length; i++) {
    if (i === 1 && picked.length < turns.length) {
      lines.push(`…(${turns.length - picked.length} turn(s) in between elided)`);
    }
    const node = picked[i];
    const prompt = clipLine(firstUserText(node), 240);
    if (prompt) {
      lines.push(`- User: ${prompt}`);
    }
    const answer = clipLine(lastAssistantText(node), 200);
    if (answer) {
      lines.push(`  Assistant: ${answer}`);
    }
    const tools = toolNames(node);
    if (tools.length > 0) {
      lines.push(`  Tools: ${tools.join(', ')}`);
    }
    if (lines.join('\n').length > maxChars) {
      break;
    }
  }
  return lines.join('\n').slice(0, maxChars);
}

/** Zero-cost fallback title: the first prompt of the session. */
export function heuristicTitle(session: AgentSession): string {
  for (const node of orderedTurns(session)) {
    const text = firstUserText(node);
    if (text) {
      return sanitizeTitle(text, 'New session');
    }
  }
  return 'New session';
}

/**
 * Normalize whatever the model produced into a storable title: first non-empty
 * line, quotes/emphasis/heading noise stripped, trailing punctuation dropped,
 * whitespace collapsed, clipped to `AUTO_TITLE_MAX_CHARS`. Returns `fallback`
 * when nothing usable is left.
 *
 * The noise classes spell their non-ASCII members as escapes: a title may still
 * come back wrapped in the CJK quote pairs or ending on a full-width comma
 * (`\u201c` `\u201d` `\u300a` `\u3002` …), and writing them this way keeps this
 * file free of literal CJK characters.
 */
export function sanitizeTitle(raw: string, fallback: string): string {
  const line = (raw || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) {
    return fallback;
  }
  const cleaned = line
    .replace(/^[#>*\-\s]+/, '')
    .replace(/^["'\u201c\u201d\u2018\u2019\u300a\u300b\u300c\u300d\u3010\u3011\s]+/, '')
    .replace(/["'\u201c\u201d\u2018\u2019\u300a\u300b\u300c\u300d\u3010\u3011\s]+$/, '')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[\u3002\uff0e.,\uff0c;\uff1b:\uff1a!\uff01?\uff1f~\uff5e\u3001|\uff5c]+$/, '')
    .trim();
  if (!cleaned) {
    return fallback;
  }
  return cleaned.slice(0, AUTO_TITLE_MAX_CHARS);
}

/** Messages for naming one session. */
export function buildTitleMessages(digest: string, currentTitle: string): ChatMessage[] {
  return [
    { role: 'system', content: TITLE_SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `Current title (for reference, may be replaced): ${currentTitle || '(none)'}\n\n` +
        `Conversation digest:\n${digest}\n\nOutput the title:`,
    },
  ];
}

/** One session in a batched backfill request. */
export interface BatchTitleEntry {
  id: string;
  currentTitle: string;
  digest: string;
}

/** Messages naming several sessions in one request (used by the backfill). */
export function buildBatchTitleMessages(entries: BatchTitleEntry[]): ChatMessage[] {
  const blocks = entries.map(
    (entry, i) => `S${i + 1}|Current title: ${entry.currentTitle || '(none)'}\nDigest:\n${entry.digest}`,
  );
  return [
    { role: 'system', content: TITLE_BATCH_SYSTEM_PROMPT },
    { role: 'user', content: `${blocks.join('\n\n')}\n\nOutput one line per session:` },
  ];
}

/**
 * Parse a batched reply (`S3|Title`, `3. Title`, …) into one title per entry.
 * Unparsed / unusable lines stay null so the caller can fall back per session.
 */
export function parseBatchTitles(raw: string, count: number): Array<string | null> {
  const out: Array<string | null> = new Array(count).fill(null);
  for (const line of (raw || '').split('\n')) {
    // The separator class spans the ASCII and the full-width forms a model may
    // still emit (`\uff5c` `\uff1a` `\u3001`) — written as escapes so this file
    // carries no CJK characters.
    const match = line.trim().match(/^S?\s*(\d+)\s*[|\uff5c:\uff1a.)\u3001]\s*(.+)$/i);
    if (!match) {
      continue;
    }
    const index = Number(match[1]) - 1;
    if (index < 0 || index >= count || out[index]) {
      continue;
    }
    const title = sanitizeTitle(match[2], '');
    if (title) {
      out[index] = title;
    }
  }
  return out;
}
