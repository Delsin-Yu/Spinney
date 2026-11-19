/**
 * A **diagnostic fixture**: a conversation built from a spec, so a rendering defect that
 * only shows up on a long session can be reproduced in seconds instead of hours of use.
 *
 * Why it exists: the stutter being chased here grows with a session's size (cards, rows,
 * the canvas layer, the megabytes a repaint ships) and a reload clears the accumulated
 * renderer state that makes it slow. Without a conversation of a controlled size there is
 * nothing to compare a freshly reloaded document against, and waiting for a real one to
 * grow costs hours that cannot be repeated on demand.
 *
 * It is a **debug-build path**, reached from `Spinney: Import Session Data` when the picked
 * folder holds {@link PERF_FIXTURE_FILE} (see {@link readPerfFixtureSpec}). Nothing here
 * talks to the model, the network or the store: it returns an {@link AgentSession} and its
 * summary, and the caller writes them through the same `writeSession` path every real
 * session uses.
 */

import * as fs from 'fs';
import * as path from 'path';
import { AgentSession, DisplayItem, TreeNode } from './tree';
import { ChatMessage, Usage } from '../agent/types';
import { SessionSummary } from './sessionStore';

/** The marker file a picked folder must hold to be read as a fixture spec. */
export const PERF_FIXTURE_FILE = 'spinney-perf-fixture.json';

