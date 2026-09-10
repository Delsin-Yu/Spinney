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
  '你是一个会话命名助手。根据给出的对话摘要，为这个会话取一个简短标题。',
  '要求：',
  '- 只输出标题本身，不要解释、不要引号、不要句末标点、不要换行、不要 markdown。',
  '- 中文优先，保留必要的英文技术名词。',
  '- 6–20 个字符，概括会话的主题与当前进展（写「在做什么」，不是「用户怎么问的」）。',
].join('\n');

export const TITLE_BATCH_SYSTEM_PROMPT = [
  '你是一个会话命名助手。下面有若干个会话，每个会话有编号（S1、S2…）、当前标题和对话摘要。',
  '为每个会话各输出一行，格式严格为：S编号|标题',
  '标题要求：中文优先，6–20 个字符，单行，不要引号、句末标点、换行或 markdown，概括该会话的主题与当前进展。',
  '只输出这些行，不要输出解释、不要小标题、不要空行。',
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
      lines.push(`…（中间省略 ${turns.length - picked.length} 个回合）`);
    }
    const node = picked[i];
    const prompt = clipLine(firstUserText(node), 240);
    if (prompt) {
      lines.push(`- 用户：${prompt}`);
    }
    const answer = clipLine(lastAssistantText(node), 200);
    if (answer) {
      lines.push(`  助手：${answer}`);
    }
    const tools = toolNames(node);
    if (tools.length > 0) {
      lines.push(`  工具：${tools.join(', ')}`);
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
    .replace(/^["'“”‘’《》「」【】\s]+/, '')
    .replace(/["'“”‘’《》「」【】\s]+$/, '')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[。．.,，;；:：!！?？~～、|｜]+$/, '')
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
        `当前标题（可参考，不必沿用）：${currentTitle || '(无)'}\n\n` +
        `对话摘要：\n${digest}\n\n请输出标题：`,
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
    (entry, i) => `S${i + 1}｜当前标题：${entry.currentTitle || '(无)'}\n摘要：\n${entry.digest}`,
  );
  return [
    { role: 'system', content: TITLE_BATCH_SYSTEM_PROMPT },
    { role: 'user', content: `${blocks.join('\n\n')}\n\n请为每个会话输出一行：` },
  ];
}

/**
 * Parse a batched reply (`S3|标题`, `3. 标题`, …) into one title per entry.
 * Unparsed / unusable lines stay null so the caller can fall back per session.
 */
export function parseBatchTitles(raw: string, count: number): Array<string | null> {
  const out: Array<string | null> = new Array(count).fill(null);
  for (const line of (raw || '').split('\n')) {
    const match = line.trim().match(/^S?\s*(\d+)\s*[|｜:：.)、]\s*(.+)$/i);
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
