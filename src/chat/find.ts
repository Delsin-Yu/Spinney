/**
 * Conversation search — the **corpus**, the **matcher** and the **order**, with no
 * `vscode` in sight.
 *
 * The user-facing find (`Ctrl+F` / `Ctrl+Shift+F`, `plans/conversation-search.md`)
 * reads the sessions the window already has in memory, never the on-disk
 * transcript dumps: those are not scoped to a workspace (`ChatViewProvider.transcriptRoot`),
 * so a search over them would surface another VS Code window's conversation, while
 * `ChatViewProvider.sessions` is exactly this workspace's (`SessionStore.sessionsDir`
 * is `sessions/<workspaceKey>/`).
 *
 * **The corpus is the question and the final answer of a card, one hit per card.**
 * That is what the card shows the reader: the pinned ask at its top and the prose
 * block after the run of steps. Tool arguments, tool output, thinking, notices and
 * harness notes are deliberately out — "which run printed this" is a question for
 * `search_transcripts`, not for Ctrl+F. Both fields are stored unclipped
 * (`clipDisplayItem` only shrinks tool payloads and a long `thinking`), so the whole
 * answer is searchable.
 *
 * A `bg` card is a command, not a turn, and is skipped.
 */
import { AgentSession, TreeNode } from './tree';
import { clipText } from '../text';

/** Which half of a card a hit came from (§ the corpus rule). */
export type FindField = 'answer' | 'question';

/** Which conversations a query covers. */
export type FindScope = 'session' | 'all';

export interface FindOptions {
  scope: FindScope;
  /** Required for `'session'`; ignored for `'all'`. */
  sessionId?: string;
  query: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  /** Row cap for this query. Default 200, hard cap 500. */
  limit?: number;
  /**
   * `Date.now()` when the caller's budget is spent. The scan stops at the next card
   * boundary past it and reports `timedOut`, so a partial page is never handed back
   * as if it were the end of the history.
   */
  deadlineAt?: number;
}

/** One card that matched: what the results panel renders and what a click jumps to. */
export interface FindHit {
  sessionId: string;
  sessionTitle: string;
  nodeId: string;
  nodeTitle: string;
  /** The card's own kind (`turn`, `compress`, `resume`, `agent`) — the row's chip. */
  nodeKind: string;
  field: FindField;
  /** Root → node, so the panel can say which branch a card is on. */
  branch: string[];
  /** One line around the first match. */
  snippet: string;
  /** The match inside `snippet`; `matchEnd === matchStart` means no mark. */
  matchStart: number;
  matchEnd: number;
}

export interface FindResult {
  hits: FindHit[];
  /** The hits in this answer. `capped` is what says the list was cut. */
  total: number;
  capped: boolean;
  /** The engine's message when the query is not a valid regex. */
  invalid?: string;
  scannedNodes: number;
  scannedSessions: number;
  timedOut: boolean;
  ms: number;
}

/** Rows per query before the list is cut. */
const DEFAULT_LIMIT = 200;
/** The hard ceiling, whatever the caller asks for. */
const MAX_LIMIT = 500;
/** Characters kept on each side of a match in a snippet. */
const SNIPPET_RADIUS = 60;
/** A snippet is one line: this is its whole length, cut through `clipText`. */
const SNIPPET_MAX = 200;
/** Cards between two yields to the event loop. */
const YIELD_EVERY = 16;
/** A card this large is worth a yield on its own, so one answer cannot block a long frame. */
const YIELD_AFTER_CHARS = 64 * 1024;

/** Escape a literal so it can be used as a `RegExp` source. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The query as a reusable pattern, or the engine's own message.
 *
 * Whole word is ignored when the regex toggle is on: that is VS Code's rule, and it
 * has to be, because a `\b` wrapped around a pattern can change what it means.
 */