/** What a fixture is built from; every field is optional and defaults below apply. */
export interface PerfFixtureSpec {
  /** Turn nodes in the chain (default 60, clamped to 1..400). */
  nodes?: number;
  /** Characters of assistant markdown per turn (default 6000). */
  answerChars?: number;
  /** Tool rows per turn, each with a `toolChars` result (default 6). */
  toolsPerTurn?: number;
  /** Characters of a tool result (default 20000). */
  toolChars?: number;
  /** Title prefix; the node count is appended to it (default `PERF FIXTURE`). */
  title?: string;
  /**
   * Prompt-cache hit rates to cycle over the turns, in percent (100 = every token came out
   * of the provider's cache). Each turn gets one `usage` on its closing answer, the shape a
   * real turn leaves behind, so the card's ring can be read without a provider
   * (`docs/agents/invariants/chat-tree.md`). A `null` entry is a turn whose provider
   * reported no cache fields at all — the "unknown rate, keep the accent" half of the same
   * rule. Absent or empty leaves every turn without usage, which is what every fixture did
   * before this existed.
   */
  cacheRates?: (number | null)[];
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** A session-id-shaped random id (the store treats it as an opaque name). */
function makeId(prefix: string): string {
  let id = prefix;
  while (id.length < 14) {
    id += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return id;
}

/** ASCII filler text, `chars` long: no unicode, so a fixture can never trip `check:unicode`. */
function filler(chars: number, tag: string): string {
  const unit = `${tag}: the fixture repeats this line to grow a log without a model. `;
  let text = '';
  while (text.length < chars) {
    text += unit;
  }
  return text.slice(0, Math.max(0, chars));
}

/**
 * Markdown-shaped prose, because the cost this fixture must reproduce is mostly
 * **elements**, not bytes: paragraphs, a list and a fenced block each become their own DOM
 * subtree when the answer is rendered, and a flat string of the same length would not.
 */
function answerMarkdown(chars: number, turn: number): string {
  const body = filler(Math.max(400, Math.floor(chars / 3)), `Answer ${turn}`);
  const list = [1, 2, 3, 4, 5]
    .map((n) => `${n}. Step ${n} of turn ${turn} does one thing and records it.`)
    .join('\n');
  const code = ['const fixture = (turn: number) => {', '  return turn * 2;', '};', 'export default fixture;']
    .map((line) => `    ${line}`)
    .join('\n');
  return (
    `## Turn ${turn}\n\n${body}\n\n${body}\n\n${list}\n\n\`\`\`ts\n${code}\n\`\`\`\n\n` +
    `${filler(Math.max(200, Math.floor(chars / 4)), `Closing ${turn}`)}`
  ).slice(0, Math.max(400, chars));
}

/** Read a fixture spec out of `dir`, or `null` when the marker file is absent or broken. */
export function readPerfFixtureSpec(dir: string): PerfFixtureSpec | null {
  try {
    const file = path.join(dir, PERF_FIXTURE_FILE);
    if (!fs.existsSync(file)) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as PerfFixtureSpec)
      : {};
  } catch {
    return null;
  }
}

/** Build the fixture session and the summary the store's index holds for it. */
export function buildPerfFixture(spec: PerfFixtureSpec): {
  session: AgentSession;
  summary: SessionSummary;
} {
  const count = Math.max(1, Math.min(400, Math.floor(spec.nodes ?? 60)));
  const answerChars = Math.max(400, Math.floor(spec.answerChars ?? 6000));
  const toolsPerTurn = Math.max(0, Math.min(40, Math.floor(spec.toolsPerTurn ?? 6)));
  const toolChars = Math.max(0, Math.floor(spec.toolChars ?? 20000));
  // The cache rates a fixture cycles over its turns: clamped, and `null` kept as "the
  // provider reported nothing" (`nodeCacheRate` returns undefined for those).
  const cacheRates = (Array.isArray(spec.cacheRates) ? spec.cacheRates : [])
    .filter((rate) => rate === null || (typeof rate === 'number' && Number.isFinite(rate)))
    .map((rate) => (rate === null ? null : Math.max(0, Math.min(100, rate))));
  /**
   * The `usage` one turn leaves behind when a cache rate is asked for: the closing answer
   * item carries it, the way a real turn's last item does. `prompt_tokens` is hit + miss,
   * which is what the provider's own numbers add up to, and the prompt grows along the chain
   * so the sizes stay believable. A `null` rate is a response with no cache fields at all —
   * the counter-case the ring must leave unpainted.
   */
  const cacheUsage = (index: number): { usage?: Usage } => {
    if (cacheRates.length === 0) {
      return {};
    }
    const rate = cacheRates[index % cacheRates.length];
    if (rate === null) {
      const prompt = 15000 + index * 1000;
      return { usage: { prompt_tokens: prompt, completion_tokens: 300, total_tokens: prompt + 300 } };
    }
    const prompt = 15000 + index * 1000;
    const hit = Math.round((prompt * rate) / 100);
    return {
      usage: {
        prompt_tokens: prompt,
        completion_tokens: 300,
        total_tokens: prompt + 300,
        prompt_cache_hit_tokens: hit,
        prompt_cache_miss_tokens: prompt - hit,
      },
    };
  };
  const now = Date.now();
  const sessionId = makeId('perf');
  const title = `${spec.title ?? 'PERF FIXTURE'} (${count} nodes)`;
  const nodes: Record<string, TreeNode> = {};
  const rootIds: string[] = [];
  let parentId: string | null = null;
  let activeNodeId = '';

  for (let index = 0; index < count; index++) {
    const turn = index + 1;
    const id = makeId('n');
    const ask =
      `Fixture turn ${turn}: change one thing, run the build and report the result. ` +
      `${filler(80, `Ask ${turn}`)}`;
    const answer = answerMarkdown(answerChars, turn);
    const displayItems: DisplayItem[] = [{ kind: 'user', text: ask }];
    for (let step = 0; step < toolsPerTurn; step++) {
      displayItems.push({
        kind: 'tool',
        name: 'exec_command',
        title: `fixture step ${turn}.${step + 1}`,
        args: JSON.stringify({ command: `dotnet build step ${turn}.${step + 1}` }),
        content: filler(toolChars, `Result ${turn}.${step + 1}`),
        status: 'done',
        startedAt: now - 1000,
        ms: 12 + step,
      });
    }
    displayItems.push({ kind: 'assistant', text: answer, ...cacheUsage(index) });
    // The API history stays a clean user/assistant pair: a tool row in the *display* items
    // needs no matching `tool_calls` exchange, and a fixture whose history a later prompt
    // could not send would be worse than one with no tool rows at all.
    const messages: ChatMessage[] = [
      { role: 'user', content: ask },
      { role: 'assistant', content: answer },
    ];
    if (parentId !== null) {
      nodes[parentId].children.push(id);
    } else {
      rootIds.push(id);
    }
    nodes[id] = {
      id,
      parentId,
      children: [],
      messages,
      displayItems,
      status: 'done',
      title: `Fixture turn ${turn}`,
      createdAt: now - (count - index) * 60_000,
    };
    parentId = id;
    activeNodeId = id;
  }

  const session: AgentSession = {
    id: sessionId,
    title,
    // A manual title: the automatic namer must never rename a fixture out from under the
    // person looking for it in the sidebar.
    titleSource: 'manual',
    titleLocked: true,
    createdAt: now,
    updatedAt: now,
    nodes,
    rootIds,
    activeNodeId,
    orphanItems: [],
  };
  const summary: SessionSummary = {
    id: sessionId,
    title,
    titleSource: 'manual',
    createdAt: now,
    updatedAt: now,
    nodeCount: count,
    activeNodeId,
  };
  return { session, summary };
}