export function compileQuery(
  query: string,
  opts: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean } = {},
): { source: string; flags: string; error?: string } {
  const flags = opts.caseSensitive ? '' : 'i';
  if (!opts.regex) {
    const literal = escapeRegExp(query);
    return { source: opts.wholeWord ? `\\b${literal}\\b` : literal, flags };
  }
  try {
    // Validate here, so the caller never has to catch around its scan: a pattern the
    // engine refuses is a `FindResult.invalid`, not an exception.
    new RegExp(query, flags);
    return { source: query, flags };
  } catch (err) {
    return { source: '', flags, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * What one card offers a search: its **answer** first, then its **question**.
 *
 * The answer is the last non-empty assistant text (the prose block after the steps),
 * the question is the first `user` item (the pinned ask). The answer leads because a
 * card that matches both should surface the sentence the reader is looking for, and
 * the caller stops at the first matching field.
 */
export function searchableText(node: TreeNode): { field: FindField; text: string }[] {
  if (!node || node.kind === 'bg') {
    return [];
  }
  const items = Array.isArray(node.displayItems) ? node.displayItems : [];
  let question = '';
  let answer = '';
  for (const item of items) {
    if (!item) {
      continue;
    }
    if (item.kind === 'user' && !question && typeof item.text === 'string' && item.text.trim()) {
      question = item.text;
      continue;
    }
    // Overwritten on purpose: the **last** assistant text is the final answer, and
    // every earlier one is a block between two steps.
    if (item.kind === 'assistant' && typeof item.text === 'string' && item.text.trim()) {
      answer = item.text;
    }
  }
  const fields: { field: FindField; text: string }[] = [];
  if (answer) {
    fields.push({ field: 'answer', text: answer });
  }
  if (question) {
    fields.push({ field: 'question', text: question });
  }
  return fields;
}

/**
 * Every node id of a session in **reading order**: each root in `rootIds`, then each
 * node's children in order, depth first. The same order the tree's own gestures and
 * the layout use, so Next walks the results the way the eye does.
 *
 * A node that no root reaches (a corrupt tree) is still searchable: it is walked
 * after the roots instead of being silently unreachable.
 */
export function orderedNodeIds(session: AgentSession): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string): void => {
    const node = id ? session.nodes[id] : undefined;
    if (!node || seen.has(id)) {
      return;
    }
    seen.add(id);
    out.push(id);
    for (const child of node.children || []) {
      walk(child);
    }
  };
  for (const root of session.rootIds || []) {
    walk(root);
  }
  for (const id of Object.keys(session.nodes || {})) {
    walk(id);
  }
  return out;
}

/** Root → node, for the branch a hit sits on. Cycle-safe. */
function branchOf(session: AgentSession, nodeId: string): string[] {
  const path: string[] = [];
  const seen = new Set<string>([nodeId]);
  let cursor = session.nodes[nodeId]?.parentId ?? null;
  while (cursor && session.nodes[cursor] && !seen.has(cursor)) {
    seen.add(cursor);
    path.push(cursor);
    cursor = session.nodes[cursor].parentId ?? null;
  }
  path.reverse();
  path.push(nodeId);
  return path;
}

/** One line: every run of whitespace becomes one space. Offsets are read after this. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The snippet of a match, and where the match sits **inside the snippet**.
 *
 * The text is cut with a radius on each side, collapsed to one line and only then
 * searched again: collapsing changes offsets, so the original match index cannot be
 * carried over. A match spanning a line break may not survive the collapse at all
 * (`foo\nbar` searched as `foo bar`); the snippet is still shown, with an empty mark,
 * and the webview re-locates it with the same matcher.
 */
function makeSnippet(text: string, re: RegExp): { snippet: string; matchStart: number; matchEnd: number } {
  const found = re.exec(text);
  if (!found) {
    return { snippet: '', matchStart: 0, matchEnd: 0 };
  }
  const start = found.index;
  const end = start + (found[0] ? found[0].length : 0);
  const from = Math.max(0, start - SNIPPET_RADIUS);
  const to = Math.min(text.length, end + SNIPPET_RADIUS);
  const line = oneLine(text.slice(from, to));
  const snippet = clipText(line, SNIPPET_MAX);
  const again = re.exec(line);
  if (!again) {
    return { snippet, matchStart: 0, matchEnd: 0 };
  }
  const matchStart = Math.min(again.index, snippet.length);
  const matchEnd = Math.min(again.index + (again[0] ? again[0].length : 0), snippet.length);
  return { snippet, matchStart, matchEnd };
}

/** Default yield: one macrotask, so pending webview/extension messages run. */
function defaultYield(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * One query over the sessions it is given. Never throws: an invalid regex, the match
 * cap and the deadline are all **results**.
 *
 * Bounded three ways, because this runs on the extension host's only JS thread: it
 * yields every {@link YIELD_EVERY} cards (and after a very large one), it stops at
 * `deadlineAt` with `timedOut`, and it stops at `limit` with `capped`. A partial page
 * must never read as the end of the history, which is what `timedOut` is for.
 */
export async function findInSessions(
  sessions: AgentSession[],
  opts: FindOptions,
  yieldTo: () => Promise<void> = defaultYield,
): Promise<FindResult> {
  const started = Date.now();
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT)));
  const result = (extra: Partial<FindResult> = {}): FindResult => ({
    hits: [],
    total: 0,
    capped: false,
    scannedNodes: 0,
    scannedSessions: 0,
    timedOut: false,
    ms: Date.now() - started,
    ...extra,
  });
  const query = opts.query ?? '';
  if (!query.trim()) {
    return result();
  }
  const compiled = compileQuery(query, opts);
  if (compiled.error) {
    return result({ invalid: compiled.error });
  }
  // No `g` flag: one `exec` per field, so `lastIndex` can never leak between cards.
  const re = new RegExp(compiled.source, compiled.flags);
  const scope = (sessions || []).filter(
    (session) => session && (opts.scope !== 'session' || session.id === opts.sessionId),
  );
  // Newest conversation first: an old session is the one the reader is less likely to mean.
  const ordered = opts.scope === 'all' ? [...scope].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)) : scope;
  const hits: FindHit[] = [];
  let scannedNodes = 0;
  let scannedSessions = 0;
  let timedOut = false;
  let capped = false;

  scan: for (const session of ordered) {
    scannedSessions++;
    let sinceYield = 0;
    for (const nodeId of orderedNodeIds(session)) {
      if (opts.deadlineAt !== undefined && Date.now() >= opts.deadlineAt) {
        timedOut = true;
        break scan;
      }
      const node = session.nodes[nodeId];
      if (!node) {
        continue;
      }
      scannedNodes++;
      let chars = 0;
      for (const field of searchableText(node)) {
        chars += field.text.length;
        const found = re.exec(field.text);
        if (!found) {
          continue;
        }
        if (hits.length >= limit) {
          capped = true;
          break scan;
        }
        const { snippet, matchStart, matchEnd } = makeSnippet(field.text, re);
        hits.push({
          sessionId: session.id,
          sessionTitle: session.title || session.id,
          nodeId,
          nodeTitle: node.title || '',
          nodeKind: node.role || node.kind || 'turn',
          field: field.field,
          branch: branchOf(session, nodeId),
          snippet,
          matchStart,
          matchEnd,
        });
        // One hit per card: the answer was looked at first, so a card that matches
        // both fields is reported once, at the sentence the reader is after.
        break;
      }
      sinceYield++;
      if (sinceYield >= YIELD_EVERY || chars >= YIELD_AFTER_CHARS) {
        sinceYield = 0;
        await yieldTo();
        if (opts.deadlineAt !== undefined && Date.now() >= opts.deadlineAt) {
          timedOut = true;
          break scan;
        }
      }
    }
  }

  return {
    hits,
    total: hits.length,
    capped,
    scannedNodes,
    scannedSessions,
    timedOut,
    ms: Date.now() - started,
  };
}
